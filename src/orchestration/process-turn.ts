import type { CodexContextMeasurement } from '../session/codex-context';
import { BackgroundWork } from './background-work';
import { containerTaskTools } from './container-tool-schemas';
import { DEFAULT_WORKER_TOOLS } from '../session/runtime-profile';
import type { RequestToolSchemas } from '../session/request-tool-capture';
import { structuredProviderMessage } from './provider-message';
import { executionTool } from './tool-name';
import { TurnUsageCollector, TokenUsage, RequestUsage } from './token-usage';
import { toolOutcome, TurnObservation, ToolOutcome } from './execution-observation';
import type { InputImage } from '../session/input-image';
import type { SessionProcess } from '../session/process';
import { OrchestrationError } from './types';
import { providerErrorMetadata, ProviderErrorMetadata } from './provider-error-metadata';

export interface TurnTimeoutPolicy { pauseRequested?: () => boolean; onUsage?: (metrics: ManagedTurnMetrics) => void; startupTimeoutMs: number; firstResponseTimeoutMs: number; compactionTimeoutMs?: number; idleTimeoutMs: number; acceptToolProgress?: boolean; idleAction?: 'observe'; onObservation?: (value: TurnObservation) => void; }
export interface TurnTimeoutDetails { phase: 'startup' | 'first_response' | 'compaction' | 'idle' | 'total'; elapsedMs: number; idleMs: number; }
export interface ProcessResult { text: string; interrupted: boolean; paused?: boolean; }
/** Shared lifecycle contract; each backend normalizes its own native event protocol. */
export type WorkerProcess = { on(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown } & Pick<SessionProcess, 'start' | 'sendMessage' | 'interrupt' | 'stop' | 'runtimeProfile' | 'managedProcessId' | 'spawnedAt' | 'managedGroupStopped'> &
  Partial<Pick<SessionProcess, 'isSpawnedConnectorTool' | 'flushToolSchemas' | 'recordTurnOutcome'>>;
export interface ProcessTurn {
  providerReady: Promise<void>;
  accepted: Promise<void>;
  result: Promise<ProcessResult>;
  stop(): Promise<void>;
}
/** Reuses the existing process/history lifecycle; a turn ends on a terminal
 * event or confirmed process exit. The owner decides task recovery policy. */
export interface ManagedTurnMetrics { contextWindow?: CodexContextMeasurement; toolIds: string[]; inputTokens: number; totalTokens: number; startedAt: number; endedAt?: number; usage?: TokenUsage | null; requests?: RequestUsage[]; loadedTools?: string[] | null; usedTools?: string[]; contextTools?: string[] | null; schemaCoverage?: {measured:number;total:number}; model?: string; }
function providerErrorText(value: unknown, codes: string[], depth = 0, budget = { nodes: 256 }): string {
  if (depth >= 8 || --budget.nodes < 0) return '';
  if (typeof value === 'string') return value.slice(0, 4096);
  if (Array.isArray(value)) return value.slice(0, 32).map(item => providerErrorText(item, codes, depth + 1, budget)).filter(Boolean).join(' ').slice(0, 4096);
  if (value && typeof value === 'object') {
    const entry = value as Record<string, unknown>;
    for (const code of [entry.code, entry.type, entry.error]) {
      if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/i.test(code) && codes.length < 32) codes.push(code.toLowerCase());
    }
    const status = /^[1-5]\d{2}$/.test(String(entry.status)) ? `HTTP ${entry.status}` : undefined;
    return [entry.code, entry.type, status, entry.message, entry.error].map(item => providerErrorText(item, codes, depth + 1, budget)).filter(Boolean).join(' ').slice(0, 4096);
  }
  if (typeof value === 'number') return String(value);
  return '';
}
export function startProcessTurn(process: WorkerProcess, prompt: string, timeoutMs: number | undefined, onText: (text: string) => void = () => {}, onMetrics?: (metrics: ManagedTurnMetrics) => void, images: readonly InputImage[] = [], policy?: TurnTimeoutPolicy, onStructured?: (chunk: string) => void, alreadyStarted = false): ProcessTurn {
  let resolveAccepted!: () => void, rejectAccepted!: (error: Error) => void;
  let resolveResult!: (result: ProcessResult) => void, rejectResult!: (error: Error) => void;
  let resolveProvider!: () => void, rejectProvider!: (error: Error) => void;
  const providerReady = new Promise<void>((resolve, reject) => { resolveProvider = resolve; rejectProvider = reject; });
  void providerReady.catch(() => {});
  const accepted = new Promise<void>((resolve, reject) => { resolveAccepted = resolve; rejectAccepted = reject; });
  const result = new Promise<ProcessResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Both promises are observed immediately, including startup errors.
  void accepted.catch(() => {}); void result.catch(() => {});
  let structuredIndex: number | undefined;
  let finalCapturePending=false;
  let settled = false, stopped = false, text = '', streamed = false, apiErrorText = '';
  let apiErrorCodes: string[] = [];
  let apiErrorMetadata: ProviderErrorMetadata = {};
  let providerMessage: string | undefined;
  const usageCollector = new TurnUsageCollector();
  const background = new BackgroundWork();
  let pauseForInput = false;
  const startedAt = Date.now(); const tools = new Set<string>(); let inputTokens = 0, totalTokens = 0, recorded = false;
  const activeTools = new Map<string, number>();
  const toolNames = new Map<string, string>();
  let lastTool: ToolOutcome | undefined;
  const observe = () => {
    if (settled) return;
    try { policy?.onObservation?.({observedAt: Date.now(), lastProgressAt, phase, activeTools: [...activeTools.keys()].slice(0,16).map(id => toolNames.get(id) || 'tool'), quiet: Date.now()-lastProgressAt >= policy.idleTimeoutMs, lastTool}); } catch { /* Telemetry cannot stop execution. */ }
  };
  let stopPromise: Promise<void> | undefined;
  let phase: TurnTimeoutDetails['phase'] = 'startup', lastProgressAt = startedAt;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  const expire = (reason: TurnTimeoutDetails['phase']) => {
    if (settled) return;
    if (reason === 'idle' && policy?.idleAction === 'observe') { observe(); return; }
    const details: TurnTimeoutDetails = {phase: reason, elapsedMs: Date.now()-startedAt, idleMs: Date.now()-lastProgressAt};
    fail(Object.assign(new OrchestrationError('TIMEOUT'), {timeout: details, ...(apiErrorCodes.length || apiErrorMetadata.status ? { providerOrigin: true, providerCodes: apiErrorCodes, ...apiErrorMetadata } : {})}));
    void stop();
  };
  const arm = (next: TurnTimeoutDetails['phase'], budget: number) => {
    phase = next; lastProgressAt = Date.now(); clearTimeout(phaseTimer);
    const check = () => {
      const remaining = budget - (Date.now() - lastProgressAt);
      // Timers may fire just before the wall-clock deadline. Do not lose the
      // first quiet observation (or expire a response before its budget).
      if (remaining > 0) { phaseTimer = setTimeout(check, remaining); return; }
      expire(next);
    };
    phaseTimer = setTimeout(check, budget);
  };
  const cleanup = () => { if (!recorded) { recorded = true; try { const measured = usageCollector.snapshot(); onMetrics?.({ toolIds: [...tools], inputTokens: measured.usage ? measured.usage.inputTokens + measured.usage.cacheCreationTokens + measured.usage.cacheReadTokens : inputTokens, totalTokens: measured.usage?.totalTokens ?? totalTokens, startedAt, endedAt: Date.now(), ...measured }); } catch { /* telemetry must not break delivery */ } } clearTimeout(timer); clearTimeout(phaseTimer); clearInterval(observationTimer); process.off('output', output); process.off('request-tools', schemaOutput); process.off('exit', exit); process.off('startup-error', startupError); };
  const fail = (error: Error) => { if (settled) return; process.recordTurnOutcome?.((error as OrchestrationError).code === 'TIMEOUT' ? 'timeout' : (error as OrchestrationError).code === 'INTERRUPTED' ? 'cancelled' : 'failed', (error as OrchestrationError).code); settled = true; cleanup(); rejectProvider(error); rejectAccepted(error); rejectResult(error); };
  const publish = (chunk: string): boolean => {
    try { onText(chunk); return true; }
    catch { fail(new OrchestrationError('RESPONSE_PERSISTENCE_FAILED')); void process.stop(); return false; }
  };
  const startupError = (error: Error) => { fail(error); void process.stop(); };
  const exit = () => {
    if (settled || finalCapturePending) return;
    if (stopped) { settled = true; cleanup(); rejectAccepted(new OrchestrationError('INTERRUPTED')); resolveResult({ text, interrupted: true }); }
    else if (apiErrorText) fail(Object.assign(new OrchestrationError('INFERENCE_FAILED', apiErrorText), { providerOrigin: true, ...apiErrorMetadata, providerCodes: apiErrorCodes, providerMessage }));
    else fail(new OrchestrationError('PROCESS_EXITED'));
  };
  const schemaOutput = (value: RequestToolSchemas) => {
    if(settled)return;
    usageCollector.observeSchemas(value);
    try {const measured=usageCollector.snapshot();policy?.onUsage?.({toolIds:[...tools],inputTokens:measured.usage?.inputTokens??0,totalTokens:measured.usage?.totalTokens??0,startedAt,...measured});}catch{}
  };
  process.on('request-tools', schemaOutput);
  const output = (line: string) => {
    let event: Record<string, any>;
    if (settled) return;
    try { event = JSON.parse(line); } catch { return; }
    if (process.runtimeProfile?.role === 'worker') background.observe(event);
    if (event.type === 'result' && !event.is_error && process.runtimeProfile?.role === 'worker' && policy?.pauseRequested?.()) pauseForInput = true;
    if (event.type === 'result' && !event.is_error && !stopped && !pauseForInput && process.runtimeProfile?.role === 'worker' && background.pending) {
      // Decide at receipt, before asynchronous schema capture: a task may finish
      // during capture, but that cannot turn this earlier waiting result into
      // the final answer. Keep accounting for every native turn in the task.
      usageCollector.observe(event);
      text = ''; streamed = false;
      resolveAccepted();
      if (policy) arm('idle', policy.idleTimeoutMs);
      return;
    }
    if(event.type==='result'&&!event.gatewaySchemasFlushed&&typeof process.flushToolSchemas==='function'){
      finalCapturePending=true;
      void process.flushToolSchemas(usageCollector.snapshot().requests.map(r=>r.id)).then(values=>{for(const value of values)usageCollector.observeSchemas(value);}).catch(()=>{}).finally(()=>{finalCapturePending=false;output(JSON.stringify({...event,gatewaySchemasFlushed:true}));});
      return;
    }
    usageCollector.observe(event);
    if ((event.type === 'assistant' && event.message?.usage) || (event.type === 'system' && ['init','native_init','native_usage'].includes(event.subtype)) || (event.type === 'stream_event' && event.event?.type === 'message_stop')) {
      try {
        const measured = usageCollector.snapshot();
        policy?.onUsage?.({toolIds: [...tools], inputTokens: measured.usage ? measured.usage.inputTokens + measured.usage.cacheCreationTokens + measured.usage.cacheReadTokens : 0, totalTokens: measured.usage?.totalTokens ?? 0, startedAt, ...measured});
      } catch { /* Usage persistence must not terminate inference. */ }
    }
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const isProviderError = event.type === 'assistant' && (event.isApiErrorMessage || event.error);
    if (!isProviderError && ((event.type === 'assistant' && blocks.some((b: any) => ['text','thinking','tool_use'].includes(b.type)))
        || (event.type === 'stream_event' && ['text_delta','thinking_delta','input_json_delta'].includes(event.event?.delta?.type))
        || (event.type === 'result' && !event.is_error))) resolveProvider();
    if (isProviderError) {
      apiErrorCodes = [];
      apiErrorMetadata = providerErrorMetadata(event.error);
      providerMessage = blocks.filter((block: any) => block.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('\n') || structuredProviderMessage(event.error);
      apiErrorText = providerErrorText({ error: event.error, message: blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text) }, apiErrorCodes);
    }
    // A successful retry supersedes the earlier provider failure. Do not blame
    // a later process crash/terminal error on an already-recovered request.
    const resumedDelta = event.type === 'stream_event' ? event.event?.delta : undefined;
    if (!isProviderError && ((event.type === 'assistant' && blocks.length > 0)
        || (resumedDelta && ['text_delta', 'thinking_delta', 'input_json_delta'].includes(resumedDelta.type)
          && (resumedDelta.text || resumedDelta.thinking || resumedDelta.partial_json)))) {
      apiErrorText = ''; apiErrorCodes = []; apiErrorMetadata = {}; providerMessage = undefined;
    }
    for (const block of blocks) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && !activeTools.has(block.id) && activeTools.size < 2000) activeTools.set(block.id, -1);
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && toolNames.size < 2000) toolNames.set(block.id, executionTool(block).name.slice(0,128));
      if (block.type === 'tool_result') {
        const name = toolNames.get(block.tool_use_id);
        if (name) lastTool = toolOutcome(name, block, Date.now());
        activeTools.delete(block.tool_use_id); toolNames.delete(block.tool_use_id);
      }
    }
    const opening = event.type === 'stream_event' && event.event?.type === 'content_block_start' ? event.event.content_block : undefined;
    if (opening?.type === 'tool_use' && typeof opening.id === 'string' && activeTools.size < 2000 && !activeTools.has(opening.id)) activeTools.set(opening.id, -1);
    if (opening?.type === 'tool_use' && typeof opening.id === 'string' && typeof opening.name === 'string' && toolNames.size < 2000) toolNames.set(opening.id, opening.name.slice(0,128));
    if (process.runtimeProfile?.responseSchema && opening?.type === 'tool_use' && opening.name === 'StructuredOutput') structuredIndex = event.event.index;
    if (structuredIndex !== undefined && event.type === 'stream_event' && event.event?.index === structuredIndex && event.event?.delta?.type === 'input_json_delta') {
      try { onStructured?.(String(event.event.delta.partial_json ?? '')); } catch (error) { fail(error as Error); void process.stop(); return; }
    }
    if (event.type === 'stream_event' && event.event?.type === 'content_block_stop' && event.event.index === structuredIndex) structuredIndex = undefined;
    let toolProgress = false;
    if (policy?.acceptToolProgress && event.type === 'tool_progress' && activeTools.has(event.tool_use_id)
        && Number.isFinite(event.elapsed_time_seconds) && event.elapsed_time_seconds > activeTools.get(event.tool_use_id)!) {
      activeTools.set(event.tool_use_id, event.elapsed_time_seconds);
      toolProgress = true;
    }
    if (policy) {
      if (event.type === 'system' && ['init', 'native_init'].includes(event.subtype) && phase === 'startup') arm('first_response', policy.firstResponseTimeoutMs);
      // Compaction is a separate model request whose tokens are not streamed to
      // the parent. Do not kill it with the first-answer silence timer. The
      // caller's hard deadline remains in force, including repeated status events.
      if (event.type === 'system' && event.subtype === 'status' && event.status === 'compacting' && phase !== 'compaction') {
        arm('compaction', policy.compactionTimeoutMs ?? 300000);
      }
      if (phase === 'compaction' && event.type === 'system' &&
          (event.subtype === 'compact_boundary' || (event.subtype === 'status' && event.status === null))) {
        arm('first_response', policy.firstResponseTimeoutMs);
      }
      // Ignore keepalives, status chatter and stderr. Only actual inference or
      // tool-result progress renews the silence budget. Worker tool_progress
      // must refer to an active tool and advance; generic keepalives do not count.
      // message_start contains headers/usage, not a token. It must not replace
      // the first-response budget with a shorter idle budget.
      const delta = event.type === 'stream_event' ? event.event?.delta : undefined;
      const progress = (event.type === 'assistant' && !isProviderError && Array.isArray(event.message?.content) && event.message.content.length > 0)
        || (delta && ['text_delta','thinking_delta','input_json_delta'].includes(delta.type) && Boolean(delta.text || delta.thinking || delta.partial_json))
        || (event.type === 'user' && Array.isArray(event.message?.content) && event.message.content.some((b: any) => b.type === 'tool_result'));
      if (progress || toolProgress) arm('idle', policy.idleTimeoutMs);
    }
    for (const block of event.message?.content ?? []) if (block.type === 'tool_use' && typeof block.id === 'string' && tools.size < 2000) tools.add(block.id);
    const usage = event.usage ?? event.message?.usage;
    if (usage) { inputTokens = Math.max(inputTokens, Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0)); totalTokens = Math.max(totalTokens, inputTokens + Number(usage.output_tokens ?? 0)); }
    if (event.type === 'system' && event.subtype === 'init' && process.runtimeProfile) {
      const role = process.runtimeProfile.role;
      const allowed = role === 'agent'
        ? /^(mcp__gateway__(jev_evaluate|capabilities_list|conversation_intake|memory_(get|search)|task_(spawn|status|cancel|update|answer|question)))$/
        : /^(Read|Glob|Grep|Bash|Edit|Write|Skill|mcp__gateway__(jev_evaluate|tool_search|tool_call|browser_[a-z_]+|generate_image|generate_video|share_file|share_image|memory_(get|search|shared_(get|create|update|delete))|task_(report_progress|request_input|stage_file|memory_append)))$/;
      const allowedTool = (name: unknown): boolean => {
        if (typeof name !== 'string') return false;
        if (name === 'mcp__gateway__jev_evaluate' && !process.runtimeProfile?.jevEnabled) return false;
        if (process.runtimeProfile?.containerExecution) {
          // Validate the same scoped inventory that the container MCP client lists.
          return containerTaskTools(role, Boolean(process.runtimeProfile?.jevEnabled), Boolean(process.runtimeProfile?.browserEnabled)).some(tool => name === `mcp__gateway__${tool.name}`) ||
            (role === 'worker' && (process.runtimeProfile.workerTools ?? DEFAULT_WORKER_TOOLS).includes(name)) ||
            (role === 'agent' && Boolean(process.runtimeProfile.responseSchema) && name === 'StructuredOutput');
        }
        return (role === 'worker' && Boolean(process.runtimeProfile?.hostExecution)) ||
          (role === 'agent' && Boolean(process.runtimeProfile?.responseSchema) && name === 'StructuredOutput') ||
          Boolean(process.isSpawnedConnectorTool?.(name)) || allowed.test(name);
      };
      if (!Array.isArray(event.tools) || event.tools.some((name: unknown) => !allowedTool(name))) {
        const rejectedTools = Array.isArray(event.tools) ? event.tools.filter((name: unknown) => !allowedTool(name))
          .slice(0,100).map((name: unknown) => typeof name === 'string' ? name.replace(/[^a-zA-Z0-9_.:-]/g,'?').slice(0,160) : '<invalid-name>') : ['<missing-inventory>'];
        fail(Object.assign(new OrchestrationError('PROFILE_INVENTORY_MISMATCH'), { rejectedTools }));
        void process.stop(); return;
      }
    }
    if (event.type === 'assistant' || (event.type === 'stream_event' && event.event?.type === 'message_start')) resolveAccepted();
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
      const delta = event.event.delta.text;
      if (typeof delta === 'string') { streamed = true; text += delta; if (!publish(delta)) return; }
    }
    if (Buffer.byteLength(text) > 262144) { fail(new OrchestrationError('RESPONSE_TOO_LARGE')); void process.stop(); return; }
    if (event.type === 'result') {
      if (event.is_error) {
        // Native adapters can explicitly replace retry evidence, including with
        // no provider error. Claude's unmarked result events keep their existing
        // cached error behavior for native retries followed by process failure.
        if (event.gatewayProviderErrorAuthoritative === true) {
          apiErrorCodes = []; apiErrorMetadata = {}; apiErrorText = ''; providerMessage = undefined;
        }
        const providerCodes = [...apiErrorCodes];
        const detail = [apiErrorText, providerErrorText([event.result, event.errors], providerCodes)].filter(Boolean).join(' ').slice(0, 4096) || 'Inference failed';
        const terminalCode = event.subtype === 'error_max_turns' ? 'MODEL_MAX_TURNS'
          : event.subtype === 'error_max_budget_usd' ? 'MODEL_BUDGET_EXCEEDED'
          : event.subtype === 'error_max_structured_output_retries' ? 'MODEL_OUTPUT_INVALID' : undefined;
        const code = terminalCode ?? (/provider capacity is fully in use|overloaded_error/i.test(detail) ? 'PROVIDER_CAPACITY'
          : /\b(?:API Error:|HTTP)\s*503\b/i.test(detail) ? 'PROVIDER_UNAVAILABLE' : 'INFERENCE_FAILED');
        fail(Object.assign(new OrchestrationError(code, detail), { providerOrigin: !terminalCode, ...apiErrorMetadata, ...providerErrorMetadata(event.errors), providerCodes, providerMessage: providerMessage || structuredProviderMessage(event.result) || structuredProviderMessage(event.errors) })); return;
      }
      if (process.runtimeProfile?.responseSchema && event.structured_output && typeof event.structured_output === 'object') {
        text = JSON.stringify(event.structured_output);
      } else if (typeof event.result === 'string' && event.result) text = event.result;
      // The CLI can emit a final-only result, or replace a short stream with
      // a larger canonical/structured result. Apply the same byte limit before
      // publishing or recording success, without silently shortening evidence.
      if (Buffer.byteLength(text) > 262144) { fail(new OrchestrationError('RESPONSE_TOO_LARGE')); void process.stop(); return; }
      if (!stopped && !pauseForInput && process.runtimeProfile?.role === 'worker' && !text.trim()) {
        fail(new OrchestrationError('WORKER_RESULT_MISSING', 'The worker ended without a final response. Inspect its changes before retrying; dependent tasks were not authorized by this empty result.'));
        return;
      }
      if (!streamed && text && !publish(text)) return;
      process.recordTurnOutcome?.(stopped ? 'cancelled' : 'completed');
      resolveAccepted(); settled = true; cleanup(); resolveResult({ text, interrupted: stopped, ...(pauseForInput ? {paused:true} : {}) });
    }
  };
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopped = true;
      if (!settled) process.recordTurnOutcome?.('cancelled');
      // Await real exit; SIGINT's boolean is not an acknowledgment.
      process.interrupt(); stopPromise = process.stop();
    }
    return stopPromise;
  };
  const observationTimer = policy?.onObservation ? setInterval(observe, 15000) : undefined;
  observationTimer?.unref();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => expire('total'), timeoutMs);
  if (policy) arm('startup', policy.startupTimeoutMs);
  process.on('output', output); process.on('exit', exit); process.on('startup-error', startupError);
  void (alreadyStarted ? Promise.resolve() : process.start()).then(() => {
    if (stopped || settled) return process.stop();
    process.sendMessage(prompt, images);
  }).catch(error => { fail(error); void process.stop(); });
  return { accepted, providerReady, result, stop };
}
