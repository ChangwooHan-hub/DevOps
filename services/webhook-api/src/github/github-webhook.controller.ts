import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { GithubWebhookService } from './github-webhook.service';
import { SignatureVerifierService } from './signature-verifier.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('github')
export class GithubWebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly githubWebhookService: GithubWebhookService,
    private readonly signatureVerifier: SignatureVerifierService
  ) {}

  @Post('webhooks')
  @HttpCode(202)
  async handleWebhook(
    @Headers('x-github-event') eventName: string,
    @Headers('x-github-delivery') deliveryId: string,
    @Headers('x-hub-signature-256') signature: string,
    @Req() request: RawBodyRequest,
    @Body() payload: Record<string, unknown>
  ) {
    const secret = this.configService.get<string>('WEBHOOK_SECRET', 'replace-me');
    this.signatureVerifier.verify(request.rawBody, signature, secret);
    this.githubWebhookService.validateEventAccess({ eventName, payload });

    if (await this.githubWebhookService.isDuplicate(deliveryId)) {
      return {
        accepted: false,
        duplicate: true,
        deliveryId
      };
    }

    await this.githubWebhookService.markProcessed({
      deliveryId,
      eventName,
      action: typeof payload.action === 'string' ? payload.action : undefined,
      payload
    });

    const domainEvent = this.githubWebhookService.buildDomainEvent({
      deliveryId,
      eventName,
      action: typeof payload.action === 'string' ? payload.action : undefined,
      payload
    });

    return this.githubWebhookService.route(domainEvent);
  }
}
