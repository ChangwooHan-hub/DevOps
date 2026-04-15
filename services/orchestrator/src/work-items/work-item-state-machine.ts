import { WorkItemState } from '@uwb/domain';

const transitionRules: Record<WorkItemState, WorkItemState[]> = {
  [WorkItemState.OPEN]: [WorkItemState.TRIAGED, WorkItemState.CANCELLED],
  [WorkItemState.TRIAGED]: [WorkItemState.PLANNED, WorkItemState.CANCELLED],
  [WorkItemState.PLANNED]: [WorkItemState.APPROVED_FOR_DEV, WorkItemState.HUMAN_REQUIRED, WorkItemState.CANCELLED],
  [WorkItemState.APPROVED_FOR_DEV]: [WorkItemState.IN_PROGRESS, WorkItemState.CANCELLED],
  [WorkItemState.IN_PROGRESS]: [
    WorkItemState.DRAFT_PR,
    WorkItemState.HUMAN_REQUIRED,
    WorkItemState.QUARANTINED,
    WorkItemState.CANCELLED
  ],
  [WorkItemState.DRAFT_PR]: [WorkItemState.VALIDATING, WorkItemState.CHANGES_REQUESTED, WorkItemState.CANCELLED],
  [WorkItemState.VALIDATING]: [
    WorkItemState.REVIEWING,
    WorkItemState.QUARANTINED,
    WorkItemState.HUMAN_REQUIRED,
    WorkItemState.CANCELLED
  ],
  [WorkItemState.REVIEWING]: [
    WorkItemState.CHANGES_REQUESTED,
    WorkItemState.REVIEW_PASSED,
    WorkItemState.HUMAN_REQUIRED,
    WorkItemState.CANCELLED
  ],
  [WorkItemState.CHANGES_REQUESTED]: [WorkItemState.IN_PROGRESS, WorkItemState.CANCELLED],
  [WorkItemState.REVIEW_PASSED]: [WorkItemState.MERGE_READY, WorkItemState.HUMAN_REQUIRED, WorkItemState.CANCELLED],
  [WorkItemState.MERGE_READY]: [WorkItemState.MERGED, WorkItemState.HUMAN_REQUIRED, WorkItemState.CANCELLED],
  [WorkItemState.MERGED]: [],
  [WorkItemState.HUMAN_REQUIRED]: [WorkItemState.APPROVED_FOR_DEV, WorkItemState.QUARANTINED, WorkItemState.CANCELLED],
  [WorkItemState.QUARANTINED]: [WorkItemState.HUMAN_REQUIRED, WorkItemState.CANCELLED],
  [WorkItemState.CANCELLED]: []
};

export function isTransitionAllowed(from: WorkItemState, to: WorkItemState): boolean {
  return transitionRules[from].includes(to);
}
