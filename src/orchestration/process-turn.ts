import { toolOutcome, TurnObservation, ToolOutcome } from './execution-observation';
import type { InputImage } from '../session/input-image';
import { SessionProcess } from '../session/process';
import { OrchestrationError } from './types';

export interface TurnTimeoutPolicy { startupTimeoutMs: number; firstResponseTimeoutMs: number; idleTimeoutMs: number; acceptToolProgress?: boolean; idleAction?: 'observe'; onObservation?: (value: TurnObservation) => void; }
export interface TurnTimeoutDetails { phase: 'startup' | 'first_response' | 'idle' | 'total'; elapsedMs: number; idleMs: number; }
export interface ProcessResult { text: string; interrupted: boolean; }
export interface ProcessTurn {
  accepted: Promise<void>;
  result: Promise<ProcessResult>;
  stop(): Promise<void>;
}
/** Reuses the existing process/history lifecycle; a turn ends on a terminal
 * event or confirmed process exit. The owner decides task recovery policy. */
export interface ManagedTurnMetrics { toolIds: string[]; inputTokens: number; totalTokens: number; startedAt: number; }
export function startProcessTurn(process: SessionProcess, prompt: string, timeoutMs: number | undefined, onText: (text: string) => void = () => {}, onMetrics?: (metrics: ManagedTurnMetrics) => void, images: readonly InputImage[] = [], policy?: TurnTimeoutPolicy, onStructured?: (chunk: string) => void): ProcessTurn {
  let resolveAccepted!: () => void, rejectAccepted!: (error: Error) => void;
  let resolveResult!: (result: ProcessResult) => void, rejectResult!: (error: Error) => void;
  const accepted = new Promise<void>((resolve, reject) => { resolveAccepted = resolve; rejectAccepted = reject; });
  const result = new Promise<ProcessResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Both promises are observed immediately, including startup errors.
  void accepted.catch(() => {}); void result.catch(() => {});
  let structuredIndex: number | undefined;
  let settled = false, stopped = false, text = '', streamed = false, apiErrorText = '';
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
    fail(Object.assign(new OrchestrationError('TIMEOUT'), {timeout: details}));
    void stop();
  };
  const arm = (next: TurnTimeoutDetails['phase'], budget: number) => {
    phase = next; lastProgressAt = Date.now(); clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => expire(next), budget);
  };
  const cleanup = () => { if (!recorded) { recorded = true; try { onMetrics?.({ toolIds: [...tools], inputTokens, totalTokens, startedAt }); } catch { /* telemetry must not break delivery */ } } clearTimeout(timer); clearTimeout(phaseTimer); clearInterval(observationTimer); process.off('output', output); process.off('exit', exit); };
  const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); rejectAccepted(error); rejectResult(error); };
  const publish = (chunk: string): boolean => {
    try { onText(chunk); return true; }
    catch { fail(new OrchestrationError('RESPONSE_PERSISTENCE_FAILED')); void process.stop(); return false; }
  };
  const exit = () => {
    if (settled) return;
    if (stopped) { settled = true; cleanup(); rejectAccepted(new OrchestrationError('INTERRUPTED')); resolveResult({ text, interrupted: true }); }
    else fail(new OrchestrationError('PROCESS_EXITED'));
  };
  const output = (line: string) => {
    let event: Record<string, any>;
    if (settled) return;
    try { event = JSON.parse(line); } catch { return; }
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant' && (event.isApiErrorMessage || event.error)) {
      apiErrorText = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n').slice(0, 4096);
    }
    for (const block of blocks) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && !activeTools.has(block.id) && activeTools.size < 2000) activeTools.set(block.id, -1);
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && toolNames.size < 2000) toolNames.set(block.id, block.name.slice(0,128));
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
      if (event.type === 'system' && event.subtype === 'init' && phase === 'startup') arm('first_response', policy.firstResponseTimeoutMs);
      // Ignore keepalives, status chatter and stderr. Only actual inference or
      // tool-result progress renews the silence budget. Worker tool_progress
      // must refer to an active tool and advance; generic keepalives do not count.
      // message_start contains headers/usage, not a token. It must not replace
      // the first-response budget with a shorter idle budget.
      const delta = event.type === 'stream_event' ? event.event?.delta : undefined;
      const progress = (event.type === 'assistant' && Array.isArray(event.message?.content) && event.message.content.length > 0)
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
        ? /^(mcp__gateway__(memory_(get|search)|task_(spawn|status|cancel|update|answer)))$/
        : /^(Read|Glob|Grep|Bash|Edit|Write|Skill|mcp__gateway__(browser_[a-z_]+|generate_image|generate_video|share_file|share_image|memory_(get|search|shared_(get|create|update|delete))|task_(report_progress|request_input|stage_file|memory_append)))$/;
      if (!Array.isArray(event.tools) || event.tools.some((name: unknown) => typeof name !== 'string' || (!(role === 'worker' && process.runtimeProfile?.hostExecution) && !(role === 'agent' && process.runtimeProfile?.responseSchema && name === 'StructuredOutput') && !process.isSpawnedConnectorTool?.(name) && !allowed.test(name)))) {
        fail(new OrchestrationError('PROFILE_INVENTORY_MISMATCH'));
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
        const detail = String(event.result || (Array.isArray(event.errors) ? event.errors.join(' ') : '') || apiErrorText || text || 'Inference failed');
        const code = /provider capacity is fully in use|overloaded_error/i.test(detail) ? 'PROVIDER_CAPACITY'
          : /API Error:\s*503/i.test(detail) ? 'PROVIDER_UNAVAILABLE' : 'INFERENCE_FAILED';
        fail(new OrchestrationError(code, detail)); return;
      }
      if (process.runtimeProfile?.responseSchema && event.structured_output && typeof event.structured_output === 'object') {
        text = JSON.stringify(event.structured_output);
      } else if (typeof event.result === 'string' && event.result) text = event.result;
      if (!streamed && text && !publish(text)) return;
      resolveAccepted(); settled = true; cleanup(); resolveResult({ text, interrupted: stopped });
    }
  };
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopped = true;
      // Await real exit; SIGINT's boolean is not an acknowledgment.
      process.interrupt(); stopPromise = process.stop();
    }
    return stopPromise;
  };
  const observationTimer = policy?.onObservation ? setInterval(observe, 15000) : undefined;
  observationTimer?.unref();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => expire('total'), timeoutMs);
  if (policy) arm('startup', policy.startupTimeoutMs);
  process.on('output', output); process.on('exit', exit);
  void process.start().then(() => {
    if (stopped || settled) return process.stop();
    process.sendMessage(prompt, images);
  }).catch(error => { fail(error); void process.stop(); });
  return { accepted, result, stop };
}
