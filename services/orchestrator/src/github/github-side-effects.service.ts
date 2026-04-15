import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';

interface InstallationTokenCache {
  installationId: number;
  token: string;
  expiresAtEpochSeconds: number;
}

@Injectable()
export class GithubSideEffectsService {
  private readonly logger = new Logger(GithubSideEffectsService.name);
  private installationTokenCache?: InstallationTokenCache;

  constructor(private readonly configService: ConfigService) {}

  async publishTriage(input: {
    repositoryFullName?: string;
    issueNumber: number;
    installationId?: number;
    triage: {
      workType: 'bug' | 'feature' | 'refactor';
      labels: string[];
      summary: string;
      nextAction: string;
      workItemId: string;
    };
  }) {
    if (!input.repositoryFullName) {
      return;
    }

    const [owner, repo] = input.repositoryFullName.split('/');
    if (!owner || !repo) {
      return;
    }

    const token = await this.getAccessToken(input.installationId);
    if (!token) {
      this.logger.warn('github credentials are not configured; skipping issue side effects');
      return;
    }

    const labels = [...new Set(['ai-triaged', ...input.triage.labels])];
    await this.requestGithub({
      token,
      method: 'POST',
      path: `/repos/${owner}/${repo}/issues/${input.issueNumber}/labels`,
      body: { labels }
    });

    const commentBody = [
      '### AI Triage',
      '',
      `- Work type: \`${input.triage.workType}\``,
      `- Summary: ${input.triage.summary}`,
      `- Next action: ${input.triage.nextAction}`,
      `- Work item: \`${input.triage.workItemId}\``
    ].join('\n');

    await this.requestGithub({
      token,
      method: 'POST',
      path: `/repos/${owner}/${repo}/issues/${input.issueNumber}/comments`,
      body: { body: commentBody }
    });
  }

  private async requestGithub(input: {
    token: string;
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
  }) {
    const response = await fetch(`https://api.github.com${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'uwb-orchestrator',
        'Content-Type': 'application/json'
      },
      body: input.body ? JSON.stringify(input.body) : undefined
    });

    if (!response.ok) {
      const responseText = await response.text();
      this.logger.warn(`github side effect failed ${response.status}: ${responseText}`);
    }
  }

  private async getAccessToken(installationId?: number): Promise<string | undefined> {
    const explicitToken = this.configService.get<string>('GITHUB_TOKEN');
    if (explicitToken) {
      return explicitToken;
    }

    const appId = this.configService.get<string>('GITHUB_APP_ID');
    const privateKeyRaw = this.configService.get<string>('GITHUB_APP_PRIVATE_KEY');
    if (!appId || !privateKeyRaw || !installationId) {
      return undefined;
    }

    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    if (
      this.installationTokenCache &&
      this.installationTokenCache.installationId === installationId &&
      this.installationTokenCache.expiresAtEpochSeconds > nowEpochSeconds + 60
    ) {
      return this.installationTokenCache.token;
    }

    const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
    const jwt = this.createAppJwt(Number(appId), privateKey, nowEpochSeconds);
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'uwb-orchestrator'
        }
      }
    );

    if (!response.ok) {
      const responseText = await response.text();
      this.logger.warn(`failed to acquire installation token: ${response.status} ${responseText}`);
      return undefined;
    }

    const payload = (await response.json()) as { token?: string; expires_at?: string };
    if (!payload.token || !payload.expires_at) {
      return undefined;
    }

    this.installationTokenCache = {
      installationId,
      token: payload.token,
      expiresAtEpochSeconds: Math.floor(new Date(payload.expires_at).getTime() / 1000)
    };
    return payload.token;
  }

  private createAppJwt(appId: number, privateKey: string, nowEpochSeconds: number): string {
    const header = this.base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' });
    const payload = this.base64UrlEncodeJson({
      iat: nowEpochSeconds - 60,
      exp: nowEpochSeconds + 9 * 60,
      iss: appId
    });
    const unsignedToken = `${header}.${payload}`;

    const signer = createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();
    const signature = signer.sign(privateKey);
    return `${unsignedToken}.${this.base64UrlEncode(signature)}`;
  }

  private base64UrlEncodeJson(value: Record<string, unknown>) {
    return this.base64UrlEncode(Buffer.from(JSON.stringify(value), 'utf-8'));
  }

  private base64UrlEncode(buffer: Buffer) {
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }
}
