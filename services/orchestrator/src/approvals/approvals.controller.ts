import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApprovalAction, ApprovalActorType } from '@uwb/domain';
import { ApprovalsService } from './approvals.service';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Post()
  async append(
    @Body()
    body: {
      workItemId: string;
      subjectType: string;
      subjectId: string;
      action: ApprovalAction;
      actorType: ApprovalActorType;
      actorId: string;
      reason?: string;
    }
  ) {
    return this.approvalsService.append(body);
  }

  @Get(':workItemId')
  async list(@Param('workItemId') workItemId: string) {
    return this.approvalsService.listByWorkItem(workItemId);
  }
}
