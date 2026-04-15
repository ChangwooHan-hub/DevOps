import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

type LlmProvider = 'mock' | 'openai-compatible';
export type SupportedSchemaName =
  | 'triage_output'
  | 'planning_output'
  | 'review_output'
  | 'merge_readiness_output'
  | 'coding_patch_output';

interface StructuredCompletionInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
}

export interface StructuredCompletionOutput {
  model: string;
  schemaName: SupportedSchemaName;
  accepted: true;
  output: Record<string, unknown>;
  provider: LlmProvider;
  latencyMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface OpenAiCompatibleCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface SchemaContract {
  name: SupportedSchemaName;
  requiredFields: string[];
  schemaInstruction: string;
  validate: (value: Record<string, unknown>) => Record<string, unknown>;
  buildMockOutput: (userPrompt: string) => Record<string, unknown>;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly configService: ConfigService) {}

  async createStructuredCompletion(input: StructuredCompletionInput): Promise<StructuredCompletionOutput> {
    this.validateRequest(input);

    const contract = this.getSchemaContract(input.schemaName);
    const provider = this.getProvider();
    const startedAt = Date.now();

    if (provider === 'openai-compatible') {
      const remote = await this.requestOpenAiCompatibleCompletion(input, contract);
      const output = contract.validate(remote.output);

      return {
        model: input.model,
        schemaName: contract.name,
        accepted: true,
        output,
        provider,
        latencyMs: Date.now() - startedAt,
        usage: remote.usage
      };
    }

    const output = contract.validate(contract.buildMockOutput(input.userPrompt));

    return {
      model: input.model,
      schemaName: contract.name,
      accepted: true,
      output,
      provider,
      latencyMs: Date.now() - startedAt
    };
  }

  listSupportedSchemas() {
    return this.getAllSchemaContracts().map((contract) => ({
      schemaName: contract.name,
      requiredFields: contract.requiredFields
    }));
  }

  private validateRequest(input: StructuredCompletionInput) {
    if (!this.isNonEmptyString(input.model)) {
      throw new BadRequestException('model is required');
    }
    if (!this.isNonEmptyString(input.systemPrompt)) {
      throw new BadRequestException('systemPrompt is required');
    }
    if (!this.isNonEmptyString(input.userPrompt)) {
      throw new BadRequestException('userPrompt is required');
    }
    if (!this.isNonEmptyString(input.schemaName)) {
      throw new BadRequestException('schemaName is required');
    }
  }

  private getProvider(): LlmProvider {
    const provider = this.configService.get<string>('LLM_PROVIDER')?.trim().toLowerCase();
    if (provider === 'openai-compatible') {
      return provider;
    }
    return 'mock';
  }

  private getSchemaContract(schemaName: string): SchemaContract {
    const contracts = this.getAllSchemaContracts();
    const contract = contracts.find((entry) => entry.name === schemaName);
    if (!contract) {
      throw new BadRequestException(
        `unsupported schemaName: ${schemaName}. supported: ${contracts.map((entry) => entry.name).join(', ')}`
      );
    }
    return contract;
  }

  private getAllSchemaContracts(): SchemaContract[] {
    return [
      this.createTriageContract(),
      this.createPlanningContract(),
      this.createReviewContract(),
      this.createMergeReadinessContract(),
      this.createCodingPatchContract()
    ];
  }

  private createTriageContract(): SchemaContract {
    return {
      name: 'triage_output',
      requiredFields: ['summary', 'workType', 'impactAreas', 'suggestedLabels', 'nextAction'],
      schemaInstruction: [
        'Return JSON object with:',
        'summary: string',
        'workType: one of bug|feature|refactor',
        'impactAreas: string[]',
        'suggestedLabels: string[]',
        'nextAction: string'
      ].join('\n'),
      validate: (value) => {
        const workType = this.requireStringEnum(value, 'workType', ['bug', 'feature', 'refactor']);
        return {
          summary: this.requireString(value, 'summary'),
          workType,
          impactAreas: this.requireStringArray(value, 'impactAreas', true),
          suggestedLabels: this.requireStringArray(value, 'suggestedLabels', true),
          nextAction: this.requireString(value, 'nextAction')
        };
      },
      buildMockOutput: (userPrompt) => ({
        summary: `Issue triage draft for prompt: ${this.truncate(userPrompt, 96)}`,
        workType: 'bug',
        impactAreas: ['services/orchestrator', 'packages/domain'],
        suggestedLabels: ['type:bug', 'needs-triage'],
        nextAction: 'confirm labels and generate planning artifact'
      })
    };
  }

  private createPlanningContract(): SchemaContract {
    return {
      name: 'planning_output',
      requiredFields: [
        'summary',
        'branchName',
        'candidateFiles',
        'testPlan',
        'riskLevel',
        'executionBudget',
        'nextAction'
      ],
      schemaInstruction: [
        'Return JSON object with:',
        'summary: string',
        'branchName: string',
        'candidateFiles: string[]',
        'testPlan: string[]',
        'riskLevel: one of low|medium|high',
        'executionBudget: { maxRuntimeSeconds:number, maxChangedFiles:number, maxLocDelta:number, maxLlmCalls:number }',
        'nextAction: string'
      ].join('\n'),
      validate: (value) => {
        const executionBudget = this.requireObject(value, 'executionBudget');

        return {
          summary: this.requireString(value, 'summary'),
          branchName: this.requireString(value, 'branchName'),
          candidateFiles: this.requireStringArray(value, 'candidateFiles', true),
          testPlan: this.requireStringArray(value, 'testPlan', true),
          riskLevel: this.requireStringEnum(value, 'riskLevel', ['low', 'medium', 'high']),
          executionBudget: {
            maxRuntimeSeconds: this.requirePositiveInteger(executionBudget, 'maxRuntimeSeconds'),
            maxChangedFiles: this.requirePositiveInteger(executionBudget, 'maxChangedFiles'),
            maxLocDelta: this.requirePositiveInteger(executionBudget, 'maxLocDelta'),
            maxLlmCalls: this.requirePositiveInteger(executionBudget, 'maxLlmCalls')
          },
          nextAction: this.requireString(value, 'nextAction')
        };
      },
      buildMockOutput: (userPrompt) => ({
        summary: `Planning draft for prompt: ${this.truncate(userPrompt, 96)}`,
        branchName: 'agent/fix-token-refresh',
        candidateFiles: [
          'services/orchestrator/src/work-items/work-items.service.ts',
          'packages/domain/src/work-items/work-item.interface.ts'
        ],
        testPlan: ['Run unit tests for work-items module', 'Run full build'],
        riskLevel: 'medium',
        executionBudget: {
          maxRuntimeSeconds: 1200,
          maxChangedFiles: 6,
          maxLocDelta: 250,
          maxLlmCalls: 12
        },
        nextAction: 'request plan approval before dev execution'
      })
    };
  }

  private createReviewContract(): SchemaContract {
    return {
      name: 'review_output',
      requiredFields: ['summary', 'findings', 'blockingFindingsCount', 'nextAction'],
      schemaInstruction: [
        'Return JSON object with:',
        'summary: string',
        'findings: { severity:low|medium|high|critical, filePath:string, line:number, message:string }[]',
        'blockingFindingsCount: number',
        'nextAction: string'
      ].join('\n'),
      validate: (value) => {
        const findingsRaw = value.findings;
        if (!Array.isArray(findingsRaw)) {
          throw new ServiceUnavailableException('llm output is missing required array field: findings');
        }

        const findings = findingsRaw.map((finding, index) => {
          if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
            throw new ServiceUnavailableException(`llm output findings[${index}] must be an object`);
          }
          const findingRecord = finding as Record<string, unknown>;
          return {
            severity: this.requireStringEnum(findingRecord, 'severity', [
              'low',
              'medium',
              'high',
              'critical'
            ]),
            filePath: this.requireString(findingRecord, 'filePath'),
            line: this.requirePositiveInteger(findingRecord, 'line'),
            message: this.requireString(findingRecord, 'message')
          };
        });

        const blockingFindingsCount = this.requireNonNegativeInteger(value, 'blockingFindingsCount');
        if (blockingFindingsCount > findings.length) {
          throw new ServiceUnavailableException(
            'llm output blockingFindingsCount cannot exceed findings length'
          );
        }

        return {
          summary: this.requireString(value, 'summary'),
          findings,
          blockingFindingsCount,
          nextAction: this.requireString(value, 'nextAction')
        };
      },
      buildMockOutput: (userPrompt) => ({
        summary: `Review draft for prompt: ${this.truncate(userPrompt, 96)}`,
        findings: [
          {
            severity: 'medium',
            filePath: 'services/webhook-api/src/github/signature-verifier.service.ts',
            line: 8,
            message: 'Reject invalid signatures before processing payload.'
          }
        ],
        blockingFindingsCount: 0,
        nextAction: 'publish review summary and continue merge-readiness evaluation'
      })
    };
  }

  private createMergeReadinessContract(): SchemaContract {
    return {
      name: 'merge_readiness_output',
      requiredFields: [
        'mergeReady',
        'blockingReasons',
        'requiredApprovalsRemaining',
        'requiredChecksPending',
        'policyBlocks',
        'nextAction'
      ],
      schemaInstruction: [
        'Return JSON object with:',
        'mergeReady: boolean',
        'blockingReasons: string[]',
        'requiredApprovalsRemaining: number',
        'requiredChecksPending: string[]',
        'policyBlocks: string[]',
        'nextAction: string'
      ].join('\n'),
      validate: (value) => ({
        mergeReady: this.requireBoolean(value, 'mergeReady'),
        blockingReasons: this.requireStringArray(value, 'blockingReasons', false),
        requiredApprovalsRemaining: this.requireNonNegativeInteger(value, 'requiredApprovalsRemaining'),
        requiredChecksPending: this.requireStringArray(value, 'requiredChecksPending', false),
        policyBlocks: this.requireStringArray(value, 'policyBlocks', false),
        nextAction: this.requireString(value, 'nextAction')
      }),
      buildMockOutput: () => ({
        mergeReady: false,
        blockingReasons: ['Missing required human approval for final merge'],
        requiredApprovalsRemaining: 1,
        requiredChecksPending: [],
        policyBlocks: ['final-merge-approval-required'],
        nextAction: 'request final merge approval'
      })
    };
  }

  private createCodingPatchContract(): SchemaContract {
    return {
      name: 'coding_patch_output',
      requiredFields: ['summary', 'commitMessage', 'patch', 'prTitle', 'prBody', 'validationCommands'],
      schemaInstruction: [
        'Return JSON object with:',
        'summary: string',
        'commitMessage: string',
        'patch: string (valid unified git diff, no markdown fences)',
        'prTitle: string',
        'prBody: string',
        'validationCommands: string[]'
      ].join('\n'),
      validate: (value) => ({
        summary: this.requireString(value, 'summary'),
        commitMessage: this.requireString(value, 'commitMessage'),
        patch: this.requireString(value, 'patch'),
        prTitle: this.requireString(value, 'prTitle'),
        prBody: this.requireString(value, 'prBody'),
        validationCommands: this.requireStringArray(value, 'validationCommands', false)
      }),
      buildMockOutput: (userPrompt) => {
        const digest = createHash('sha256').update(userPrompt).digest('hex').slice(0, 8);
        const fileName = `AGENT_PATCH_${digest}.md`;
        const patch = [
          `diff --git a/${fileName} b/${fileName}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${fileName}`,
          '@@ -0,0 +1,6 @@',
          '+# Agent Patch Output',
          '+',
          `+Prompt digest: ${digest}`,
          '+',
          '+This file was generated by the mock coding patch schema.',
          '+Replace LLM_PROVIDER with openai-compatible for non-mock patch generation.'
        ].join('\n');

        return {
          summary: `Generated coding patch draft for prompt: ${this.truncate(userPrompt, 96)}`,
          commitMessage: `chore: apply agent patch ${digest}`,
          patch,
          prTitle: `Agent Patch ${digest}`,
          prBody: [
            '## Summary',
            'Applied an agent-generated patch.',
            '',
            '## Notes',
            '- Generated via llm-gateway coding_patch_output schema.',
            '- Provider: mock'
          ].join('\n'),
          validationCommands: []
        };
      }
    };
  }

  private async requestOpenAiCompatibleCompletion(
    input: StructuredCompletionInput,
    contract: SchemaContract
  ): Promise<{
    output: Record<string, unknown>;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  }> {
    const apiKey = this.configService.get<string>('LLM_API_KEY');
    if (!this.isNonEmptyString(apiKey)) {
      throw new ServiceUnavailableException('LLM_API_KEY is required for openai-compatible provider');
    }

    const baseUrl = this.configService.get<string>('LLM_API_BASE_URL')?.trim() ?? 'https://api.openai.com/v1';
    const timeoutMs = Number(this.configService.get<string>('LLM_REQUEST_TIMEOUT_MS') ?? 30000);
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: input.model,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `${input.systemPrompt}\n\nYou must respond with valid JSON only.`
            },
            {
              role: 'user',
              content: `${input.userPrompt}\n\nSchema contract:\n${contract.schemaInstruction}`
            }
          ]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const message = await response.text();
        this.logger.error(`provider request failed (${response.status}): ${message}`);
        throw new ServiceUnavailableException('failed to call llm provider');
      }

      const payload = (await response.json()) as OpenAiCompatibleCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (!this.isNonEmptyString(content)) {
        throw new ServiceUnavailableException('llm provider returned empty content');
      }

      const output = this.parseJsonObject(content);
      const usage = payload.usage
        ? {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens
          }
        : undefined;

      return { output, usage };
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown provider error';
      this.logger.error(`provider request threw an exception: ${message}`);
      throw new ServiceUnavailableException('failed to call llm provider');
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private parseJsonObject(raw: string): Record<string, unknown> {
    const content = raw.trim();
    const normalized = content.startsWith('```')
      ? content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      : content;

    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized);
    } catch {
      throw new ServiceUnavailableException('llm provider returned non-json content');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ServiceUnavailableException('llm provider returned invalid json object');
    }

    return parsed as Record<string, unknown>;
  }

  private requireObject(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ServiceUnavailableException(`llm output is missing required object field: ${key}`);
    }
    return value as Record<string, unknown>;
  }

  private requireString(source: Record<string, unknown>, key: string): string {
    const value = source[key];
    if (!this.isNonEmptyString(value)) {
      throw new ServiceUnavailableException(`llm output is missing required field: ${key}`);
    }
    return value;
  }

  private requireBoolean(source: Record<string, unknown>, key: string): boolean {
    const value = source[key];
    if (typeof value !== 'boolean') {
      throw new ServiceUnavailableException(`llm output is missing required boolean field: ${key}`);
    }
    return value;
  }

  private requireStringEnum(
    source: Record<string, unknown>,
    key: string,
    supportedValues: string[]
  ): string {
    const value = this.requireString(source, key);
    if (!supportedValues.includes(value)) {
      throw new ServiceUnavailableException(
        `llm output field ${key} must be one of: ${supportedValues.join(', ')}`
      );
    }
    return value;
  }

  private requireStringArray(
    source: Record<string, unknown>,
    key: string,
    requireNonEmpty: boolean
  ): string[] {
    const value = source[key];
    if (!Array.isArray(value)) {
      throw new ServiceUnavailableException(`llm output is missing required array field: ${key}`);
    }

    const items = value.filter((item): item is string => this.isNonEmptyString(item));
    if (items.length !== value.length) {
      throw new ServiceUnavailableException(`llm output field ${key} must be string[]`);
    }
    if (requireNonEmpty && items.length === 0) {
      throw new ServiceUnavailableException(`llm output field ${key} must not be empty`);
    }
    return items;
  }

  private requirePositiveInteger(source: Record<string, unknown>, key: string): number {
    const value = source[key];
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new ServiceUnavailableException(`llm output field ${key} must be a positive integer`);
    }
    return value as number;
  }

  private requireNonNegativeInteger(source: Record<string, unknown>, key: string): number {
    const value = source[key];
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new ServiceUnavailableException(`llm output field ${key} must be a non-negative integer`);
    }
    return value as number;
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}
