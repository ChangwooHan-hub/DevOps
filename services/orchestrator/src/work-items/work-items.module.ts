import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { RunnerTriggerService } from './runner-trigger.service';
import { WorkItemsController } from './work-items.controller';
import { WorkItemsService } from './work-items.service';

@Module({
  imports: [PersistenceModule],
  controllers: [WorkItemsController],
  providers: [WorkItemsService, RunnerTriggerService],
  exports: [WorkItemsService]
})
export class WorkItemsModule {}
