import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { WorkItemsModule } from '../work-items/work-items.module';
import { OrchestratorQueueService } from './orchestrator-queue.service';

@Module({
  imports: [GithubModule, PersistenceModule, WorkItemsModule],
  providers: [OrchestratorQueueService]
})
export class QueueModule {}
