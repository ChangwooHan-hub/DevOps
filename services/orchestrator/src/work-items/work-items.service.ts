import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { StateTransition, WorkItem, WorkItemState } from '@uwb/domain';
import { createHash, randomUUID } from 'crypto';
import { PostgresService } from '../persistence/postgres.service';
import { RunnerTriggerService } from './runner-trigger.service';
import { isTransitionAllowed } from './work-item-state-machine';

interface RepositoryMetadata {
  fullName?: string;
  githubRepoId?: number;
  githubInstallationId?: number;
  defaultBranch?: string;
}

interface CreateWorkItemInput {
  title: string;
  repositoryId: string;
  issueNumber: number;
  repository?: RepositoryMetadata;
}

interface WorkItemRow {
  id: string;
  repository_id: string;
  source_type: 'issue' | 'pull_request';
  issue_number: number | null;
  pr_number: number | null;
  title: string;
  state: WorkItemState;
  risk_level: 'low' | 'medium' | 'high' | null;
  current_branch: string | null;
  current_head_sha: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StateTransitionRow {
  id: string;
  work_item_id: string;
  from_state: WorkItemState | null;
  to_state: WorkItemState;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string;
  reason: string | null;
  created_at: Date;
}

@Injectable()
export class WorkItemsService {
  private readonly logger = new Logger(WorkItemsService.name);
  private readonly workItems = new Map<string, WorkItem>();
  private readonly transitions = new Map<string, StateTransition[]>();

  constructor(
    private readonly postgresService: PostgresService,
    private readonly runnerTriggerService: RunnerTriggerService
  ) {}

  async createFromIssue(input: CreateWorkItemInput): Promise<WorkItem> {
    const title = input.title.trim();
    if (!title) {
      throw new BadRequestException('title is required');
    }

    if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
      throw new BadRequestException('issueNumber must be a positive integer');
    }

    if (this.postgresService.enabled) {
      const repositoryId = await this.resolveRepositoryId(input.repositoryId, input.repository);
      const now = new Date().toISOString();
      const id = randomUUID();

      await this.postgresService.query(
        `
          insert into work_items (
            id, repository_id, source_type, issue_number, title, state, created_at, updated_at
          )
          values ($1, $2, 'issue', $3, $4, $5, $6, $6)
        `,
        [id, repositoryId, input.issueNumber, title, WorkItemState.OPEN, now]
      );

      await this.recordTransition({
        workItemId: id,
        fromState: null,
        toState: WorkItemState.OPEN,
        actorType: 'system',
        actorId: 'orchestrator',
        reason: 'work item created'
      });

      return this.getById(id);
    }

    const now = new Date().toISOString();
    const workItem: WorkItem = {
      id: randomUUID(),
      repositoryId: input.repositoryId,
      sourceType: 'issue',
      issueNumber: input.issueNumber,
      title,
      state: WorkItemState.OPEN,
      createdAt: now,
      updatedAt: now
    };

    this.workItems.set(workItem.id, workItem);
    this.appendInMemoryTransition({
      id: randomUUID(),
      workItemId: workItem.id,
      fromState: undefined,
      toState: WorkItemState.OPEN,
      actorType: 'system',
      actorId: 'orchestrator',
      reason: 'work item created',
      createdAt: now
    });
    return workItem;
  }

  async list(): Promise<WorkItem[]> {
    if (this.postgresService.enabled) {
      const { rows } = await this.postgresService.query<WorkItemRow>(
        `
          select
            id,
            repository_id,
            source_type,
            issue_number,
            pr_number,
            title,
            state,
            risk_level,
            current_branch,
            current_head_sha,
            created_at,
            updated_at
          from work_items
          order by created_at desc
        `
      );
      return rows.map((row) => this.mapWorkItemRow(row));
    }

    return [...this.workItems.values()];
  }

  async getById(id: string): Promise<WorkItem> {
    if (this.postgresService.enabled) {
      const { rows } = await this.postgresService.query<WorkItemRow>(
        `
          select
            id,
            repository_id,
            source_type,
            issue_number,
            pr_number,
            title,
            state,
            risk_level,
            current_branch,
            current_head_sha,
            created_at,
            updated_at
          from work_items
          where id = $1
        `,
        [id]
      );

      if (rows.length === 0) {
        throw new NotFoundException(`work item ${id} not found`);
      }

      return this.mapWorkItemRow(rows[0]);
    }

    const workItem = this.workItems.get(id);
    if (!workItem) {
      throw new NotFoundException(`work item ${id} not found`);
    }
    return workItem;
  }

  async listTransitions(id: string): Promise<StateTransition[]> {
    if (this.postgresService.enabled) {
      await this.ensureWorkItemExists(id);
      const { rows } = await this.postgresService.query<StateTransitionRow>(
        `
          select
            id,
            work_item_id,
            from_state,
            to_state,
            actor_type,
            actor_id,
            reason,
            created_at
          from state_transitions
          where work_item_id = $1
          order by created_at asc
        `,
        [id]
      );
      return rows.map((row) => this.mapTransitionRow(row));
    }

    if (!this.workItems.has(id)) {
      throw new NotFoundException(`work item ${id} not found`);
    }
    return this.transitions.get(id) ?? [];
  }

  async transition(
    id: string,
    nextState: WorkItemState,
    actor: { actorType: 'user' | 'agent' | 'system'; actorId: string; reason?: string } = {
      actorType: 'system',
      actorId: 'orchestrator'
    }
  ): Promise<WorkItem> {
    const workItem = await this.getById(id);
    if (workItem.state === nextState) {
      return workItem;
    }

    if (!isTransitionAllowed(workItem.state, nextState)) {
      throw new ConflictException(`invalid transition ${workItem.state} -> ${nextState}`);
    }

    await this.enforceTransitionGates(id, nextState);

    if (this.postgresService.enabled) {
      await this.postgresService.query(
        `
          update work_items
          set state = $2, updated_at = now()
          where id = $1
        `,
        [id, nextState]
      );

      await this.recordTransition({
        workItemId: id,
        fromState: workItem.state,
        toState: nextState,
        actorType: actor.actorType,
        actorId: actor.actorId,
        reason: actor.reason ?? null
      });

      const updated = await this.getById(id);
      await this.tryAutoTriggerRunner(updated, nextState);
      return updated;
    }

    const updated: WorkItem = {
      ...workItem,
      state: nextState,
      updatedAt: new Date().toISOString()
    };
    this.workItems.set(id, updated);
    this.appendInMemoryTransition({
      id: randomUUID(),
      workItemId: id,
      fromState: workItem.state,
      toState: nextState,
      actorType: actor.actorType,
      actorId: actor.actorId,
      reason: actor.reason,
      createdAt: updated.updatedAt
    });
    await this.tryAutoTriggerRunner(updated, nextState);
    return updated;
  }

  private async tryAutoTriggerRunner(workItem: WorkItem, nextState: WorkItemState) {
    try {
      if (nextState === WorkItemState.APPROVED_FOR_DEV) {
        await this.runnerTriggerService.triggerOnApprovedForDev(workItem);
        return;
      }
      if (nextState === WorkItemState.REVIEWING) {
        await this.runnerTriggerService.triggerOnReviewing(workItem);
        return;
      }
      if (nextState === WorkItemState.REVIEW_PASSED) {
        await this.runnerTriggerService.triggerOnReviewPassed(workItem);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown trigger error';
      this.logger.warn(`runner auto-trigger failed for work item ${workItem.id}: ${message}`);
    }
  }

  private async enforceTransitionGates(workItemId: string, nextState: WorkItemState) {
    if (nextState === WorkItemState.APPROVED_FOR_DEV) {
      const approved = await this.hasLatestSubjectApproval(workItemId, 'plan');
      if (!approved) {
        throw new ConflictException('plan approval is required before APPROVED_FOR_DEV');
      }
    }

    if (nextState === WorkItemState.MERGE_READY) {
      const approved = await this.hasLatestSubjectApproval(workItemId, 'merge');
      if (!approved) {
        throw new ConflictException('final merge approval is required before MERGE_READY');
      }
    }
  }

  private async hasLatestSubjectApproval(workItemId: string, subjectType: string): Promise<boolean> {
    if (!this.postgresService.enabled) {
      return true;
    }

    const { rows } = await this.postgresService.query<{ action: string }>(
      `
        select action
        from approval_events
        where work_item_id = $1 and subject_type = $2
        order by created_at desc
        limit 1
      `,
      [workItemId, subjectType]
    );

    if (rows.length === 0) {
      return false;
    }
    return rows[0].action === 'approved';
  }

  private async recordTransition(input: {
    workItemId: string;
    fromState: WorkItemState | null;
    toState: WorkItemState;
    actorType: 'user' | 'agent' | 'system';
    actorId: string;
    reason: string | null;
  }) {
    if (!this.postgresService.enabled) {
      return;
    }
    await this.postgresService.query(
      `
        insert into state_transitions (
          id, work_item_id, from_state, to_state, actor_type, actor_id, reason
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [randomUUID(), input.workItemId, input.fromState, input.toState, input.actorType, input.actorId, input.reason]
    );
  }

  private async resolveRepositoryId(repositoryIdInput: string, metadata?: RepositoryMetadata): Promise<string> {
    if (this.isUuid(repositoryIdInput)) {
      return repositoryIdInput;
    }

    const fullName = metadata?.fullName ?? repositoryIdInput;
    const githubRepoId = metadata?.githubRepoId ?? this.computeNumericHash(repositoryIdInput);
    const installationId = metadata?.githubInstallationId ?? 0;
    const defaultBranch = metadata?.defaultBranch ?? 'main';

    const { rows } = await this.postgresService.query<{ id: string }>(
      `
        insert into repositories (
          id, github_installation_id, github_repo_id, full_name, default_branch
        )
        values ($1, $2, $3, $4, $5)
        on conflict (full_name)
        do update set
          github_installation_id = excluded.github_installation_id,
          github_repo_id = excluded.github_repo_id,
          default_branch = excluded.default_branch
        returning id
      `,
      [randomUUID(), installationId, githubRepoId, fullName, defaultBranch]
    );

    return rows[0].id;
  }

  private async ensureWorkItemExists(id: string) {
    const { rows } = await this.postgresService.query<{ id: string }>('select id from work_items where id = $1', [id]);
    if (rows.length === 0) {
      throw new NotFoundException(`work item ${id} not found`);
    }
  }

  private mapWorkItemRow(row: WorkItemRow): WorkItem {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      sourceType: row.source_type,
      issueNumber: row.issue_number ?? undefined,
      prNumber: row.pr_number ?? undefined,
      title: row.title,
      state: row.state,
      riskLevel: row.risk_level ?? undefined,
      currentBranch: row.current_branch ?? undefined,
      currentHeadSha: row.current_head_sha ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }

  private mapTransitionRow(row: StateTransitionRow): StateTransition {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      fromState: row.from_state ?? undefined,
      toState: row.to_state,
      actorType: row.actor_type,
      actorId: row.actor_id,
      reason: row.reason ?? undefined,
      createdAt: row.created_at.toISOString()
    };
  }

  private appendInMemoryTransition(transition: StateTransition) {
    const current = this.transitions.get(transition.workItemId) ?? [];
    current.push(transition);
    this.transitions.set(transition.workItemId, current);
  }

  private computeNumericHash(value: string): number {
    const digest = createHash('sha256').update(value).digest();
    return digest.readUInt32BE(0);
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
