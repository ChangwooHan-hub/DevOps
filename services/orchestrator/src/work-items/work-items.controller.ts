import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { WorkItemState } from '@uwb/domain';
import { WorkItemsService } from './work-items.service';

@Controller('work-items')
export class WorkItemsController {
  constructor(private readonly workItemsService: WorkItemsService) {}

  @Get()
  async list() {
    return this.workItemsService.list();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.workItemsService.getById(id);
  }

  @Get(':id/transitions')
  async listTransitions(@Param('id') id: string) {
    return this.workItemsService.listTransitions(id);
  }

  @Post()
  async create(
    @Body()
    body: {
      title: string;
      repositoryId: string;
      issueNumber: number;
      repository?: {
        fullName?: string;
        githubRepoId?: number;
        githubInstallationId?: number;
        defaultBranch?: string;
      };
    }
  ) {
    return this.workItemsService.createFromIssue({
      title: body.title,
      repositoryId: body.repositoryId,
      issueNumber: body.issueNumber,
      repository: body.repository
    });
  }

  @Patch(':id/state')
  async transition(
    @Param('id') id: string,
    @Body()
    body: {
      state: WorkItemState;
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string;
      reason?: string;
    }
  ) {
    return this.workItemsService.transition(id, body.state, {
      actorType: body.actorType ?? 'system',
      actorId: body.actorId ?? 'orchestrator',
      reason: body.reason
    });
  }
}
