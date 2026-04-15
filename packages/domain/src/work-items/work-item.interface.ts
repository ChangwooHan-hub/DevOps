import { WorkItemState } from './work-item-state.enum';

export interface WorkItem {
  id: string;
  repositoryId: string;
  sourceType: 'issue' | 'pull_request';
  issueNumber?: number;
  prNumber?: number;
  title: string;
  state: WorkItemState;
  riskLevel?: 'low' | 'medium' | 'high';
  currentBranch?: string;
  currentHeadSha?: string;
  createdAt: string;
  updatedAt: string;
}

