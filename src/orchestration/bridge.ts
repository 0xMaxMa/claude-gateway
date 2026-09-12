import { createServer, Server } from 'http';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { AgentConfig } from '../types';
import { importContainerFile } from './container';
import { TaskService } from './tasks/service';
import { CommandContext, OrchestrationError, ChangeMode } from './types';
import { AGENT_OVERLAY, RuntimeProfile, WORKER_OVERLAY } from '../session/runtime-profile';
import { API_SOURCE_RULES, IDENTITY_EDIT_RULES, SECRET_RULES } from './source-policy';
import { TaskFiles } from './task-files';

import { resolveNamedSkill } from './skills';
import type { SkillRegistry } from '../skills';

type Scope = { role: 'agent'; context: Omit<CommandContext, 'actionId'>; onTaskQueued?: (spoken: string) => void } |
  { role: 'worker'; attemptId: string; generation: number };

/** Private MCP bridge: host loopback or an app-local Unix socket. No public task API. */
export class TaskBridge {
  private server?: Server;
  private url = '';
  recordRetrievals = false;
  private readonly scopes = new Map<string, Scope>();
  constructor(private readonly tasks: TaskService, private readonly files?: TaskFiles,
    private readonly shareCall?: (attemptId: string, generation: number, args: Record<string, unknown>) => Promise<unknown>, private readonly skills?: () => SkillRegistry, private readonly container?: { agent: AgentConfig; spool: string }) {}
  captureWorkerOutput(attemptId: string, generation: number, line: string): void {
    try { this.files?.captureOutput(attemptId, generation, line); }
    catch { /* A failed image capture must not break worker execution. Staging reports missing capture. */ }
  }
  async start(): Promise<void> {
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      try {
        if (request.method !== 'POST' || request.url !== '/call' || request.headers.origin) throw new OrchestrationError('ACCESS_DENIED');
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        const scope = token && this.scopes.get(token);
        if (!scope) throw new OrchestrationError('ACCESS_DENIED');
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > 131072) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
          chunks.push(buffer);
        }
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!command || typeof command.tool !== 'string' || !command.args || typeof command.args !== 'object' || Array.isArray(command.args) || typeof command.action_id !== 'string' || command.action_id.length > 256) throw new OrchestrationError('INVALID_INPUT');
        const a = command.args;
        let result: unknown;
        if (scope.role === 'agent') {
          const context: CommandContext = { ...scope.context, actionId: `${scope.context.inputId}:${command.action_id}` };
          switch (command.tool) {
            case 'task_spawn': {
              const skill = resolveNamedSkill(a.skill_name, a.skill_args, this.skills?.());
              if (a.target_profile === 'skill-worker' && !skill) throw new OrchestrationError('UNKNOWN_SKILL');
              if (a.target_profile !== 'skill-worker' && (a.skill_name !== undefined || a.skill_args !== undefined)) throw new OrchestrationError('INVALID_INPUT');
              const spoken = typeof a.spoken_acknowledgement === 'string' ? a.spoken_acknowledgement.trim() : '';
              if (scope.onTaskQueued && (!spoken || spoken.length > 600 || spoken.includes('```'))) throw new OrchestrationError('VOICE_ACKNOWLEDGEMENT_REQUIRED');
              await this.tasks.validateSpawnProfile(context, a.target_profile);
              const task = this.tasks.spawn(context, { title: a.title, instructions: a.instructions, targetProfile: a.target_profile, contextRefs: a.context_refs, continueTaskId: a.continue_task_id, continuationPolicy: a.continuation_policy, ...(skill ? { skill } : {}) });
              scope.onTaskQueued?.(spoken);
              const { skill: _workerOnly, ...receipt } = task;
              result = receipt;
              break;
            }
            case 'task_status': result = this.tasks.status(context.conversationId, context.principalId, a.task_id); break;
            case 'task_cancel': result = this.tasks.cancel(context, a.task_id, a.replaced_by_task_id); break;
            case 'task_update': result = this.tasks.update(context, a.task_id, a.expected_revision, a.instruction, a.mode as ChangeMode); break;
            case 'task_answer': result = this.tasks.answer(context, a.task_id, a.question_id, a.answer); break;
            default: throw new OrchestrationError('TOOL_DENIED');
          }
        } else {
          if (command.tool === 'task_report_progress') result = this.tasks.progress(scope.attemptId, scope.generation, a.text, command.action_id) ?? { accepted: true };
          else if (command.tool === 'task_request_input') result = this.tasks.requestInput(scope.attemptId, scope.generation, a.question, command.action_id);
          else if (command.tool === 'task_stage_file' && this.files) {
            this.files.scope(scope.attemptId, scope.generation);
            if (this.container && Number(this.tasks.store.get('SELECT COUNT(*) n FROM task_files WHERE attempt_id=?', scope.attemptId)!.n) >= 10 && !this.tasks.store.get('SELECT id FROM task_files WHERE attempt_id=? AND action_id=?', scope.attemptId, command.action_id)) throw new OrchestrationError('TOO_MANY_ARTIFACTS');
            const args = this.container ? { ...a, path: await importContainerFile(this.container.agent, this.container.spool, scope.attemptId, command.action_id, a.path) } : a;
            result = this.files.stage(scope.attemptId, scope.generation, command.action_id, args);
          }
          else if (command.tool === 'task_memory_append' && !this.container && this.files) result = this.files.remember(scope.attemptId, scope.generation, command.action_id, a);
          else if (command.tool === 'task_validate' && this.files) { this.files.scope(scope.attemptId, scope.generation); result = { active: true }; }
          else if (command.tool === 'task_share_call' && !this.container && this.files && this.shareCall) {
            this.files.scope(scope.attemptId, scope.generation);
            result = await this.shareCall(scope.attemptId, scope.generation, a);
          }
          else throw new OrchestrationError('TOOL_DENIED');
        }
        response.end(JSON.stringify(result));
      } catch (error) {
        const code = error instanceof OrchestrationError ? error.code : 'INVALID_REQUEST';
        response.statusCode = code === 'ACCESS_DENIED' ? 403 : 400;
        response.end(JSON.stringify({ error: code, ...(error instanceof OrchestrationError && ['WORKER_GIT_PROJECT_REQUIRED', 'ARTIFACT_FILE_NOT_FOUND', 'ARTIFACT_PATH_DENIED', 'MCP_IMAGE_NOT_CAPTURED'].includes(code) ? { message: error.message, retryable: true } : {}) }));
      }
    });
    server.requestTimeout = 10000; server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); if (this.container) server.listen(join(this.container.agent.workspace, '.orch-' + randomBytes(8).toString('hex') + '.sock'), resolve); else server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address) throw new Error('Invalid bridge address');
    this.server = server; this.url = typeof address === 'string' ? address : `http://127.0.0.1:${address.port}/call`;
  }
  issue(scope: Scope, directory: string, workspace: string, sharedKbDir = ''): { profile: RuntimeProfile; revoke(): void } {
    if (!this.server) throw new Error('Bridge is not started');
    const token = randomBytes(32).toString('hex');
    this.scopes.set(token, scope);
    // A ticket is immutable for the lifetime of this MCP process. Never replace
    // a shared ticket file at the next turn: late calls must keep their epoch.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ticketPath = join(directory, 'ticket.json'), mcpConfigPath = join(directory, 'mcp.json');
    const worker = scope.role === 'worker' && this.files ? this.files.scope(scope.attemptId, scope.generation) : undefined;
    const workerMemory = Boolean(worker?.task.capabilities.writeMemory && worker.conversation.source !== 'api');
    writeFileSync(ticketPath, JSON.stringify({ url: this.url, token, ...(this.container ? { socket: this.url, tools: containerTaskTools(scope.role) } : {}) }), { mode: 0o600, flag: 'wx' });
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { gateway: { command: 'bun', args: [resolve(__dirname, '../../mcp/server.ts')], env: {
      GATEWAY_ORCHESTRATION_ROLE: scope.role, GATEWAY_ORCHESTRATION_TICKET_FILE: ticketPath,
      GATEWAY_WORKSPACE_DIR: workspace, GATEWAY_SHARED_KB_DIR: sharedKbDir,
      GATEWAY_RECORD_RETRIEVALS: this.recordRetrievals ? '1' : '',
      GATEWAY_ORIGIN_CHANNEL: workerMemory ? String(worker!.conversation.source) : 'api', GATEWAY_AGENT_ID: this.tasks.store.agentId,
      GATEWAY_SESSION_ID: worker?.task.agentSessionId ?? '', GATEWAY_SESSION_MEDIA_DIR: worker?.mediaDir ?? '',
      GATEWAY_ORCHESTRATION_MEDIA: worker ? 'true' : '',
      GETPOD_BROWSER_URL: worker ? process.env.GETPOD_BROWSER_URL ?? 'http://127.0.0.1:10880' : '',
      GETPOD_BROWSER_API_KEY: worker ? process.env.GETPOD_BROWSER_API_KEY ?? '' : '',
      GETPOD_BROWSER_DISABLED: worker ? process.env.GETPOD_BROWSER_DISABLED ?? '' : 'true',
      GATEWAY_ORCHESTRATION_WRITE_MEMORY: workerMemory ? 'true' : '',
      GATEWAY_NODE_EXEC_PATH: process.execPath,
      GATEWAY_API_KEY: '', TELEGRAM_BOT_TOKEN: '', DISCORD_BOT_TOKEN: '', SLACK_BOT_TOKEN: '', LINE_CHANNEL_ACCESS_TOKEN: '',
      IMAGE_BASE_URL: worker ? process.env.IMAGE_BASE_URL ?? '' : '',
      ANTHROPIC_BASE_URL: worker ? process.env.ANTHROPIC_BASE_URL ?? '' : '',
      IMAGE_API_KEY: worker ? process.env.IMAGE_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '' : '',
      VIDEO_BASE_URL: worker ? process.env.VIDEO_BASE_URL ?? '' : '',
      VIDEO_API_KEY: worker ? process.env.VIDEO_API_KEY ?? '' : '',
      VIDEO_DISABLED: process.env.VIDEO_DISABLED ?? '',
      IMAGE_DISABLED: process.env.IMAGE_DISABLED ?? '', IMAGE_POLL_TIMEOUT_MS: process.env.IMAGE_POLL_TIMEOUT_MS ?? '',
    } } } }), { mode: 0o600, flag: 'wx' });
    const writeMemory = workerMemory || (scope.role === 'agent' && scope.context.writeMemory && this.tasks.store.get('SELECT source FROM conversations WHERE id=?', scope.context.conversationId)?.source !== 'api');
    const personaContext = scope.role === 'agent' ? `This agent persona workspace: ${JSON.stringify(this.container ? '/workspace' : workspace)}.` : '';
    const sourceRules = `${personaContext}\n${writeMemory ? `Channel memory updates use scoped memory tools. ${SECRET_RULES}` : API_SOURCE_RULES}\n${IDENTITY_EDIT_RULES}`;
    return { profile: { role: scope.role, containerExecution: Boolean(this.container), mcpConfigPath, overlay: `${scope.role === 'agent' ? AGENT_OVERLAY : WORKER_OVERLAY}\n\n${sourceRules}` },
      revoke: () => { this.scopes.delete(token); if (scope.role === 'worker') this.files?.releaseCaptured(scope.attemptId); } };
  }
  async close(): Promise<void> {
    this.scopes.clear();
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}

/** Container task-only MCP inventory; no host media/browser/memory delegation. */
export function containerTaskTools(role: 'agent' | 'worker') {
  const text = { type: 'string' };
  const entries: Array<[string, Record<string, unknown>, string[], string]> = role === 'agent' ? [
    ['task_spawn', { title:text, instructions:text, target_profile:text, spoken_acknowledgement:text, skill_name:text, skill_args:text, continue_task_id:text, continuation_policy:{type:'string',enum:['after_success','after_terminal']}, context_refs:{type:'array',items:text} }, ['title','instructions','target_profile'], 'Queue work inside this app container and return a durable receipt.'],
    ['task_status',{task_id:text},[],'Read task status without waiting.'],
    ['task_cancel',{task_id:text},['task_id'],'Request cancellation.'],
    ['task_update',{task_id:text,expected_revision:{type:'integer'},instruction:text,mode:{type:'string',enum:['when_ready','interrupt_and_resume']}},['task_id','expected_revision','instruction','mode'],'Replace the current task instructions when the user changes the goal or constraints. Write the complete updated brief, preserving unchanged requirements and citing relevant user input IDs.'],
    ['task_answer',{task_id:text,question_id:text,answer:text},['task_id','question_id','answer'],'Answer a pending worker question. Cite the user input IDs supporting any authorization; distinguish direct user statements from your interpretation. For a changed goal, prefer task_update with a complete replacement brief instead of repeatedly answering the same question.'],
  ] : [
    ['task_report_progress',{text},['text'],'Report progress for this task.'],
    ['task_request_input',{question:text},['question'],'Ask for input then end the turn.'],
    ['task_stage_file',{path:text,caption:text},['path'],'Stage a finished file from /workspace or /tmp inside the container.'],
  ];
  return entries.map(([name,properties,required,description])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}));
}
