export interface GithubDomainEvent {
  eventName: string;
  action?: string;
  deliveryId: string;
  repositoryId: number;
  installationId?: number;
  payload: Record<string, unknown>;
  receivedAt: string;
}

