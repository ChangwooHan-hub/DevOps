export interface GithubWebhookJob {
  deliveryId: string;
  eventName: string;
  action?: string;
  repository: {
    id: number;
    fullName?: string;
    defaultBranch?: string;
  };
  installationId?: number;
  payload: Record<string, unknown>;
  receivedAt: string;
}
