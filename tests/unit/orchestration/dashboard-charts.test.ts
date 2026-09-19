import { DatabaseSync } from 'node:sqlite';
import { readDashboardCharts } from '../../../src/orchestration/dashboard-charts';

describe('overview chart accounting',()=>{
 let db: DatabaseSync;
 beforeEach(()=>{db=new DatabaseSync(':memory:');db.exec('CREATE TABLE token_turns(id TEXT PRIMARY KEY,role TEXT,started_at INTEGER,payload_json TEXT); CREATE TABLE token_turn_metrics(id TEXT PRIMARY KEY,payload_json TEXT)');});
 afterEach(()=>db.close());
 const write=(id:string,role:string,at:string,model:string,usage:unknown)=>db.prepare('INSERT OR REPLACE INTO token_turns VALUES(?,?,?,?)').run(id,role,Date.parse(at),JSON.stringify({model,usage}));
 const usage=(fresh:number,write:number,read:number,output:number)=>({inputTokens:fresh,cacheCreationTokens:write,cacheReadTokens:read,outputTokens:output,totalTokens:fresh+write+read+output});
 it('sums agent, worker and model totals once; separates reads, writes and fresh input from output',()=>{
  write('a','agent','2026-09-19T00:00:00Z','model-a',usage(10,20,70,5));
  write('w','worker','2026-09-19T01:00:00Z','model-b',usage(2,3,15,7));
  // Repeated stream updates replace the measurement, not append another request.
  write('w','worker','2026-09-19T01:00:00Z','model-b',usage(4,6,30,14));
  write('old','worker','2026-09-18T23:59:59Z','old',usage(100,100,100,100));
  write('future','agent','2026-09-20T00:00:00Z','future',usage(1,1,1,1));
  const data=readDashboardCharts(db,'24h','UTC',Date.parse('2026-09-19T12:00Z'));
  expect(data.agent).toBe(105);expect(data.worker).toBe(54);
  expect(data.models).toEqual([{name:'model-a',tokens:105},{name:'model-b',tokens:54}]);
  expect(data.buckets.map(({key,agent,worker})=>({key,agent,worker}))).toEqual([{key:'00',agent:105,worker:0},{key:'01',agent:0,worker:54}]);
  expect(data.buckets[0]).toMatchObject({fresh:10,write:20,read:70});
  expect(data.buckets.reduce((n,b)=>n+b.fresh+b.write+b.read,0)).toBe(140);
  expect(data.reuse).toEqual({fresh:14,write:26,read:100,measuredTurns:2,missingTurns:0});
  expect(data.reuse.read/(data.reuse.fresh+data.reuse.write+data.reuse.read)).toBeCloseTo(100/140);
 });
 it('uses configured local midnight, daily buckets and fractional-hour timezones',()=>{
  write('before','agent','2026-09-18T18:14:59Z','a',usage(1,0,0,0));
  write('midnight','agent','2026-09-18T18:15:00Z','a',usage(2,0,0,0));
  write('next-hour','worker','2026-09-18T19:15:00Z','b',usage(3,0,0,0));
  const now=Date.parse('2026-09-19T04:00Z');
  expect(readDashboardCharts(db,'24h','Asia/Kathmandu',now).buckets.map(({key,agent,worker})=>({key,agent,worker}))).toEqual([{key:'00',agent:2,worker:0},{key:'01',agent:0,worker:3}]);
  expect(readDashboardCharts(db,'7d','Asia/Kathmandu',now).buckets.map(({key,agent,worker})=>({key,agent,worker}))).toEqual([{key:'2026-09-18',agent:1,worker:0},{key:'2026-09-19',agent:2,worker:3}]);
 });
 it('falls back per missing projection row and excludes incomplete usage from reuse rather than assuming zero',()=>{
  write('a','agent','2026-09-19T01:00Z','old',usage(999,0,0,0));
  write('b','worker','2026-09-19T02:00Z','b',{totalTokens:100,inputTokens:100});
  write('c','agent','2026-09-19T03:00Z','c',null);
  db.prepare('INSERT INTO token_turn_metrics VALUES(?,?)').run('a',JSON.stringify({model:'a',usage:usage(1,2,7,0)}));
  const data=readDashboardCharts(db,'24h','UTC',Date.parse('2026-09-19T04:00Z'));
  expect(data.agent+data.worker).toBe(110);
  expect(data.reuse).toEqual({fresh:1,write:2,read:7,measuredTurns:1,missingTurns:2});
  db.exec('DROP TABLE token_turn_metrics');
  expect(readDashboardCharts(db,'24h','UTC',Date.parse('2026-09-19T04:00Z')).agent).toBe(999);
 });
});
