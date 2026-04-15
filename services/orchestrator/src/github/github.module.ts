import { Module } from '@nestjs/common';
import { GithubSideEffectsService } from './github-side-effects.service';

@Module({
  providers: [GithubSideEffectsService],
  exports: [GithubSideEffectsService]
})
export class GithubModule {}
