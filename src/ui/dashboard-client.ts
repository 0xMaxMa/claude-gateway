import { dashboardSince, dashboardRange } from './dashboard-range';
import { dashboardPresentationClient } from './dashboard-presentation';
/** Browser controller: no provider keys or model-generated HTML are trusted. */
export const dashboardClient = dashboardPresentationClient + dashboardRange.toString()+';'+dashboardSince.toString()+';'+ String.raw`
let dashboardData = null, dashboardOffset = 0, dashboardBusy = false, dashboardSearch = '', dashboardAgent = '', dashboardScope = '24h';
const dashboardStateKey='gateway-dashboard-view:'+location.pathname.replace(/\/$/,'');
let savedDashboardState={};
try{savedDashboardState=JSON.parse(sessionStorage.getItem(dashboardStateKey)||'{}')||{};}catch{}
dashboardScope=dashboardRange(savedDashboardState.scope);
dashboardOffset=Number.isSafeInteger(savedDashboardState.offset)&&savedDashboardState.offset>=0&&savedDashboardState.offset<=1000000?savedDashboardState.offset:0;
dashboardSearch=typeof savedDashboardState.search==='string'?savedDashboardState.search:'';
dashboardAgent=typeof savedDashboardState.agent==='string'?savedDashboardState.agent:'';
window.addEventListener('pagehide',()=>{try{sessionStorage.setItem(dashboardStateKey,JSON.stringify({view:document.querySelector('.tab.active')?.dataset.view,scope:dashboardScope,offset:dashboardOffset,search:dashboardSearch,agent:dashboardAgent}));}catch{}});
document.addEventListener('DOMContentLoaded',()=>{
 document.getElementById('dash-search').value=dashboardSearch;
 document.querySelectorAll('#dash-scope [data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.range===dashboardScope)));
 const tab=[...document.querySelectorAll('.tab')].find(t=>t.dataset.view===savedDashboardState.view)||document.getElementById('tab-overview');tab.click();
});
const dashboardExpanded=new Map();
let dashboardFocus=null;
const dashboardMobile=window.matchMedia('(max-width:760px)');
function updateSidebarToggle(){
 const expanded=dashboardMobile.matches?document.body.classList.contains('menuopen'):document.documentElement.dataset.sidebarCollapsed!=='true';
 const label=expanded?'Collapse sidebar':'Expand sidebar';
 document.querySelectorAll('#dash-menu,#sidebar-brand').forEach(button=>{button.setAttribute('aria-expanded',String(expanded));button.setAttribute('aria-label',label);button.title=label;});
}
document.querySelectorAll('.sidebar .tab').forEach(tab=>{tab.title=tab.textContent.trim();tab.setAttribute('aria-label',tab.textContent.trim());});
dashboardMobile.addEventListener('change',updateSidebarToggle);updateSidebarToggle();
function dashboardRows() {
  const rows=[];
  (dashboardData?.agents||[]).forEach(a=>(a.sessions||[]).forEach(s=>rows.push({a,s})));
  return rows.filter(({a,s})=>(!dashboardAgent||a.id===dashboardAgent)&&(!dashboardSearch||[a.id,s.sessionId,s.chatId,s.source,s.model].join(' ').toLowerCase().includes(dashboardSearch.toLowerCase()))).sort((x,y)=>(Number(y.s.updatedAt||y.s.spawnedAt)||0)-(Number(x.s.updatedAt||x.s.spawnedAt)||0)||String(x.s.sessionId).localeCompare(String(y.s.sessionId)));
}
function dashboardTaskRows(){return dashboardRows().flatMap(({a,s})=>(s.tasks||[]).map(t=>({a,s,t}))).sort((x,y)=>Number(y.t.updatedAt)-Number(x.t.updatedAt)||x.t.taskId.localeCompare(y.t.taskId));}
function dashText(value){return escHtml(value==null?'—':String(value));}
function dashCount(value){return compactNumber(value);}
function dashStatus(value){return taskStatusBadge(value);}
// Managed sessions carry a DB-derived status where 'idle' cannot tell a kept-alive
// session from one already killed by the idle cleaner; sessionAlive (from the live
// runner map) disambiguates: alive -> idle, gone -> stopped. Real busy states
// (working/thinking/waiting_input/queued/…) are meaningful and left untouched.
function sessionDisplayStatus(s){
 if(s.orchestration){var st=s.status||'';return(!st||st==='idle')?(s.sessionAlive?'idle':'stopped'):st;}
 return s.status||(s.isRunning?'running':'stopped');
}
function dashReportUrl(a,s){return apiUrl('/dashboard/token-report')+'?agentId='+encodeURIComponent(a)+'&sessionId='+encodeURIComponent(s)+'&scope='+dashboardScope;}
function dashOpenAttrs(a,s,t){return ' data-dash-agent="'+escHtml(a)+'" data-dash-session="'+escHtml(s)+'"'+(t?' data-dash-task="'+escHtml(t)+'"':'');}
function dashId(value){return value?'<span class="short-id" title="'+dashText(value)+'">'+dashText(String(value))+'</span>':'<span class="muted">Not assigned</span>';}
function dashTable(headers,rows){
 const widths=headers[0]==='Agent / Channel'?[170,285,190,140,150,130,175]:headers[0]==='Task / Agent'?[300,140,290,120,120,145,200]:headers[0]==='Agent / Session'?[240,150,150,150,160,180]:[320,180,140];
 return '<div class="table-wrap"><table class="data-table" style="min-width:'+widths.reduce((a,b)=>a+b,0)+'px"><colgroup>'+widths.map(w=>'<col style="width:'+w+'px">').join('')+'</colgroup><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td colspan="'+headers.length+'" class="empty">No records in this scope.</td></tr>')+'</tbody></table></div>';
}
function renderDashboard(data){
  dashboardData=data;

  const rows=dashboardRows(), tasks=dashboardTaskRows();
  const agents=data.agents||[];
  const counts=agents.flatMap(a=>a.orchestration?.counts?.tasks||[]);
  const taskCount=states=>counts.filter(c=>states.includes(c.state)).reduce((n,c)=>n+Number(c.count),0);
  const sessions=agents.reduce((n,a)=>n+(a.orchestration?.counts?.sessions??a.sessions?.length??0),0);
  const stats=[['Recorded sessions',sessions],['Work in progress',taskCount(['running','starting','queued','interrupting','cancel_requested'])],['Waiting for a decision',taskCount(['waiting_input'])],['Loaded agents',agents.length]];
  document.getElementById('overview-stats').innerHTML=stats.map(([label,n])=>'<div class="dash-stat"><span>'+label+'</span><strong>'+dashCount(n)+'</strong></div>').join('');
  const attention=agents.flatMap(a=>(a.orchestration?.attention||[]).map(t=>({a,s:{sessionId:t.sessionId},t})));
  document.getElementById('overview-attention').innerHTML=attention.length?dashTable(['Task','Agent','Status'],attention.slice(0,8).map(({a,s,t})=>'<tr'+dashOpenAttrs(a.id,s.sessionId,t.taskId)+' tabindex="0" aria-expanded="false"><td>'+dashText(t.title)+'</td><td>'+agentBadge(a.id)+'</td><td>'+dashStatus(t.state)+'</td></tr>')):'<p class="muted">No tasks are waiting for a decision or reconciliation.</p>';
  const hourly=Array.from({length:24},()=>({agent:0,worker:0}));let hasUsage=false;
  agents.forEach(a=>(a.orchestration?.usageToday||[]).forEach(r=>{if(hourly[r.hour]&&['agent','worker'].includes(r.role)){hourly[r.hour][r.role]+=Number(r.tokens||0);hasUsage=true;}}));
  const peak=Math.max(1,...hourly.flatMap(h=>[h.agent,h.worker]));
  const points=role=>hourly.map((h,i)=>(i*600/23).toFixed(1)+','+(160-h[role]/peak*140).toFixed(1)).join(' ');
  document.getElementById('overview-chart').innerHTML=hasUsage?'<svg viewBox="0 0 600 180" role="img" aria-label="Recorded token activity today in UTC" style="width:100%;height:180px"><path d="M0 20H600M0 90H600M0 160H600" fill="none" stroke="var(--line)" stroke-dasharray="4 5"/><polyline points="'+points('worker')+'" fill="none" stroke="var(--accent)" stroke-width="2"/><polyline points="'+points('agent')+'" fill="none" stroke="var(--blue)" stroke-width="2"/></svg><div class="row between muted small"><span>00:00 UTC</span><span>12:00</span><span>23:00 UTC</span></div>':'<p class="empty">No recorded token usage today.</p>';
  const sessionRows=rows.map(({a,s})=>'<tr class="session-row"'+(s.orchestration?dashOpenAttrs(a.id,s.sessionId):'')+' tabindex="0" aria-expanded="false" data-row-key="'+escHtml(a.id+':'+s.sessionId)+'"><td>'+agentBadge(a.id)+'<br>'+channelBadge(s.source)+'</td><td><span class="session-id">'+dashText(s.sessionId)+'</span><br><small class="ts">Chat '+dashText(s.chatId)+'</small></td><td><span class="cell-clip" title="'+dashText(s.model)+'">'+dashText(s.model||'—')+'</span></td><td>'+dashStatus(sessionDisplayStatus(s))+'</td><td>'+ (s.orchestration?dashCount(s.tokenSummary?.agentTokens)+' / '+dashCount(s.tokenSummary?.totalTokens):dashCount(s.tokens))+'<br><small class="ts">'+(s.orchestration?'Agent / total · recorded only':'Legacy process tokens')+'</small></td><td class="dash-tools">'+toolInventory(s.loadedTools,s.usedTools,s.contextTools)+'</td><td>'+ (s.orchestration?'<a class="btn-stream" target="_blank" rel="noopener" href="'+escHtml(dashReportUrl(a.id,s.sessionId))+'">View token report ↗</a>':'')+(s.hasPtyStream&&s.isRunning&&s.mode==='pty-shell'?'<button class="btn-stream" data-agent-id="'+escHtml(a.id)+'" data-session-id="'+escHtml(s.sessionId)+'">Terminal</button>':'')+'</td></tr>');
  document.getElementById('session-results').innerHTML=dashTable(['Agent / Channel','Session / Chat','Model','Status','Tokens','Tools','Inspect'],sessionRows);
  const taskRows=tasks.map(({a,s,t})=>'<tr'+dashOpenAttrs(a.id,s.sessionId,t.taskId)+' tabindex="0" aria-expanded="false" data-row-key="'+escHtml(a.id+':'+t.taskId)+'"><td><strong class="dash-task-title">'+dashText(t.title)+'</strong><small class="ts">'+agentBadge(a.id)+' · '+dashId(t.taskId)+'<br>'+channelBadge(s.source)+'</small></td><td>'+dashStatus(t.state)+'</td><td class="session-id">'+dashId(t.workerSessionId)+'<br><small class="ts">Attempt '+dashId(t.attemptId)+'</small></td><td>'+dashCount(t.tokenSummary?.totalTokens)+'<br><small class="ts">Latest attempt</small></td><td>'+dashCount(t.tokenSummary?.allAttemptsTokens)+'<br><small class="ts">All recorded attempts</small></td><td class="dash-tools">'+toolInventory(t.loadedTools,t.usedTools,t.contextTools)+'</td><td><span class="cell-clip" title="'+dashText(t.lastTool?.name)+'">'+dashText(t.lastTool?.name||'No recorded tool')+'</span>'+'<br><small class="ts">'+(t.lastTool?.at?dashText(new Date(t.lastTool.at).toLocaleString()):'')+'</small></td></tr>');
  document.getElementById('task-results').innerHTML=dashTable(['Task / Agent','Status','Worker session / Attempt','Latest tokens','Task tokens','Latest attempt tools','Latest activity'],taskRows);
  const recentWork=agents.flatMap(a=>(a.orchestration?.recentWork||[]).map(t=>({a,s:{sessionId:t.sessionId},t}))).sort((x,y)=>Number(y.t.updatedAt)-Number(x.t.updatedAt)||x.t.taskId.localeCompare(y.t.taskId));
  document.getElementById('overview-tasks').innerHTML=dashTable(['Task','Agent','Status'],recentWork.slice(0,6).map(({a,s,t})=>'<tr'+dashOpenAttrs(a.id,s.sessionId,t.taskId)+' tabindex="0" aria-expanded="false"><td>'+dashText(t.title)+'</td><td>'+agentBadge(a.id)+'</td><td>'+dashStatus(t.state)+'</td></tr>'));
  document.getElementById('usage-results').innerHTML=dashTable(['Agent / Session','Channel','Agent tokens','Worker tokens','Total tokens','Report'],rows.filter(({s})=>s.orchestration).map(({a,s})=>'<tr'+dashOpenAttrs(a.id,s.sessionId)+' tabindex="0" aria-expanded="false"><td>'+agentBadge(a.id)+'<br>'+dashId(s.sessionId)+'</td><td>'+channelBadge(s.source)+'</td><td>'+dashCount(s.tokenSummary?.agentTokens)+'</td><td>'+dashCount(s.tokenSummary?.workerTokens)+'</td><td>'+dashCount(s.tokenSummary?.totalTokens)+'</td><td><a class="btn-stream" target="_blank" rel="noopener" href="'+escHtml(dashReportUrl(a.id,s.sessionId))+'">View token report ↗</a></td></tr>'));

  const max=Math.max(0,...agents.map(a=>Number(a.orchestration?.pagination?.total||0)));
  document.querySelectorAll('[data-dash-next]').forEach(b=>b.disabled=dashboardOffset+25>=max);
  document.querySelectorAll('[data-dash-prev]').forEach(b=>b.disabled=dashboardOffset===0);
  document.querySelectorAll('[data-dash-page]').forEach(e=>e.textContent='Page '+(Math.floor(dashboardOffset/25)+1)+' · up to 25 sessions per agent · '+sessions+' recorded sessions total');
  const select=document.getElementById('dash-agent-filter');
  const signature=agents.map(a=>a.id).join('\n');
  if(select.dataset.signature!==signature){select.innerHTML='<option value="">All agents</option>'+agents.map(a=>'<option value="'+escHtml(a.id)+'">'+dashText(a.id)+'</option>').join('');select.value=dashboardAgent;select.dataset.signature=signature;}
  restoreDashboardDetails();
  for(const record of [...dashboardExpanded.values()])void dashDetail(record.agentId,record.sessionId,record.taskId,record.offset);
  document.getElementById('tasks-scope').textContent='Tasks for sessions on the current page. Up to 100 recent tasks per session; open the session to inspect all recorded worker attempts in its token report.';
}
async function dashDetail(agentId,sessionId,taskId,offset=0){
  const key=[agentId,sessionId,taskId||''].join(':');
  const previous=dashboardExpanded.get(key);if(previous?.pending)return;
  const record={agentId,sessionId,taskId,offset,pending:true,html:previous?.html||'<p>Loading recorded details…</p>'};
  const opening=!dashboardExpanded.size;
  if(opening)dashboardFocus=document.activeElement;
  dashboardExpanded.clear();dashboardExpanded.set(key,record);restoreDashboardDetails();
  if(opening)document.getElementById('dash-drawer').focus();
  try{
    const path=taskId?'/dashboard/task':'/dashboard/session';
    const response=await fetch(apiUrl(path)+'?agentId='+encodeURIComponent(agentId)+'&sessionId='+encodeURIComponent(sessionId)+'&offset='+offset+'&scope='+dashboardScope+(taskId?'&taskId='+encodeURIComponent(taskId):''));
    if(response.status===401){onUnauthorized();return;}
    if(!response.ok)throw Error('Details unavailable (HTTP '+response.status+').');
    const detail=await response.json();if(dashboardExpanded.get(key)!==record)return;
    let body='<h1>'+dashText(taskId?detail.snapshot.title:'Session details')+'</h1><p class="muted">'+agentBadge(agentId)+' · <span class="session-id">'+dashText(sessionId)+'</span></p><p class="live-note">Recorded snapshot · '+new Date().toLocaleTimeString()+'</p><a class="btn-stream" href="'+escHtml(dashReportUrl(agentId,sessionId))+'" target="_blank" rel="noopener">Open full token report ↗</a>';
    if(taskId){
      body+='<h2>Task</h2>'+dashStatus(detail.snapshot.state)+'<pre>'+dashText(detail.snapshot.instructions||'No assignment recorded')+'</pre>';
      if(detail.snapshot.result)body+='<h2>Latest result</h2><pre>'+dashText(detail.snapshot.result.summary||JSON.stringify(detail.snapshot.result,null,2))+'</pre>';
      body+='<h2>Worker attempts</h2><p class="muted">'+detail.totalAttempts+' attempts · displaying '+(offset+1)+'–'+Math.min(offset+25,detail.totalAttempts)+'</p>';
      body+=detail.attempts.map(a=>'<section class="detail-block"><h3>Attempt '+dashText(a.generation)+' · '+dashText(a.state)+'</h3><dl><dt>Attempt ID</dt><dd>'+dashText(a.attemptId)+'</dd><dt>Worker ID</dt><dd>'+dashText(a.workerId)+'</dd><dt>Worker session</dt><dd>'+dashText(a.sessionId)+'</dd><dt>Model</dt><dd>'+dashText(a.metrics?.model)+'</dd><dt>Recorded tokens</dt><dd>'+dashCount(a.metrics?.usage?.totalTokens)+'</dd></dl>'+toolInventory(a.metrics?.loadedTools,a.metrics?.usedTools,a.metrics?.contextTools)+(a.metrics?.contextTools?'<h3>Loaded tools</h3>'+toolNameList(a.metrics.contextTools):'')+'<h3>Used tools</h3>'+toolNameList(a.metrics?.usedTools)+'<h3>Latest recorded events</h3>'+a.events.map(e=>'<section class="detail-block"><h3>'+dashText(new Date(e.at).toLocaleString())+' · '+dashText(e.type)+'</h3><pre>'+dashText(JSON.stringify(e.payload,null,2))+'</pre></section>').join('')+'</section>').join('');
      if(offset>0)body+='<button data-attempt-page="'+Math.max(0,offset-25)+'">Newer attempts</button>';
      if(offset+25<detail.totalAttempts)body+='<button data-attempt-page="'+(offset+25)+'">Older attempts</button>';
    }else{
      body+='<h2>Session</h2><dl><dt>Channel</dt><dd>'+channelBadge(detail.session?.source)+'</dd><dt>Chat</dt><dd>'+dashText(detail.session?.chatId)+'</dd><dt>Created</dt><dd>'+dashText(detail.session?.createdAt?new Date(detail.session.createdAt).toLocaleString():null)+'</dd></dl>';
      var uBy=detail.usageByRole||[];
      var uAgent=uBy.find(function(u){return u.role==='agent';}),uWorker=uBy.find(function(u){return u.role==='worker';});
      var cachedLineFor=function(u){if(!u)return '';var read=Number(u.cacheReadTokens||0),base=Number(u.inputTokens||0)+read+Number(u.cacheCreationTokens||0);return '<span class="card-cached">Cached: <b>'+(base?(read/base*100).toFixed(2):'0.00')+'%</b></span>';};
      var cw=detail.contextWindow;
      var windowCap=function(t){return t>=1e6?(+(t/1e6).toFixed(2))+'M':Math.round(t/1000)+'K';};
      var detailActivity=detail.activityStatus||'';
      var cwStopped=(!detailActivity||detailActivity==='idle')&&detail.sessionStatus==='stopped';
      body+='<div class="dash-grid session-token-totals"><div class="dash-stat box-context"><span>Context window</span><strong>'+(cwStopped?'-':(cw?dashCount(cw.used)+' / '+windowCap(cw.total):'—'))+'</strong>'+((!cwStopped&&cw&&cw.model)?'<span class="card-cached">Model: '+escHtml(cw.model)+'</span>':'')+'</div><div class="dash-stat box-agent"><span>Agent tokens</span><strong>'+dashCount(detail.totals.agentTokens)+'</strong>'+cachedLineFor(uAgent)+'</div><div class="dash-stat box-worker"><span>Worker tokens</span><strong>'+dashCount(detail.totals.workerTokens)+'</strong>'+cachedLineFor(uWorker)+'</div></div><p class="live-note">Recorded turns only. Missing measurements are shown as —, not zero. Token volume is not billing cost.</p>';
      body+='<details class="detail-block turn-disclosure session-tasks" data-detail-turn="section:tasks"><summary>Tasks ('+dashCount(detail.totalTasks)+')</summary><div class="dash-mini-list">'+(detail.tasks||[]).map(t=>'<div class="session-task-row"><span class="session-task-title">'+dashText(t.title)+'</span>'+dashStatus(t.state)+'</div>').join('')+(!detail.tasks?.length?'<p class="muted">No tasks recorded.</p>':'')+'</div></details><h2>Turns & worker attempts</h2>';
      body+=detail.turns.map(t=>'<details class="detail-block turn-disclosure" data-detail-turn="'+dashText(t.id)+'"><summary>'+dashText(t.role)+' · '+dashText(t.category)+' · '+dashText(new Date(t.startedAt).toLocaleString())+' · '+dashCount(t.usage?.totalTokens)+' tokens</summary><p class="live-note">'+dashText(t.id)+' · '+dashText(t.model)+' · '+dashText(t.state)+'</p>'+(t.taskId?'<p>Task '+dashText(t.taskId)+'</p>':'')+toolInventory(t.loadedTools,t.usedTools,t.contextTools)+(t.contextTools?'<h3>Loaded tools</h3>'+toolNameList(t.contextTools):'')+'<h3>Used tools</h3>'+toolNameList(t.usedTools)+(t.inputTexts||[]).map(text=>'<pre>'+dashText(text)+'</pre>').join('')+(t.responseText?'<h3>Response / result</h3><pre>'+dashText(t.responseText)+'</pre>':'')+'</details>').join('');
      if(!detail.turns.length)body+='<p class="empty">No instrumented turns recorded on this page.</p>';
      if(offset>0)body+='<button data-session-page="'+Math.max(0,offset-50)+'">Previous records</button>';
      if(offset+50<Math.max(detail.totalTasks||0,detail.pagination?.total||0))body+='<button data-session-page="'+(offset+50)+'">Next records</button>';
    }
    record.html=body;restoreDashboardDetails();
  }catch(e){if(dashboardExpanded.get(key)===record){record.html='<p>'+dashText(e.message)+'</p>';restoreDashboardDetails();}}finally{record.pending=false;}
}
function restoreDashboardDetails(){
 const record=[...dashboardExpanded.values()][0];
 const back=document.getElementById('dash-drawer-back'),panel=document.getElementById('dash-drawer');
 back.classList.toggle('open',Boolean(record));document.body.style.overflow=record?'hidden':'';
 document.querySelectorAll('tr[data-dash-agent]').forEach(row=>row.setAttribute('aria-expanded',String(Boolean(record&&row.dataset.dashAgent===record.agentId&&row.dataset.dashSession===record.sessionId&&(row.dataset.dashTask||'')===(record.taskId||'')))));
 if(!record){panel.innerHTML='';delete panel.dataset.html;return;}
 const html='<button data-dash-close aria-label="Close details">Close ×</button>'+record.html;
 if(panel.dataset.html!==html){
  const scroll=panel.scrollTop,focused=panel.contains(document.activeElement),closeFocused=document.activeElement?.hasAttribute('data-dash-close');
  const sameDetail=panel.dataset.agent===record.agentId&&panel.dataset.session===record.sessionId&&panel.dataset.task===(record.taskId||'');
  const openTurns=new Set(sameDetail?[...panel.querySelectorAll('details[data-detail-turn][open]')].map(e=>e.dataset.detailTurn):[]);
  const focusedTurn=focused?document.activeElement.closest('details[data-detail-turn]')?.dataset.detailTurn:null;
  panel.innerHTML=html;panel.dataset.html=html;
  panel.querySelectorAll('details[data-detail-turn]').forEach(e=>{e.open=openTurns.has(e.dataset.detailTurn);});
  panel.scrollTop=scroll;
  if(focusedTurn){const summary=[...panel.querySelectorAll('details[data-detail-turn]')].find(e=>e.dataset.detailTurn===focusedTurn)?.querySelector('summary');summary?.focus({preventScroll:true});}
  if(focused&&!focusedTurn)(closeFocused?panel.querySelector('[data-dash-close]'):panel).focus({preventScroll:true});
 }
 panel.dataset.agent=record.agentId;panel.dataset.session=record.sessionId;panel.dataset.task=record.taskId||'';
}
function dashClose(){const wasOpen=dashboardExpanded.size;dashboardExpanded.clear();restoreDashboardDetails();if(wasOpen&&dashboardFocus?.isConnected)dashboardFocus.focus({preventScroll:true});}
document.addEventListener('click',function(e){
  const open=e.target.closest('[data-dash-agent]');if(open&&!e.target.closest('a,summary,input,select')&&(!e.target.closest('button')||open.tagName==='BUTTON')){const key=[open.dataset.dashAgent,open.dataset.dashSession,open.dataset.dashTask||''].join(':');if(dashboardExpanded.has(key)){dashClose();}else dashDetail(open.dataset.dashAgent,open.dataset.dashSession,open.dataset.dashTask);return;}
  if(e.target.closest('[data-dash-close]')||e.target.id==='dash-drawer-back')dashClose();
  const next=e.target.closest('[data-dash-next]'),prev=e.target.closest('[data-dash-prev]');if(next||prev){dashClose();dashboardOffset=Math.max(0,dashboardOffset+(next?25:-25));refresh();connectDashboardStream();}
  const sessionPage=e.target.closest('[data-session-page]');if(sessionPage){const p=document.getElementById('dash-drawer');dashDetail(p.dataset.agent,p.dataset.session,null,Number(sessionPage.dataset.sessionPage));}
  const older=e.target.closest('[data-attempt-page]');if(older){const p=document.getElementById('dash-drawer');dashDetail(p.dataset.agent,p.dataset.session,p.dataset.task,Number(older.dataset.attemptPage));}
  const sidebarBlank=e.target.matches('#dashboard-sidebar,#dashboard-sidebar .tabs,#dashboard-sidebar .sidebarfoot');
  if(e.target.closest('#dash-menu,#sidebar-brand')||sidebarBlank){
   if(dashboardMobile.matches)document.body.classList.toggle('menuopen');
   else{const collapsed=document.documentElement.dataset.sidebarCollapsed!=='true';document.documentElement.dataset.sidebarCollapsed=String(collapsed);try{localStorage.setItem('gateway-sidebar-collapsed',String(collapsed));}catch{}}
   updateSidebarToggle();
  }
  if(e.target.closest('.tab')){const view=e.target.closest('.tab').dataset.view;document.querySelector('.dash-filter').hidden=['view-overview','view-kb','view-system'].includes(view);document.getElementById('dash-search').hidden=view==='view-dreams';document.getElementById('dash-agent-filter').hidden=view==='view-dreams';document.querySelector('.dash-pager').hidden=['view-overview','view-kb','view-dreams','view-system'].includes(view);document.body.classList.remove('menuopen');updateSidebarToggle();document.getElementById('dash-current-view').textContent=e.target.closest('.tab').textContent.trim();if(e.target.closest('.tab').dataset.view==='view-system')refreshProcesses();}
  if(e.target.closest('#dash-theme')){const root=document.documentElement;root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';}
});
document.addEventListener('keydown',function(e){
 if(e.target.id==='sidebar-brand'&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.target.click();return;}
 if(e.key==='Escape'){dashClose();document.body.classList.remove('menuopen');updateSidebarToggle();}
 if(e.key==='Tab'&&document.getElementById('dash-drawer-back').classList.contains('open')){const panel=document.getElementById('dash-drawer'),nodes=[...panel.querySelectorAll('button,a,summary')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 if((e.key==='Enter'||e.key===' ')&&e.target.matches('tr[data-dash-agent]')){e.preventDefault();e.target.click();}
});
document.getElementById('dash-scope').addEventListener('click',e=>{const button=e.target.closest('[data-range]');if(!button)return;dashboardScope=button.dataset.range;document.querySelectorAll('#dash-scope [data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));dashboardOffset=0;dashClose();refresh();connectDashboardStream();window.__loadDreams?.(true);});
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

