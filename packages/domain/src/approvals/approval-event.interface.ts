export type ApprovalAction = 'approved' | 'rejected' | 'revoked' | 'superseded';
export type ApprovalActorType = 'user' | 'agent' | 'system';

export interface ApprovalEvent {
  id: string;
  workItemId: string;
  subjectType: string;
  subjectId: string;
  action: ApprovalAction;
  actorType: ApprovalActorType;
  actorId: string;
  reason?: string;
  prevEventId?: string;
  prevHash?: string;
  eventHash: string;
  createdAt: string;
}
