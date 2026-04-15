import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkItem } from '@uwb/domain';
import * as path from 'path';
import { PostgresService } from '../persistence/postgres.service';

interface RepositoryInfo {
  fullName: string;
  defaultBranch: string;
}

type RunnerAgentType = 'dev' | 'review' | 'merge_readiness';

@Injectable()
export class RunnerTriggerService {
  private readonly logger = new Logger(RunnerTriggerService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly postgresService: PostgresService
  ) {}

  async triggerOnApprovedForDev(workItem: WorkItem): Promise<void> {
    if (!this.getBoolean('RUNNER_AUTOTRIGGER_ENABLED', true)) {
      return;
    }

    if (await this.hasExistingAgentRun(workItem.id, 'dev')) {
      return;
    }

    const repository = await this.resolveRepositoryInfo(workItem);
    if (!repository) {
      this.logger.warn(`skip runner auto-trigger for work item ${workItem.id}: repository info unavailable`);
      return;
    }

    const repositoryPath = this.resolveRepositoryPath(repository.fullName);
    if (!repositoryPath) {
      this.logger.warn(
        `skip runner auto-trigger for work item ${workItem.id}: repository path mapping missing for ${repository.fullName}`
      );
      return;
    }

    const budget = this.resolveBudget();
    const branchName = `agent/workitem-${workItem.id.slice(0, 8)}`;
    const payload: Record<string, unknown> = {
      repository: repository.fullName,
      repositoryPath,
      taskPrompt: this.buildTaskPrompt(workItem, repository.fullName),
      budget,
      workItemId: workItem.id,
      baseBranch: repository.defaultBranch,
      branchName,
      prBaseBranch: repository.defaultBranch,
      openPullRequest: this.getBoolean('RUNNER_AUTOTRIGGER_OPEN_PR', true),
      draftPullRequest: this.getBoolean('RUNNER_AUTOTRIGGER_DRAFT_PR', true),
      dryRun: this.getBoolean('RUNNER_AUTOTRIGGER_DRY_RUN', false)
    };

    const model = this.configService.get<string>('RUNNER_AUTOTRIGGER_MODEL');
    if (model && model.trim().length > 0) {
      payload.model = model.trim();
    }

    if (!this.getBoolean('RUNNER_AUTOTRIGGER_VALIDATION_ENABLED', false)) {
      payload.validationCommands = [];
    }

    await this.postRunnerRequest({
      workItemId: workItem.id,
      endpoint: '/runner/agent-runs',
      payload
    });
  }

  async triggerOnReviewing(workItem: WorkItem): Promise<void> {
    if (!this.getBoolean('RUNNER_AUTOTRIGGER_REVIEW_ENABLED', true)) {
      return;
    }
    if (await this.hasExistingAgentRun(workItem.id, 'review')) {
      return;
    }

    const repository = await this.resolveRepositoryInfo(workItem);
    if (!repository) {
      this.logger.warn(`skip review auto-trigger for work item ${workItem.id}: repository info unavailable`);
      return;
    }

    const payload = {
      repository: repository.fullName,
      workItemId: workItem.id,
      reviewPrompt: this.buildReviewPrompt(workItem, repository.fullName)
    };

    await this.postRunnerRequest({
      workItemId: workItem.id,
      endpoint: '/runner/review-runs',
      payload
    });
  }

  async triggerOnReviewPassed(workItem: WorkItem): Promise<void> {
    if (!this.getBoolean('RUNNER_AUTOTRIGGER_MERGE_ENABLED', true)) {
      return;
    }
    if (await this.hasExistingAgentRun(workItem.id, 'merge_readiness')) {
      return;
    }

    const repository = await this.resolveRepositoryInfo(workItem);
    if (!repository) {
      this.logger.warn(
        `skip merge decision auto-trigger for work item ${workItem.id}: repository info unavailable`
      );
      return;
    }

    const payload = {
      repository: repository.fullName,
      workItemId: workItem.id,
      decisionPrompt: this.buildMergeDecisionPrompt(workItem, repository.fullName)
    };

    await this.postRunnerRequest({
      workItemId: workItem.id,
      endpoint: '/runner/merge-decision-runs',
      payload
    });
  }

  private async resolveRepositoryInfo(workItem: WorkItem): Promise<RepositoryInfo | undefined> {
    if (!this.postgresService.enabled) {
      if (this.isRepositorySlug(workItem.repositoryId)) {
        return {
          fullName: workItem.repositoryId,
          defaultBranch: 'main'
        };
      }
      return undefined;
    }

    const { rows } = await this.postgresService.query<{ full_name: string; default_branch: string }>(
      `
        select full_name, default_branch
        from repositories
        where id = $1
        limit 1
      `,
      [workItem.repositoryId]
    );
    if (rows.length === 0) {
      return undefined;
    }
    return {
      fullName: rows[0].full_name,
      defaultBranch: rows[0].default_branch || 'main'
    };
  }

  private resolveRepositoryPath(repositoryFullName: string): string | undefined {
    const mapped = this.readRepositoryPathMap(repositoryFullName);
    if (mapped) {
      return mapped;
    }

    const defaultPath = this.configService.get<string>('RUNNER_DEFAULT_REPOSITORY_PATH');
    if (defaultPath && defaultPath.trim().length > 0) {
      return path.resolve(defaultPath.trim());
    }

    const baseDir = this.configService.get<string>('RUNNER_REPOSITORY_BASE_DIR');
    if (baseDir && baseDir.trim().length > 0) {
      const [, repoName] = repositoryFullName.split('/');
      if (!repoName) {
        return undefined;
      }
      return path.resolve(baseDir.trim(), repoName);
    }

    return undefined;
  }

  private readRepositoryPathMap(repositoryFullName: string): string | undefined {
    const raw = this.configService.get<string>('RUNNER_REPOSITORY_PATH_MAP');
    if (!raw || raw.trim().length === 0) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const mappedPath = parsed[repositoryFullName];
      if (!mappedPath || mappedPath.trim().length === 0) {
        return undefined;
      }
      return path.resolve(mappedPath.trim());
    } catch {
      this.logger.warn('RUNNER_REPOSITORY_PATH_MAP is not valid JSON');
      return undefined;
    }
  }

  private resolveBudget() {
    return {
      maxRuntimeSeconds: Number(
        this.configService.get<string>('RUNNER_AUTOTRIGGER_MAX_RUNTIME_SECONDS') ??
          this.configService.get<string>('RUNNER_MAX_RUNTIME_SECONDS') ??
          3600
      ),
      maxChangedFiles: Number(
        this.configService.get<string>('RUNNER_AUTOTRIGGER_MAX_CHANGED_FILES') ??
          this.configService.get<string>('RUNNER_MAX_CHANGED_FILES') ??
          50
      ),
      maxLocDelta: Number(
        this.configService.get<string>('RUNNER_AUTOTRIGGER_MAX_LOC_DELTA') ??
          this.configService.get<string>('RUNNER_MAX_LOC_DELTA') ??
          2000
      ),
      maxLlmCalls: Number(
        this.configService.get<string>('RUNNER_AUTOTRIGGER_MAX_LLM_CALLS') ??
          this.configService.get<string>('RUNNER_MAX_LLM_CALLS') ??
          100
      )
    };
  }

  private buildTaskPrompt(workItem: WorkItem, repositoryFullName: string): string {
    const issueSuffix = workItem.issueNumber ? ` (issue #${workItem.issueNumber})` : '';
    return [
      `Implement work item from ${repositoryFullName}${issueSuffix}.`,
      `Title: ${workItem.title}`,
      'Requirements:',
      '- Keep changes minimal and safe.',
      '- Run deterministic validation before PR.',
      '- Prepare a draft PR with implementation summary.'
    ].join('\n');
  }

  private buildReviewPrompt(workItem: WorkItem, repositoryFullName: string): string {
    const issueSuffix = workItem.issueNumber ? `#${workItem.issueNumber}` : workItem.id;
    return [
      `Review work item from ${repositoryFullName} (${issueSuffix}).`,
      `Title: ${workItem.title}`,
      'Focus on correctness risks, regressions, and missing validation.'
    ].join('\n');
  }

  private buildMergeDecisionPrompt(workItem: WorkItem, repositoryFullName: string): string {
    const issueSuffix = workItem.issueNumber ? `#${workItem.issueNumber}` : workItem.id;
    return [
      `Assess merge readiness for ${repositoryFullName} (${issueSuffix}).`,
      `Title: ${workItem.title}`,
      'Evaluate remaining approvals, checks, and policy blocks.'
    ].join('\n');
  }

  private async hasExistingAgentRun(workItemId: string, agentType: RunnerAgentType): Promise<boolean> {
    if (!this.postgresService.enabled) {
      return false;
    }

    const { rows } = await this.postgresService.query<{ id: string; status: string }>(
      `
        select id, status
        from agent_runs
        where work_item_id = $1
          and agent_type = $2
          and status in ('queued', 'running', 'completed')
        order by started_at desc nulls last
        limit 1
      `,
      [workItemId, agentType]
    );

    if (rows.length === 0) {
      return false;
    }

    this.logger.log(
      `skip runner auto-trigger for work item ${workItemId}: existing ${agentType} run ${rows[0].id} (${rows[0].status})`
    );
    return true;
  }

  private async postRunnerRequest(input: {
    workItemId: string;
    endpoint: '/runner/agent-runs' | '/runner/review-runs' | '/runner/merge-decision-runs';
    payload: Record<string, unknown>;
  }) {
    const runnerServiceUrl = this.configService.get<string>('RUNNER_SERVICE_URL', 'http://127.0.0.1:3002');
    const response = await fetch(`${runnerServiceUrl.replace(/\/$/, '')}${input.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input.payload)
    });

    if (!response.ok) {
      const responseText = await response.text();
      this.logger.warn(
        `runner auto-trigger failed for work item ${input.workItemId}: ${response.status} ${responseText}`
      );
      return;
    }

    const resultText = await response.text();
    this.logger.log(`runner auto-trigger accepted for work item ${input.workItemId}: ${resultText}`);
  }

  private getBoolean(key: string, defaultValue: boolean): boolean {
    const value = this.configService.get<string>(key);
    if (!value) {
      return defaultValue;
    }
    return value.trim().toLowerCase() !== 'false';
  }

  private isRepositorySlug(value: string): boolean {
    return /^[^/\s]+\/[^/\s]+$/.test(value);
  }
}
