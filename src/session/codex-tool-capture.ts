import type { RequestToolSchemas } from './request-tool-capture';
export interface CodexTraceState { files: Record<string, { offset: number; remainder: string }>; pending: Array<{ directory: string; event: any }>; calls: Record<string, { model?: string; loaded?: string[]; deferred?: string[] }>; responses?: Record<string, { loaded: string[]; deferred: string[] }>; }
export interface CodexTraceMeasurement { schemas?: RequestToolSchemas; request?: { id: string; model?: string; usage: Record<string, number> }; }
/** Self-contained so the identical reader can execute inside an app container.
 * Raw request/response payloads never cross the container boundary or enter the DB. */
export function scanCodexTrace(root: string, state: CodexTraceState): { state: CodexTraceState; measurements: CodexTraceMeasurement[] } {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const measurements: CodexTraceMeasurement[] = [];
  const read = (file: string, limit: number): string | undefined => {
    let fd: number | undefined;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const st = fs.fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > limit) return; return fs.readFileSync(fd, 'utf8'); }
    catch { return; } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const safeParent = (file: string): boolean => {
    try { return fs.realpathSync(path.dirname(file)) === path.dirname(file); } catch { return false; }
  };
  const remove = (file: string) => { try { if (safeParent(file)) fs.unlinkSync(file); } catch {} };
  let directories: string[];
  try { directories = fs.readdirSync(root).filter(name => /^trace-[a-f0-9-]+$/.test(name) && !fs.lstatSync(path.join(root, name)).isSymbolicLink()).slice(0, 64); } catch { return { state, measurements }; }
  for (const directory of directories) {
    const file = path.join(root, directory, 'trace.jsonl');
    const cursor = state.files[directory] ??= { offset: 0, remainder: '' };
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) continue;
      if (stat.size < cursor.offset) { cursor.offset = 0; cursor.remainder = ''; }
      const buffer = Buffer.alloc(Math.min(2 * 1024 * 1024, stat.size - cursor.offset));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset); cursor.offset += bytes;
      const lines = (cursor.remainder + buffer.toString('utf8', 0, bytes)).split('\n'); cursor.remainder = lines.pop() ?? '';
      if (cursor.remainder.length > 1024 * 1024) cursor.remainder = '';
      for (const line of lines) try {
        const event = JSON.parse(line);
        if (event.schema_version === 1 && event.payload) state.pending.push({ directory, event: event.payload });
      } catch { /* Incomplete/unsupported telemetry must not break the worker. */ }
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const waiting: CodexTraceState['pending'] = [];
  for (const entry of state.pending.slice(-2048)) {
    const event = entry.event;
    const ref = event.type === 'inference_started' ? event.request_payload : event.type === 'inference_completed' ? event.response_payload : undefined;
    const id = event.inference_call_id;
    if (ref && typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(id) && /^payloads\/[0-9]+\.json$/.test(ref.path)) {
      const file = path.join(root, entry.directory, ref.path);
      if (!safeParent(file)) continue;
      const raw = read(file, 16 * 1024 * 1024);
      if (raw === undefined) { waiting.push(entry); continue; }
      let body: any; try { body = JSON.parse(raw); } catch { waiting.push(entry); continue; }
      if (event.type === 'inference_started') {
        // An explicit tools array replaces the preceding request's inventory,
        // including tools: []; only omitted inventories inherit it.
        const inherited = !Array.isArray(body.tools) && typeof body.previous_response_id === 'string' ? state.responses?.[body.previous_response_id] : undefined;
        const additional = Array.isArray(body.input) ? body.input.filter((item: any) => item?.type === 'additional_tools' && Array.isArray(item.tools)) : [];
        const known = Array.isArray(body.tools) || additional.length > 0 || inherited !== undefined;
        const loaded = new Set<string>(inherited?.loaded), deferred = new Set<string>(inherited?.deferred);
        const collect = (tools: any[], prefix = '', depth = 0) => {
          if (depth > 8) return;
          for (const tool of tools.slice(0, 10000)) {
            if (typeof tool?.name !== 'string' || !tool.name || tool.name.length > 256) continue;
            if (tool.type === 'namespace' && Array.isArray(tool.tools)) collect(tool.tools, prefix + tool.name + '__', depth + 1);
            else {
              (tool.defer_loading === true ? deferred : loaded).add(prefix + tool.name);
              // Code Mode embeds callable schemas in the exec tool description.
              // Only explicit declarations count; ALL_TOOLS catalog names do not.
              if (prefix === 'functions__' && tool.name === 'exec' && typeof tool.description === 'string' && tool.defer_loading !== true) {
                for (const match of tool.description.matchAll(/declare const tools:\s*\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) loaded.add(match[1]);
              }
            }
          }
        };
        if (Array.isArray(body.tools)) collect(body.tools);
        for (const item of additional) collect(item.tools);
        // Tool-search results can activate a deferred schema in later requests.
        let visited = 0;
        const references = (value: any, depth = 0) => {
          if (++visited > 50000 || depth > 24 || !value || typeof value !== 'object') return;
          if (value.type === 'tool_reference' && typeof value.tool_name === 'string' && deferred.delete(value.tool_name)) loaded.add(value.tool_name);
          for (const child of Object.values(value)) if (typeof child === 'object') references(child, depth + 1);
        };
        references(body.input);
        state.calls[id] = { model: typeof body.model === 'string' ? body.model : undefined, ...(known ? { loaded: [...loaded].sort(), deferred: [...deferred].sort() } : {}) };
        if (known) measurements.push({ schemas: { messageId: id, requestId: id, source: 'codex-request-body', loaded: [...loaded].sort(), deferred: [...deferred].sort() } });
      } else if (event.type === 'inference_completed') {
        const u = body.token_usage;
        const valid = (n: any) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
        if (u && valid(u.input_tokens) && valid(u.output_tokens)) {
          const read = valid(u.cached_input_tokens) ? Math.min(u.input_tokens, u.cached_input_tokens) : 0;
          const write = valid(u.cache_write_input_tokens) ? Math.min(u.input_tokens - read, u.cache_write_input_tokens) : 0;
          measurements.push({ request: { id, model: state.calls[id]?.model, usage: { input_tokens: u.input_tokens - read - write, cache_read_input_tokens: read, ...(valid(u.cache_write_input_tokens) ? { cache_creation_input_tokens: write } : {}), output_tokens: u.output_tokens } } });
        }
        const call = state.calls[id];
        if (typeof body.response_id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(body.response_id) && call?.loaded) {
          (state.responses ??= {})[body.response_id] = { loaded: call.loaded, deferred: call.deferred ?? [] };
          while (Object.keys(state.responses).length > 128) delete state.responses[Object.keys(state.responses)[0]];
        }
        delete state.calls[id];
      }
      remove(file);
    }
    // Non-inference payloads contain prompts/tool results we never need to retain.
    for (const value of Object.values(event) as any[]) if (value && typeof value === 'object' && /^payloads\/[0-9]+\.json$/.test(value.path) && value !== ref) remove(path.join(root, entry.directory, value.path));
  }
  state.pending = waiting.slice(-512);
  while (Object.keys(state.calls).length > 512) delete state.calls[Object.keys(state.calls)[0]];
  return { state, measurements };
}
