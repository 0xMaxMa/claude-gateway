import { classifyProcesses, parseProcesses } from '../../src/api/dashboard-processes';
import { generateDashboardHtml } from '../../src/ui/web-ui';
import { runInNewContext } from 'vm';
const row = (pid:number,ppid:number,args:string,command='node') => ({pid,ppid,args,command,stat:'S',cpu:2,rssKb:1024});

test('assigns descendants to the closest owner, includes Codex children, and omits argv',()=>{
  const rows=[row(1,0,'gateway'),row(2,1,'agent'),row(3,1,'codex app-server'),row(4,3,'mcp secret-token'),row(5,4,'tool'),row(6,0,'codex personal')];
  const result=classifyProcesses(rows,[{pid:1,group:'gateway'},{pid:2,group:'agent',sessionId:'s'},{pid:3,group:'worker',harness:'codex',taskId:'t'}],[]);
  expect(result.map(p=>[p.pid,p.group])).toEqual([[1,'gateway'],[2,'agent'],[3,'worker'],[4,'worker'],[5,'worker']]);
  expect(JSON.stringify(result)).not.toContain('secret-token');
  expect(result.find(p=>p.pid===4)).toMatchObject({taskId:'t',harness:'codex'});
});

test('owned safemode remains separate from gateway and is never orphaned',()=>{
  const result=classifyProcesses([row(1,0,'gateway'),row(10,0,'node dist/entry.js safemode'),row(11,10,'codex'),row(12,11,'mcp')],
    [{pid:1,group:'gateway'},{pid:10,group:'safemode',name:'investigation',mode:'interactive'}],[]);
  expect(result.filter(p=>p.group==='safemode')).toHaveLength(3);
  expect(result.some(p=>p.group==='orphan')).toBe(false);
});

test('deduplicates host/container PIDs and links Docker execution without relying on PPID',()=>{
  const marker='/tmp/gateway-orch-11111111-1111-4111-8111-111111111111';
  const worker=row(10,1,'docker exec app node supervisor '+marker,'docker');
  const container=row(21,20,'node supervisor '+marker);
  const result=classifyProcesses([row(1,0,'gateway'),worker,row(20,0,'init'),container,row(22,21,'codex app-server'),container],
    [{pid:1,group:'gateway'},{pid:10,group:'worker',harness:'codex',taskId:'t',container:'app'}],
    [{name:'app',id:'container-id',agentIds:['a'],state:'running',pids:[20,21,22]}]);
  expect(result).toHaveLength(5);
  expect(result.find(p=>p.pid===22)).toMatchObject({group:'container',role:'worker',taskId:'t',harness:'codex'});
  expect(result.reduce((n,p)=>n+p.rssKb,0)).toBe(5120);
});

test('does not classify personal CLIs as gateway orphans',()=>{
  const result=classifyProcesses([row(1,0,'claude --print'),row(2,0,'codex app-server'),row(3,0,'claude --mcp-config /home/sample/.claude-gateway/task/mcp.json')],[],[]);
  expect(result.map(p=>[p.pid,p.group])).toEqual([[3,'orphan']]);
});

test('parses ps output without treating Docker column headings as processes',()=>{
  expect(parseProcesses('PID PPID STAT %CPU RSS COMMAND COMMAND\n12 1 Sl 2.5 4096 codex codex app-server')).toEqual([
    {pid:12,ppid:1,stat:'Sl',cpu:2.5,rssKb:4096,command:'codex',args:'codex app-server'}]);
});

test('renders all groups, identifiers, resource totals and escaped labels',()=>{
  const html=generateDashboardHtml();
  const start=html.indexOf('    function renderProcessTree('),end=html.indexOf('    // Logout',start);
  const target={innerHTML:''};
  const escape=(s:unknown)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const context={document:{getElementById:()=>target},escHtml:escape};
  runInNewContext(html.slice(start,end)+`;renderProcessTree([
    {pid:1,ppid:0,group:'gateway',rootPid:1,command:'node',cpu:2,rssKb:1024},
    {pid:2,ppid:1,group:'worker',rootPid:2,command:'codex',harness:'codex',model:'gpt-fixture',agentId:'<script>',taskId:'full-task-id',sessionId:'full-session-id',cpu:2,rssKb:1024}
  ],2,[],[]);`,context);
  for(const text of ['Gateway','Agents','Workers','App containers','Safemode','Receivers','Orphans','Codex','gpt-fixture','full-task-id','full-session-id','CPU 2.0%','MEM 2 MB'])expect(target.innerHTML).toContain(text);
  expect(target.innerHTML).toContain('&lt;script&gt;');
  expect(target.innerHTML).not.toContain('<script>');
  expect(target.innerHTML).toContain('\n');
});
