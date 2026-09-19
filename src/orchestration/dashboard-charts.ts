import { dashboardSince } from '../ui/dashboard-range';
import type { DatabaseSync } from 'node:sqlite';

/** Aggregate projected measurements in the isolated reader, never transcripts on the event loop. */
export function readDashboardCharts(db: DatabaseSync, scope: string, timezone: string, now: number) {
  const since = dashboardSince(scope, now, timezone);
  const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const empty = { buckets: [] as any[], models: [] as any[], agent: 0, worker: 0,
    reuse: { fresh: 0, write: 0, read: 0, measuredTurns: 0, missingTurns: 0 } };
  if (!exists('token_turns')) return empty;
  // Older ledgers may have only part of the lightweight projection: fall back per row.
  const projected = exists('token_turn_metrics');
  const payload = projected ? 'COALESCE(m.payload_json,t.payload_json)' : 't.payload_json';
  const join = projected ? 'LEFT JOIN token_turn_metrics m ON m.id=t.id' : '';
  const clock = new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
  db.function('dashboard_chart_bucket', (at) => {
    const parts = clock.formatToParts(Number(at));
    const part = (type: string) => parts.find(p=>p.type===type)!.value;
    return scope==='24h' ? part('hour') : part('year')+'-'+part('month')+'-'+part('day');
  });
  const rows = db.prepare(`WITH turns AS (
    SELECT t.role, dashboard_chart_bucket(t.started_at) bucket,
      json_extract(${payload},'$.model') model, json_extract(${payload},'$.usage') usage
    FROM token_turns t ${join} WHERE t.started_at>=? AND t.started_at<=?
  ), measured AS (
    SELECT *, json_extract(usage,'$.totalTokens') total,
      json_extract(usage,'$.inputTokens') fresh,
      json_extract(usage,'$.cacheCreationTokens') cache_write,
      json_extract(usage,'$.cacheReadTokens') cache_read FROM turns
  ) SELECT role,bucket,model,SUM(total) tokens,
    SUM(CASE WHEN fresh>=0 AND cache_write>=0 AND cache_read>=0 THEN fresh ELSE 0 END) fresh,
    SUM(CASE WHEN fresh>=0 AND cache_write>=0 AND cache_read>=0 THEN cache_write ELSE 0 END) cache_write,
    SUM(CASE WHEN fresh>=0 AND cache_write>=0 AND cache_read>=0 THEN cache_read ELSE 0 END) cache_read,
    SUM(CASE WHEN fresh>=0 AND cache_write>=0 AND cache_read>=0 THEN 1 ELSE 0 END) measured,
    SUM(CASE WHEN fresh>=0 AND cache_write>=0 AND cache_read>=0 THEN 0 ELSE 1 END) missing
    FROM measured GROUP BY role,bucket,model ORDER BY bucket`).all(since, now) as Record<string, any>[];
  const buckets = new Map<string, { key: string; agent: number; worker: number }>();
  const models = new Map<string, number>();
  for (const row of rows) {
    if (row.role !== 'agent' && row.role !== 'worker') continue;
    const key = String(row.bucket);
    const bucket = buckets.get(key) ?? {key,agent:0,worker:0};
    const tokens = Number(row.tokens ?? 0);
    bucket[row.role as 'agent'|'worker'] += tokens;
    buckets.set(key,bucket);
    empty[row.role as 'agent'|'worker'] += tokens;
    const model = typeof row.model==='string' && row.model ? row.model : 'Unspecified model';
    if (tokens>0) models.set(model,(models.get(model)??0)+tokens);
    empty.reuse.fresh+=Number(row.fresh); empty.reuse.write+=Number(row.cache_write); empty.reuse.read+=Number(row.cache_read);
    empty.reuse.measuredTurns+=Number(row.measured); empty.reuse.missingTurns+=Number(row.missing);
  }
  return {...empty,buckets:[...buckets.values()],models:[...models].map(([name,tokens])=>({name,tokens})).sort((a,b)=>b.tokens-a.tokens||a.name.localeCompare(b.name))};
}
