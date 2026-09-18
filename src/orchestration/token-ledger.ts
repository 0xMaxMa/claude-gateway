import type { ManagedTurnMetrics } from './process-turn';
import { OrchestrationStore } from './store';
import { sumUsage } from './token-usage';

export interface TokenTurn extends ManagedTurnMetrics {
  id: string;
  sessionId: string;
  role: 'agent' | 'worker';
  category: 'input' | 'report' | 'worker';
  taskId?: string;
  taskRevision?: number;
  inputTexts?: string[];
  inputModalities?: string[];
  inputSequences?: number[];
  responseText?: string;
  taskTitle?: string;
  state?: string;
  failureCode?: string;
  /** Stored attempt number for a worker turn; the stable label for a row that has
   *  no input_seq of its own. */
  attemptGeneration?: number;
  /** This row is an accepted input that has no measured turn yet. Never real usage:
   *  it is derived on read and is absent from token_turns, so no aggregate sees it. */
  pending?: true;
  /** How long the input waited between acceptance and its turn starting — or, on a
   *  pending row, how long it has been waiting so far. */
  queuedMs?: number;
}
const initialized = new WeakSet<OrchestrationStore>();
/** Latest observed request in the most recent agent turn, including its output.
 * A peak earlier in the turn may predate compaction and is not current context. */
function latestAgentContextWindow(store: Pick<OrchestrationStore, 'get'>, sessionId: string): { used: number; total: number | null; model: string | null } | null {
  const row = store.get(`SELECT payload_json FROM token_turns WHERE session_id=? AND role='agent' AND EXISTS (SELECT 1 FROM json_each(token_turns.payload_json,'$.requests') r WHERE json_type(r.value,'$.usage')='object') ORDER BY started_at DESC,id DESC LIMIT 1`, sessionId);
  if (!row) return null;
  let turn: TokenTurn;
  try { turn = JSON.parse(String(row.payload_json)) as TokenTurn; } catch { return null; }
  const requests = Array.isArray(turn.requests) ? turn.requests : [];
  let best: { context: number; total: number } | null = null;
  for (const request of requests) {
    const usage = request?.usage;
    if (!usage) continue;
    const context = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheCreationTokens ?? 0);
    best = { context, total: Number(usage.totalTokens ?? 0) };
  }
  if (!best) return null;
  return { used: best.total, total: null, model: typeof turn.model === 'string' ? turn.model : null };
}
// Dashboard polling never reloads full request arrays or conversation text.
// Cache only projected measurements, invalidate the affected session on writes.
const summaries = new WeakMap<OrchestrationStore, Map<string, TokenTurn[]>>();
export function measuredTurns(store: OrchestrationStore, sessionId: string): TokenTurn[] {
  ensure(store);
  let cache = summaries.get(store);
  if (!cache) { cache = new Map(); summaries.set(store, cache); }
  const found = cache.get(sessionId);
  if (found) return found;
  const turns = store.all(`SELECT id, role, task_id, started_at,
    json_extract(payload_json,'$.usage') AS usage,
    json_extract(payload_json,'$.loadedTools') AS loaded_tools,
    json_extract(payload_json,'$.contextTools') AS context_tools,
    json_extract(payload_json,'$.usedTools') AS used_tools
    FROM token_turns WHERE session_id=? ORDER BY started_at,id`, sessionId).map(row => ({
      id: String(row.id), sessionId, role: String(row.role) as TokenTurn['role'], category: String(row.role) === 'worker' ? 'worker' as const : 'input' as const,
      taskId: row.task_id == null ? undefined : String(row.task_id), startedAt: Number(row.started_at), toolIds: [], inputTokens: 0, totalTokens: 0,
      contextTools: row.context_tools == null ? null : JSON.parse(String(row.context_tools)),
      usage: row.usage == null ? null : JSON.parse(String(row.usage)), loadedTools: row.loaded_tools == null ? null : JSON.parse(String(row.loaded_tools)),
      usedTools: row.used_tools == null ? [] : JSON.parse(String(row.used_tools)),
    }));
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(sessionId, turns);
  return turns;
}
function ensure(store: OrchestrationStore): void {
  if (initialized.has(store)) return;
  store.run(`CREATE TABLE IF NOT EXISTS token_turns(id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    role TEXT NOT NULL, task_id TEXT, started_at INTEGER NOT NULL, payload_json TEXT NOT NULL)`);
  store.run('CREATE INDEX IF NOT EXISTS token_turns_session ON token_turns(session_id,started_at)');
  store.run(`CREATE TABLE IF NOT EXISTS token_turn_metrics(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at INTEGER NOT NULL, payload_json TEXT NOT NULL)`);
  store.run('CREATE INDEX IF NOT EXISTS token_turn_metrics_session ON token_turn_metrics(session_id,started_at)');
  store.run('CREATE INDEX IF NOT EXISTS token_turns_started ON token_turns(started_at)');
  initialized.add(store);
}
export function recordTokenTurn(store: OrchestrationStore, turn: TokenTurn): void {
  ensure(store);
  store.compose(() => {
  store.run(`INSERT INTO token_turns VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`,
    turn.id, turn.sessionId, turn.role, turn.taskId ?? null, turn.startedAt, JSON.stringify(turn));
  store.run(`INSERT INTO token_turn_metrics VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`,
    turn.id,turn.sessionId,turn.startedAt,JSON.stringify({...turn,requests:undefined,inputTexts:undefined,responseText:undefined}));
  });
  const cached = summaries.get(store)?.get(turn.sessionId);
  if (cached) {
    const projection = {...turn, requests: undefined, inputTexts: undefined, responseText: undefined};
    const index = cached.findIndex(previous => previous.id === turn.id);
    if (index < 0) cached.push(projection); else cached[index] = projection;
  }
}
export function tokenReport(store: OrchestrationStore, sessionId: string, includeDetails = true) {
  ensure(store);
  return readTokenReport(store, sessionId, includeDetails);
}
/** Accepted inputs that have no measured ledger turn yet.
 *
 * Turns are serialised per session on purpose (runtime.ts skips a session that already
 * has a decision in flight), so a message sent while the previous turn is still running
 * waits — occasionally minutes — before its own decision starts, and the token_turns row
 * only appears with that turn's first usage event. Until then the report had no row for
 * the message at all, which is why a queued message looked lost.
 *
 * These rows are DERIVED ON EVERY READ from conversation_inputs rather than written into
 * token_turns, which is what the rest of this read path already does for decisions,
 * responses, tasks and attempts. Two properties fall out of that choice for free:
 *  - the ledger stays purely measured usage, so no total, average, distribution or
 *    %cached query can ever see a pending row (they all sum token_turns);
 *  - a pending row cannot get stuck. It exists only while the input is genuinely still
 *    'accepted'/'assigned' with no measured turn, so a handled, interrupted or replaced
 *    input drops out immediately, and a gateway restart (recovery.ts resets 'assigned'
 *    back to 'accepted') leaves it truthfully queued rather than permanently "running".
 */
export function pendingInputTurns(store: Pick<OrchestrationStore, 'all'>, sessionId: string,
  since = 0, hasLedger = true, now = Date.now()): TokenTurn[] {
  // An input whose decision already recorded usage is represented by that real turn.
  const measured = hasLedger ? `AND NOT EXISTS (SELECT 1 FROM conversation_decisions d JOIN token_turns t ON t.id=d.id
      WHERE d.conversation_id=i.conversation_id
      AND EXISTS (SELECT 1 FROM json_each(d.input_ids_json) j WHERE j.value=i.id))` : '';
  return store.all(`SELECT i.id,i.input_seq,i.text,i.modality,i.created_at,i.status,i.store_user_message
    FROM conversation_inputs i JOIN conversations c ON c.id=i.conversation_id
    WHERE c.agent_session_id=? AND i.status IN ('accepted','assigned') AND i.created_at>=? ${measured}
    ORDER BY i.created_at DESC,i.input_seq DESC LIMIT 50`, sessionId, since).map(row => ({
      id: String(row.id), sessionId, role: 'agent' as const,
      // store_user_message=0 is an orchestration report request, not a user message.
      category: row.store_user_message ? 'input' as const : 'report' as const,
      pending: true as const, startedAt: Number(row.created_at),
      queuedMs: Math.max(0, now - Number(row.created_at)),
      toolIds: [], inputTokens: 0, totalTokens: 0, usage: null,
      inputTexts: [String(row.text)], inputModalities: [String(row.modality)], inputSequences: [Number(row.input_seq)],
      // 'assigned' means its decision has begun but no usage has been reported yet.
      state: String(row.status) === 'assigned' ? 'starting' : 'queued',
    }));
}
export function readTokenReport(store: Pick<OrchestrationStore, 'all' | 'get' | 'attempt'>, sessionId: string, includeDetails = true, page?: {offset: number; limit: number; since?: number; newestFirst?: boolean}) {
  const since = page?.since ?? 0;
  const order = page?.newestFirst ? 'DESC' : 'ASC';
  const turns = store.all(`SELECT payload_json FROM token_turns WHERE session_id=? AND started_at>=? ORDER BY started_at ${order},id ${order} LIMIT ? OFFSET ?`, sessionId, since, page?.limit ?? -1, page?.offset ?? 0)
    .map(row => {
      const turn = JSON.parse(String(row.payload_json)) as TokenTurn;
      if (!includeDetails) return turn;
      if (turn.role === 'agent') {
        const decision = store.get('SELECT d.* FROM conversation_decisions d JOIN conversations c ON c.id=d.conversation_id WHERE d.id=? AND c.agent_session_id=?', turn.id, sessionId);
        if (decision) {
          const inputs = store.all('SELECT text,modality,input_seq,created_at FROM conversation_inputs WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY input_seq', decision.conversation_id, decision.input_ids_json);
          turn.inputTexts = inputs.map(input => String(input.text));
          turn.inputModalities = inputs.map(input => String(input.modality));
          turn.inputSequences = inputs.map(input => Number(input.input_seq));
          // How long the earliest input waited for this turn to start. Serialised turns
          // mean a short message can sit queued for minutes; without this the turn just
          // looks slow instead of "queued behind the previous turn".
          const accepted = inputs.map(input => Number(input.created_at)).filter(value => Number.isFinite(value) && value > 0);
          if (accepted.length && Number.isFinite(Number(decision.started_at))) turn.queuedMs = Math.max(0, Number(decision.started_at) - Math.min(...accepted));
          turn.responseText = store.all('SELECT generated_text FROM assistant_responses WHERE decision_id=? ORDER BY created_at,id', turn.id).map(response => String(response.generated_text)).join('\n\n');
          turn.state = String(decision.state);
          if (turn.state === 'failed') {
            const failure = store.get("SELECT json_extract(payload_json,'$.payload.code') code FROM conversation_events WHERE conversation_id=? AND type='response.error' AND json_extract(payload_json,'$.payload.responseId') IN (SELECT id FROM assistant_responses WHERE decision_id=?) ORDER BY seq DESC LIMIT 1", decision.conversation_id, turn.id);
            if (typeof failure?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(failure.code)) turn.failureCode = failure.code;
          }

        }
      } else if (turn.taskId) {
        const task = store.get('SELECT t.snapshot_json FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.agent_session_id=?', turn.taskId, sessionId);
        const attempt = store.attempt(turn.id);
        if (task && attempt) {
          const snapshot = JSON.parse(String(task.snapshot_json));
          const revision = store.get('SELECT payload_json FROM task_revisions WHERE task_id=? AND revision=?', turn.taskId, attempt.revision);
          turn.taskTitle = snapshot.title;
          if (revision) {
            const applied = JSON.parse(String(revision.payload_json));
            turn.inputTexts = [`Current applied task revision ${attempt.revision}:\n${applied.instructions}`,
              ...(applied.answers?.length ? ['Answers applied to the assignment (orchestrator interpretation):\n' + JSON.stringify(applied.answers, null, 2)] : []),
              ...(applied.guidance ? ['Recorded supervision advice (may have been superseded by newer evidence):\n' + applied.guidance] : [])];
            if (turn.taskRevision != null && turn.taskRevision !== attempt.revision) {
              const initial = store.get('SELECT payload_json FROM task_revisions WHERE task_id=? AND revision=?', turn.taskId, turn.taskRevision);
              if (initial) turn.inputTexts.unshift(`Assignment at attempt start, revision ${turn.taskRevision}:\n${String(initial.payload_json)}`);
            }
          }
          turn.state = attempt.state;
          // Stored, stable label for a worker row: it has no input_seq of its own.
          turn.attemptGeneration = Number(attempt.generation);
          // A task's newest result must not be attributed to an older retry.
          if (snapshot.activeAttemptId === turn.id || store.get('SELECT id FROM task_attempts WHERE task_id=? ORDER BY generation DESC LIMIT 1', turn.taskId)?.id === turn.id) turn.responseText = snapshot.result?.summary;
        }
      }
      return turn;
    });
  // Newest page only: a queued input is by definition newer than every recorded turn, so
  // repeating it while paging back through history would be noise. Pending rows are
  // appended to the view, never to token_turns, so every aggregate below ignores them.
  if (includeDetails && !(page?.offset ?? 0)) turns.push(...pendingInputTurns(store, sessionId, since));
  const totalsByRole = store.all(`SELECT role, SUM(json_extract(payload_json,'$.usage.totalTokens')) total FROM token_turns WHERE session_id=? AND started_at>=? GROUP BY role`,sessionId,since);
  const agentTokens = totalsByRole.find(row=>row.role==='agent')?.total ?? null;
  const workerTokens = totalsByRole.find(row=>row.role==='worker')?.total ?? null;
  const totalTokens = agentTokens === null && workerTokens === null ? null : Number(agentTokens??0)+Number(workerTokens??0);
  const distribution = store.all(`SELECT json_extract(payload_json,'$.category') category, SUM(json_extract(payload_json,'$.usage.totalTokens')) tokens FROM token_turns WHERE session_id=? AND started_at>=? AND json_type(payload_json,'$.usage')='object' GROUP BY category`,sessionId,since).map(r=>({category:String(r.category),tokens:Number(r.tokens??0)}));
  const usageByRole = store.all(`SELECT role,
    SUM(json_extract(payload_json,'$.usage.inputTokens')) inputTokens,
    SUM(json_extract(payload_json,'$.usage.cacheCreationTokens')) cacheCreationTokens,
    SUM(json_extract(payload_json,'$.usage.cacheReadTokens')) cacheReadTokens,
    SUM(json_extract(payload_json,'$.usage.outputTokens')) outputTokens
    FROM token_turns WHERE session_id=? AND started_at>=? AND json_type(payload_json,'$.usage')='object' GROUP BY role`, sessionId, since)
    .map(row => ({role:String(row.role),inputTokens:Number(row.inputTokens??0),cacheCreationTokens:Number(row.cacheCreationTokens??0),cacheReadTokens:Number(row.cacheReadTokens??0),outputTokens:Number(row.outputTokens??0)}));
  return { sessionId, turns, usageByRole, contextWindow: latestAgentContextWindow(store, sessionId), totals: {agentTokens:agentTokens===null?null:Number(agentTokens),workerTokens:workerTokens===null?null:Number(workerTokens),totalTokens}, distribution,
    pagination: page ? {...page,total:Number(store.get('SELECT COUNT(*) n FROM token_turns WHERE session_id=? AND started_at>=?',sessionId,since)!.n)} : undefined,
    coverage: 'recorded-turns-only' as const };
}export function summarizeTokenTurns(turns: TokenTurn[]) {
  const measured = turns.filter(turn => turn.usage);
  const usage = measured.length ? sumUsage(measured.map(turn => turn.usage!)) : null;
  return {totalTokens: usage?.totalTokens ?? null,
    contextTools: turns.some(turn=>turn.contextTools!=null)?[...new Set(turns.flatMap(turn=>turn.contextTools??[]))].sort():null,
    loadedTools: turns.some(turn => turn.loadedTools != null) ? [...new Set(turns.flatMap(turn => turn.loadedTools ?? []))].sort() : null,
    usedTools: [...new Set(turns.flatMap(turn => turn.usedTools ?? []))].sort()};
}
