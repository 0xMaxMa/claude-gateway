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
}
const initialized = new WeakSet<OrchestrationStore>();
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
          const inputs = store.all('SELECT text,modality,input_seq FROM conversation_inputs WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY input_seq', decision.conversation_id, decision.input_ids_json);
          turn.inputTexts = inputs.map(input => String(input.text));
          turn.inputModalities = inputs.map(input => String(input.modality));
          turn.inputSequences = inputs.map(input => Number(input.input_seq));
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
          // A task's newest result must not be attributed to an older retry.
          if (snapshot.activeAttemptId === turn.id || store.get('SELECT id FROM task_attempts WHERE task_id=? ORDER BY generation DESC LIMIT 1', turn.taskId)?.id === turn.id) turn.responseText = snapshot.result?.summary;
        }
      }
      return turn;
    });
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
  return { sessionId, turns, usageByRole, totals: {agentTokens:agentTokens===null?null:Number(agentTokens),workerTokens:workerTokens===null?null:Number(workerTokens),totalTokens}, distribution,
    pagination: page ? {...page,total:Number(store.get('SELECT COUNT(*) n FROM token_turns WHERE session_id=? AND started_at>=?',sessionId,since)!.n)} : undefined,
    coverage: 'recorded-turns-only' as const };
}
export function summarizeTokenTurns(turns: TokenTurn[]) {
  const measured = turns.filter(turn => turn.usage);
  const usage = measured.length ? sumUsage(measured.map(turn => turn.usage!)) : null;
  return {totalTokens: usage?.totalTokens ?? null,
    contextTools: turns.some(turn=>turn.contextTools!=null)?[...new Set(turns.flatMap(turn=>turn.contextTools??[]))].sort():null,
    loadedTools: turns.some(turn => turn.loadedTools != null) ? [...new Set(turns.flatMap(turn => turn.loadedTools ?? []))].sort() : null,
    usedTools: [...new Set(turns.flatMap(turn => turn.usedTools ?? []))].sort()};
}
