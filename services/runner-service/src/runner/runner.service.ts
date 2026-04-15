import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { PostgresService } from '../persistence/postgres.service';

const execFileAsync = promisify(execFile);

export interface RunnerBudget {
  maxRuntimeSeconds: number;
  maxChangedFiles: number;
  maxLocDelta: number;
  maxLlmCalls: number;
}

export interface ValidationCommand {
  name: string;
  command: string;
}

interface PlanningOutput {
  summary: string;
  branchName: string;
  candidateFiles: string[];
  testPlan: string[];
  riskLevel: 'low' | 'medium' | 'high';
  executionBudget: RunnerBudget;
  nextAction: string;
}

interface CodingPatchOutput {
  summary: string;
  commitMessage: string;
  patch: string;
  prTitle: string;
  prBody: string;
  validationCommands: string[];
}

interface ReviewFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  filePath: string;
  line: number;
  message: string;
}

interface ReviewOutput {
  summary: string;
  findings: ReviewFinding[];
  blockingFindingsCount: number;
  nextAction: string;
}

interface MergeReadinessOutput {
  mergeReady: boolean;
  blockingReasons: string[];
  requiredApprovalsRemaining: number;
  requiredChecksPending: string[];
  policyBlocks: string[];
  nextAction: string;
}

type AgentRole = 'planning_agent' | 'coding_agent' | 'code_review_agent' | 'merge_decision_agent';

interface LlmStructuredCompletionResponse {
  accepted?: boolean;
  output?: Record<string, unknown>;
  provider?: string;
  latencyMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly postgresService: PostgresService
  ) {}

  createExecutionPlan(input: {
    repository: string;
    branchName: string;
    budget: RunnerBudget;
  }) {
    this.validateBudget(input.budget);

    return {
      repository: input.repository,
      branchName: input.branchName,
      budget: input.budget,
      executionMode: 'ephemeral',
      nextSteps: [
        'clone repository',
        'checkout base branch',
        'create agent branch',
        'apply patch',
        'run validation subset',
        'commit and push'
      ]
    };
  }

  async executeRun(input: {
    repository: string;
    branchName: string;
    budget: RunnerBudget;
    repositoryPath: string;
    dryRun?: boolean;
  }) {
    this.validateBudget(input.budget);
    if (!input.repositoryPath) {
      throw new BadRequestException('repositoryPath is required');
    }

    const plan = this.createExecutionPlan({
      repository: input.repository,
      branchName: input.branchName,
      budget: input.budget
    });

    if (input.dryRun ?? true) {
      return {
        ...plan,
        dryRun: true,
        executed: false
      };
    }

    const timeoutMs = input.budget.maxRuntimeSeconds * 1000;
    await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], input.repositoryPath, timeoutMs);
    await this.runCommand('git', ['checkout', '-B', input.branchName], input.repositoryPath, timeoutMs);

    return {
      ...plan,
      dryRun: false,
      executed: true,
      result: 'branch prepared; patch application delegated to orchestrator pipeline'
    };
  }

  async runCodingAgent(input: {
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
  }) {
    this.validateBudget(input.budget);

    const repository = this.requireNonEmptyString(input.repository, 'repository');
    const repositoryPath = this.requireNonEmptyString(input.repositoryPath, 'repositoryPath');
    const taskPrompt = this.requireNonEmptyString(input.taskPrompt, 'taskPrompt');
    const baseBranch = this.normalizeBranchName(input.baseBranch ?? 'main');
    const model = this.configService.get<string>('AGENT_DEFAULT_MODEL', input.model ?? 'gpt-5.4');
    const openPullRequest = input.openPullRequest ?? true;
    const draftPullRequest = input.draftPullRequest ?? true;
    const dryRun = input.dryRun ?? false;
    const prBaseBranch = this.normalizeBranchName(input.prBaseBranch ?? baseBranch);
    const llmCallBudget = input.budget.maxLlmCalls;
    const provider = this.configService.get<string>('LLM_PROVIDER', 'mock').trim().toLowerCase();
    const allowMockExecution =
      this.configService.get<string>('RUNNER_ALLOW_MOCK_EXECUTION', 'false').trim().toLowerCase() === 'true';

    if (!dryRun && provider === 'mock' && !allowMockExecution) {
      throw new BadRequestException(
        'LLM_PROVIDER=mock cannot execute real coding runs. Set LLM_PROVIDER=openai-compatible and LLM_API_KEY, or set RUNNER_ALLOW_MOCK_EXECUTION=true explicitly.'
      );
    }

    if (llmCallBudget < 2) {
      throw new BadRequestException('maxLlmCalls must be at least 2 for planning + coding patch generation');
    }

    const startedAt = new Date().toISOString();
    let actualLlmCalls = 0;
    const planningAgentInstruction = await this.loadAgentRoleInstruction('planning_agent');
    const codingAgentInstruction = await this.loadAgentRoleInstruction('coding_agent');

    const planningRaw = await this.requestStructuredCompletion({
      model,
      schemaName: 'planning_output',
      systemPrompt: this.withAgentInstruction(
        'You are a senior software planning agent. Return a precise, bounded plan with realistic execution budget.',
        planningAgentInstruction
      ),
      userPrompt: this.buildPlanningPrompt(repository, taskPrompt, input.budget)
    });
    actualLlmCalls += 1;
    const planning = this.mapPlanningOutput(planningRaw);

    const branchName = this.normalizeBranchName(
      input.branchName ?? planning.branchName ?? `agent/run-${Date.now()}`
    );

    const codingRaw = await this.requestStructuredCompletion({
      model,
      schemaName: 'coding_patch_output',
      systemPrompt: this.withAgentInstruction(
        [
          'You are a coding agent that writes safe, minimal patches.',
          'Return a valid unified git diff in the patch field.',
          'Do not include markdown code fences around patch.'
        ].join('\n'),
        codingAgentInstruction
      ),
      userPrompt: this.buildCodingPrompt(repository, taskPrompt, branchName, planning)
    });
    actualLlmCalls += 1;
    const coding = this.mapCodingPatchOutput(codingRaw);

    if (actualLlmCalls > llmCallBudget) {
      throw new BadRequestException(`llm call budget exceeded: ${actualLlmCalls}/${llmCallBudget}`);
    }

    if (dryRun) {
      return {
        startedAt,
        mode: 'dry-run',
        repository,
        repositoryPath,
        baseBranch,
        branchName,
        planning,
        codingPreview: {
          summary: coding.summary,
          commitMessage: coding.commitMessage,
          prTitle: coding.prTitle,
          patchBytes: Buffer.byteLength(coding.patch, 'utf8')
        },
        actualLlmCalls
      };
    }

    const timeoutMs = input.budget.maxRuntimeSeconds * 1000;
    const runId = await this.startAgentRunRecord({
      workItemId: input.workItemId,
      agentType: 'dev',
      budget: input.budget
    });

    const patchPath = path.join(os.tmpdir(), `uwb-agent-${randomUUID()}.patch`);
    let changedFiles = 0;
    let locDelta = 0;
    let validationResult: Awaited<ReturnType<RunnerService['runDeterministicValidation']>> | undefined;

    try {
      await this.prepareBranch(repositoryPath, baseBranch, branchName, timeoutMs);

      const normalizedPatch = coding.patch.endsWith('\n') ? coding.patch : `${coding.patch}\n`;
      await fs.writeFile(patchPath, normalizedPatch, 'utf8');
      await this.runCommand('git', ['apply', '--whitespace=nowarn', patchPath], repositoryPath, timeoutMs);
      await this.runCommand('git', ['add', '-A'], repositoryPath, timeoutMs);

      const diffStats = await this.collectStagedDiffStats(repositoryPath, timeoutMs);
      changedFiles = diffStats.changedFiles;
      locDelta = diffStats.locDelta;

      if (changedFiles === 0) {
        throw new BadRequestException('generated patch produced no staged file changes');
      }
      if (changedFiles > input.budget.maxChangedFiles) {
        throw new BadRequestException(
          `changed file budget exceeded: ${changedFiles}/${input.budget.maxChangedFiles}`
        );
      }
      if (locDelta > input.budget.maxLocDelta) {
        throw new BadRequestException(`loc delta budget exceeded: ${locDelta}/${input.budget.maxLocDelta}`);
      }

      const validationCommands = this.resolveValidationCommands(input.validationCommands, coding.validationCommands);
      if (validationCommands.length > 0) {
        validationResult = await this.runDeterministicValidation({
          repositoryPath,
          commands: validationCommands,
          timeoutSeconds: input.validationTimeoutSeconds
        });
        if (validationResult && !validationResult.passed) {
          throw new BadRequestException('validation failed before commit/push');
        }
      }

      await this.runCommand(
        'git',
        ['commit', '-m', this.normalizeCommitMessage(coding.commitMessage)],
        repositoryPath,
        timeoutMs
      );
      await this.runCommand('git', ['push', '-u', 'origin', branchName], repositoryPath, timeoutMs);

      let pullRequest:
        | {
            number: number;
            url: string;
            state: string;
            draft: boolean;
          }
        | undefined;
      if (openPullRequest) {
        pullRequest = await this.createPullRequest({
          repository,
          headBranch: branchName,
          baseBranch: prBaseBranch,
          title: coding.prTitle,
          body: coding.prBody,
          draft: draftPullRequest
        });
      }

      await this.completeAgentRunRecord({
        runId,
        status: 'completed',
        actualLlmCalls,
        changedFiles,
        locDelta
      });

      return {
        startedAt,
        completedAt: new Date().toISOString(),
        mode: 'executed',
        runId,
        repository,
        repositoryPath,
        baseBranch,
        branchName,
        planning,
        coding: {
          summary: coding.summary,
          commitMessage: coding.commitMessage,
          prTitle: coding.prTitle
        },
        actualLlmCalls,
        changedFiles,
        locDelta,
        validation: validationResult ?? { passed: true, skipped: true },
        pullRequest
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown runner failure';
      await this.completeAgentRunRecord({
        runId,
        status: 'failed',
        actualLlmCalls,
        changedFiles,
        locDelta,
        errorMessage: message
      });
      throw new BadRequestException(`agent run failed: ${message}`);
    } finally {
      await fs.unlink(patchPath).catch(() => undefined);
    }
  }

  async runCodeReviewAgent(input: {
    repository: string;
    workItemId?: string;
    reviewPrompt: string;
    model?: string;
  }) {
    const repository = this.requireRepositorySlug(input.repository);
    const reviewPrompt = this.requireNonEmptyString(input.reviewPrompt, 'reviewPrompt');
    const model = this.configService.get<string>('AGENT_DEFAULT_MODEL', input.model ?? 'gpt-5.4');
    const startedAt = new Date().toISOString();
    const reviewAgentInstruction = await this.loadAgentRoleInstruction('code_review_agent');

    const runId = await this.startAgentRunRecord({
      workItemId: input.workItemId,
      agentType: 'review'
    });

    try {
      const reviewRaw = await this.requestStructuredCompletion({
        model,
        schemaName: 'review_output',
        systemPrompt: this.withAgentInstruction(
          'You are a rigorous code review agent. Identify concrete findings and classify severity accurately.',
          reviewAgentInstruction
        ),
        userPrompt: this.buildReviewPrompt(repository, reviewPrompt)
      });
      const review = this.mapReviewOutput(reviewRaw);

      await this.completeAgentRunRecord({
        runId,
        status: 'completed',
        actualLlmCalls: 1,
        changedFiles: 0,
        locDelta: 0
      });

      return {
        startedAt,
        completedAt: new Date().toISOString(),
        mode: 'executed',
        runId,
        repository,
        review
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown code review agent failure';
      await this.completeAgentRunRecord({
        runId,
        status: 'failed',
        actualLlmCalls: 0,
        changedFiles: 0,
        locDelta: 0,
        errorMessage: message
      });
      throw new BadRequestException(`code review agent failed: ${message}`);
    }
  }

  async runMergeDecisionAgent(input: {
    repository: string;
    workItemId?: string;
    decisionPrompt: string;
    model?: string;
  }) {
    const repository = this.requireRepositorySlug(input.repository);
    const decisionPrompt = this.requireNonEmptyString(input.decisionPrompt, 'decisionPrompt');
    const model = this.configService.get<string>('AGENT_DEFAULT_MODEL', input.model ?? 'gpt-5.4');
    const startedAt = new Date().toISOString();
    const mergeDecisionInstruction = await this.loadAgentRoleInstruction('merge_decision_agent');

    const runId = await this.startAgentRunRecord({
      workItemId: input.workItemId,
      agentType: 'merge_readiness'
    });

    try {
      const decisionRaw = await this.requestStructuredCompletion({
        model,
        schemaName: 'merge_readiness_output',
        systemPrompt: this.withAgentInstruction(
          'You are a merge decision agent. Decide merge readiness based on approvals, checks, and policy constraints.',
          mergeDecisionInstruction
        ),
        userPrompt: this.buildMergeDecisionPrompt(repository, decisionPrompt)
      });
      const decision = this.mapMergeReadinessOutput(decisionRaw);

      await this.completeAgentRunRecord({
        runId,
        status: 'completed',
        actualLlmCalls: 1,
        changedFiles: 0,
        locDelta: 0
      });

      return {
        startedAt,
        completedAt: new Date().toISOString(),
        mode: 'executed',
        runId,
        repository,
        decision
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown merge decision agent failure';
      await this.completeAgentRunRecord({
        runId,
        status: 'failed',
        actualLlmCalls: 0,
        changedFiles: 0,
        locDelta: 0,
        errorMessage: message
      });
      throw new BadRequestException(`merge decision agent failed: ${message}`);
    }
  }

  async runDeterministicValidation(input: {
    repositoryPath: string;
    commands?: ValidationCommand[];
    timeoutSeconds?: number;
  }) {
    if (!input.repositoryPath) {
      throw new BadRequestException('repositoryPath is required');
    }

    const timeoutSeconds = input.timeoutSeconds ?? Number(this.configService.get('VALIDATION_TIMEOUT_SECONDS', 900));
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new BadRequestException('timeoutSeconds must be a positive integer');
    }

    const commands = input.commands?.length
      ? input.commands
      : this.getDefaultValidationCommands();

    const results: Array<{
      name: string;
      command: string;
      passed: boolean;
      stdout: string;
      stderr: string;
      durationMs: number;
      exitCode?: number;
    }> = [];

    for (const command of commands) {
      const startedAt = Date.now();
      try {
        const { stdout, stderr } = await this.runShellCommand(
          command.command,
          input.repositoryPath,
          timeoutSeconds * 1000
        );
        results.push({
          name: command.name,
          command: command.command,
          passed: true,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt
        });
      } catch (error: unknown) {
        const normalized = this.normalizeCommandError(error);
        results.push({
          name: command.name,
          command: command.command,
          passed: false,
          stdout: normalized.stdout,
          stderr: normalized.stderr,
          durationMs: Date.now() - startedAt,
          exitCode: normalized.exitCode
        });
        break;
      }
    }

    const passed = results.every((result) => result.passed);
    return {
      passed,
      mode: 'deterministic',
      timeoutSeconds,
      commands: results
    };
  }

  private getDefaultValidationCommands(): ValidationCommand[] {
    return [
      { name: 'lint', command: this.configService.get<string>('VALIDATION_LINT_COMMAND', 'cmd /c npm.cmd run lint') },
      {
        name: 'typecheck',
        command: this.configService.get<string>('VALIDATION_TYPECHECK_COMMAND', 'cmd /c npm.cmd run build')
      },
      { name: 'test', command: this.configService.get<string>('VALIDATION_TEST_COMMAND', 'cmd /c npm.cmd test') }
    ];
  }

  private validateBudget(budget: RunnerBudget) {
    const {
      maxRuntimeSeconds,
      maxChangedFiles,
      maxLocDelta,
      maxLlmCalls
    } = budget;

    const values = [
      { key: 'maxRuntimeSeconds', value: maxRuntimeSeconds },
      { key: 'maxChangedFiles', value: maxChangedFiles },
      { key: 'maxLocDelta', value: maxLocDelta },
      { key: 'maxLlmCalls', value: maxLlmCalls }
    ];
    for (const item of values) {
      if (!Number.isInteger(item.value) || item.value <= 0) {
        throw new BadRequestException(`${item.key} must be a positive integer`);
      }
    }

    const policy = {
      maxRuntimeSeconds: Number(this.configService.get('RUNNER_MAX_RUNTIME_SECONDS', 3600)),
      maxChangedFiles: Number(this.configService.get('RUNNER_MAX_CHANGED_FILES', 50)),
      maxLocDelta: Number(this.configService.get('RUNNER_MAX_LOC_DELTA', 2000)),
      maxLlmCalls: Number(this.configService.get('RUNNER_MAX_LLM_CALLS', 100))
    };

    if (maxRuntimeSeconds > policy.maxRuntimeSeconds) {
      throw new BadRequestException(`maxRuntimeSeconds exceeds policy limit ${policy.maxRuntimeSeconds}`);
    }
    if (maxChangedFiles > policy.maxChangedFiles) {
      throw new BadRequestException(`maxChangedFiles exceeds policy limit ${policy.maxChangedFiles}`);
    }
    if (maxLocDelta > policy.maxLocDelta) {
      throw new BadRequestException(`maxLocDelta exceeds policy limit ${policy.maxLocDelta}`);
    }
    if (maxLlmCalls > policy.maxLlmCalls) {
      throw new BadRequestException(`maxLlmCalls exceeds policy limit ${policy.maxLlmCalls}`);
    }
  }

  private async runCommand(command: string, args: string[], cwd: string, timeoutMs: number) {
    await this.runCommandWithOutput(command, args, cwd, timeoutMs);
  }

  private async runCommandWithOutput(command: string, args: string[], cwd: string, timeoutMs: number) {
    return execFileAsync(command, args, {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 32
    });
  }

  private async runShellCommand(command: string, cwd: string, timeoutMs: number) {
    return execFileAsync('cmd.exe', ['/c', command], {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 16
    });
  }

  private normalizeCommandError(error: unknown): {
    stdout: string;
    stderr: string;
    exitCode?: number;
  } {
    if (
      error &&
      typeof error === 'object' &&
      'stdout' in error &&
      'stderr' in error
    ) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: typeof err.code === 'number' ? err.code : undefined
      };
    }
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : 'unknown command error'
    };
  }

  private async prepareBranch(repositoryPath: string, baseBranch: string, branchName: string, timeoutMs: number) {
    await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], repositoryPath, timeoutMs);
    await this.runCommand('git', ['fetch', 'origin', baseBranch], repositoryPath, timeoutMs);
    await this.runCommand('git', ['checkout', '-B', branchName, `origin/${baseBranch}`], repositoryPath, timeoutMs);
  }

  private async collectStagedDiffStats(repositoryPath: string, timeoutMs: number): Promise<{
    changedFiles: number;
    locDelta: number;
  }> {
    const { stdout: fileStdout } = await this.runCommandWithOutput(
      'git',
      ['diff', '--cached', '--name-only'],
      repositoryPath,
      timeoutMs
    );
    const changedFiles = fileStdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;

    const { stdout: numStatStdout } = await this.runCommandWithOutput(
      'git',
      ['diff', '--cached', '--numstat'],
      repositoryPath,
      timeoutMs
    );

    let locDelta = 0;
    const rows = numStatStdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const row of rows) {
      const [added, removed] = row.split(/\s+/g);
      const parsedAdded = Number.parseInt(added, 10);
      const parsedRemoved = Number.parseInt(removed, 10);
      if (!Number.isNaN(parsedAdded)) {
        locDelta += parsedAdded;
      }
      if (!Number.isNaN(parsedRemoved)) {
        locDelta += parsedRemoved;
      }
    }

    return { changedFiles, locDelta };
  }

  private async requestStructuredCompletion(input: {
    model: string;
    schemaName:
      | 'planning_output'
      | 'coding_patch_output'
      | 'review_output'
      | 'merge_readiness_output';
    systemPrompt: string;
    userPrompt: string;
  }): Promise<Record<string, unknown>> {
    const baseUrl = this.configService.get<string>('LLM_GATEWAY_URL', 'http://127.0.0.1:3003');
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/llm/structured-completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`llm-gateway request failed (${response.status}): ${body}`);
      throw new ServiceUnavailableException('failed to call llm-gateway');
    }

    const payload = (await response.json()) as LlmStructuredCompletionResponse;
    if (!payload.accepted || !payload.output || typeof payload.output !== 'object' || Array.isArray(payload.output)) {
      throw new ServiceUnavailableException('llm-gateway returned invalid structured completion payload');
    }
    return payload.output;
  }

  private mapPlanningOutput(value: Record<string, unknown>): PlanningOutput {
    return {
      summary: this.requireObjectString(value, 'summary'),
      branchName: this.requireObjectString(value, 'branchName'),
      candidateFiles: this.requireObjectStringArray(value, 'candidateFiles'),
      testPlan: this.requireObjectStringArray(value, 'testPlan'),
      riskLevel: this.requireObjectStringEnum(value, 'riskLevel', ['low', 'medium', 'high']) as
        | 'low'
        | 'medium'
        | 'high',
      executionBudget: this.mapExecutionBudget(value.executionBudget),
      nextAction: this.requireObjectString(value, 'nextAction')
    };
  }

  private mapCodingPatchOutput(value: Record<string, unknown>): CodingPatchOutput {
    return {
      summary: this.requireObjectString(value, 'summary'),
      commitMessage: this.requireObjectString(value, 'commitMessage'),
      patch: this.requireObjectString(value, 'patch'),
      prTitle: this.requireObjectString(value, 'prTitle'),
      prBody: this.requireObjectString(value, 'prBody'),
      validationCommands: this.requireObjectStringArray(value, 'validationCommands', false)
    };
  }

  private mapReviewOutput(value: Record<string, unknown>): ReviewOutput {
    return {
      summary: this.requireObjectString(value, 'summary'),
      findings: this.requireReviewFindings(value),
      blockingFindingsCount: this.requireNonNegativeInteger(value, 'blockingFindingsCount'),
      nextAction: this.requireObjectString(value, 'nextAction')
    };
  }

  private mapMergeReadinessOutput(value: Record<string, unknown>): MergeReadinessOutput {
    return {
      mergeReady: this.requireObjectBoolean(value, 'mergeReady'),
      blockingReasons: this.requireObjectStringArray(value, 'blockingReasons', false),
      requiredApprovalsRemaining: this.requireNonNegativeInteger(value, 'requiredApprovalsRemaining'),
      requiredChecksPending: this.requireObjectStringArray(value, 'requiredChecksPending', false),
      policyBlocks: this.requireObjectStringArray(value, 'policyBlocks', false),
      nextAction: this.requireObjectString(value, 'nextAction')
    };
  }

  private requireReviewFindings(source: Record<string, unknown>): ReviewFinding[] {
    const raw = source.findings;
    if (!Array.isArray(raw)) {
      throw new ServiceUnavailableException('llm output field findings must be an array');
    }
    return raw.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new ServiceUnavailableException(`llm output findings[${index}] must be an object`);
      }
      const finding = item as Record<string, unknown>;
      return {
        severity: this.requireObjectStringEnum(finding, 'severity', [
          'low',
          'medium',
          'high',
          'critical'
        ]) as ReviewFinding['severity'],
        filePath: this.requireObjectString(finding, 'filePath'),
        line: this.requirePositiveInteger(finding, 'line'),
        message: this.requireObjectString(finding, 'message')
      };
    });
  }

  private mapExecutionBudget(value: unknown): RunnerBudget {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ServiceUnavailableException('llm planning output executionBudget is invalid');
    }
    const budget = value as Record<string, unknown>;
    return {
      maxRuntimeSeconds: this.requirePositiveInteger(budget, 'maxRuntimeSeconds'),
      maxChangedFiles: this.requirePositiveInteger(budget, 'maxChangedFiles'),
      maxLocDelta: this.requirePositiveInteger(budget, 'maxLocDelta'),
      maxLlmCalls: this.requirePositiveInteger(budget, 'maxLlmCalls')
    };
  }

  private buildPlanningPrompt(repository: string, taskPrompt: string, budget: RunnerBudget): string {
    return [
      `Repository: ${repository}`,
      'Task:',
      taskPrompt,
      '',
      'Execution budget limits:',
      `maxRuntimeSeconds=${budget.maxRuntimeSeconds}`,
      `maxChangedFiles=${budget.maxChangedFiles}`,
      `maxLocDelta=${budget.maxLocDelta}`,
      `maxLlmCalls=${budget.maxLlmCalls}`,
      '',
      'Return a practical implementation plan constrained by these limits.'
    ].join('\n');
  }

  private buildCodingPrompt(
    repository: string,
    taskPrompt: string,
    branchName: string,
    planning: PlanningOutput
  ): string {
    return [
      `Repository: ${repository}`,
      `Target branch: ${branchName}`,
      'Task:',
      taskPrompt,
      '',
      'Planning summary:',
      planning.summary,
      '',
      `Candidate files: ${planning.candidateFiles.join(', ')}`,
      `Suggested tests: ${planning.testPlan.join(' | ')}`,
      '',
      'Generate a single valid unified git diff patch implementing the task.',
      'Patch must be minimal and deterministic.'
    ].join('\n');
  }

  private buildReviewPrompt(repository: string, reviewPrompt: string): string {
    return [
      `Repository: ${repository}`,
      'Review scope:',
      reviewPrompt,
      '',
      'Return review_output with concrete findings and precise severities.'
    ].join('\n');
  }

  private buildMergeDecisionPrompt(repository: string, decisionPrompt: string): string {
    return [
      `Repository: ${repository}`,
      'Merge decision context:',
      decisionPrompt,
      '',
      'Return merge_readiness_output with explicit blocking reasons and next action.'
    ].join('\n');
  }

  private withAgentInstruction(baseSystemPrompt: string, agentInstruction: string): string {
    if (!agentInstruction) {
      return baseSystemPrompt;
    }
    return `${baseSystemPrompt}\n\n[agents.md role instruction]\n${agentInstruction}`;
  }

  private async loadAgentRoleInstruction(role: AgentRole): Promise<string> {
    const specPath = path.resolve(this.configService.get<string>('AGENTS_SPEC_PATH', 'agents.md'));
    const required = this.configService.get<string>('AGENTS_SPEC_REQUIRED', 'true').trim().toLowerCase() !== 'false';

    let content: string;
    try {
      content = await fs.readFile(specPath, 'utf8');
    } catch (error: unknown) {
      if (!required) {
        return '';
      }
      const message = error instanceof Error ? error.message : 'unknown file read error';
      throw new ServiceUnavailableException(`failed to read agents spec file ${specPath}: ${message}`);
    }

    const trimmed = content.trim();
    if (!trimmed) {
      if (!required) {
        return '';
      }
      throw new ServiceUnavailableException(`agents spec file is empty: ${specPath}`);
    }

    const sections = this.parseAgentSections(trimmed);
    const section = sections.get(role);
    if (!section || section.trim().length === 0) {
      if (!required) {
        return '';
      }
      throw new ServiceUnavailableException(`agents spec role section missing: ${role}`);
    }

    return section.trim();
  }

  private parseAgentSections(markdown: string): Map<string, string> {
    const sections = new Map<string, string>();
    const lines = markdown.split(/\r?\n/g);
    let currentRole: string | undefined;
    let buffer: string[] = [];

    const flush = () => {
      if (!currentRole) {
        return;
      }
      sections.set(currentRole, buffer.join('\n').trim());
      buffer = [];
    };

    for (const line of lines) {
      const heading = line.match(/^##\s+([A-Za-z0-9_-]+)\s*$/);
      if (heading) {
        flush();
        currentRole = heading[1].trim().toLowerCase();
        continue;
      }
      if (currentRole) {
        buffer.push(line);
      }
    }

    flush();
    return sections;
  }

  private resolveValidationCommands(
    explicit: ValidationCommand[] | undefined,
    llmCommands: string[]
  ): ValidationCommand[] {
    if (explicit?.length) {
      return explicit;
    }
    if (llmCommands.length === 0) {
      return [];
    }

    return llmCommands.map((command, index) => ({
      name: `llm-validation-${index + 1}`,
      command
    }));
  }

  private normalizeBranchName(value: string): string {
    const normalized = value
      .trim()
      .replace(/\\/g, '/')
      .replace(/[^A-Za-z0-9/_-]+/g, '-')
      .replace(/\/{2,}/g, '/')
      .replace(/^-+/, '')
      .replace(/-+$/, '');

    if (!normalized) {
      throw new BadRequestException('branchName must contain at least one alphanumeric character');
    }
    return normalized;
  }

  private normalizeCommitMessage(value: string): string {
    const normalized = value.trim().replace(/\r?\n/g, ' ');
    return normalized.length > 0 ? normalized : 'chore: apply agent-generated patch';
  }

  private async createPullRequest(input: {
    repository: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{
    number: number;
    url: string;
    state: string;
    draft: boolean;
  }> {
    const token =
      this.configService.get<string>('GITHUB_TOKEN') ?? this.configService.get<string>('GH_TOKEN');
    if (!token) {
      throw new BadRequestException('GITHUB_TOKEN (or GH_TOKEN) is required to create pull requests');
    }

    const repository = this.requireRepositorySlug(input.repository);
    const response = await fetch(`https://api.github.com/repos/${repository}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'uwb-runner-service',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
        draft: input.draft
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new BadRequestException(`failed to create pull request: ${response.status} ${body}`);
    }

    const payload = (await response.json()) as {
      number?: number;
      html_url?: string;
      state?: string;
      draft?: boolean;
    };
    if (!payload.number || !payload.html_url || !payload.state || typeof payload.draft !== 'boolean') {
      throw new BadRequestException('github returned invalid pull request payload');
    }

    return {
      number: payload.number,
      url: payload.html_url,
      state: payload.state,
      draft: payload.draft
    };
  }

  private requireRepositorySlug(value: string): string {
    const normalized = value.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
      throw new BadRequestException('repository must be in owner/repo format');
    }
    return normalized;
  }

  private requireNonEmptyString(value: string | undefined, key: string): string {
    if (!value || value.trim().length === 0) {
      throw new BadRequestException(`${key} is required`);
    }
    return value.trim();
  }

  private requireObjectString(source: Record<string, unknown>, key: string): string {
    const value = source[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ServiceUnavailableException(`llm output field ${key} must be a non-empty string`);
    }
    return value.trim();
  }

  private requireObjectStringArray(
    source: Record<string, unknown>,
    key: string,
    requireNonEmpty = true
  ): string[] {
    const value = source[key];
    if (!Array.isArray(value)) {
      throw new ServiceUnavailableException(`llm output field ${key} must be string[]`);
    }
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (items.length !== value.length) {
      throw new ServiceUnavailableException(`llm output field ${key} must be string[]`);
    }
    if (requireNonEmpty && items.length === 0) {
      throw new ServiceUnavailableException(`llm output field ${key} must not be empty`);
    }
    return items;
  }

  private requireObjectStringEnum(
    source: Record<string, unknown>,
    key: string,
    supportedValues: string[]
  ): string {
    const value = this.requireObjectString(source, key);
    if (!supportedValues.includes(value)) {
      throw new ServiceUnavailableException(`llm output field ${key} must be one of ${supportedValues.join(', ')}`);
    }
    return value;
  }

  private requireObjectBoolean(source: Record<string, unknown>, key: string): boolean {
    const value = source[key];
    if (typeof value !== 'boolean') {
      throw new ServiceUnavailableException(`llm output field ${key} must be a boolean`);
    }
    return value;
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

  private async startAgentRunRecord(input: {
    workItemId?: string;
    agentType: 'dev' | 'review' | 'merge_readiness';
    budget?: RunnerBudget;
  }): Promise<string | undefined> {
    if (!this.postgresService.enabled || !input.workItemId) {
      return undefined;
    }

    const { rows } = await this.postgresService.query<{ id: string }>(
      'select id from work_items where id = $1 limit 1',
      [input.workItemId]
    );
    if (rows.length === 0) {
      throw new BadRequestException(`work item ${input.workItemId} not found`);
    }

    const runId = randomUUID();
    await this.postgresService.query(
      `
        insert into agent_runs (
          id, work_item_id, agent_type, status, started_at,
          budget_seconds, budget_llm_calls, budget_max_files, budget_max_loc
        )
        values ($1, $2, $3, 'running', now(), $4, $5, $6, $7)
      `,
      [
        runId,
        input.workItemId,
        input.agentType,
        input.budget?.maxRuntimeSeconds ?? null,
        input.budget?.maxLlmCalls ?? null,
        input.budget?.maxChangedFiles ?? null,
        input.budget?.maxLocDelta ?? null
      ]
    );
    return runId;
  }

  private async completeAgentRunRecord(input: {
    runId?: string;
    status: 'completed' | 'failed';
    actualLlmCalls: number;
    changedFiles: number;
    locDelta: number;
    errorMessage?: string;
  }) {
    if (!this.postgresService.enabled || !input.runId) {
      return;
    }

    await this.postgresService.query(
      `
        update agent_runs
        set
          status = $2,
          completed_at = now(),
          actual_llm_calls = $3,
          actual_changed_files = $4,
          actual_loc_delta = $5,
          error_message = $6
        where id = $1
      `,
      [input.runId, input.status, input.actualLlmCalls, input.changedFiles, input.locDelta, input.errorMessage ?? null]
    );
  }
}
