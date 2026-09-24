import {parentVerifiableBrowserResult} from '../jev/browser-contract';
import { JevError } from '../jev/types';
import type { GatewayTaskAdapter } from './gateway-tasks/controller';
import { CRON_TOOLS } from '../cron/tool-schemas';
import { containerTaskTools } from './container-tool-schemas';
import { retryableMutation } from './mutation-recovery';
import { CHECKPOINT_HOOK } from './tasks/checkpoint-hook';
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

import type { IntakeChoice } from './conversation-intake';
import { resolveNamedSkill } from './skills';
import type { SkillRegistry } from '../skills';

type Scope = { role: 'agent'; compactOnly?: boolean; capabilities?: (args: Record<string, unknown>) => Promise<unknown>; onQuestion?: (context: CommandContext, args: Record<string, unknown>) => unknown; context: Omit<CommandContext, 'actionId'>; onTaskQueued?: (spoken: string) => void; onIntake?: (choice: IntakeChoice) => Promise<unknown>; onMutationResult?: (actionId: string, committed: boolean, errorCode?: string) => void; beforeMutation?: (tool: string, args: Record<string, unknown>, actionId: string) => Promise<void> } |
  { role: 'worker'; attemptId: string; generation: number };

/** Private MCP bridge: host loopback or an app-local Unix socket. No public task API. */
export class TaskBridge {
  private server?: Server;
  private url = '';
  recordRetrievals = false;
  jevEnabled?: () => boolean;
  browserEnabled?: () => boolean;
  computerEnabled?: () => boolean;
  jevCall?: (scope: Scope, args: Record<string, unknown>, actionId: string, signal: AbortSignal) => Promise<unknown>;
  private readonly scopes = new Map<string, Scope>();
  private readonly cancellations = new Map<string, AbortController>();
  constructor(private readonly tasks: TaskService, private readonly files?: TaskFiles,
    private readonly shareCall?: (attemptId: string, generation: number, args: Record<string, unknown>) => Promise<unknown>, private readonly skills?: () => SkillRegistry, private readonly container?: { agent: AgentConfig; spool: string }, private readonly cronCall?: (attemptId: string, generation: number, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>, private readonly gatewayAdapters = new Map<string, GatewayTaskAdapter>()) {}
  captureWorkerOutput(attemptId: string, generation: number, line: string): void {
    try { this.files?.captureOutput(attemptId, generation, line); }
    catch { /* A failed image capture must not break worker execution. Staging reports missing capture. */ }
  }
  async start(): Promise<void> {
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      let retryOf: string | undefined;
      let denialReason: string | undefined;
      function deny(reason: string): never { denialReason = reason; throw new OrchestrationError('ACCESS_DENIED'); }
      try {
        if (request.method !== 'POST' || request.url !== '/call' || request.headers.origin) deny('INVALID_BRIDGE_REQUEST');
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        const scope = token && this.scopes.get(token);
        if (!scope) deny('TICKET_INVALID_OR_REVOKED');
        if (scope.role === 'agent' && scope.compactOnly) deny('COMPACTION_SCOPE');
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > 131072) throw new OrchestrationError('PAYLOAD_TOO_LARGE');
          chunks.push(buffer);
        }
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!command || typeof command.tool !== 'string' || !command.args || typeof command.args !== 'object' || Array.isArray(command.args) || typeof command.action_id !== 'string' || command.action_id.length > 256) throw new OrchestrationError('INVALID_INPUT');
        if(this.scopes.get(token!)!==scope)deny('TICKET_INVALID_OR_REVOKED');
        const a = command.args;
        let result: unknown;
        if (command.tool === 'jev_evaluate') {
          if (!this.jevEnabled?.() || !this.jevCall) deny('JEV_NOT_ALLOWED');
          if (scope.role === 'agent') {
            this.tasks.store.assertMember(scope.context.conversationId, scope.context.principalId);
            if (!scope.context.execute) deny('READ_ONLY_TURN');
          } else {
            if (!this.files) deny('WORKER_SCOPE_UNAVAILABLE');
            this.files.scope(scope.attemptId, scope.generation);
          }
          const cancelled = this.cancellations.get(token!);
          if (!cancelled) deny('TICKET_INVALID_OR_REVOKED');
          const disconnected = new AbortController();
          const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
          response.once('close', onClose);
          try { result = await this.jevCall(scope, a, command.action_id, AbortSignal.any([cancelled.signal, disconnected.signal])); }
          finally { response.off('close', onClose); }
        } else if (scope.role === 'agent') {
          const context: CommandContext = { ...scope.context, actionId: `${scope.context.inputId}:${command.action_id}` };
          const mutation = ['task_spawn','task_update','task_answer'].includes(command.tool);
          try {
            if (mutation) await scope.beforeMutation?.(command.tool, a, context.actionId);
            if(this.scopes.get(token!)!==scope)deny('TICKET_INVALID_OR_REVOKED');
            switch (command.tool) {
              case 'capabilities_list': {
                this.tasks.store.assertMember(context.conversationId, context.principalId);
                if (a.scope === 'safemode' || a.scope === 'browser' || a.scope === 'computer') {
                  if (this.container && a.scope === 'safemode') deny('SAFEMODE_HOST_ONLY');
                  const adapter = this.gatewayAdapters.get(a.scope);
                  if (!adapter) throw new OrchestrationError('SAFEMODE_AGENT_NOT_ALLOWED');
                  if (a.query !== undefined && typeof a.query !== 'string') throw new OrchestrationError('INVALID_INPUT');
                  result = await adapter.discover(a.query, a.offset, context);
                  if(this.scopes.get(token!)!==scope)deny('TICKET_INVALID_OR_REVOKED');
                  this.tasks.store.assertMember(context.conversationId, context.principalId); break;
                }
                if (a.scope !== undefined && a.scope !== 'capabilities') throw new OrchestrationError('INVALID_INPUT');
                if (!scope.capabilities) throw new OrchestrationError('CAPABILITY_DISCOVERY_UNAVAILABLE');
                result = { ...(await scope.capabilities(a) as Record<string, unknown>), executionAllowedForThisTurn: context.execute, memoryWriteAllowedForThisTurn: context.writeMemory }; break;
              }
              case 'conversation_intake': {
                // The tool is declared on every turn to keep the cached tools prefix
                // byte-identical, so the model can reach this handler on a turn where the
                // feature is not active (flag off, or an internal notification turn). Refuse
                // explicitly and tell it what to do instead: an error result would make the
                // model guess, and a bare success would imply the user had been acknowledged.
                if (!scope.onIntake) {
                  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn',
                    event: 'conversation_intake called while semantic intake is inactive',
                    agentId: this.tasks.store.agentId, referenceId: context.actionId, mode: typeof a.mode === 'string' ? a.mode : null }));
                  result = { intake_required: false, instruction: 'Semantic intake is not active for this turn. Do not call conversation_intake again now: answer the user directly, and queue any authorized work with the task tools without a separate acknowledgement.' };
                  break;
                }
                result = await scope.onIntake(a); break;
              }
              case 'task_spawn': {
                let gatewayTarget;
                if (a.target_profile === 'gateway-managed' || a.gateway_target !== undefined) {
                  if (this.container && !['browser','computer'].includes(a.gateway_target?.adapter)) deny('SAFEMODE_HOST_ONLY');
                  if (a.target_profile !== 'gateway-managed' || !a.gateway_target || typeof a.gateway_target !== 'object' || Array.isArray(a.gateway_target)) throw new OrchestrationError('INVALID_GATEWAY_TARGET');
                  const adapter = this.gatewayAdapters.get(a.gateway_target.adapter);
                  if (!adapter) throw new OrchestrationError('INVALID_GATEWAY_TARGET');
                  gatewayTarget = adapter.resolve(a.gateway_target, context);
                }
                const skill = resolveNamedSkill(a.skill_name, a.skill_args, this.skills?.());
                if (a.target_profile === 'skill-worker' && !skill) throw new OrchestrationError('UNKNOWN_SKILL');
                if (a.target_profile !== 'skill-worker' && (a.skill_name !== undefined || a.skill_args !== undefined)) throw new OrchestrationError('INVALID_INPUT');
                const spoken = typeof a.spoken_acknowledgement === 'string' ? a.spoken_acknowledgement.trim() : '';
                if (scope.onTaskQueued && (!spoken || spoken.length > 600 || spoken.includes('```'))) throw new OrchestrationError('VOICE_ACKNOWLEDGEMENT_REQUIRED');
                await this.tasks.validateSpawnProfile(context, a.target_profile);
                // Profile resolution may yield while another input arrives. Recheck
                // readiness immediately before the synchronous task transaction.
                await scope.beforeMutation?.(command.tool, a, context.actionId);
                if(this.scopes.get(token!)!==scope)deny('TICKET_INVALID_OR_REVOKED');
                const task = this.tasks.spawn(context, { title: a.title, instructions: a.instructions, targetProfile: a.target_profile, gatewayTarget, workingDirectory: a.working_directory, contextRefs: a.context_refs, continueTaskId: a.continue_task_id, continuationPolicy: a.continuation_policy, ...(skill ? { skill } : {}) });
                scope.onTaskQueued?.(spoken);
                const { skill: _workerOnly, ...receipt } = task;
                result = receipt;
                break;
              }
              case 'task_status': {
                const rows=a.task_id ? this.tasks.status(context.conversationId,context.principalId,a.task_id) : this.tasks.context(context.conversationId,context.principalId,context.decisionId);
                if(a.computer_trace_offset!==undefined){
                  if(!a.task_id||a.browser_evidence!==undefined||!Number.isSafeInteger(a.computer_trace_offset)||a.computer_trace_offset<0)throw new OrchestrationError('INVALID_INPUT');
                  const task=this.tasks.status(context.conversationId,context.principalId,a.task_id)[0],adapter=this.gatewayAdapters.get('computer');
                  if(task.ownerPrincipalId!==context.principalId||task.gatewayTarget?.adapter!=='computer'||!adapter?.diagnostics)throw new OrchestrationError('ACCESS_DENIED');
                  const computerTrace=await adapter.diagnostics(task,a.computer_trace_offset);
                  if(this.scopes.get(token!)!==scope)deny('TICKET_INVALID_OR_REVOKED');
                  this.tasks.store.assertMember(context.conversationId,context.principalId);
                  result={tasks:rows,computerTrace};
                }else if(a.browser_evidence!==undefined){
                  if(!a.task_id || !['recorded','fresh'].includes(a.browser_evidence))throw new OrchestrationError('INVALID_INPUT');
                  const task=this.tasks.status(context.conversationId,context.principalId,a.task_id)[0];
                  const adapter=this.gatewayAdapters.get('browser');
                  if(task.ownerPrincipalId!==context.principalId || task.gatewayTarget?.adapter!=='browser' || !adapter?.evidence)throw new OrchestrationError('ACCESS_DENIED');
                  const evidence=await adapter.evidence(task,a.browser_evidence==='fresh',this.cancellations.get(token!)?.signal);
                  if(this.scopes.get(token!)!==scope)deny('TICKET_INVALID_OR_REVOKED');
                  this.tasks.store.assertMember(context.conversationId,context.principalId);
                  result={tasks:rows,browserEvidence:evidence,untrustedPageContent:true,
                    ...(evidence.evidenceId && parentVerifiableBrowserResult(task.browserReport) ? {verification:{
                      instruction:'If this fresh observation independently proves the current goal, call task_update with these exact fields plus your concrete evidence in instruction. Do not run the task again merely to report the observed result.',
                      tool:'task_update',arguments:{task_id:task.taskId,expected_revision:task.revision,mode:'verify_browser',expected_request_id:evidence.requestId,evidence_id:evidence.evidenceId}
                    }} : {})};
                }else result=rows;
                break;
              }
              case 'task_cancel': result = this.tasks.cancel(context, a.task_id, a.replaced_by_task_id); break;
              case 'task_update': {
                if(['verify_browser','reconcile_browser'].includes(a.mode) && (typeof a.evidence_id!=='string'||!a.evidence_id||typeof a.expected_request_id!=='string'||!a.expected_request_id))throw new OrchestrationError('BROWSER_EVIDENCE_REQUIRED','Copy browserEvidence.evidenceId into evidence_id and browserEvidence.requestId into expected_request_id from task_status(browser_evidence=fresh). Retry the same verification/reconciliation with both IDs, expected_revision and instruction. Missing IDs do not mean the browser failed: do not requeue or replay the task.');
                if(a.mode==='reconcile_browser'){
                  const task=this.tasks.status(context.conversationId,context.principalId,a.task_id)[0];
                  const adapter=this.gatewayAdapters.get('browser');
                  if(!adapter?.reconcileEvidence)throw new OrchestrationError('BROWSER_INSPECTION_UNAVAILABLE');
                  result=this.tasks.reconcileBrowser(context,a.task_id,a.expected_revision,a.expected_request_id,a.evidence_id,a.instruction,()=>adapter.reconcileEvidence!(task,a.expected_request_id,a.evidence_id));
                }else if(a.mode==='verify_browser'){
                  const task=this.tasks.status(context.conversationId,context.principalId,a.task_id)[0];
                  const adapter=this.gatewayAdapters.get('browser');
                  if(!adapter?.verifyEvidence)throw new OrchestrationError('BROWSER_VERIFICATION_UNAVAILABLE');
                  result=this.tasks.verifyBrowser(context,a.task_id,a.expected_revision,a.expected_request_id,a.evidence_id,a.instruction,()=>adapter.verifyEvidence!(task,a.expected_request_id,a.evidence_id));
                }else result=this.tasks.update(context,a.task_id,a.expected_revision,a.instruction,a.mode as ChangeMode);
                break;
              }
              case 'task_question': {
                if (!scope.onQuestion) throw new OrchestrationError('QUESTION_CONTROLS_UNAVAILABLE');
                result = scope.onQuestion(context, a); break;
              }
              case 'task_answer': result = this.tasks.answer(context, a.task_id, a.question_id, a.answer); break;
              default: throw new OrchestrationError('TOOL_DENIED');
            }
            if (mutation) scope.onMutationResult?.(context.actionId, true);
          } catch (error) {
            if (error instanceof OrchestrationError && retryableMutation(command.tool, error.code)) retryOf = context.actionId;
            if (mutation) scope.onMutationResult?.(context.actionId, false, error instanceof OrchestrationError ? error.code : undefined);
            throw error;
          }
        } else {
          if (command.tool === 'task_checkpoint') result = this.tasks.checkpoint(scope.attemptId, scope.generation, a);
          else if (command.tool === 'task_report_progress') result = this.tasks.progress(scope.attemptId, scope.generation, a.text, command.action_id, a.checkpoint) ?? { accepted: true };
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
          else if (CRON_TOOLS.some(tool => tool.name === command.tool) && this.files && this.cronCall) {
            this.files.scope(scope.attemptId, scope.generation);
            const cancelled = this.cancellations.get(token!);
            if (!cancelled) throw new OrchestrationError('ACCESS_DENIED');
            const disconnected = new AbortController();
            const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
            response.once('close', onClose);
            try {
              result = await this.cronCall(scope.attemptId, scope.generation, command.tool, a,
                AbortSignal.any([cancelled.signal, disconnected.signal]));
            } finally { response.off('close', onClose); }
          }
          else throw new OrchestrationError('TOOL_DENIED');
        }
        response.end(JSON.stringify(result));
      } catch (error) {
        const code = error instanceof JevError ? `JEV_${error.code}` : error instanceof OrchestrationError ? error.code : 'INVALID_REQUEST';
        if (code === 'ACCESS_DENIED' && denialReason) console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', message: 'Task bridge authorization denied', data: { agentId: this.tasks.store.agentId, reason: denialReason } }));
        response.statusCode = code === 'ACCESS_DENIED' ? 403 : 400;
        response.end(JSON.stringify({ error: code, ...(error instanceof JevError ? {message:error.message,...error.metadata} : {}), ...(code === 'ACCESS_DENIED' && denialReason ? { reason: denialReason } : {}), ...(error instanceof OrchestrationError && ['CRON_API_ERROR', 'CRON_OUTCOME_UNKNOWN'].includes(code) ? { message: error.message, retryable: false } : {}), ...(retryOf ? {retry_of:retryOf} : {}), ...(error instanceof OrchestrationError && ['WORKER_GIT_PROJECT_REQUIRED', 'ARTIFACT_FILE_NOT_FOUND', 'ARTIFACT_PATH_DENIED', 'MCP_IMAGE_NOT_CAPTURED', 'BROWSER_EVIDENCE_REQUIRED', 'LIVE_CONTROL_TARGET_ONLY', 'AUTOMATION_SESSION_EXISTS', 'AUTOMATION_SESSION_CLOSED'].includes(code) ? { message: error.message, retryable: true } : {}) }));
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
    this.cancellations.set(token, new AbortController());
    // A ticket is immutable for the lifetime of this MCP process. Never replace
    // a shared ticket file at the next turn: late calls must keep their epoch.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ticketPath = join(directory, 'ticket.json'), mcpConfigPath = join(directory, 'mcp.json');
    const worker = scope.role === 'worker' && this.files ? this.files.scope(scope.attemptId, scope.generation) : undefined;
    const workerMemory = Boolean(worker?.task.capabilities.writeMemory && worker.conversation.source !== 'api');
    const jevEnabled = Boolean(this.jevEnabled?.());
    const browserEnabled = Boolean(this.browserEnabled?.());
    writeFileSync(ticketPath, JSON.stringify({ url: this.url, token, ...(this.container ? { socket: this.url, tools: containerTaskTools(scope.role, jevEnabled, browserEnabled, Boolean(this.computerEnabled?.())) } : {}) }), { mode: 0o600, flag: 'wx' });
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { gateway: { command: 'bun', args: [resolve(__dirname, '../../mcp/server.ts')], env: {
      GATEWAY_JEV_ENABLED: jevEnabled ? 'true' : '',
      GATEWAY_CAPABILITY_CATALOG: scope.role === 'agent' && scope.capabilities ? 'true' : '',
      GATEWAY_ORCHESTRATION_ROLE: scope.role, GATEWAY_ORCHESTRATION_TICKET_FILE: ticketPath,
      GATEWAY_WORKSPACE_DIR: workspace, GATEWAY_SHARED_KB_DIR: sharedKbDir,
      GATEWAY_RECORD_RETRIEVALS: this.recordRetrievals ? '1' : '',
      GATEWAY_ORIGIN_CHANNEL: workerMemory ? String(worker!.conversation.source) : 'api', GATEWAY_AGENT_ID: this.tasks.store.agentId,
      GATEWAY_SESSION_ID: worker?.task.agentSessionId ?? '', GATEWAY_SESSION_MEDIA_DIR: worker?.mediaDir ?? '',
      GATEWAY_ORCHESTRATION_MEDIA: worker ? 'true' : '',
      GATEWAY_LAZY_TOOLS: worker ? 'true' : '',
      GATEWAY_ORCHESTRATION_CRON: worker && this.cronCall ? 'true' : '',
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
    const checkpointPath = join(directory, 'checkpoint.cjs');
    if (scope.role === 'worker') writeFileSync(checkpointPath, CHECKPOINT_HOOK, { mode: 0o600, flag: 'wx' });
    const quote = (value: string) => process.platform === 'win32' ? JSON.stringify(value) : "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const checkpointCommand = scope.role === 'worker' ? [process.execPath, checkpointPath, ticketPath].map(quote).join(' ') : undefined;
    const writeMemory = workerMemory || (scope.role === 'agent' && scope.context.writeMemory && this.tasks.store.get('SELECT source FROM conversations WHERE id=?', scope.context.conversationId)?.source !== 'api');
    const personaContext = scope.role === 'agent' ? `This agent persona workspace: ${JSON.stringify(this.container ? '/workspace' : workspace)}.` : '';
    const sourceRules = `${personaContext}\n${writeMemory ? `Channel memory updates use scoped memory tools. ${SECRET_RULES}` : API_SOURCE_RULES}\n${IDENTITY_EDIT_RULES}`;
    return { profile: { role: scope.role, jevEnabled, browserEnabled, checkpointCommand, containerExecution: Boolean(this.container), mcpConfigPath, overlay: `${scope.role === 'agent' ? AGENT_OVERLAY : WORKER_OVERLAY}\n\n${sourceRules}` },
      revoke: () => { this.cancellations.get(token)?.abort(); this.cancellations.delete(token); this.scopes.delete(token); if (scope.role === 'worker') this.files?.releaseCaptured(scope.attemptId); } };
  }
  async close(): Promise<void> {
    for (const controller of this.cancellations.values()) controller.abort();
    this.cancellations.clear();
    this.scopes.clear();
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}

export { containerTaskTools } from './container-tool-schemas';
