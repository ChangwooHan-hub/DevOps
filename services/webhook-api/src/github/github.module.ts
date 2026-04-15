import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { GithubWebhookController } from './github-webhook.controller';
import { GithubWebhookService } from './github-webhook.service';
import { SignatureVerifierService } from './signature-verifier.service';

@Module({
  imports: [PersistenceModule, QueueModule],
  controllers: [GithubWebhookController],
  providers: [GithubWebhookService, SignatureVerifierService]
})
export class GithubModule {}
