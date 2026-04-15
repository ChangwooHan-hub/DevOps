import { Body, Controller, Get, Post } from '@nestjs/common';
import { LlmService } from './llm.service';

@Controller('llm')
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Get('schemas')
  listSchemas() {
    return this.llmService.listSupportedSchemas();
  }

  @Post('structured-completions')
  createCompletion(
    @Body()
    body: {
      model: string;
      systemPrompt: string;
      userPrompt: string;
      schemaName: string;
    }
  ) {
    return this.llmService.createStructuredCompletion(body);
  }
}
