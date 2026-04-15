import { WorkItemState } from './work-item-state.enum';

export type StateTransitionActorType = 'user' | 'agent' | 'system';

export interface StateTransition {
  id: string;
  workItemId: string;
  fromState?: WorkItemState;
  toState: WorkItemState;
  actorType: StateTransitionActorType;
  actorId: string;
  reason?: string;
  createdAt: string;
}
