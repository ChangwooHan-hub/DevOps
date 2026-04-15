import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ApprovalAction, ApprovalActorType, ApprovalEvent } from '@uwb/domain';
import { createHash, randomUUID } from 'crypto';
import { PostgresService } from '../persistence/postgres.service';

interface ApprovalRow {
  id: string;
  work_item_id: string;
  subject_type: string;
  subject_id: string;
  action: ApprovalAction;
  actor_type: ApprovalActorType;
  actor_id: string;
  reason: string | null;
  prev_event_id: string | null;
  prev_hash: string | null;
  event_hash: string;
  created_at: Date;
}

@Injectable()
export class ApprovalsService {
  private readonly approvalEvents = new Map<string, ApprovalEvent[]>();

  constructor(private readonly postgresService: PostgresService) {}

  async append(input: {
    workItemId: string;
    subjectType: string;
    subjectId: string;
    action: ApprovalAction;
    actorType: ApprovalActorType;
    actorId: string;
    reason?: string;
  }): Promise<ApprovalEvent> {
    this.validateInput(input);

    if (this.postgresService.enabled) {
      await this.ensureWorkItemExists(input.workItemId);
      const latest = await this.getLatestSubjectEvent(input.workItemId, input.subjectType, input.subjectId);
      const id = randomUUID();
      const now = new Date().toISOString();
      const eventHash = this.computeEventHash({
        id,
        workItemId: input.workItemId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        action: input.action,
        actorType: input.actorType,
        actorId: input.actorId,
        reason: input.reason ?? '',
        prevHash: latest?.event_hash ?? '',
        createdAt: now
      });

      const { rows } = await this.postgresService.query<ApprovalRow>(
        `
          insert into approval_events (
            id,
            work_item_id,
            subject_type,
            subject_id,
            action,
            actor_type,
            actor_id,
            reason,
            prev_event_id,
            prev_hash,
            event_hash,
            created_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          returning
            id,
            work_item_id,
            subject_type,
            subject_id,
            action,
            actor_type,
            actor_id,
            reason,
            prev_event_id,
            prev_hash,
            event_hash,
            created_at
        `,
        [
          id,
          input.workItemId,
          input.subjectType,
          input.subjectId,
          input.action,
          input.actorType,
          input.actorId,
          input.reason ?? null,
          latest?.id ?? null,
          latest?.event_hash ?? null,
          eventHash,
          now
        ]
      );
      return this.mapApprovalRow(rows[0]);
    }

    const latestInMemory = this.getLatestSubjectEventInMemory(
      input.workItemId,
      input.subjectType,
      input.subjectId
    );
    const createdAt = new Date().toISOString();
    const approvalEvent: ApprovalEvent = {
      id: randomUUID(),
      workItemId: input.workItemId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId,
      reason: input.reason,
      prevEventId: latestInMemory?.id,
      prevHash: latestInMemory?.eventHash,
      eventHash: this.computeEventHash({
        id: randomUUID(),
        workItemId: input.workItemId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        action: input.action,
        actorType: input.actorType,
        actorId: input.actorId,
        reason: input.reason ?? '',
        prevHash: latestInMemory?.eventHash ?? '',
        createdAt
      }),
      createdAt
    };

    const current = this.approvalEvents.get(input.workItemId) ?? [];
    current.push(approvalEvent);
    this.approvalEvents.set(input.workItemId, current);
    return approvalEvent;
  }

  async listByWorkItem(workItemId: string): Promise<ApprovalEvent[]> {
    if (this.postgresService.enabled) {
      const { rows } = await this.postgresService.query<ApprovalRow>(
        `
          select
            id,
            work_item_id,
            subject_type,
            subject_id,
            action,
            actor_type,
            actor_id,
            reason,
            prev_event_id,
            prev_hash,
            event_hash,
            created_at
          from approval_events
          where work_item_id = $1
          order by created_at asc
        `,
        [workItemId]
      );
      return rows.map((row) => this.mapApprovalRow(row));
    }

    return this.approvalEvents.get(workItemId) ?? [];
  }

  private validateInput(input: {
    workItemId: string;
    subjectType: string;
    subjectId: string;
    action: ApprovalAction;
    actorType: ApprovalActorType;
    actorId: string;
    reason?: string;
  }) {
    if (!input.workItemId) {
      throw new BadRequestException('workItemId is required');
    }
    if (!input.subjectType) {
      throw new BadRequestException('subjectType is required');
    }
    if (!input.subjectId) {
      throw new BadRequestException('subjectId is required');
    }
    if (!input.actorId) {
      throw new BadRequestException('actorId is required');
    }
  }

  private async ensureWorkItemExists(workItemId: string) {
    const { rows } = await this.postgresService.query<{ id: string }>('select id from work_items where id = $1', [
      workItemId
    ]);
    if (rows.length === 0) {
      throw new NotFoundException(`work item ${workItemId} not found`);
    }
  }

  private async getLatestSubjectEvent(workItemId: string, subjectType: string, subjectId: string) {
    const { rows } = await this.postgresService.query<{ id: string; event_hash: string }>(
      `
        select id, event_hash
        from approval_events
        where work_item_id = $1 and subject_type = $2 and subject_id = $3
        order by created_at desc
        limit 1
      `,
      [workItemId, subjectType, subjectId]
    );
    return rows[0];
  }

  private getLatestSubjectEventInMemory(workItemId: string, subjectType: string, subjectId: string) {
    const events = this.approvalEvents.get(workItemId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.subjectType === subjectType && event.subjectId === subjectId) {
        return event;
      }
    }
    return undefined;
  }

  private computeEventHash(input: {
    id: string;
    workItemId: string;
    subjectType: string;
    subjectId: string;
    action: ApprovalAction;
    actorType: ApprovalActorType;
    actorId: string;
    reason: string;
    prevHash: string;
    createdAt: string;
  }) {
    const canonical = [
      input.id,
      input.workItemId,
      input.subjectType,
      input.subjectId,
      input.action,
      input.actorType,
      input.actorId,
      input.reason,
      input.prevHash,
      input.createdAt
    ].join('|');
    return createHash('sha256').update(canonical).digest('hex');
  }

  private mapApprovalRow(row: ApprovalRow): ApprovalEvent {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      action: row.action,
      actorType: row.actor_type,
      actorId: row.actor_id,
      reason: row.reason ?? undefined,
      prevEventId: row.prev_event_id ?? undefined,
      prevHash: row.prev_hash ?? undefined,
      eventHash: row.event_hash,
      createdAt: row.created_at.toISOString()
    };
  }
}
