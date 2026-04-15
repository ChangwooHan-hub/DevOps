import { Body, Controller, Post } from '@nestjs/common';
import { RunnerBudget, RunnerService, ValidationCommand } from './runner.service';

@Controller('runner')
export class RunnerController {
  constructor(private readonly runnerService: RunnerService) {}

  @Post('execution-plans')
  createPlan(
    @Body()
    body: {
      repository: string;
      branchName: string;
      budget: RunnerBudget;
    }
  ) {
    return this.runnerService.createExecutionPlan(body);
  }

  @Post('executions')
  execute(
    @Body()
    body: {
      repository: string;
      branchName: string;
      budget: RunnerBudget;
      repositoryPath: string;
      dryRun?: boolean;
    }
  ) {
    return this.runnerService.executeRun(body);
  }

  @Post('validation-runs')
  validate(
    @Body()
    body: {
      repositoryPath: string;
      commands?: ValidationCommand[];
      timeoutSeconds?: number;
    }
  ) {
    return this.runnerService.runDeterministicValidation(body);
  }

  @Post('agent-runs')
  runCodingAgent(
    @Body()
    body: {
      repository: string;
      repositoryPath: string;
      taskPrompt: string;
      budget: RunnerBudget;
      workItemId?: string;
      model?: string;
      baseBranch?: string;
      branchName?: string;
      prBaseBranch?: string;
      openPullRequest?: boolean;
      draftPullRequest?: boolean;
      dryRun?: boolean;
      validationCommands?: ValidationCommand[];
      validationTimeoutSeconds?: number;
    }
  ): Promise<unknown> {
    return this.runnerService.runCodingAgent(body);
  }

  @Post('review-runs')
  runCodeReviewAgent(
    @Body()
    body: {
      repository: string;
      workItemId?: string;
      reviewPrompt: string;
      model?: string;
    }
  ): Promise<unknown> {
    return this.runnerService.runCodeReviewAgent(body);
  }

  @Post('merge-decision-runs')
  runMergeDecisionAgent(
    @Body()
    body: {
      repository: string;
      workItemId?: string;
      decisionPrompt: string;
      model?: string;
    }
  ): Promise<unknown> {
    return this.runnerService.runMergeDecisionAgent(body);
  }
}
