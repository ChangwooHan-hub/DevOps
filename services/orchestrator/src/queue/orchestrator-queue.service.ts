import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubWebhookJob, WorkItemState } from '@uwb/domain';
import { createHash, randomUUID } from 'crypto';
import IORedis from 'ioredis';
import { Job, QueueEvents, Worker } from 'bullmq';
import { GithubSideEffectsService } from '../github/github-side-effects.service';
import { PostgresService } from '../persistence/postgres.service';
import { WorkItemsService } from '../work-items/work-items.service';

interface TriageDecision {
  workType: 'bug' | 'feature' | 'refactor';
  labels: string[];
  summary: string;
  nextAction: string;
}

@Injectable()
export class OrchestratorQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorQueueService.name);
  private readonly queueName = 'github-events';
  private connection?: IORedis;
  private worker?: Worker<GithubWebhookJob>;
  private queueEvents?: QueueEvents;

  constructor(
    private readonly configService: ConfigService,
    private readonly workItemsService: WorkItemsService,
    private readonly githubSideEffectsService: GithubSideEffectsService,
    private readonly postgresService: PostgresService
  ) {}

  async onModuleInit() {
    const enabled = this.configService.get<string>('ORCHESTRATOR_QUEUE_ENABLED', 'true') !== 'false';
    if (!enabled) {
      this.logger.warn('orchestrator queue worker is disabled by ORCHESTRATOR_QUEUE_ENABLED=false');
      return;
    }

    const redisUrl = this.configService.get<string>('REDIS_URL', 'redis://127.0.0.1:6379');
    this.connection = new IORedis(redisUrl, {
      // BullMQ Worker requires null to support its blocking commands.
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 1000,
      retryStrategy: () => null
    });
    try {
      if (this.connection.status === 'wait') {
        await this.connection.connect();
      }
      await this.connection.ping();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown redis error';
      this.logger.warn(`redis unavailable; queue worker disabled: ${message}`);
      this.connection.disconnect(false);
      this.connection = undefined;
      return;
    }

    this.worker = new Worker<GithubWebhookJob>(
      this.queueName,
      async (job) => this.handleWebhookJob(job),
      { connection: this.connection, concurrency: 5 }
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`webhook job failed: ${job?.id ?? 'unknown'} - ${error.message}`);
    });

    this.queueEvents = new QueueEvents(this.queueName, { connection: this.connection });
    await this.queueEvents.waitUntilReady();
    this.logger.log(`orchestrator queue worker started for queue ${this.queueName}`);
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
    if (this.queueEvents) {
      await this.queueEvents.close();
    }
    if (this.connection) {
      try {
        await this.connection.quit();
      } catch {
        this.connection.disconnect(false);
      }
    }
  }

  private async handleWebhookJob(job: Job<GithubWebhookJob>) {
    const payload = job.data;
    await this.markProcessingStatus(payload.deliveryId, 'processing');

    try {
      if (payload.eventName !== 'issues' || payload.action !== 'opened') {
        await this.markProcessingStatus(payload.deliveryId, 'ignored');
        return { ignored: true };
      }

      const issue = payload.payload.issue as { number?: number; title?: string; body?: string } | undefined;
      if (!issue?.number || !issue.title) {
        await this.markProcessingStatus(payload.deliveryId, 'ignored');
        return { ignored: true, reason: 'missing issue payload' };
      }

      const triage = this.triageIssue(issue.title, issue.body ?? '');
      const workItem = await this.workItemsService.createFromIssue({
        title: issue.title,
        repositoryId: payload.repository.fullName ?? String(payload.repository.id),
        issueNumber: issue.number,
        repository: {
          fullName: payload.repository.fullName,
          githubRepoId: payload.repository.id,
          githubInstallationId: payload.installationId,
          defaultBranch: payload.repository.defaultBranch
        }
      });

      await this.recordTriageArtifact(workItem.id, triage);

      await this.workItemsService.transition(workItem.id, WorkItemState.TRIAGED, {
        actorType: 'agent',
        actorId: 'triage-agent',
        reason: 'triage artifact created'
      });

      await this.githubSideEffectsService.publishTriage({
        repositoryFullName: payload.repository.fullName,
        issueNumber: issue.number,
        installationId: payload.installationId,
        triage: {
          ...triage,
          workItemId: workItem.id
        }
      });

      await this.markProcessingStatus(payload.deliveryId, 'processed');
      return { accepted: true, workItemId: workItem.id };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown worker error';
      await this.markProcessingStatus(payload.deliveryId, 'failed');
      throw new Error(message);
    }
  }

  private triageIssue(title: string, body: string): TriageDecision {
    const content = `${title}\n${body}`.toLowerCase();
    if (/(error|exception|fail|broken|regression|bug)/.test(content)) {
      return {
        workType: 'bug',
        labels: ['type:bug', 'needs-planning'],
        summary: 'Issue appears to describe a defect or regression.',
        nextAction: 'prepare a fix-focused plan with validation scope'
      };
    }
    if (/(refactor|cleanup|tech debt|debt)/.test(content)) {
      return {
        workType: 'refactor',
        labels: ['type:refactor', 'needs-planning'],
        summary: 'Issue appears to request internal code structure improvements.',
        nextAction: 'prepare refactor plan with impact and rollback notes'
      };
    }
    return {
      workType: 'feature',
      labels: ['type:feature', 'needs-planning'],
      summary: 'Issue appears to request new or extended behavior.',
      nextAction: 'prepare implementation plan and approval request'
    };
  }

  private async recordTriageArtifact(workItemId: string, triage: TriageDecision) {
    if (!this.postgresService.enabled) {
      return;
    }

    const serialized = JSON.stringify(triage);
    const sha256 = createHash('sha256').update(serialized).digest('hex');
    await this.postgresService.query(
      `
        insert into artifacts (
          id, work_item_id, artifact_type, storage_uri, sha256, metadata
        )
        values ($1, $2, 'triage_artifact', $3, $4, $5::jsonb)
      `,
      [randomUUID(), workItemId, `inline://triage/${workItemId}`, sha256, serialized]
    );
  }

  private async markProcessingStatus(deliveryId: string, status: 'processing' | 'processed' | 'failed' | 'ignored') {
    if (!this.postgresService.enabled) {
      return;
    }

    await this.postgresService.query(
      `
        update github_events
        set
          processing_status = $2,
          processed_at = case
            when $2 in ('processed', 'failed', 'ignored') then now()
            else processed_at
          end
        where delivery_id = $1
      `,
      [deliveryId, status]
    );
  }
}
