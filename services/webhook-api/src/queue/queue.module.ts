import { Module } from '@nestjs/common';
import { WebhookQueueService } from './webhook-queue.service';

@Module({
  providers: [WebhookQueueService],
  exports: [WebhookQueueService]
})
export class QueueModule {}
