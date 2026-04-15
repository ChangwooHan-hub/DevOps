import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { RunnerController } from './runner.controller';
import { RunnerService } from './runner.service';

@Module({
  imports: [PersistenceModule],
  controllers: [RunnerController],
  providers: [RunnerService]
})
export class RunnerModule {}
