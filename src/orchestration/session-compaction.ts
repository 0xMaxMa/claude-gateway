import { randomUUID } from 'crypto';
import { OrchestrationStore } from './store';
import { latestAgentContextWindow } from './token-ledger';

export interface SessionCompactionConfig {
  enabled?: boolean;
  thresholdPercent?: number;
  quietMinutes?: number;
  maxSessionsPerRun?: number;
}
export interface ResolvedSessionCompaction {
  enabled: boolean; thresholdPercent: number; quietMinutes: number; maxSessionsPerRun: number;
}
export function resolveSessionCompaction(agent?: SessionCompactionConfig, global?: SessionCompactionConfig): ResolvedSessionCompaction {
  const number=(key: keyof SessionCompactionConfig, fallback:number,min:number,max:number) => {
    const value=agent?.[key]??global?.[key];
    return typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;
  };
  return {enabled:(agent?.enabled??global?.enabled)===true,thresholdPercent:number('thresholdPercent',50,1,99),
    quietMinutes:number('quietMinutes',60,1,10080),maxSessionsPerRun:Math.floor(number('maxSessionsPerRun',5,1,100))};
}
export interface CompactionItem {
  sessionId:string; status:'completed'|'failed'|'skipped'|'running'; reason?:string;
  beforeTokens:number|null; afterTokens:number|null; contextWindow:number|null;
  startedAt:number; endedAt:number|null; errorCode?:string;
}
export interface CompactionRun {
  id:string; agent:string; kind:'session_compaction'; startedAt:number; endedAt:number|null; status:string;
  config:ResolvedSessionCompaction; items:CompactionItem[];
}
// All agents share one native-compaction slot; user activity is rechecked after waiting.
let serial:Promise<unknown>=Promise.resolve();
/** Recover audit state at runtime startup, before the lazy nightly manager exists.
 * Keep measurement fences: an interrupted process may have finished compaction. */
export function recoverSessionCompaction(store:OrchestrationStore):void {
  if(!store.get("SELECT name FROM sqlite_master WHERE name='session_compaction_runs'") ||
      !store.get("SELECT name FROM sqlite_master WHERE name='session_compaction_items'"))return;
  store.transaction(()=>{
    const now=Date.now();
    for(const row of store.all("SELECT id FROM session_compaction_runs WHERE status='running'")) {
      for(const item of store.all('SELECT session_id,payload_json FROM session_compaction_items WHERE run_id=?',row.id)) {
        const value=JSON.parse(String(item.payload_json));
        if(value.status==='running')store.run('UPDATE session_compaction_items SET payload_json=? WHERE run_id=? AND session_id=?',JSON.stringify({...value,status:'failed',errorCode:'INTERRUPTED',endedAt:now}),row.id,item.session_id);
      }
      store.run("UPDATE session_compaction_runs SET status='interrupted',ended_at=? WHERE id=?",now,row.id);
    }
  });
}
export class SessionCompaction {
  private running?:Promise<CompactionRun>;
  constructor(private store:OrchestrationStore,private agentId:string,private deps:{
    busy:(sessionId:string)=>boolean; stopping:()=>boolean; model:()=>string;
    window:(model:string)=>Promise<number>; compact:(sessionId:string,model:string)=>Promise<void>;
  }) {
    store.run(`CREATE TABLE IF NOT EXISTS session_compaction_runs(id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,ended_at INTEGER,status TEXT NOT NULL,config_json TEXT NOT NULL)`);
    store.run(`CREATE TABLE IF NOT EXISTS session_compaction_items(run_id TEXT NOT NULL REFERENCES session_compaction_runs(id),session_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,session_id))`);
    store.run(`CREATE TABLE IF NOT EXISTS session_compaction_marks(session_id TEXT PRIMARY KEY,measurement_id TEXT NOT NULL,completed_at INTEGER NOT NULL)`);
    recoverSessionCompaction(store);
  }
  report(limit=100):CompactionRun[] {
    return this.store.all('SELECT * FROM session_compaction_runs ORDER BY started_at DESC,id DESC LIMIT ?',Math.min(100,Math.max(1,limit))).map(row=>({
      id:String(row.id),agent:this.agentId,kind:'session_compaction',startedAt:Number(row.started_at),endedAt:row.ended_at==null?null:Number(row.ended_at),status:String(row.status),
      config:JSON.parse(String(row.config_json)),items:this.store.all('SELECT payload_json FROM session_compaction_items WHERE run_id=? ORDER BY rowid',row.id).map(item=>JSON.parse(String(item.payload_json))),
    }));
  }
  private skip(sessionId:string,cfg:ResolvedSessionCompaction):string|undefined {
    if(this.deps.stopping())return 'gateway_stopping';
    if(this.deps.busy(sessionId))return 'agent_busy';
    if(this.store.get("SELECT t.id FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE c.agent_session_id=? AND t.state NOT IN ('completed','failed','cancelled') LIMIT 1",sessionId))return 'active_tasks';
    if(this.store.get("SELECT i.id FROM conversation_inputs i JOIN conversations c ON c.id=i.conversation_id WHERE c.agent_session_id=? AND i.status IN ('accepted','assigned') LIMIT 1",sessionId))return 'pending_input';
    const last=this.store.get(`SELECT MAX(at) at FROM (
      SELECT MAX(COALESCE(ended_at,started_at)) at FROM conversation_decisions WHERE session_id=?
      UNION ALL SELECT MAX(i.created_at) at FROM conversation_inputs i JOIN conversations c ON c.id=i.conversation_id WHERE c.agent_session_id=? AND i.store_user_message=1)`,sessionId,sessionId)?.at;
    if(last!=null && Date.now()-Number(last)<cfg.quietMinutes*60000)return 'recent_activity';
  }
  run(cfg:ResolvedSessionCompaction):Promise<CompactionRun> {
    if(this.running)return this.running;
    const operation=serial.catch(()=>{}).then(()=>this.execute(cfg));
    serial=operation.catch(()=>{});
    this.running=operation;
    void operation.finally(()=>{this.running=undefined;}).catch(()=>{});
    return operation;
  }
  private async execute(cfg:ResolvedSessionCompaction):Promise<CompactionRun> {
    const id=randomUUID(),startedAt=Date.now();
    this.store.run("INSERT INTO session_compaction_runs VALUES(?,?,NULL,'running',?)",id,startedAt,JSON.stringify(cfg));
    const items:CompactionItem[]=[];
    const save=(item:CompactionItem)=>this.store.run(`INSERT INTO session_compaction_items VALUES(?,?,?) ON CONFLICT(run_id,session_id) DO UPDATE SET payload_json=excluded.payload_json`,id,item.sessionId,JSON.stringify(item));
    let attempted=0,status='completed';
    try {
      if(!cfg.enabled){status='disabled';return {id,agent:this.agentId,kind:'session_compaction',startedAt,endedAt:Date.now(),status,config:cfg,items};}
      const sessions=this.store.all('SELECT session_id FROM agent_cli_sessions ORDER BY updated_at DESC LIMIT 1000');
      for(const row of sessions) {
        if(this.deps.stopping()){status='interrupted';break;}
        const sessionId=String(row.session_id);
        const item:CompactionItem={sessionId,status:'skipped',beforeTokens:null,afterTokens:null,contextWindow:null,startedAt:Date.now(),endedAt:null};items.push(item);
        const finish=(reason:string)=>{item.reason=reason;item.endedAt=Date.now();save(item);};
        const reason=this.skip(sessionId,cfg);if(reason){finish(reason);continue;}
        if(attempted>=cfg.maxSessionsPerRun){finish('run_limit');continue;}
        if(!this.store.get("SELECT name FROM sqlite_master WHERE name='token_turns'")){finish('no_measurement');continue;}
        const measured=this.store.get("SELECT id,started_at FROM token_turns WHERE session_id=? AND role='agent' AND EXISTS (SELECT 1 FROM json_each(payload_json,'$.requests') r WHERE json_type(r.value,'$.usage')='object') ORDER BY started_at DESC,id DESC LIMIT 1",sessionId);
        const context=latestAgentContextWindow(this.store,sessionId);
        if(!measured || !context || !Number.isFinite(context.used)){finish('no_measurement');continue;}
        item.beforeTokens=context.used;
        if(this.store.get('SELECT session_id FROM session_compaction_marks WHERE session_id=? AND measurement_id=?',sessionId,measured.id)){finish('unchanged_measurement');continue;}
        if(this.store.get("SELECT seq FROM conversation_events WHERE type='session.context_compacted' AND json_extract(payload_json,'$.payload.sessionId')=? AND occurred_at>=? LIMIT 1",sessionId,measured.started_at)){finish('already_compacted');continue;}
        const model=this.deps.model();
        try {item.contextWindow=await this.deps.window(model);}catch{finish('model_window_unavailable');continue;}
        if(!Number.isFinite(item.contextWindow)||item.contextWindow<=0){finish('model_window_unavailable');continue;}
        if(context.used<=item.contextWindow*cfg.thresholdPercent/100){finish('below_threshold');continue;}
        const changed=this.skip(sessionId,cfg);if(changed){finish(changed);continue;}
        item.status='running';save(item);attempted++;
        // Fence even an uncertain crash after compaction: next user turn produces a new measurement.
        this.store.run('INSERT INTO session_compaction_marks VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET measurement_id=excluded.measurement_id,completed_at=excluded.completed_at',sessionId,measured.id,Date.now());
        try {await this.deps.compact(sessionId,model);item.status='completed';}
        catch(error) {
          item.status='failed';const code=(error as {code?:unknown}).code;
          item.errorCode=typeof code==='string'&&/^[A-Z_0-9]{1,80}$/.test(code)?code:'COMPACTION_FAILED';
          // Known failure may retry on a later night, never in this sweep.
          this.store.run('DELETE FROM session_compaction_marks WHERE session_id=? AND measurement_id=?',sessionId,measured.id);
          if(code==='NO_CLI_SESSION'){item.status='skipped';item.reason='missing_transcript';delete item.errorCode;}
          else status='partial_failure';
        }
        item.endedAt=Date.now();save(item);
      }
    } catch(error) {status='failed';throw error;}
    finally {this.store.run('UPDATE session_compaction_runs SET status=?,ended_at=? WHERE id=?',status,Date.now(),id);}
    return {id,agent:this.agentId,kind:'session_compaction',startedAt,endedAt:Date.now(),status,config:cfg,items};
  }
}
