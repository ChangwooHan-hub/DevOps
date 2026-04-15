import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApprovalsModule } from './approvals/approvals.module';
import { GithubModule } from './github/github.module';
import { HealthModule } from './health/health.module';
import { PersistenceModule } from './persistence/persistence.module';
import { QueueModule } from './queue/queue.module';
import { WorkItemsModule } from './work-items/work-items.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ApprovalsModule,
    GithubModule,
    HealthModule,
    PersistenceModule,
    QueueModule,
    WorkItemsModule
  ]
})
export class AppModule {}
