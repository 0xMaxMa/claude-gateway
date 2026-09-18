import { contextFootprint } from './context-footprint';
import { parentPort } from 'worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'fs';
import { readTokenReport, summarizeTokenTurns, pendingInputTurns, TokenTurn } from './token-ledger';
import { normalizeTaskRevisions } from './tasks/task-directive';
import type { TaskAttempt, TaskRevision } from './types';

/**
 * Conversation activity status — the single source shared by the dashboard
 * Conversations "Status" column and the Session token report header, so the two
 * views can never disagree (thinking → working → waiting_input → queued → idle).
 * `thinking` is returned alongside so callers keep the existing isRunning signal
 * without re-querying. Display-only; does not touch token accounting.
 */
function conversationActivityStatus(
  get: (sql: string, ...params: any[]) => Record<string, any> | undefined,
  all: (sql: string, ...params: any[]) => Record<string, any>[],
  conversationId: unknown,
): { status: string; thinking: boolean } {
  const thinking = Boolean(get("SELECT id FROM conversation_decisions WHERE conversation_id=? AND state='running' LIMIT 1", conversationId));
  const states = all("SELECT DISTINCT state FROM tasks WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled')", conversationId).map(t => t.state);
  const status = thinking ? 'thinking' : states.includes('needs_reconciliation') ? 'needs_reconciliation' : states.some(s => ['starting', 'running', 'interrupting', 'cancel_requested'].includes(s)) ? 'working' : states.includes('waiting_input') ? 'waiting_input' : states.includes('queued') ? 'queued' : 'idle';
  return { status, thinking };
}

const connections = new Map<string, DatabaseSync>();
function database(filename: string): DatabaseSync | undefined {
  if (!existsSync(filename)) return undefined;
  let db = connections.get(filename);
  if (!db) {
    if (connections.size >= 32) { const key = connections.keys().next().value!; connections.get(key)!.close(); connections.delete(key); }
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    connections.set(filename, db);
  }
  connections.delete(filename); connections.set(filename,db);
  return db;
}
function read(filename: string, operation: string, options: Record<string, any>) {
  const db = database(filename);
  if (!db) return undefined;
  const all = (sql: string, ...params: any[]) => db.prepare(sql).all(...params) as Record<string, any>[];
  const get = (sql: string, ...params: any[]) => db.prepare(sql).get(...params) as Record<string, any> | undefined;
  const exists = (table: string) => Boolean(get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table));
  if (!exists('conversations')) return undefined;
  const since = Math.max(0, Number(options.since) || 0);
  // A read transaction makes the session/task/attempt relationships consistent.
  db.exec('BEGIN');
  try {
    const adapter = { all, get, attempt: (id: string) => { const row = get('SELECT payload_json FROM task_attempts WHERE id=?', id); return row ? JSON.parse(row.payload_json) as TaskAttempt : undefined; } };
    if (operation === 'report' || operation === 'session') {
      if (!get('SELECT id FROM conversations WHERE agent_session_id=?', options.sessionId)) return undefined;
      // Before the ledger table exists (an agent whose very first turn has not recorded
      // usage yet) a queued input still has to be visible, so derive the pending rows
      // without the token_turns lookup instead of returning an empty list.
      const report = exists('token_turns') ? readTokenReport(adapter, options.sessionId, true, {offset:Math.max(0,Number(options.offset)||0),limit:operation==='report'?25:50,since,newestFirst:true}) : { sessionId: options.sessionId, turns: pendingInputTurns(adapter, options.sessionId, since, false), totals: {agentTokens:null, workerTokens:null, totalTokens:null}, coverage:'recorded-turns-only' };
      if(operation==='session') {
        const session = get('SELECT * FROM conversations WHERE agent_session_id=?',options.sessionId)!;
        const offset=Math.max(0,Number(options.offset)||0);
        const tasks=all('SELECT id,state,snapshot_json,updated_at FROM tasks WHERE conversation_id=? AND updated_at>=? ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?',session.id,since,offset).map(t=>({taskId:t.id,state:t.state,title:JSON.parse(t.snapshot_json).title,updatedAt:t.updated_at}));
        // Same activity status the Conversations column shows, so the session drawer's
        // Context window box can use the same idle-vs-stopped disambiguation as the report page.
        const activityStatus=conversationActivityStatus(get,all,session.id).status;
        return {...report,session:{sessionId:session.agent_session_id,source:session.source,chatId:session.chat_id,createdAt:session.created_at,updatedAt:session.updated_at},tasks,totalTasks:Number(get('SELECT COUNT(*) n FROM tasks WHERE conversation_id=? AND updated_at>=?',session.id,since)!.n),offset,activityStatus};
      }
      const session=get('SELECT id,source,chat_id FROM conversations WHERE agent_session_id=?',options.sessionId)!;
      // Same activity status the Conversations column shows, so the report header mirrors it.
      const activityStatus=conversationActivityStatus(get,all,session.id).status;
      return {...report, source:session.source, chatId:session.chat_id, activityStatus, since, contextFootprint:contextFootprint(options.workspace)};
    }
    if (operation === 'task') {
      const row = get('SELECT t.*,c.agent_session_id FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.agent_session_id=?', options.taskId, options.sessionId);
      if (!row) return undefined;
      const snapshot = JSON.parse(row.snapshot_json);
      // The assignment text is never stored on the task snapshot — it lives in task_revisions.
      // Read the revisions the worker actually received (appliedRevision, or the newest authored
      // one before the first claim) and normalize them exactly like TaskService.revision() does,
      // so a revision > 1 shows the effective brief instead of append-only answer text.
      const effectiveRevision = Number(snapshot.appliedRevision) || Number(snapshot.revision) || Number.MAX_SAFE_INTEGER;
      const revisions = all('SELECT payload_json FROM task_revisions WHERE task_id=? AND revision<=? ORDER BY revision', options.taskId, effectiveRevision)
        .map(r => JSON.parse(String(r.payload_json)) as TaskRevision);
      const instructions = revisions.length ? normalizeTaskRevisions(revisions).instructions : undefined;
      const offset = Math.max(0, Number(options.offset) || 0);
      const attempts = all(`SELECT payload_json FROM task_attempts WHERE task_id=? AND COALESCE(json_extract(payload_json,'$.startedAt'),0)>=? ORDER BY generation DESC LIMIT 25 OFFSET ?`, options.taskId, since, offset).map(r => {
        const attempt = JSON.parse(r.payload_json);
        const metrics = exists('token_turns') ? get('SELECT payload_json FROM token_turns WHERE id=? AND session_id=?', attempt.attemptId, options.sessionId) : undefined;
        const events = all('SELECT type,payload_json,occurred_at FROM worker_events WHERE attempt_id=? ORDER BY local_seq DESC LIMIT 30', attempt.attemptId).map(e=>({type:e.type,at:e.occurred_at,payload:JSON.parse(e.payload_json)}));
        return {...attempt, metrics: metrics ? JSON.parse(metrics.payload_json) : null, events};
      });
      return {snapshot, instructions, attempts, totalAttempts:Number(get("SELECT COUNT(*) n FROM task_attempts WHERE task_id=? AND COALESCE(json_extract(payload_json,'$.startedAt'),0)>=?", options.taskId,since)!.n), offset};
    }
    const offset = Math.max(0, Number(options.offset) || 0), limit = 25;
    const conversations = all('SELECT c.* FROM conversations c WHERE c.updated_at>=? ORDER BY c.updated_at DESC,c.id DESC LIMIT ? OFFSET ?', since, limit, offset);
    const sessions = conversations.map(c => {
      const turns: TokenTurn[] = exists('token_turn_metrics')
        ? all("SELECT COALESCE(m.payload_json,json_remove(t.payload_json,'$.requests','$.inputTexts','$.responseText')) payload_json FROM token_turns t LEFT JOIN token_turn_metrics m ON m.id=t.id WHERE t.session_id=? AND t.started_at>=? ORDER BY t.started_at,t.id", c.agent_session_id,since).map(r=>JSON.parse(r.payload_json))
        : exists('token_turns') ? all(`SELECT id,role,task_id,started_at,json_extract(payload_json,'$.usage') usage,
          json_extract(payload_json,'$.loadedTools') loadedTools,json_extract(payload_json,'$.usedTools') usedTools,
          json_extract(payload_json,'$.model') model FROM token_turns WHERE session_id=? AND started_at>=? ORDER BY started_at,id`, c.agent_session_id,since).map(r=>({...r,taskId:r.task_id,startedAt:r.started_at,sessionId:c.agent_session_id,usage:r.usage?JSON.parse(r.usage):null,loadedTools:r.loadedTools?JSON.parse(r.loadedTools):null,usedTools:r.usedTools?JSON.parse(r.usedTools):[]} as TokenTurn)) : [];
      const agent = summarizeTokenTurns(turns.filter(t=>t.role==='agent')), workers = summarizeTokenTurns(turns.filter(t=>t.role==='worker'));
      const tasks = all(`SELECT * FROM tasks WHERE conversation_id=? AND updated_at>=? ORDER BY updated_at DESC,id DESC LIMIT 100`, c.id,since).map(t => {
        const snapshot = JSON.parse(t.snapshot_json);
        const last = t.active_attempt_id ? {id:t.active_attempt_id} : get('SELECT id FROM task_attempts WHERE task_id=? ORDER BY generation DESC LIMIT 1',t.id);
        const attempt = last ? adapter.attempt(last.id) : undefined;
        const metrics = summarizeTokenTurns(turns.filter(turn=>turn.id===attempt?.attemptId));
        const total = summarizeTokenTurns(turns.filter(turn=>turn.taskId===t.id));
        const lastTool = get("SELECT payload_json,occurred_at FROM conversation_events WHERE json_extract(payload_json,'$.task_id')=? AND type='tool.activity' ORDER BY seq DESC LIMIT 1",t.id);
        const tool = lastTool ? JSON.parse(lastTool.payload_json).payload : undefined;
        return {taskId:t.id,sessionId:c.agent_session_id,title:snapshot.title,state:t.state,updatedAt:t.updated_at,
          createdAt:t.created_at, execution:snapshot.execution, workerId:attempt?.workerId, attemptId:attempt?.attemptId,
          workerSessionId:attempt?.sessionId, resumed:attempt?.resumeSession, workstreamId:snapshot.workstreamId,
          continueTaskId:snapshot.continueTaskId,hostProcessId:t.active_attempt_id?attempt?.processIdentity?.pid:undefined,
          tokenSummary:{totalTokens:metrics.totalTokens,allAttemptsTokens:total.totalTokens},contextTools:metrics.contextTools,loadedTools:metrics.loadedTools,usedTools:metrics.usedTools,
          lastTool:tool?{name:tool.name,type:tool.type,is_error:tool.is_error,at:lastTool!.occurred_at}:undefined};
      });
      const {status:state, thinking} = conversationActivityStatus(get, all, c.id);
      const totalTokens = agent.totalTokens===null&&workers.totalTokens===null ? null : (agent.totalTokens??0)+(workers.totalTokens??0);
      return {sessionId:c.agent_session_id,chatId:c.chat_id,source:c.source,orchestration:true,mode:'headless',status:state,isRunning:thinking,
        model:turns.filter(t=>t.role==='agent'&&t.model).at(-1)?.model??'',updatedAt:c.updated_at,createdAt:c.created_at,
        tokenSummary:{agentTokens:agent.totalTokens,workerTokens:workers.totalTokens,totalTokens},contextTools:agent.contextTools,loadedTools:agent.loadedTools,usedTools:agent.usedTools,
        tasks,totalTasks:Number(get('SELECT COUNT(*) n FROM tasks WHERE conversation_id=? AND updated_at>=?',c.id,since)!.n),
        workerIds:all('SELECT id FROM worker_pool WHERE conversation_id=?',c.id).map(w=>w.id),spawnedAt:0,uptimeSec:0,tokens:0};
    });
    const today=Date.now()-Date.now()%86400000;
    const usageToday=exists('token_turns')?all(`SELECT role,CAST((started_at-?)/3600000 AS INTEGER) hour,SUM(json_extract(payload_json,'$.usage.totalTokens')) tokens FROM token_turns WHERE started_at>=? AND json_type(payload_json,'$.usage')='object' GROUP BY role,hour`,today,Math.max(today,since)):[];
    const attention=all(`SELECT t.id taskId,t.state,t.snapshot_json,c.agent_session_id sessionId FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.updated_at>=? AND t.state IN ('waiting_input','needs_reconciliation') ORDER BY t.updated_at DESC LIMIT 8`,since).map(t=>({taskId:t.taskId,state:t.state,sessionId:t.sessionId,title:JSON.parse(t.snapshot_json).title}));
    const recentWork=all(`SELECT t.id taskId,t.state,t.snapshot_json,t.updated_at updatedAt,c.agent_session_id sessionId FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.updated_at>=? ORDER BY t.updated_at DESC,t.id DESC LIMIT 6`,today).map(t=>({taskId:t.taskId,state:t.state,sessionId:t.sessionId,updatedAt:t.updatedAt,title:JSON.parse(t.snapshot_json).title}));
    const pool = exists('worker_pool') ? all('SELECT * FROM worker_pool') : [];
    return {usageToday,attention,recentWork,managedLegacyIds:all('SELECT agent_session_id FROM conversations WHERE agent_session_id IN (SELECT value FROM json_each(?))',JSON.stringify(options.legacyIds??[])).map(c=>c.agent_session_id),enabled:true,backend:'headless',workspaceMode:options.workspaceMode,sessions,tasks:sessions.flatMap(s=>s.tasks),
      pagination:{offset,limit,total:Number(get('SELECT COUNT(*) n FROM conversations WHERE updated_at>=?',since)!.n)},
      counts:{sessions:Number(get('SELECT COUNT(*) n FROM conversations WHERE updated_at>=?',since)!.n),tasks:all('SELECT state,COUNT(*) count FROM tasks WHERE updated_at>=? GROUP BY state',since)},
      activeAgentSessions:sessions.filter(s=>s.isRunning).map(s=>s.sessionId),
      workerPool:{maxWorkers:options.maxWorkers,idleTtlMs:options.idleTtlMs,workers:pool.map(w=>({workerId:w.id,sessionId:w.session_id,workstreamId:w.workstream_id,state:w.active_task_id?'busy':'idle',taskId:w.active_task_id,expiresAt:w.active_task_id?undefined:Number(w.idle_since)+Number(options.idleTtlMs)}))}};
  } finally { db.exec('ROLLBACK'); }
}
parentPort!.on('message', ({id, operation, filename, options}) => {
  try { parentPort!.postMessage({id,value:read(filename,operation,options)}); }
  catch { parentPort!.postMessage({id,error:'Unable to read dashboard data'}); }
});
