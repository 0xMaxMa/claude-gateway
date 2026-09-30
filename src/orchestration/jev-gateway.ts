import { createHash } from 'crypto';
import { mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { GatewayConfig, AgentConfig } from '../types';
import { claudeSettingsEnv } from '../config/claude-settings';
import { JevService, resolveDirectJevConnection } from '../jev/service';
import { JevConfig, JevError, JevEvaluationEvent } from '../jev/types';

const services = new WeakMap<GatewayConfig, GatewayJev>();
export function jevAllowed(config: GatewayConfig, agent: AgentConfig): boolean {
  const jev = config.gateway.jev;
  return jev?.enabled === true && agent.allow_tools !== false && agent.jev?.enabled !== false &&
    (!jev.allowedAgentIds || jev.allowedAgentIds.includes(agent.id));
}
/** Reuse an upstream identity as a group; never pair another identity's key with its URL. */
export async function resolveGatewayJevConnection(config: JevConfig) {
  if (config.provider !== 'upstream') return resolveDirectJevConnection(config);
  if (config.apiKeyFile || config.apiKeyEnv) {
    if (!config.baseUrl) throw new JevError('INVALID_CONFIG', 'An explicit upstream Jev credential requires its own baseUrl.');
    return resolveDirectJevConnection({ ...config, provider: 'typesafe' });
  }
  if (config.baseUrl) throw new JevError('INVALID_CONFIG', 'An explicit upstream Jev baseUrl requires an explicit credential reference.');
  const settings = claudeSettingsEnv();
  const names = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
  // The presence of any setting in this identity group selects settings as a
  // whole. An incomplete group is an error, never a reason to borrow a token
  // or endpoint from another identity in the inherited environment.
  const identity = ['ANTHROPIC_BASE_URL', ...names].some(name => name in settings) ? settings : process.env;
  const clean = (value: unknown): string => typeof value === 'string' && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
  const baseUrl = clean(identity.ANTHROPIC_BASE_URL);
  const apiKey = names.map(name => clean(identity[name])).find(Boolean);
  if (!baseUrl || !apiKey) throw new JevError('INVALID_CONFIG', 'Upstream Jev requires a complete endpoint and credential group in one configuration source.');
  return { baseUrl, apiKey };
}

export class GatewayJev {
  readonly service: JevService;
  private db?: DatabaseSync;
  constructor(private readonly config: GatewayConfig) {
    this.service = new JevService({getConfig: () => config.gateway.jev, resolveConnection: resolveGatewayJevConnection,
      onEvaluation: event => {try{this.record(event);}catch{console.warn(JSON.stringify({event:'jev_usage_record_failed',requestId:event.requestId}));}}});
  }
  private database(): DatabaseSync {
    if (!this.db) {
      const file = join(dirname(this.config.gateway.logDir), 'jev-usage.db');
      mkdirSync(dirname(file), {recursive:true,mode:0o700});
      const db = new DatabaseSync(file); chmodSync(file,0o600);
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS evaluations (id INTEGER PRIMARY KEY, agent_id TEXT, started_at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS evaluations_agent_time ON evaluations(agent_id,started_at DESC)');
      this.db = db;
    }
    return this.db;
  }
  private record(event: JevEvaluationEvent): void {
    // The public event contains metadata only. Never persist request state/questions or credentials.
    const safe = {...event, principalId: createHash('sha256').update(event.principalId).digest('hex')};
    const db = this.database();
    db.prepare('INSERT INTO evaluations(agent_id,started_at,data) VALUES(?,?,?)').run(event.agentId ?? null,event.startedAt,JSON.stringify(safe));
    db.prepare('DELETE FROM evaluations WHERE id <= (SELECT MAX(id)-10000 FROM evaluations)').run();
  }
  history(agentId: string, limit = 50, offset = 0, since = 0): {records: JevEvaluationEvent[]; total:number} {
    const db = this.database();
    return {records:db.prepare('SELECT data FROM evaluations WHERE agent_id=? AND started_at>=? ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?').all(agentId,since,limit,offset).map(row=>JSON.parse(String(row.data))),
      total:Number(db.prepare('SELECT COUNT(*) n FROM evaluations WHERE agent_id=? AND started_at>=?').get(agentId,since)?.n ?? 0)};
  }
  dashboardHistory(agentIds: string[], since:number,limit=25,offset=0): {records:JevEvaluationEvent[];total:number} {
    if(!agentIds.length)return {records:[],total:0};
    const db=this.database(),marks=agentIds.map(()=>'?').join(',');
    const where=`agent_id IN (${marks}) AND started_at>=?`;
    return {records:db.prepare(`SELECT data FROM evaluations WHERE ${where} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`).all(...agentIds,since,limit,offset).map(row=>JSON.parse(String(row.data))),
      total:Number(db.prepare(`SELECT COUNT(*) n FROM evaluations WHERE ${where}`).get(...agentIds,since)?.n??0)};
  }
  close(): void {this.db?.close();this.db=undefined;}
}
export function gatewayJev(config: GatewayConfig): GatewayJev {
  let value=services.get(config); if(!value){value=new GatewayJev(config);services.set(config,value);} return value;
}
