import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubDomainEvent, GithubWebhookJob } from '@uwb/domain';
import { randomUUID } from 'crypto';
import { PostgresService } from '../persistence/postgres.service';
import { WebhookQueueService } from '../queue/webhook-queue.service';

@Injectable()
export class GithubWebhookService {
  private readonly logger = new Logger(GithubWebhookService.name);
  private readonly processedDeliveries = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly postgresService: PostgresService,
    private readonly webhookQueueService: WebhookQueueService
  ) {}

  async isDuplicate(deliveryId: string): Promise<boolean> {
    if (this.postgresService.enabled) {
      const { rows } = await this.postgresService.query<{ delivery_id: string }>(
        'select delivery_id from github_events where delivery_id = $1 limit 1',
        [deliveryId]
      );
      return rows.length > 0;
    }
    return this.processedDeliveries.has(deliveryId);
  }

  async markProcessed(input: {
    deliveryId: string;
    eventName: string;
    action?: string;
    payload: Record<string, unknown>;
  }) {
    if (this.postgresService.enabled) {
      const repository = this.extractRepository(input.payload);
      const repositoryId = await this.resolveRepositoryId({
        githubRepoId: repository.id,
        fullName: repository.fullName,
        installationId: this.extractInstallationId(input.payload),
        defaultBranch: repository.defaultBranch
      });

      await this.postgresService.query(
        `
          insert into github_events (
            id,
            repository_id,
            delivery_id,
            event_name,
            action,
            payload,
            received_at,
            processing_status
          )
          values ($1, $2, $3, $4, $5, $6::jsonb, now(), 'received')
          on conflict (delivery_id) do nothing
        `,
        [randomUUID(), repositoryId, input.deliveryId, input.eventName, input.action ?? null, JSON.stringify(input.payload)]
      );
      return;
    }

    this.processedDeliveries.add(input.deliveryId);
  }

  validateEventAccess(input: { eventName: string; payload: Record<string, unknown> }) {
    const allowedEvents = this.parseCsv('GITHUB_WEBHOOK_ALLOWLIST');
    if (allowedEvents.length > 0 && !allowedEvents.includes(input.eventName)) {
      throw new UnauthorizedException(`event ${input.eventName} is not allowlisted`);
    }

    const repository = this.extractRepository(input.payload);
    const allowedRepos = this.parseCsv('GITHUB_REPOSITORY_ALLOWLIST');
    if (allowedRepos.length > 0 && repository.fullName && !allowedRepos.includes(repository.fullName)) {
      throw new UnauthorizedException(`repository ${repository.fullName} is not allowlisted`);
    }

    const installationId = this.extractInstallationId(input.payload);
    const allowedInstallations = this.parseCsv('GITHUB_INSTALLATION_ALLOWLIST');
    if (
      allowedInstallations.length > 0 &&
      installationId !== undefined &&
      !allowedInstallations.includes(String(installationId))
    ) {
      throw new UnauthorizedException(`installation ${installationId} is not allowlisted`);
    }
  }

  buildDomainEvent(input: {
    deliveryId: string;
    eventName: string;
    action?: string;
    payload: Record<string, unknown>;
  }): GithubDomainEvent {
    const repository = this.extractRepository(input.payload);
    const installationId = this.extractInstallationId(input.payload);

    return {
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      action: input.action,
      payload: input.payload,
      repositoryId: repository.id,
      installationId,
      receivedAt: new Date().toISOString()
    };
  }

  async route(event: GithubDomainEvent) {
    const repository = this.extractRepository(event.payload);
    const job: GithubWebhookJob = {
      deliveryId: event.deliveryId,
      eventName: event.eventName,
      action: event.action,
      repository: {
        id: repository.id,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch
      },
      installationId: event.installationId,
      payload: event.payload,
      receivedAt: event.receivedAt
    };

    if (this.webhookQueueService.isEnabled) {
      const queued = await this.webhookQueueService.enqueue(job);
      if (queued) {
        this.logger.log(
          `accepted GitHub event ${event.eventName}.${event.action ?? 'unknown'} for repo ${event.repositoryId}`
        );
        return {
          accepted: true,
          routedTo: 'orchestrator-queue',
          event
        };
      }
    }

    this.logger.log(`queue unavailable or disabled; accepted event ${event.deliveryId} in inline mode`);
    return {
      accepted: true,
      routedTo: 'orchestrator-inline',
      event
    };
  }

  private parseCsv(key: string): string[] {
    return (this.configService.get<string>(key) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private extractRepository(payload: Record<string, unknown>) {
    const repository = payload.repository as
      | {
          id?: number;
          full_name?: string;
          default_branch?: string;
        }
      | undefined;

    return {
      id: repository?.id ?? 0,
      fullName: repository?.full_name,
      defaultBranch: repository?.default_branch
    };
  }

  private extractInstallationId(payload: Record<string, unknown>) {
    const installation = payload.installation as { id?: number } | undefined;
    return installation?.id;
  }

  private async resolveRepositoryId(input: {
    githubRepoId: number;
    fullName?: string;
    installationId?: number;
    defaultBranch?: string;
  }): Promise<string> {
    const githubRepoId = input.githubRepoId || 0;
    const fullName = input.fullName ?? `unknown/${githubRepoId}`;
    const installationId = input.installationId ?? 0;
    const defaultBranch = input.defaultBranch ?? 'main';

    const { rows } = await this.postgresService.query<{ id: string }>(
      `
        insert into repositories (
          id, github_installation_id, github_repo_id, full_name, default_branch
        )
        values ($1, $2, $3, $4, $5)
        on conflict (github_repo_id)
        do update set
          github_installation_id = excluded.github_installation_id,
          full_name = excluded.full_name,
          default_branch = excluded.default_branch
        returning id
      `,
      [randomUUID(), installationId, githubRepoId, fullName, defaultBranch]
    );

    return rows[0].id;
  }
}
