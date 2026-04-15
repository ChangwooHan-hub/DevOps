import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubWebhookJob } from '@uwb/domain';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

@Injectable()
export class WebhookQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookQueueService.name);
  private readonly queueName = 'github-events';
  private readonly connection?: IORedis;
  private readonly queue?: Queue<GithubWebhookJob>;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.configService.get<string>('WEBHOOK_QUEUE_ENABLED', 'true') !== 'false';
    if (!this.enabled) {
      return;
    }

    const redisUrl = this.configService.get<string>('REDIS_URL', 'redis://127.0.0.1:6379');
    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 1000,
      retryStrategy: () => null
    });
    this.queue = new Queue<GithubWebhookJob>(this.queueName, { connection: this.connection });
  }

  get isEnabled() {
    return this.enabled;
  }

  async enqueue(job: GithubWebhookJob): Promise<boolean> {
    if (!this.queue) {
      return false;
    }

    try {
      if (this.connection && this.connection.status === 'wait') {
        await this.connection.connect();
      }
      await this.queue.add('github-webhook', job, {
        jobId: job.deliveryId,
        removeOnComplete: 1000,
        removeOnFail: 1000
      });

      this.logger.log(`enqueued webhook delivery ${job.deliveryId} to queue ${this.queueName}`);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown queue error';
      this.logger.error(`failed to enqueue webhook delivery ${job.deliveryId}: ${message}`);
      return false;
    }
  }

  async onModuleDestroy() {
    if (this.queue) {
      await this.queue.close();
    }
    if (this.connection) {
      try {
        await this.connection.quit();
      } catch {
        this.connection.disconnect(false);
      }
    }
  }
}
