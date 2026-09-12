import { browserRouting } from './browser-routing';
import { inferenceFailureMessage } from './inference-errors';
import { partialDisplay } from './display-stream';
import { responseHasVoiceOrigin, voiceReplyAllowed } from './voice-reply-policy';
import { taskReport } from './task-report';
import { TelegramToolStatus } from './telegram-tool-status';
import { ChannelActivity } from './channel-activity';
import { loadInputImages } from './input-images';
import { LineLoading } from './line-loading';
import {applyGatewayOrchestration} from './gateway-config';
import { ChannelControls } from './channel-controls';
import { TaskControls } from './task-controls';
import { TelegramVoices } from './telegram-voices';
import { StopControls } from './stop-controls';
import { resolveDreamingConfig } from '../agent/dreaming/config';
import { validateContainer } from './container';
import { toolActivity, ToolActivity } from './tool-activity';
import { transcribeVoiceNote, voiceNoteFailureMessage } from '../voice/notes';
import { VoiceError } from '../voice/types';
import { describeVoiceError } from '../voice/errors';
import { MediaStore } from '../history/media-store';
import { resolveSkill, skillCatalog } from './skills';
import type { SkillRegistry } from '../skills';
import { voiceChoices, resolveVoiceId } from '../voice/providers/voice-catalog';
import { SPEECH_SCHEMA, SPEECH_OVERLAY, splitSpeechResponse, speechVoiceStyle } from './speech';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { realpath } from 'fs/promises';
import type { AgentConfig, GatewayConfig } from '../types';
import { SessionProcess } from '../session/process';
import { SessionStore } from '../session/store';
import { HistoryDB } from '../history/db';
import { RuntimeProfile } from '../session/runtime-profile';
import { OrchestrationStore, AcceptInput, channelVoiceKey } from './store';
import { resolveOrchestrationConfig } from './config';
import { TaskService } from './tasks/service';
import { DecisionService, DecisionReceipt } from './decisions';
import { TaskBridge } from './bridge';
import { TaskWorkspaces } from './tasks/workspace';
import { ClaudeWorkerDriver } from './tasks/driver';
import { WorkerDriver, WorkerScheduler } from './tasks/scheduler';
import { OrchestrationHistoryWriter } from './history';
import { ProcessTurn, startProcessTurn } from './process-turn';
import { OrchestrationError, ExecutionCapabilities, ConversationScope } from './types';
import { recoverOrchestration } from './recovery';
import { acquireInstanceLock } from './instance-lock';
import { DeliveryOutbox, channelSender, ChannelSender } from './delivery';
import { resolveSharedConfig, sharedVaultDir } from '../agent/knowledge';
import { ConversationEvents } from './events';
import { BoundedQueue } from './bounded-queue';
import { gatewayCapacity } from './capacity';
import { ResourceCleanup } from './tasks/cleanup';
import { TaskFiles } from './task-files';
import { workerShares } from './worker-shares';

export interface AgentOrchestrationHost {
  sendLinkedChannel?: ChannelSender;
  skills?(): SkillRegistry;
  refreshSkills?(): Promise<void>;
  onManagedTurn?(sessionId: string, text: string, metrics: import('./process-turn').ManagedTurnMetrics, skills?: string[]): void;
  transcribeNote?: typeof transcribeVoiceNote;
  createAgentSession(sessionId: string, profile: RuntimeProfile, model?: string, scope?: ConversationScope): Promise<SessionProcess>;
  releaseAgentSession(sessionId: string, process: SessionProcess): Promise<void>;
}
export class AgentOrchestrationRuntime {
  readonly store: OrchestrationStore;
  readonly tasks: TaskService;
  readonly stopControls: StopControls;
  readonly taskControls: TaskControls;
  readonly channelControls: ChannelControls;
  readonly telegramVoices: TelegramVoices;
  readonly decisions: DecisionService;
  readonly bridge: TaskBridge;
  readonly events: ConversationEvents;
  private readonly history: OrchestrationHistoryWriter;
  private readonly delivery: DeliveryOutbox;
  private readonly scheduler: WorkerScheduler;
  private readonly scheduledReports = new Set<string>();
  private readonly seenSessions = new Set<string>();
  private readonly active = new Map<string, { decision?: DecisionReceipt; turn?: ProcessTurn; stopping: boolean; modality?: string; notification?: boolean }>();
  private config;
  private draining = false;
  private closing = false;
  private lineLoading?: LineLoading;
  private channelActivity?: ChannelActivity;
  private telegramToolStatus?: TelegramToolStatus;
  private mailboxTimer?: ReturnType<typeof setInterval>;
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private resourceTimer?: ReturnType<typeof setInterval>;
  private settleResources: () => Promise<void> = async () => {};
  private readonly deferred = new Map<string, { resolve(text: string): void; reject(error: unknown): void }>();
  private readonly inputResponses = new Map<string, Promise<string>>();
  private readonly voiceListeners = new Map<string, { principalId: string; receive: (result: { responseId: string; text: string; spoken: string; requestId?: string; speechOnly?: boolean }) => void; gender?: () => string | undefined }>();
  subscribeVoiceResults(sessionId: string, principalId: string, receive: (result: { responseId: string; text: string; spoken: string; requestId?: string; speechOnly?: boolean }) => void, gender?: () => string | undefined): () => void {
    this.authorizeSession(sessionId, principalId);
    const listener = { principalId, receive, gender };
    this.voiceListeners.set(sessionId, listener);
    return () => { if (this.voiceListeners.get(sessionId) === listener) this.voiceListeners.delete(sessionId); };
  }
  private readonly inputStreams = new Map<string, BoundedQueue<{ responseId: string; text: string }>>();
  private releaseLock: () => void = () => {};
  private sharedKb = '';
  private readonly pending = new Set<Promise<unknown>>();
  private readonly sessionResponses = new Map<string, Promise<string>>();
  private constructor(private readonly agent: AgentConfig, private readonly root: string, private readonly host: AgentOrchestrationHost,
    store: OrchestrationStore, history: OrchestrationHistoryWriter, scheduler: WorkerScheduler, bridge: TaskBridge, tasks: TaskService) {
    this.store = store; this.history = history; this.scheduler = scheduler; this.bridge = bridge; this.tasks = tasks;
    this.telegramVoices = new TelegramVoices(store, () => this.config.voice.tts);
    this.taskControls = new TaskControls(store, tasks);
    this.stopControls = new StopControls(store, tasks, id => this.stopResponse(id));
    this.channelControls = new ChannelControls(store,this.taskControls,this.stopControls,new TelegramVoices(store,()=>this.config.voice.tts,voiceChoices,8),()=>(this.config.voice.enabled && this.config.voice.notes.replyWithVoice));
    this.delivery = new DeliveryOutbox(store, channelSender(() => this.agent, fetch, (binding, speech) => Boolean(this.config.enabled && this.config.channels.includes(String(binding.channel) as any) && (this.config.voice.enabled && this.config.voice.notes.replyWithVoice) && voiceReplyAllowed(store.channelVoiceMode(String(binding.channel),String(binding.chat_id),String(binding.thread_key??'')), speech.voiceOrigin === true) && this.config.voice.tts.provider === speech.provider), host.sendLinkedChannel));
    this.decisions = new DecisionService(store, (response, binding, text) => {
      this.delivery.enqueue(response, binding, text);
      const spoken = store.get('SELECT text FROM response_speech WHERE response_id=?', response);
      const destination = store.get('SELECT channel,chat_id,thread_key FROM conversation_bindings WHERE id=?', binding);
      if (spoken?.text && (this.config.voice.enabled && this.config.voice.notes.replyWithVoice) && destination && ['telegram','discord','line','slack'].includes(String(destination.channel)) && voiceReplyAllowed(store.channelVoiceMode(String(destination.channel),String(destination.chat_id),String(destination.thread_key??'')), responseHasVoiceOrigin(store,response))) {
        this.delivery.enqueueSpeech(response, binding, { ...this.telegramVoices.settings(channelVoiceKey(String(destination.channel),String(destination.chat_id),String(destination.thread_key??''))), text: String(spoken.text), voiceOrigin: responseHasVoiceOrigin(store,response) });
      }
    }); this.config = resolveOrchestrationConfig(agent.orchestration, agent.voice ?? { enabled: false });
    this.events = new ConversationEvents(store, this.config.events.maxSubscriberBufferBytes);
  }
  static async open(agent: AgentConfig, gateway: GatewayConfig, root: string, sessions: SessionStore, historyDb: HistoryDB,
    host: AgentOrchestrationHost, workerDriver?: WorkerDriver): Promise<AgentOrchestrationRuntime> {
    agent=applyGatewayOrchestration(agent,gateway);

    if (agent.type === 'app-agent') {
      if (agent.orchestration?.tasks?.workspaceMode && agent.orchestration.tasks.workspaceMode !== 'container') throw new OrchestrationError('CONTAINER_WORKSPACE_REQUIRED');
      if (agent.orchestration?.tasks?.projectRoot) throw new OrchestrationError('CONTAINER_PROJECT_OVERRIDE_DENIED');
      agent = { ...agent, orchestration: { ...agent.orchestration, enabled:agent.orchestration?.enabled, channels:agent.orchestration?.channels, tasks: { ...agent.orchestration?.tasks, workspaceMode: 'container' } } };
    } else if (agent.orchestration?.tasks?.workspaceMode === 'container') throw new OrchestrationError('CONTAINER_REQUIRED');

    mkdirSync(root, { recursive: true, mode: 0o700 });
    const releaseLock = acquireInstanceLock(join(root, 'orchestration-instance.lock'));
    let store: OrchestrationStore;
    try { store = new OrchestrationStore(join(root, 'orchestration.db'), agent.id); } catch (error) { releaseLock(); throw error; }
    try {
      const needsExecution = agent.orchestration?.enabled || store.get("SELECT id FROM conversation_inputs WHERE status IN ('accepted','assigned') LIMIT 1")
        || store.get("SELECT id FROM tasks WHERE state NOT IN ('completed','failed','cancelled') LIMIT 1")
        || store.get("SELECT id FROM notifications WHERE status!='handled' LIMIT 1");
      if (needsExecution) {
        if (agent.type === 'app-agent') await validateContainer(agent);
        if (gateway.gateway.headless === false) throw new OrchestrationError('UNSUPPORTED_ORCHESTRATION_BACKEND');
        if (process.platform !== 'linux') throw new OrchestrationError('UNSUPPORTED_PROCESS_SUPERVISOR');
        if (agent.claude.extraFlags?.length) throw new OrchestrationError('PROFILE_FLAGS_CONFLICT');
      }
    } catch (error) { store.close(); releaseLock(); throw error; }
    const tasks = new TaskService(store, agent.orchestration, agent.workspace);
    const files = new TaskFiles(store, join(agent.workspace, '../..'), agent.type === 'app-agent' ? join(root, 'container-files') : undefined);
    const bridge = new TaskBridge(tasks, files, workerShares(files, agent, gateway), host.skills ? () => host.skills!() : undefined, agent.type === 'app-agent' ? { agent, spool: join(root, 'container-files') } : undefined);
    const personalRetention = resolveDreamingConfig(agent.dreaming, gateway.gateway.dreaming, gateway.gateway.timezone).staleness;
    const sharedRetention = resolveSharedConfig(agent.knowledge?.shared, gateway.gateway.knowledge?.shared).staleness;
    bridge.recordRetrievals = (personalRetention.enabled && personalRetention.recordRetrievals) || (sharedRetention.enabled && sharedRetention.recordRetrievals);
    try {
      recoverOrchestration(store);
      // A prior gateway cannot prove that these processes stopped. Reserve
      // their global capacity conservatively as well as the per-agent slots.
      for (const _row of store.all("SELECT id FROM tasks WHERE state='needs_reconciliation' AND active_attempt_id IS NOT NULL")) gatewayCapacity(gateway).acquire('worker', false);
      if (agent.orchestration?.enabled) store.run("UPDATE conversations SET status='active' WHERE status='draining'");
      await bridge.start();
      const project = agent.orchestration?.tasks?.projectRoot || agent.workspace;
      if (agent.orchestration?.tasks?.workspaceMode === 'shared-lock') {
        const [actualProject, identity] = await Promise.all([realpath(project), realpath(agent.workspace)]);
        if (actualProject === identity || actualProject.startsWith(identity + '/') || identity.startsWith(actualProject + '/')) throw new OrchestrationError('SHARED_PROJECT_MUST_DIFFER_FROM_IDENTITY_WORKSPACE');
      }
      const workspaces = new TaskWorkspaces(store, project, join(root, 'task-worktrees'), agent.orchestration?.tasks?.workspaceMode);
      for (const row of store.all("SELECT id FROM tasks WHERE state IN ('completed','failed','cancelled')")) await workspaces.release(String(row.id));
      const driver = workerDriver ?? new ClaudeWorkerDriver(agent, gateway, tasks, bridge, workspaces, join(root, 'task-attempts'), host.onManagedTurn);
      const scheduler = new WorkerScheduler(tasks, driver);
      const cleanup = new ResourceCleanup(store, join(root, 'task-worktrees'), join(root, 'task-artifacts'), resolveOrchestrationConfig(agent.orchestration).tasks.resourceRetentionDays);
      const runtime = new AgentOrchestrationRuntime(agent, root, host, store, new OrchestrationHistoryWriter(store, sessions, historyDb), scheduler, bridge, tasks);
      runtime.gateway = gateway;
      runtime.releaseLock = releaseLock;
      runtime.settleResources = async () => { cleanup.stop(); await workspaces.settle(); await cleanup.settle(); };
      const shared = resolveSharedConfig(agent.knowledge?.shared, gateway.gateway.knowledge?.shared);
      runtime.sharedKb = shared.enabled ? sharedVaultDir(shared) : '';
      if (!agent.orchestration?.enabled) runtime.drain();
      await runtime.flushHistory();
      scheduler.start();
      runtime.mailboxTimer = setInterval(() => {
        try { runtime.pumpMailbox(); } catch { /* admission remains durable for retry */ }
        void runtime.delivery.tick().catch(() => {});
      }, 100);
      runtime.mailboxTimer.unref();
      runtime.lineLoading = new LineLoading(store, () => runtime.agent, () => runtime.config.enabled);
      runtime.lineLoading.start();
      runtime.channelActivity = new ChannelActivity(store, () => runtime.agent, () => runtime.config.enabled);
      runtime.channelActivity.start();
      runtime.telegramToolStatus = new TelegramToolStatus(store, () => runtime.agent, () => runtime.config.enabled && runtime.config.channels.includes('telegram'));
      runtime.telegramToolStatus.start();
      runtime.maintenanceTimer = setInterval(() => {
        try { runtime.events.prune(runtime.config.events.retentionDays); } catch { /* retry next maintenance interval */ }
        void cleanup.tick().catch(() => {});
      }, 60000);
      runtime.maintenanceTimer.unref();
      runtime.resourceTimer = setInterval(() => {
        for (const row of store.all("SELECT DISTINCT t.id FROM tasks t JOIN task_resources r ON r.task_id=t.id WHERE t.state IN ('completed','failed','cancelled') AND r.mode='shared-lock' AND r.lifecycle_state IN ('active','preparing','needs_reconciliation','releasing') LIMIT 100")) void workspaces.release(String(row.id)).catch(() => {});
      }, 1000);
      runtime.resourceTimer.unref();
      return runtime;
    } catch (error) { await bridge.close(); store.close(); releaseLock(); throw error; }
  }
  activity(sessionId: string, principalId: string, after = 0) {
    const conversation = this.store.get('SELECT * FROM conversations WHERE agent_session_id=?', sessionId);
    if (!conversation) return { cursor: 0, tasks: [], responses: [], tools: [], busy: false };
    this.store.assertMember(String(conversation.id), principalId);
    const id = String(conversation.id);
    if (!Number.isSafeInteger(after) || after < 0 || after > Number(conversation.last_event_seq)) throw new OrchestrationError('INVALID_CURSOR');
    const tasks = this.tasks.status(id, principalId).map(t => {
      return { taskId: t.taskId, title: t.title, state: t.state, stateVersion: t.stateVersion, progress: t.latestProgress, execution: t.execution, result: t.result?.summary, updatedAt: Math.max(t.updatedAt, t.execution?.lastActivityAt ?? 0) };
    });
    const responses = this.store.all('SELECT id,request_id,state,generated_text,created_at FROM assistant_responses WHERE conversation_id=? ORDER BY created_at DESC LIMIT 100', id).reverse().map(r => ({
      id: r.id, requestId: r.request_id, state: r.state, text: r.generated_text, createdAt: r.created_at,
      files: this.store.all('SELECT path FROM task_files WHERE response_id=? ORDER BY created_at,id', r.id).map(f => f.path),
    }));
    const tools = this.store.all("SELECT seq,payload_json FROM conversation_events WHERE conversation_id=? AND seq>? AND type='tool.activity' ORDER BY seq LIMIT 500", id, after).map(r => ({ seq: r.seq, ...JSON.parse(String(r.payload_json)).payload }));
    return { cursor: tools.length === 500 ? tools[tools.length - 1].seq : Number(conversation.last_event_seq), tasks, responses, tools, busy: this.isBusy(sessionId) };
  }
  isBusy(sessionId: string): boolean { return this.active.has(sessionId); }
  responseFiles(sessionId: string, requestId?: string): string[] {
    const response = this.store.get(`SELECT r.id FROM assistant_responses r JOIN conversations c ON c.id=r.conversation_id WHERE c.agent_session_id=?
      ${requestId === undefined ? '' : 'AND r.request_id=?'} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`, ...[sessionId, ...(requestId === undefined ? [] : [requestId])]);
    return response ? this.store.all('SELECT path FROM task_files WHERE response_id=? ORDER BY created_at,id', response.id).map(row => String(row.path)) : [];
  }
  async notifySession(sessionId: string, text: string, deliver = true): Promise<void> {
    const matches = this.store.all("SELECT id FROM conversations WHERE agent_session_id=? AND status='active'", sessionId);
    if (matches.length !== 1) return; // Unknown/ambiguous targets never fall back to a chat.
    const responseId = this.decisions.notice(String(matches[0].id), text, deliver);
    await this.history.write(`response:${responseId}`);
    this.publishText(sessionId, responseId, text, true);
  }
  ownsSession(sessionId: string): boolean { return Boolean(this.store.get('SELECT id FROM conversations WHERE agent_session_id=?', sessionId)); }
  ownsChannelIngress(source: string): boolean {
    return Boolean(this.store.get('SELECT id FROM conversations WHERE source=? LIMIT 1', source)) && !this.canReturnToLegacy();
  }
  ownsChannel(source: string, chatId: string): boolean {
    return Boolean(this.store.get('SELECT id FROM conversations WHERE source=? AND chat_id=? LIMIT 1', source, chatId)) && !this.canReturnToLegacy();
  }
  private gateway!: GatewayConfig;
  private assertBackend(agent = this.agent): void {
    if (this.gateway.gateway.headless === false) throw new OrchestrationError('UNSUPPORTED_ORCHESTRATION_BACKEND');
    if (process.platform !== 'linux') throw new OrchestrationError('UNSUPPORTED_PROCESS_SUPERVISOR');
    if (agent.claude.extraFlags?.length) throw new OrchestrationError('PROFILE_FLAGS_CONFLICT');
  }
  updateAgentConfig(agent: AgentConfig): void {
    if (agent.id !== this.agent.id || agent.type !== this.agent.type || agent.container !== this.agent.container || agent.workspace !== this.agent.workspace) throw new OrchestrationError('ORCHESTRATION_IDENTITY_CHANGED');
    if (agent.orchestration?.enabled) this.assertBackend(agent);
    // Keep the shared identity held by the worker driver and bridge services.
    // Replacing nested properties also removes old channel tokens on disable.
    this.configure(agent.orchestration, agent);
    for (const key of Object.keys(this.agent)) if (!(key in agent)) delete (this.agent as any)[key];
    Object.assign(this.agent, agent);
  }
  configure(config: AgentConfig['orchestration'], backendAgent = this.agent): void {
    if (config?.enabled) this.assertBackend(backendAgent);
    if (this.agent.type === 'app-agent') {
      if (config?.tasks?.projectRoot || (config?.tasks?.workspaceMode && config.tasks.workspaceMode !== 'container')) throw new OrchestrationError('CONTAINER_WORKSPACE_REQUIRED');
      config = { ...config, ...(config?.enabled === undefined ? {} : { enabled: config.enabled }), ...(config?.channels === undefined ? {} : { channels: config.channels }), tasks: { ...config?.tasks, workspaceMode: 'container' } };
    }
    if (this.agent.type !== 'app-agent' && config?.tasks?.workspaceMode === 'container') throw new OrchestrationError('CONTAINER_REQUIRED');
    this.config = resolveOrchestrationConfig(config, backendAgent.voice ?? { enabled: false });
    this.tasks.configure(config);
    if (!this.config.enabled) this.drain();
    else { this.draining = false; this.store.run("UPDATE conversations SET status='active' WHERE status='draining'"); }
  }
  dashboardSummary() {
    const tasks = this.store.all(`SELECT t.*,c.agent_session_id FROM tasks t JOIN conversations c ON c.id=t.conversation_id
      ORDER BY CASE WHEN t.active_attempt_id IS NOT NULL THEN 0 WHEN t.state IN ('completed','failed','cancelled') THEN 2 ELSE 1 END,t.updated_at DESC LIMIT 100`).map(row => {
      const snapshot = JSON.parse(String(row.snapshot_json));
      const latest = row.active_attempt_id ? { id: row.active_attempt_id } : this.store.get('SELECT id FROM task_attempts WHERE task_id=? ORDER BY generation DESC LIMIT 1', row.id);
      const attempt = latest ? this.store.attempt(String(latest.id)) : undefined;
      const event = this.store.get("SELECT payload_json FROM conversation_events WHERE json_extract(payload_json,'$.task_id')=? AND type='tool.activity' ORDER BY seq DESC LIMIT 1", row.id);
      const tool = event ? JSON.parse(String(event.payload_json)).payload : undefined;
      return { taskId: row.id, sessionId: row.agent_session_id, state: row.state, title: snapshot.title,
        execution: snapshot.execution, workerId: attempt?.workerId, workstreamId: snapshot.workstreamId, continueTaskId: snapshot.continueTaskId, resumed: attempt?.resumeSession,
        attemptId: attempt?.attemptId, workerSessionId: attempt?.sessionId, hostProcessId: row.active_attempt_id ? attempt?.processIdentity?.pid : undefined,
        container: this.agent.type === 'app-agent' ? this.agent.container : undefined,
        lastTool: tool ? { name: tool.name, type: tool.type, is_error: tool.is_error } : undefined };
    });
    const workers = this.store.all('SELECT * FROM worker_pool');
    const visible = [...new Set([...this.seenSessions, ...this.scheduler.startedSessions])];
    const sessions = this.store.all(`SELECT c.* FROM conversations c WHERE c.agent_session_id IN (SELECT value FROM json_each(?)) ORDER BY
      CASE WHEN EXISTS(SELECT 1 FROM tasks t WHERE t.conversation_id=c.id AND t.active_attempt_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM conversation_decisions d WHERE d.conversation_id=c.id AND d.state='running') THEN 0 ELSE 1 END,
      c.updated_at DESC LIMIT 50`, JSON.stringify(visible)).map(c => {
      const children = tasks.filter(t => t.sessionId === c.agent_session_id);
      const thinking = this.active.has(String(c.agent_session_id));
      const states = this.store.all("SELECT DISTINCT state FROM tasks WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled')", c.id).map(t => String(t.state));
      const state = thinking ? 'thinking' : states.includes('needs_reconciliation') ? 'needs_reconciliation'
        : states.some(state => ['starting','running','interrupting','cancel_requested'].includes(state)) ? 'working'
        : states.includes('waiting_input') ? 'waiting_input' : states.includes('queued') ? 'queued' : 'idle';
      return { orchestration: true, sessionId: String(c.agent_session_id), chatId: String(c.chat_id), source: String(c.source),
        mode: 'headless', model: '', tokens: 0, isRunning: thinking, status: state, spawnedAt: 0, uptimeSec: 0,
        tasks: children, workerIds: workers.filter(w => w.conversation_id === c.id).map(w => String(w.id)) };
    });
    return { enabled: this.config.enabled, backend: 'headless', workspaceMode: this.config.tasks.workspaceMode, sessions,
      workerPool: { maxWorkers: this.config.tasks.maxConcurrentPerAgent, idleTtlMs: this.config.tasks.workerIdleTtlMs, workers: this.store.all('SELECT id,session_id,conversation_id,workstream_id,active_task_id,idle_since FROM worker_pool').map(w => ({ workerId: w.id, sessionId: w.session_id, workstreamId: w.workstream_id, state: w.active_task_id ? 'busy' : 'idle', taskId: w.active_task_id, expiresAt: w.active_task_id ? undefined : Number(w.idle_since) + this.config.tasks.workerIdleTtlMs })) },
      activeAgentSessions: [...this.active.keys()], tasks };
  }
  private readonly textListeners = new Map<string, Set<{ principalId: string; receive: (value: { responseId: string; text: string; final: boolean }) => void }>>();
  subscribeText(sessionId: string, principalId: string, receive: (value: { responseId: string; text: string; final: boolean }) => void): () => void {
    this.authorizeSession(sessionId, principalId);
    let listeners = this.textListeners.get(sessionId);
    if (!listeners) this.textListeners.set(sessionId, listeners = new Set());
    const listener = { principalId, receive };
    listeners.add(listener);
    for (const row of this.store.all("SELECT r.* FROM assistant_responses r JOIN conversations c ON c.id=r.conversation_id WHERE c.agent_session_id=? AND r.state='generating'", sessionId))
      if (row.generated_text) receive({ responseId: String(row.id), text: String(row.generated_text), final: false });
    return () => { listeners!.delete(listener); if (!listeners!.size) this.textListeners.delete(sessionId); };
  }
  private publishText(sessionId: string, responseId: string, text: string, final = false): void {
    if (!final) this.store.run("UPDATE assistant_responses SET generated_text=? WHERE id=? AND state='generating'", text, responseId);
    for (const listener of this.textListeners.get(sessionId) ?? []) {
      try { this.authorizeSession(sessionId, listener.principalId); listener.receive({ responseId, text, final }); } catch { /* One client cannot stop inference. */ }
    }
  }
  saveVoiceAudio(sessionId: string, principalId: string, responseId: string, audio: Buffer): void {
    this.authorizeSession(sessionId, principalId);
    if (!this.store.get('SELECT r.id FROM assistant_responses r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.agent_session_id=?', responseId, sessionId)) return;
    this.store.saveResponseAudio(responseId, audio);
  }
  voiceAudio(sessionId: string, principalId: string, responseId?: string) {
    this.authorizeSession(sessionId, principalId);
    return this.store.responseAudio(sessionId, responseId);
  }
  authorizeSession(sessionId: string, principalId: string): void {
    for (const row of this.store.all('SELECT id FROM conversations WHERE agent_session_id=?', sessionId)) this.store.assertMember(String(row.id), principalId);
  }
  responseIdForInput(inputId: string): string | undefined {
    const response = this.store.get(`SELECT r.id FROM assistant_responses r JOIN conversation_decisions d ON d.id=r.decision_id
      WHERE EXISTS(SELECT 1 FROM json_each(d.input_ids_json) WHERE value=?) ORDER BY r.created_at DESC LIMIT 1`, inputId);
    return response ? String(response.id) : undefined;
  }
  recordPlayback(responseId: string, principalId: string, progress: { generation: string; epoch: number; generatedSamples: number; playedSamples: number }, state: string): void {
    if (this.closing) return;
    const response = this.store.get('SELECT conversation_id FROM assistant_responses WHERE id=?', responseId);
    if (!response) throw new OrchestrationError('RESPONSE_NOT_FOUND');
    this.store.assertMember(String(response.conversation_id), principalId);
    const binding = this.store.get('SELECT id FROM conversation_bindings WHERE conversation_id=?', response.conversation_id)!;
    this.store.run(`INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,audio_progress_json=excluded.audio_progress_json,updated_at=excluded.updated_at`,
      `voice:${responseId}:${progress.generation}:${progress.epoch}`, responseId, null, binding.id, 'audio', state, null, null, JSON.stringify(progress), Date.now());
  }
  send(input: AcceptInput, capabilities: ExecutionCapabilities, options: { timeoutMs: number; model?: string; onText?: (text: string) => void; onTool?: (event: ToolActivity) => void }): Promise<string> {
    if (this.closing) return Promise.reject(new OrchestrationError('ORCHESTRATION_CLOSING'));
    if (this.active.get(input.scope.agentSessionId)?.modality === 'live_voice' && input.modality !== 'live_voice') {
      const previous = this.sessionResponses.get(input.scope.agentSessionId);
      this.stopResponse(input.scope.agentSessionId);
      return Promise.resolve(previous).catch(() => '').then(() => this.send(input, capabilities, options));
    }
    if (this.active.get(input.scope.agentSessionId)?.notification) {
      const previous = this.sessionResponses.get(input.scope.agentSessionId);
      // A notification is an internal follow-up, not a competing user request.
      // Keep this submitted message and run it once that short response finishes.
      if (previous) return previous.catch(() => '').then(() => this.send(input, capabilities, options));
    }
    if (this.active.has(input.scope.agentSessionId)) return Promise.reject(new OrchestrationError('CONFLICT'));
    const result = this.run({ ...input, skill: input.skill ?? resolveSkill(input.text, input.scope.source, this.host.skills?.()), capabilities, model: options.model ?? input.model }, capabilities, options);
    this.pending.add(result);
    this.sessionResponses.set(input.scope.agentSessionId, result);
    void result.finally(() => {
      this.pending.delete(result);
      if (this.sessionResponses.get(input.scope.agentSessionId) === result) this.sessionResponses.delete(input.scope.agentSessionId);
    }).catch(() => {});
    return result;
  }
  async waitForTaskReport(sessionId: string, principalId: string, requestId: string, initialText: string, deadline: number): Promise<string> {
    const input = this.store.get(`SELECT i.id,i.conversation_id FROM conversation_inputs i JOIN conversations c ON c.id=i.conversation_id
      WHERE c.agent_session_id=? AND i.principal_id=? AND i.request_id=?`, sessionId, principalId, requestId);
    if (!input) throw new OrchestrationError('INPUT_NOT_FOUND');
    const conversationId = String(input.conversation_id);
    this.scheduledReports.add(conversationId);
    try {
      while (!this.closing) {
        const report = taskReport(this.store, String(input.id));
        if (!report.pending) return report.text ?? initialText;
        if (Date.now() >= deadline) throw new OrchestrationError('TASK_RESULT_TIMEOUT', 'Scheduled work did not produce a final report before its deadline; inspect its tasks before retrying.');
        this.pumpMailbox();
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new OrchestrationError('ORCHESTRATION_CLOSING');
    } finally { this.scheduledReports.delete(conversationId); }
  }
  submitInput(input: AcceptInput, capabilities: ExecutionCapabilities): { inputId: string; response: Promise<string>; stream?: AsyncIterable<{ responseId: string; text: string }> } {
    if (this.closing) throw new OrchestrationError('ORCHESTRATION_CLOSING');
    const receipt = this.store.acceptInput({ ...input, skill: input.skill ?? resolveSkill(input.text, input.scope.source, this.host.skills?.()), capabilities }, this.config.conversation.maxPendingInputs);
    const previous = this.inputResponses.get(receipt.inputId);
    if (previous) return { inputId: receipt.inputId, response: previous };
    const completed = this.store.get(`SELECT r.generated_text FROM assistant_responses r JOIN conversation_decisions d ON r.decision_id=d.id JOIN conversation_inputs i ON i.id=?
      WHERE i.status='handled' AND EXISTS(SELECT 1 FROM json_each(d.input_ids_json) WHERE value=i.id) ORDER BY r.created_at DESC LIMIT 1`, receipt.inputId);
    if (completed) return { inputId: receipt.inputId, response: Promise.resolve(String(completed.generated_text)) };
    const response = new Promise<string>((resolve, reject) => this.deferred.set(receipt.inputId, { resolve, reject }));
    this.inputResponses.set(receipt.inputId, response);
    const stream = input.modality === 'live_voice' ? new BoundedQueue<{ responseId: string; text: string }>(65536, chunk => Buffer.byteLength(chunk.text) + 128) : undefined;
    if (stream) this.inputStreams.set(receipt.inputId, stream);
    void response.then(() => stream?.close(), error => stream?.close(error instanceof Error ? error : new Error('CONVERSATION_FAILED'))).finally(() => { this.inputResponses.delete(receipt.inputId); this.inputStreams.delete(receipt.inputId); });
    void response.catch(() => {});
    this.pumpMailbox();
    return { inputId: receipt.inputId, response, stream };
  }
  private pumpMailbox(): void {
    if (this.closing) return;
    if (this.config.conversation.notificationPolicy === 'existing_receive_path' || this.scheduledReports.size) {
      for (const row of this.store.all("SELECT MIN(n.id) notification_id,c.* FROM notifications n JOIN conversations c ON c.id=n.conversation_id WHERE n.status='pending' AND c.agent_session_id NOT IN (SELECT value FROM json_each(?)) GROUP BY c.id LIMIT 20", JSON.stringify([...this.active.keys()]))) {
        if (this.config.conversation.notificationPolicy !== 'existing_receive_path' && !this.scheduledReports.has(String(row.id))) continue;
        if (this.active.has(String(row.agent_session_id))) continue;
        if (this.store.get("SELECT id FROM conversation_inputs WHERE conversation_id=? AND json_extract(ingress_json,'$.ingressKey')=?", row.id, `notification:${row.notification_id}`)) continue;
        this.store.acceptInput({ scope: { agentId: this.agent.id, agentSessionId: String(row.agent_session_id), source: row.source as ConversationScope['source'],
          accountId: String(row.account_id), chatId: String(row.chat_id), threadKey: String(row.thread_key), principalId: String(row.owner_principal_id) },
          text: 'Report the persisted task status update as your own work, preserving your persona. Present the actual result, current step or blocker directly; do not narrate receiving a worker report. If a task was cancelled, briefly confirm which task stopped. When cancellation.requestedBy is user, explicitly treat it as the user’s intentional stop, never an execution failure or an unexplained interruption. Do not retry or restart it. If cancellation is still pending, say stopping, not stopped. Do not start or modify tasks. This is a reporting-only turn by design, not an execution outage. Do not promise an automatic future retry or claim the execution system is unavailable. If a worker repeats an answered question, explain the specific unresolved discrepancy instead of asking the user to repeat the same approval.', storeUserMessage: false,
          modality: this.voiceListeners.get(String(row.agent_session_id))?.principalId === row.owner_principal_id ? 'live_voice' : undefined,
          ingressKey: `notification:${row.notification_id}`, capabilities: { execute: false, writeMemory: false } }, this.config.conversation.maxPendingInputs);
      }
    }
    for (const row of this.store.all("SELECT i.* FROM conversation_inputs i JOIN conversations c ON c.id=i.conversation_id WHERE i.status='accepted' AND c.agent_session_id NOT IN (SELECT value FROM json_each(?)) ORDER BY i.created_at,i.input_seq LIMIT 100", JSON.stringify([...this.active.keys()]))) {
      if (this.active.size >= this.config.conversation.maxActiveSessions) break;
      const input: AcceptInput = JSON.parse(String(row.ingress_json));
      if (!input.scope || !input.capabilities || this.active.has(input.scope.agentSessionId)) continue;
      // A persisted input retains the authenticated scope and model from ingress.
      // Recovery can repeat inference, but committed tool receipts remain fenced.
      const result = this.send({ ...input, acceptedInputId: String(row.id) }, input.capabilities,
        { timeoutMs: this.config.conversation.maxDecisionDurationMs, model: input.model, onText: text => {
          const responseId = this.responseIdForInput(String(row.id));
          if (input.modality !== 'live_voice' && responseId) { try { this.inputStreams.get(String(row.id))?.push({ responseId, text }); } catch { /* slow audio cannot stall inference */ } }
        } });
      void result.then(text => this.deferred.get(String(row.id))?.resolve(text), error => this.deferred.get(String(row.id))?.reject(error))
        .finally(() => this.deferred.delete(String(row.id)));
    }
  }
  private async run(input: AcceptInput, capabilities: ExecutionCapabilities, options: { timeoutMs: number; model?: string; onText?: (text: string) => void; onTool?: (event: ToolActivity) => void }): Promise<string> {
    const sessionId = input.scope.agentSessionId;
    const channelTts = this.telegramVoices.settings(channelVoiceKey(input.scope.source,input.scope.chatId,input.scope.threadKey));
    if (this.active.has(sessionId)) throw new OrchestrationError('CONFLICT');
    if (this.active.size >= this.config.conversation.maxActiveSessions) throw new OrchestrationError('CAPACITY_EXCEEDED');
    const active: { decision?: DecisionReceipt; turn?: ProcessTurn; stopping: boolean; modality?: string; notification?: boolean } = { stopping: false, modality: input.modality, notification: input.ingressKey?.startsWith('notification:') };
    this.active.set(sessionId, active);
    let agentSession: SessionProcess | undefined, revoke: (() => void) | undefined;
    try {
      const receipt = this.store.acceptInput(input, this.config.conversation.maxPendingInputs);
      const admitted = this.store.get('SELECT ingress_json FROM conversation_inputs WHERE id=?', receipt.inputId);
      const admittedModel = admitted ? JSON.parse(String(admitted.ingress_json)).model : undefined;
      options = { ...options, model: options.model ?? admittedModel ?? input.model };
      if (this.draining) this.store.run("UPDATE conversations SET status='draining' WHERE id=?", receipt.conversationId);
      this.seenSessions.add(sessionId);
      const decision = this.decisions.begin(receipt.conversationId, input.scope.principalId, [receipt.inputId], input.requestId);
      active.decision = decision;
      await this.host.refreshSkills?.();
      if (!input.skill) input = {...input, skill: resolveSkill(input.text, input.scope.source, this.host.skills?.())};
      const channelSpeech = ['telegram','discord','line','slack'].includes(input.scope.source) && (this.config.voice.enabled && this.config.voice.notes.replyWithVoice) && voiceReplyAllowed(this.store.channelVoiceMode(input.scope.source,input.scope.chatId,input.scope.threadKey), responseHasVoiceOrigin(this.store,decision.responseId!));
      const speechEnabled = channelSpeech || input.modality === 'live_voice' || this.voiceListeners.get(sessionId)?.principalId === input.scope.principalId;
      const typedSpeech = speechEnabled && input.modality !== 'live_voice';

      this.store.transaction(() => this.store.appendEvent(receipt.conversationId, 'response.started', { responseId: decision.responseId }));
      if (input.modality === 'voice_note') {
        let transcript = this.store.get('SELECT * FROM voice_note_transcripts WHERE input_id=?', receipt.inputId);
        if (!transcript) {
          this.store.run("INSERT INTO voice_note_transcripts VALUES(?,'processing',NULL,NULL)", receipt.inputId);
          try {
            if (!(this.config.voice.enabled && this.config.voice.notes.enabled)) throw new OrchestrationError('VOICE_NOTES_DISABLED');
            if (!input.attachmentIds?.[0]) throw new OrchestrationError('VOICE_NOTE_ATTACHMENT_MISSING');
            const path = MediaStore.resolvePath(join(this.agent.workspace, '../..'), this.agent.id, input.attachmentIds[0]);
            const text = await (this.host.transcribeNote ?? transcribeVoiceNote)(path, { ...this.config.voice.notes, language: this.config.voice.language });
            this.store.run("UPDATE voice_note_transcripts SET state='completed',text=? WHERE input_id=?", text, receipt.inputId);
          } catch (error) {
            const code = error instanceof OrchestrationError || error instanceof VoiceError ? error.code : 'VOICE_NOTE_STT_FAILED';
            this.store.run("UPDATE voice_note_transcripts SET state='failed',error_code=? WHERE input_id=?", code, receipt.inputId);
            console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'Voice note transcription failed', agentId: this.agent.id, sessionId, referenceId: receipt.inputId, code, provider: this.config.voice.notes.provider, model: this.config.voice.notes.model, ...describeVoiceError(code) }));
          }
          transcript = this.store.get('SELECT * FROM voice_note_transcripts WHERE input_id=?', receipt.inputId)!;
        }
        if (transcript.state !== 'completed') {
          const text = `${voiceNoteFailureMessage(String(transcript.error_code ?? 'VOICE_NOTE_INTERRUPTED'))} Reference: ${receipt.inputId}`;
          this.decisions.finish(decision, text, 'failed'); await this.flushHistory(); options.onText?.(text); return text;
        }
        input = { ...input, text: String(transcript.text), skill: resolveSkill(String(transcript.text), input.scope.source, this.host.skills?.()) };
        // Preserve original ingress/hash for provider retry; canonical history uses the transcript.
        this.store.run('UPDATE conversation_inputs SET text=? WHERE id=?', input.text, receipt.inputId);
      }
      const visualInput = await loadInputImages(join(this.agent.workspace, '../..'), this.agent.id, input.attachmentIds);
      if (input.skill && input.modality !== 'live_voice' && !channelSpeech && !visualInput.images.length && !visualInput.unavailable.length) {
        const task = this.tasks.spawn({ ...capabilities, ...receipt, ...decision, principalId: input.scope.principalId,
          model: options.model ?? this.agent.claude.model, actionId: `skill:${receipt.inputId}` }, {
          title: `/${input.skill.name}`, targetProfile: 'skill-worker', skill: input.skill,
          instructions: `Invoke the installed Skill tool named ${input.skill.name} with args ${JSON.stringify(input.skill.args)}. Follow its instructions within the worker capabilities. Report results and stage output files.`,
        });
        const text = `I've queued /${input.skill.name} as one of my tasks. I'll report the result when it's ready.`;
        // This deterministic receipt must not consume pending result notifications.
        this.store.run("UPDATE notifications SET status='pending',decision_id=NULL WHERE decision_id=? AND status='assigned'", decision.decisionId);
        this.store.run("UPDATE conversation_decisions SET notification_ids_json='[]' WHERE id=?", decision.decisionId);
        this.decisions.finish(decision, text);
        options.onText?.(text);
        await this.flushHistory();
        return text;
      }
      let taskSpeech = '';
      const ticket = this.bridge.issue({ role: 'agent', onTaskQueued: speechEnabled && !active.notification ? spoken => {
        if (taskSpeech) return; // A turn may delegate several tasks, but has one initial reply.
        taskSpeech = spoken;
        this.publishText(sessionId, decision.responseId!, spoken);
        this.store.transaction(() => {
          this.store.run('INSERT INTO response_speech VALUES(?,?)', decision.responseId!, spoken);
          // Channel speech is enqueued with the committed text in DecisionService.finish.
          // Live web voice retains its immediate acknowledgement below.
        });
        const stream = this.inputStreams.get(receipt.inputId);
        stream?.push({ responseId: decision.responseId!, text: spoken });
        if (typedSpeech) {
          const listener = this.voiceListeners.get(sessionId);
          if (listener?.principalId === input.scope.principalId) listener.receive({ responseId: decision.responseId!, text: spoken, spoken, requestId: input.requestId, speechOnly: true });
        }
        stream?.close(); // Flush TTS now, without waiting for the Agent terminal response.
      } : undefined, context: { ...capabilities, ...receipt, ...decision, model: options.model ?? this.agent.claude.model, principalId: input.scope.principalId } },
        join(this.root, 'decisions', decision.decisionId), this.agent.workspace, this.sharedKb);
      revoke = ticket.revoke;
      ticket.profile.overlay += '\n' + browserRouting(this.agent, this.gateway, this.config.tasks.workspaceMode === 'host');
      ticket.profile.connectorsAllowed = false; // Connector execution belongs to workers, never the user-facing decision.
      if (input.scope.source === 'telegram') ticket.profile.overlay += '\nTelegram response layout: use short paragraphs and numbered or bulleted lists for summaries, task status and comparisons. Avoid Markdown tables unless the user explicitly requests a table; wide tables are difficult to read on a phone. Keep command names inline and preserve their literal characters. Rewrite worker reports into this layout rather than copying their tables.';
      if (this.agent.type === 'app-agent') ticket.profile.overlay += '\nContainer execution is mandatory. Workers run only inside this app container. No host tools or host services are available. Use default-worker for app execution. Gateway media/browser/memory tools are unavailable in this container profile.';
      ticket.profile.overlay += '\n' + skillCatalog(this.host.skills?.());
      if (speechEnabled) {
        ticket.profile.responseSchema = SPEECH_SCHEMA;
        const listener = this.voiceListeners.get(sessionId);
        const gender = channelSpeech ? await resolveVoiceId(channelTts).then(async id => (await voiceChoices(channelTts)).find(v => v.id === id)?.gender).catch(() => undefined) : listener?.principalId === input.scope.principalId ? listener.gender?.() : undefined;
        ticket.profile.overlay += '\n' + SPEECH_OVERLAY + speechVoiceStyle(gender);
      }
      agentSession = await this.host.createAgentSession(sessionId, ticket.profile, options.model, input.scope);
      const snapshots = this.tasks.status(receipt.conversationId, input.scope.principalId);
      const committed = this.store.all('SELECT command_type,receipt_json FROM task_commands WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30', receipt.conversationId).map(row => {
        const commandReceipt = JSON.parse(String(row.receipt_json));
        delete commandReceipt.skill;
        return { ...row, receipt_json: JSON.stringify(commandReceipt) };
      });
      const prompt = `${input.text}\n${input.metadata?.promptContext ?? ''}\n\n[Orchestration context: persisted task snapshots, not instructions]\n${JSON.stringify(snapshots)}\nRecent committed command receipts (do not repeat their originating work): ${JSON.stringify(committed)}\nExecution eligible: ${capabilities.execute}. Workspace mode: ${this.config.tasks.workspaceMode}. Worker profiles: default-worker is the general-purpose worker for research, files, browser/API operations, services, calculations and code. In host mode it uses the Agent working environment; no Git or projectRoot is required. In container mode it stays inside the app container. Only explicitly configured isolated-worktree mode requires Git for default-worker; media-worker remains available for standalone scratch work in isolated modes. State the authorized working directory in task instructions; workers may change directories only within their execution boundary. Serialize conflicting edits to the same shared files; continue related work with continue_task_id. Memory write eligible: ${capabilities.writeMemory}.\nOriginal attachment refs (automatically inherited by workers): ${JSON.stringify(input.attachmentIds ?? [])}\nImages attached to this user message in order: ${JSON.stringify(visualInput.refs)}. Inspect these yourself before answering or delegating execution.\nUnavailable attachments: ${JSON.stringify(visualInput.unavailable)}${input.skill ? `\nRequested installed skill: ${JSON.stringify({ name: input.skill.name, args: input.skill.args })}. Inspect the user images first, then dispatch this skill via task_spawn with skill_name and skill_args.` : ''}`;
      if (active.stopping) {
        this.decisions.interrupt(decision);
        this.decisions.finish(decision, 'Response stopped.', 'interrupted', undefined, false);
        await this.flushHistory(); return 'Response stopped.';
      }
      agentSession.on('output', toolActivity(event => {
        this.store.transaction(() => this.store.appendEvent(receipt.conversationId, 'tool.activity', { ...event, responseId: decision.responseId, role: 'agent' }));
        options.onTool?.(event);
      }));
      let rawDisplay = '', streamedDisplay = '', structuredStarted = false;
      const displayChunk = (chunk: string) => {
        if (speechEnabled) {
          rawDisplay += chunk;
          if (Buffer.byteLength(rawDisplay) > 262144) throw new OrchestrationError('RESPONSE_TOO_LARGE');
          const next = partialDisplay(rawDisplay);
          if (!next || !next.startsWith(streamedDisplay)) return;
          chunk = next.slice(streamedDisplay.length);
          streamedDisplay = next;
        } else streamedDisplay += chunk;
        if (!chunk) return;
        this.publishText(sessionId, decision.responseId!, streamedDisplay);
        options.onText?.(chunk);
      };
      const turn = startProcessTurn(agentSession, prompt, Math.min(options.timeoutMs, this.config.conversation.maxDecisionDurationMs), text => {
        displayChunk(text);
      }, metrics => this.host.onManagedTurn?.(sessionId, input.text, metrics), visualInput.images, {
        startupTimeoutMs: this.config.conversation.startupTimeoutMs,
        firstResponseTimeoutMs: this.config.conversation.firstResponseTimeoutMs,
        idleTimeoutMs: this.config.conversation.idleTimeoutMs,
      }, chunk => {
        // StructuredOutput tool arguments are a separate JSON stream from commentary.
        if (!structuredStarted) { rawDisplay = ""; structuredStarted = true; }
        displayChunk(chunk);
      });
      active.turn = turn;
      const response = await turn.result;
      const surfaces = speechEnabled ? splitSpeechResponse(response.text) : { display: response.text, spoken: '' };
      const display = speechEnabled && response.interrupted ? streamedDisplay || 'Response stopped.' : surfaces.display || (response.interrupted ? 'Response stopped.' : '');
      this.decisions.finish(decision, display, response.interrupted ? 'interrupted' : 'completed', channelSpeech ? taskSpeech || surfaces.spoken : undefined, !active.stopping);
      if (speechEnabled && !response.interrupted && !taskSpeech) {
        if (!channelSpeech) this.store.run('INSERT INTO response_speech VALUES(?,?)', decision.responseId!, surfaces.spoken);
        if (surfaces.spoken) this.inputStreams.get(receipt.inputId)?.push({ responseId: decision.responseId!, text: surfaces.spoken });
      }
      if (speechEnabled && display.startsWith(streamedDisplay)) options.onText?.(display.slice(streamedDisplay.length));
      this.publishText(sessionId, decision.responseId!, display, true);
      await this.flushHistory();
      const listener = this.voiceListeners.get(sessionId);
      if ((active.notification || (typedSpeech && !taskSpeech)) && speechEnabled && !response.interrupted && listener?.principalId === input.scope.principalId) {
        try { listener.receive({ responseId: decision.responseId!, text: display, spoken: surfaces.spoken, requestId: input.requestId, speechOnly: typedSpeech }); } catch { /* playback cannot fail a persisted report */ }
      }
      return display;
    } catch (error) {
      // Retain a safe diagnostic code; never log prompts, credentials or provider bodies.
      const failure = error as { code?: string; name?: string; stack?: string };
      const failureCode = /^[A-Za-z0-9_]{1,80}$/.test(failure?.code ?? '') ? failure.code! : failure?.name ?? 'ERROR';
      console.error('[orchestration] response failed', { sessionId, code: failureCode, origin: failure?.stack?.split('\n').slice(1, 4) });
      if (active.decision) {
        const row = this.store.get('SELECT state,conversation_id FROM conversation_decisions WHERE id=?', active.decision.decisionId);
        if (row?.state === 'running') {
          this.store.transaction(() => this.store.appendEvent(String(row.conversation_id), 'response.error', { responseId: active.decision!.responseId, code: failureCode }));
          const timeout = (error as {timeout?: {phase: string; elapsedMs: number; idleMs: number}})?.timeout;
          if (timeout) this.store.transaction(() => this.store.appendEvent(String(row.conversation_id), 'response.timeout', {responseId: active.decision!.responseId, ...timeout}));
          const message = inferenceFailureMessage(error) ?? (error instanceof OrchestrationError && error.code === 'TIMEOUT'
            ? (timeout?.phase === 'startup' ? 'The agent could not finish starting in time.'
              : timeout?.phase === 'first_response' ? 'The model did not begin responding in time.'
              : timeout?.phase === 'idle' ? 'The agent stopped making progress before completing the reply.'
              : 'The agent reached its response time limit before completing the reply.') + ' Please check /tasks for any pending work.'
            : error instanceof OrchestrationError && error.code === 'PROFILE_INVENTORY_MISMATCH'
              ? 'The agent could not start because its tool configuration does not match the running gateway (PROFILE_INVENTORY_MISMATCH). Check that the gateway and MCP server are from the same deployment.'
              : 'The response could not be completed. Please check /tasks for any pending work.');
          this.decisions.finish(active.decision, message, 'failed');
        }
        else if (row?.state === 'interrupting') this.decisions.finish(active.decision, 'Response stopped.', 'interrupted', undefined, !active.stopping);
        await this.flushHistory();
        const failed = this.store.get('SELECT generated_text FROM assistant_responses WHERE id=?', active.decision.responseId!);
        if (failed?.generated_text) this.publishText(sessionId, active.decision.responseId!, String(failed.generated_text), true);
      }
      throw error;
    } finally {
      revoke?.();
      if (agentSession) await this.host.releaseAgentSession(sessionId, agentSession);
      this.active.delete(sessionId);
    }
  }
  stopResponse(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    if (!active || active.stopping) return false;
    active.stopping = true;
    if (active.decision && active.turn) {
      this.decisions.interrupt(active.decision);
      void active.turn.stop();
    }
    return true;
  }
  async flushHistory(): Promise<void> {
    for (const row of this.store.all("SELECT operation_id FROM history_operations WHERE state='pending' ORDER BY updated_at LIMIT 200")) await this.history.write(String(row.operation_id));
  }
  drain(): void {
    this.draining = true;
    this.store.run("UPDATE conversations SET status='draining' WHERE status='active'");
  }
  canReturnToLegacy(): boolean {
    return this.draining && !this.active.size && !this.pending.size && !this.store.get("SELECT id FROM conversation_inputs WHERE status IN ('accepted','assigned') LIMIT 1") && !this.store.get("SELECT id FROM tasks WHERE state NOT IN ('completed','failed','cancelled') LIMIT 1") &&
      !this.store.get("SELECT operation_id FROM history_operations WHERE state!='completed' LIMIT 1") && !this.store.get("SELECT id FROM notifications WHERE status!='handled' LIMIT 1");
  }
  async close(): Promise<void> {
    this.closing = true;
    this.lineLoading?.close();
    this.channelActivity?.close();
    this.telegramToolStatus?.close();
    if (this.mailboxTimer) clearInterval(this.mailboxTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    this.events.close();
    this.voiceListeners.clear();
    for (const waiter of this.deferred.values()) waiter.reject(new OrchestrationError('ORCHESTRATION_CLOSING'));
    this.deferred.clear();
    this.drain();
    for (const sessionId of this.active.keys()) this.stopResponse(sessionId);
    await this.scheduler.close();
    await this.settleResources();
    await Promise.allSettled([...this.pending]);
    await this.delivery.tick();
    await this.bridge.close();
    // Caller waits for pending conversational responses before releasing store.
    if (this.active.size) throw new OrchestrationError('ACTIVE_DECISIONS_DURING_SHUTDOWN');
    this.store.close();
    this.releaseLock();
  }
}
