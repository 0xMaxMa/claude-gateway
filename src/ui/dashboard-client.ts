import { dashboardPresentationClient } from './dashboard-presentation';
/** Browser controller: no provider keys or model-generated HTML are trusted. */
export const dashboardClient = dashboardPresentationClient + String.raw`
let dashboardData = null, dashboardOffset = 0, dashboardBusy = false, dashboardSearch = '', dashboardAgent = '', dashboardScope = 'current', dashboardFocus = null, dashboardDetailGeneration = 0;
function dashboardRows() {
  const rows=[];
  (dashboardData?.agents||[]).forEach(a=>(a.sessions||[]).forEach(s=>rows.push({a,s})));
  return rows.filter(({a,s})=>(!dashboardAgent||a.id===dashboardAgent)&&(!dashboardSearch||[a.id,s.sessionId,s.chatId,s.source,s.model].join(' ').toLowerCase().includes(dashboardSearch.toLowerCase()))).sort((x,y)=>(Number(y.s.updatedAt||y.s.spawnedAt)||0)-(Number(x.s.updatedAt||x.s.spawnedAt)||0)||String(x.s.sessionId).localeCompare(String(y.s.sessionId)));
}
function dashboardTaskRows(){return dashboardRows().flatMap(({a,s})=>(s.tasks||[]).map(t=>({a,s,t}))).sort((x,y)=>Number(y.t.updatedAt)-Number(x.t.updatedAt)||x.t.taskId.localeCompare(y.t.taskId));}
function dashText(value){return escHtml(value==null?'Unavailable':String(value));}
function dashCount(value){return value==null?'Unavailable':Number(value).toLocaleString();}
function dashStatus(value){return '<span class="badge '+(['running','working','thinking','completed'].includes(value)?'badge-green':value==='failed'?'badge-red':'badge-gray')+'">'+dashText(String(value||'unknown').replace(/_/g,' '))+'</span>';}
function dashReportUrl(a,s){return apiUrl('/dashboard/token-report')+'?agentId='+encodeURIComponent(a)+'&sessionId='+encodeURIComponent(s)+'&scope='+dashboardScope;}
function dashOpenAttrs(a,s,t){return ' data-dash-agent="'+escHtml(a)+'" data-dash-session="'+escHtml(s)+'"'+(t?' data-dash-task="'+escHtml(t)+'"':'');}
function dashId(value){return value?'<span class="short-id" title="'+dashText(value)+'">'+dashText(String(value).slice(0,8))+'</span>':'<span class="muted">Not assigned</span>';}
function dashTable(headers,rows){
 const widths=headers[0]==='Agent / Channel'?[180,180,200,130,185,160,175]:headers[0]==='Task / Agent'?[310,130,175,130,130,170,210]:headers[0]==='Agent / Session'?[240,150,150,150,160,180]:[320,180,140];
 return '<div class="table-wrap"><table class="data-table" style="min-width:'+widths.reduce((a,b)=>a+b,0)+'px"><colgroup>'+widths.map(w=>'<col style="width:'+w+'px">').join('')+'</colgroup><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td colspan="'+headers.length+'" class="empty">No records in this scope.</td></tr>')+'</tbody></table></div>';
}
function renderDashboard(data){
  dashboardData=data;
  const openTools=[...document.querySelectorAll('.dash-tools details[open]')].map(e=>({row:e.closest('tr').dataset.rowKey,label:e.querySelector('summary').textContent.split(':')[0]}));
  const rows=dashboardRows(), tasks=dashboardTaskRows();
  const agents=data.agents||[];
  const counts=agents.flatMap(a=>a.orchestration?.counts?.tasks||[]);
  const taskCount=states=>counts.filter(c=>states.includes(c.state)).reduce((n,c)=>n+Number(c.count),0);
  const sessions=agents.reduce((n,a)=>n+(a.orchestration?.counts?.sessions??a.sessions?.length??0),0);
  const stats=[['Recorded sessions',sessions],['Work in progress',taskCount(['running','starting','queued','interrupting','cancel_requested'])],['Waiting for a decision',taskCount(['waiting_input'])],['Loaded agents',agents.length]];
  document.getElementById('overview-stats').innerHTML=stats.map(([label,n])=>'<div class="dash-stat"><span>'+label+'</span><strong>'+dashCount(n)+'</strong></div>').join('');
  const attention=agents.flatMap(a=>(a.orchestration?.attention||[]).map(t=>({a,s:{sessionId:t.sessionId},t})));
  document.getElementById('overview-attention').innerHTML=attention.length?attention.slice(0,8).map(({a,s,t})=>'<button'+dashOpenAttrs(a.id,s.sessionId,t.taskId)+'><span>'+dashText(t.title)+'<br><small class="muted">'+agentBadge(a.id)+'</small></span>'+dashStatus(t.state)+'</button>').join(''):'<p class="muted">No tasks are waiting for a decision or reconciliation.</p>';
  const hourly=Array.from({length:24},()=>({agent:0,worker:0}));let hasUsage=false;
  agents.forEach(a=>(a.orchestration?.usageToday||[]).forEach(r=>{if(hourly[r.hour]&&['agent','worker'].includes(r.role)){hourly[r.hour][r.role]+=Number(r.tokens||0);hasUsage=true;}}));
  const peak=Math.max(1,...hourly.flatMap(h=>[h.agent,h.worker]));
  const points=role=>hourly.map((h,i)=>(i*600/23).toFixed(1)+','+(160-h[role]/peak*140).toFixed(1)).join(' ');
  document.getElementById('overview-chart').innerHTML=hasUsage?'<svg viewBox="0 0 600 180" role="img" aria-label="Recorded token activity today in UTC" style="width:100%;height:180px"><path d="M0 20H600M0 90H600M0 160H600" fill="none" stroke="var(--line)" stroke-dasharray="4 5"/><polyline points="'+points('worker')+'" fill="none" stroke="var(--accent)" stroke-width="2"/><polyline points="'+points('agent')+'" fill="none" stroke="var(--blue)" stroke-width="2"/></svg><div class="row between muted small"><span>00:00 UTC</span><span>12:00</span><span>23:00 UTC</span></div>':'<p class="empty">No recorded token usage today.</p>';
  const sessionRows=rows.map(({a,s})=>'<tr class="session-row" data-row-key="'+escHtml(a.id+':'+s.sessionId)+'"><td>'+agentBadge(a.id)+'<br>'+channelBadge(s.source)+'</td><td><button class="btn-stream"'+(s.orchestration?dashOpenAttrs(a.id,s.sessionId):' disabled title="Detailed records are available for orchestration sessions"')+'>'+dashText(s.sessionId?.slice(0,8))+(s.orchestration?' · Details':' · Legacy')+'</button><br><small class="ts">Chat '+dashText(s.chatId)+'</small></td><td><span class="cell-clip" title="'+dashText(s.model)+'">'+dashText(s.model||'Unavailable')+'</span></td><td>'+dashStatus(s.status||(s.isRunning?'running':'stopped'))+'</td><td>'+ (s.orchestration?dashCount(s.tokenSummary?.agentTokens)+' / '+dashCount(s.tokenSummary?.totalTokens):dashCount(s.tokens))+'<br><small class="ts">'+(s.orchestration?'Agent / combined · recorded only':'Legacy process tokens')+'</small></td><td class="dash-tools">'+toolInventory(s.loadedTools,s.usedTools)+'</td><td>'+ (s.orchestration?'<a class="btn-stream" target="_blank" rel="noopener" href="'+escHtml(dashReportUrl(a.id,s.sessionId))+'">View token report ↗</a>':'')+(s.hasPtyStream&&s.isRunning&&s.mode==='pty-shell'?'<button class="btn-stream" data-agent-id="'+escHtml(a.id)+'" data-session-id="'+escHtml(s.sessionId)+'">Terminal</button>':'')+'</td></tr>');
  document.getElementById('session-results').innerHTML=dashTable(['Agent / Channel','Session / Chat','Model','Status','Tokens','Tools','Inspect'],sessionRows);
  const taskRows=tasks.map(({a,s,t})=>'<tr data-row-key="'+escHtml(a.id+':'+t.taskId)+'"><td><button class="btn-stream dash-task-title" title="'+dashText(t.title)+'"'+dashOpenAttrs(a.id,s.sessionId,t.taskId)+'>'+dashText(t.title)+'</button><small class="ts">'+agentBadge(a.id)+' · '+dashId(t.taskId)+'<br>'+channelBadge(s.source)+'</small></td><td>'+dashStatus(t.state)+'</td><td class="session-id">'+dashId(t.workerSessionId)+'<br><small class="ts">Attempt '+dashId(t.attemptId)+'</small></td><td>'+dashCount(t.tokenSummary?.totalTokens)+'<br><small class="ts">Latest attempt</small></td><td>'+dashCount(t.tokenSummary?.allAttemptsTokens)+'<br><small class="ts">All recorded attempts</small></td><td class="dash-tools">'+toolInventory(t.loadedTools,t.usedTools)+'</td><td><span class="cell-clip" title="'+dashText(t.lastTool?.name)+'">'+dashText(t.lastTool?.name||'No recorded tool')+'</span>'+'<br><small class="ts">'+(t.lastTool?.at?dashText(new Date(t.lastTool.at).toLocaleString()):'')+'</small></td></tr>');
  document.getElementById('task-results').innerHTML=dashTable(['Task / Agent','Status','Worker session / Attempt','Latest tokens','Task tokens','Latest attempt tools','Latest activity'],taskRows);
  document.getElementById('overview-tasks').innerHTML=dashTable(['Task','Agent','Status'],tasks.slice(0,6).map(({a,s,t})=>'<tr><td><button class="btn-stream"'+dashOpenAttrs(a.id,s.sessionId,t.taskId)+'>'+dashText(t.title)+'</button></td><td>'+agentBadge(a.id)+'</td><td>'+dashStatus(t.state)+'</td></tr>'));
  document.getElementById('usage-results').innerHTML=dashTable(['Agent / Session','Channel','Agent tokens','Worker tokens','Combined tokens','Report'],rows.filter(({s})=>s.orchestration).map(({a,s})=>'<tr><td>'+agentBadge(a.id)+'<br>'+dashId(s.sessionId)+'</td><td>'+channelBadge(s.source)+'</td><td>'+dashCount(s.tokenSummary?.agentTokens)+'</td><td>'+dashCount(s.tokenSummary?.workerTokens)+'</td><td>'+dashCount(s.tokenSummary?.totalTokens)+'</td><td><a class="btn-stream" target="_blank" rel="noopener" href="'+escHtml(dashReportUrl(a.id,s.sessionId))+'">View token report ↗</a></td></tr>'));
  for(const e of document.querySelectorAll('.dash-tools details'))if(openTools.some(item=>item.row===e.closest('tr').dataset.rowKey&&item.label===e.querySelector('summary').textContent.split(':')[0]))e.open=true;
  const max=Math.max(0,...agents.map(a=>Number(a.orchestration?.pagination?.total||0)));
  document.querySelectorAll('[data-dash-next]').forEach(b=>b.disabled=dashboardOffset+25>=max);
  document.querySelectorAll('[data-dash-prev]').forEach(b=>b.disabled=dashboardOffset===0);
  document.querySelectorAll('[data-dash-page]').forEach(e=>e.textContent='Page '+(Math.floor(dashboardOffset/25)+1)+' · up to 25 sessions per agent · '+sessions+' recorded sessions total');
  const select=document.getElementById('dash-agent-filter');
  const signature=agents.map(a=>a.id).join('\n');
  if(select.dataset.signature!==signature){select.innerHTML='<option value="">All agents</option>'+agents.map(a=>'<option value="'+escHtml(a.id)+'">'+dashText(a.id)+'</option>').join('');select.value=dashboardAgent;select.dataset.signature=signature;}
  document.getElementById('tasks-scope').textContent='Tasks for sessions on the current page. Up to 100 recent tasks per session; open the session to inspect all recorded worker attempts in its token report.';
}
async function dashDetail(agentId,sessionId,taskId,offset=0){
  const generation=++dashboardDetailGeneration;
  dashboardFocus=document.activeElement;
  const back=document.getElementById('dash-drawer-back'), panel=document.getElementById('dash-drawer');
  back.classList.add('open');document.body.style.overflow='hidden';
  panel.innerHTML='<button data-dash-close aria-label="Close details">Close ×</button><p class="live-note">Loading recorded details…</p>';panel.focus();
  try{
    const path=taskId?'/dashboard/task':'/dashboard/session';
    const response=await fetch(apiUrl(path)+'?agentId='+encodeURIComponent(agentId)+'&sessionId='+encodeURIComponent(sessionId)+'&offset='+offset+'&scope='+dashboardScope+(taskId?'&taskId='+encodeURIComponent(taskId):''));
    if(response.status===401){onUnauthorized();return;}
    if(!response.ok)throw Error('Details unavailable (HTTP '+response.status+').');
    const detail=await response.json();if(generation!==dashboardDetailGeneration)return;
    let body='<button data-dash-close aria-label="Close details">Close ×</button><h1 id="dash-detail-title">'+dashText(taskId?detail.snapshot.title:'Session details')+'</h1><p class="muted">'+agentBadge(agentId)+' · <span class="session-id">'+dashText(sessionId)+'</span></p><p class="live-note">Recorded snapshot · '+new Date().toLocaleTimeString()+'</p><a class="btn-stream" href="'+escHtml(dashReportUrl(agentId,sessionId))+'" target="_blank" rel="noopener">Open full token report ↗</a>';
    if(taskId){
      body+='<h2>Task</h2>'+dashStatus(detail.snapshot.state)+'<pre>'+dashText(detail.snapshot.instructions||'No assignment recorded')+'</pre>';
      if(detail.snapshot.result)body+='<h2>Latest result</h2><pre>'+dashText(detail.snapshot.result.summary||JSON.stringify(detail.snapshot.result,null,2))+'</pre>';
      body+='<h2>Worker attempts</h2><p class="muted">'+detail.totalAttempts+' attempts · displaying '+(offset+1)+'–'+Math.min(offset+25,detail.totalAttempts)+'</p>';
      body+=detail.attempts.map(a=>'<details open><summary>Attempt '+dashText(a.generation)+' · '+dashText(a.state)+'</summary><dl><dt>Attempt ID</dt><dd>'+dashText(a.attemptId)+'</dd><dt>Worker ID</dt><dd>'+dashText(a.workerId)+'</dd><dt>Worker session</dt><dd>'+dashText(a.sessionId)+'</dd><dt>Model</dt><dd>'+dashText(a.metrics?.model)+'</dd><dt>Recorded tokens</dt><dd>'+dashCount(a.metrics?.usage?.totalTokens)+'</dd></dl>'+toolInventory(a.metrics?.loadedTools,a.metrics?.usedTools)+'<h3>Latest recorded events</h3>'+a.events.map(e=>'<details><summary>'+dashText(new Date(e.at).toLocaleString())+' · '+dashText(e.type)+'</summary><pre>'+dashText(JSON.stringify(e.payload,null,2))+'</pre></details>').join('')+'</details>').join('');
      if(offset>0)body+='<button data-attempt-page="'+Math.max(0,offset-25)+'">Newer attempts</button>';
      if(offset+25<detail.totalAttempts)body+='<button data-attempt-page="'+(offset+25)+'">Older attempts</button>';
    }else{
      body+='<h2>Session</h2><dl><dt>Channel</dt><dd>'+channelBadge(detail.session?.source)+'</dd><dt>Chat</dt><dd>'+dashText(detail.session?.chatId)+'</dd><dt>Created</dt><dd>'+dashText(detail.session?.createdAt?new Date(detail.session.createdAt).toLocaleString():null)+'</dd></dl><h2>Tasks ('+dashCount(detail.totalTasks)+')</h2><div class="dash-mini-list">'+(detail.tasks||[]).map(t=>'<button'+dashOpenAttrs(agentId,sessionId,t.taskId)+'>'+dashText(t.title)+dashStatus(t.state)+'</button>').join('')+'</div>';
      body+='<div class="dash-grid"><div class="dash-stat"><span>Agent tokens</span><strong>'+dashCount(detail.totals.agentTokens)+'</strong></div><div class="dash-stat"><span>Worker tokens</span><strong>'+dashCount(detail.totals.workerTokens)+'</strong></div></div><p class="live-note">Recorded turns only. Missing measurements are unavailable, not zero. Token volume is not billing cost.</p><h2>Turns & worker attempts</h2>';
      body+=detail.turns.map(t=>'<details><summary>'+dashText(t.role)+' · '+dashText(t.category)+' · '+dashText(new Date(t.startedAt).toLocaleString())+' · '+dashCount(t.usage?.totalTokens)+' tokens</summary><p class="live-note">'+dashText(t.id)+' · '+dashText(t.model)+' · '+dashText(t.state)+'</p>'+(t.taskId?'<button class="btn-stream"'+dashOpenAttrs(agentId,sessionId,t.taskId)+'>Inspect task / worker</button>':'')+toolInventory(t.loadedTools,t.usedTools)+(t.inputTexts||[]).map(text=>'<pre>'+dashText(text)+'</pre>').join('')+(t.responseText?'<h3>Response / result</h3><pre>'+dashText(t.responseText)+'</pre>':'')+'</details>').join('');
      if(!detail.turns.length)body+='<p class="empty">No instrumented turns recorded on this page.</p>';
      if(offset>0)body+='<button data-session-page="'+Math.max(0,offset-50)+'">Previous records</button>';
      if(offset+50<Math.max(detail.totalTasks||0,detail.pagination?.total||0))body+='<button data-session-page="'+(offset+50)+'">Next records</button>';
    }
    panel.innerHTML=body;panel.dataset.agent=agentId;panel.dataset.session=sessionId;panel.dataset.task=taskId||'';
  }catch(e){if(generation===dashboardDetailGeneration)panel.innerHTML='<button data-dash-close>Close ×</button><p class="error">'+dashText(e.message)+'</p>';}
}
function dashClose(){dashboardDetailGeneration++;document.getElementById('dash-drawer-back').classList.remove('open');document.body.style.overflow='';dashboardFocus?.focus();}
document.addEventListener('click',function(e){
  const open=e.target.closest('[data-dash-agent]');if(open){dashDetail(open.dataset.dashAgent,open.dataset.dashSession,open.dataset.dashTask);return;}
  if(e.target.closest('[data-dash-close]')||e.target.id==='dash-drawer-back')dashClose();
  const next=e.target.closest('[data-dash-next]'),prev=e.target.closest('[data-dash-prev]');if(next||prev){dashboardOffset=Math.max(0,dashboardOffset+(next?25:-25));refresh();connectDashboardStream();}
  const sessionPage=e.target.closest('[data-session-page]');if(sessionPage){const p=document.getElementById('dash-drawer');dashDetail(p.dataset.agent,p.dataset.session,null,Number(sessionPage.dataset.sessionPage));}
  const older=e.target.closest('[data-attempt-page]');if(older){const p=document.getElementById('dash-drawer');dashDetail(p.dataset.agent,p.dataset.session,p.dataset.task,Number(older.dataset.attemptPage));}
  if(e.target.closest('#dash-menu'))document.body.classList.toggle('menuopen');
  if(e.target.closest('.tab')){const view=e.target.closest('.tab').dataset.view;document.querySelector('.dash-filter').hidden=['view-kb','view-system'].includes(view);document.getElementById('dash-search').hidden=view==='view-dreams';document.getElementById('dash-agent-filter').hidden=view==='view-dreams';document.querySelector('.dash-pager').hidden=['view-kb','view-dreams','view-system'].includes(view);document.body.classList.remove('menuopen');document.getElementById('dash-current-view').textContent=e.target.closest('.tab').textContent.trim();if(e.target.closest('.tab').dataset.view==='view-system')refreshProcesses();}
  if(e.target.closest('#dash-theme')){const root=document.documentElement;root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';}
});
document.addEventListener('keydown',function(e){
 if(e.key==='Escape'){dashClose();document.body.classList.remove('menuopen');}
 if(e.key==='Tab'&&document.getElementById('dash-drawer-back').classList.contains('open')){const panel=document.getElementById('dash-drawer'),nodes=[...panel.querySelectorAll('button,a,summary')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
});
document.getElementById('dash-scope').addEventListener('change',e=>{dashboardScope=e.target.value;dashboardOffset=0;refresh();connectDashboardStream();window.__loadDreams?.(true);});
document.getElementById('dash-search').addEventListener('input',e=>{dashboardSearch=e.target.value;if(dashboardData)renderDashboard(dashboardData);});
document.getElementById('dash-agent-filter').addEventListener('change',e=>{dashboardAgent=e.target.value;if(dashboardData)renderDashboard(dashboardData);});

let dashboardStream=null;
function connectDashboardStream(){
  dashboardStream?.close();dashboardStream=null;
  if(document.hidden||!window.EventSource)return;
  const stream=dashboardStream=new EventSource(apiUrl('/dashboard/events')+'?offset='+dashboardOffset+'&scope='+dashboardScope);
  stream.addEventListener('snapshot',e=>{if(stream!==dashboardStream)return;try{applyDashboardSnapshot(JSON.parse(e.data));}catch{document.getElementById('refresh-indicator').textContent='Update unavailable';}});
  stream.addEventListener('unauthorized',()=>{stream.close();onUnauthorized();});
  stream.addEventListener('unavailable',()=>{document.getElementById('refresh-indicator').textContent='Data unavailable';});
  stream.onerror=()=>{document.getElementById('refresh-indicator').textContent='Reconnecting…';};
}

`;

