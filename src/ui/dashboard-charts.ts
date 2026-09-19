export function dashboardChartsHtml(timezone: string): string {
  const zone=timezone.replace(/[^A-Za-z0-9_+\/.-]/g,'');
  return '<div id="overview-charts" class="overview-chart-grid">'+[
    ['activity','Token activity'],['agents','Tokens by agent'],['models','Tokens by model'],['reuse','Context reuse'],
  ].map(([key,title])=>'<section class="dash-panel overview-chart-card" data-chart="'+key+'"><div class="chart-card-header"><h2>'+title+'</h2><div class="range-toggle chart-range" role="group" aria-label="'+title+' date range">'+['24h','7d','30d','90d'].map(range=>'<button type="button" data-chart-range="'+range+'" aria-pressed="'+(range==='24h')+'" title="'+(range==='24h'?'Today from 00:00 ':range+' including today · ')+zone+'">'+range+'</button>').join('')+'</div></div><p class="live-note chart-period"></p><div class="chart-content" id="chart-'+key+'"><p class="empty">Loading recorded usage…</p></div><p class="live-note chart-status" role="status"></p></section>').join('')+'</div>';
}

export const dashboardChartsClient=String.raw`
const overviewChartRanges={activity:'24h',agents:'24h',models:'24h',reuse:'24h'};
const overviewChartSnapshots=new Map(),overviewChartInflight=new Map();
const chartColors=['var(--blue)','var(--accent)','var(--orange)','#dd659e','#32a887','#9b8337'];
try{const saved=JSON.parse(sessionStorage.getItem('gateway-overview-charts')||'{}');Object.keys(overviewChartRanges).forEach(key=>{if(['24h','7d','30d','90d'].includes(saved[key]))overviewChartRanges[key]=saved[key];});}catch{}
function chartPeriod(data){const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:data.timezone,day:'numeric',month:'short'});return (data.scope==='24h'?'Today · from 00:00':fmt.format(data.since)+' – '+fmt.format(data.asOf))+' · '+data.timezone;}
function chartEmpty(){return '<p class="empty">No recorded token usage in this period.</p>';}
function chartActivity(data){
 const slots=new Map();
 if(data.scope==='24h')for(let i=0;i<24;i++)slots.set(String(i).padStart(2,'0'),{agent:0,worker:0});
 else{
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const parts=fmt.formatToParts(data.asOf),v=k=>Number(parts.find(p=>p.type===k).value),end=Date.UTC(v('year'),v('month')-1,v('day'));
  for(let i=Number(data.scope.slice(0,-1))-1;i>=0;i--)slots.set(new Date(end-i*86400000).toISOString().slice(0,10),{agent:0,worker:0});
 }
 data.agents.forEach(a=>a.buckets.forEach(b=>{if(slots.has(b.key)){const slot=slots.get(b.key);slot.agent+=b.agent;slot.worker+=b.worker;}}));
 const values=[...slots].map(([key,value])=>({key,...value})),peak=Math.max(0,...values.flatMap(v=>[v.agent,v.worker]));
 if(!peak)return chartEmpty();
 const label=key=>data.scope==='24h'?key+':00':key.slice(8,10)+'/'+key.slice(5,7);
 const points=role=>values.map((v,i)=>(i*600/(values.length-1)).toFixed(2)+','+(180-v[role]/peak*170).toFixed(2)).join(' ');
 return '<div class="activity-frame"><div class="chart-y-labels"><span>'+compactNumber(peak)+'</span><span>'+compactNumber(peak/2)+'</span><span>0</span></div><div class="activity-plot"><svg viewBox="0 0 600 190" preserveAspectRatio="none" aria-label="Agent and worker recorded token activity" role="img"><path d="M0 10H600M0 95H600M0 180H600" fill="none" stroke="var(--line)" stroke-dasharray="3 5" vector-effect="non-scaling-stroke"/>'+['worker','agent'].map(role=>'<polyline points="'+points(role)+'" fill="none" stroke="'+(role==='agent'?'var(--blue)':'var(--accent)')+'" stroke-width="1.5" vector-effect="non-scaling-stroke"/>').join('')+'</svg><div class="chart-hit-grid" style="grid-template-columns:repeat('+values.length+',minmax(0,1fr))">'+values.map((v,i)=>'<div class="chart-hit" tabindex="0" role="img" aria-label="'+escHtml(label(v.key)+': Agent '+compactNumber(v.agent)+', workers '+compactNumber(v.worker))+'">'+['agent','worker'].map(role=>'<i class="chart-line-dot" style="top:'+((180-v[role]/peak*170)/190*100)+'%;left:'+((i/(values.length-1)*values.length-i)*100)+'%;--dot-color:'+(role==='agent'?'var(--blue)':'var(--accent)')+'"></i>').join('')+'<span class="chart-popover '+(i>values.length/2?'align-right':'align-left')+'"><strong>'+label(v.key)+'</strong><br>Agent · '+compactNumber(v.agent)+'<br>Workers · '+compactNumber(v.worker)+'<br>Total · '+compactNumber(v.agent+v.worker)+'</span></div>').join('')+'</div><div class="chart-x-labels"><span>'+label(values[0].key)+'</span><span>'+label(values[Math.floor(values.length/2)].key)+'</span><span>'+label(values[values.length-1].key)+'</span></div></div></div><div class="chart-key"><span><i style="background:var(--blue)"></i>Agent</span><span><i style="background:var(--accent)"></i>Workers</span></div><p class="live-note">Recorded tokens, including cache. Not billing cost.</p>';
}
function chartAgents(data,element){
 const agents=data.agents.map(a=>({...a,total:a.agent+a.worker})).filter(a=>a.total>0).sort((a,b)=>b.total-a.total||a.id.localeCompare(b.id));
 if(!agents.length)return chartEmpty();
 const capacity=Math.max(2,Math.min(8,Math.floor((element.clientWidth-40)/76))),top=agents.slice(0,capacity),peak=top[0].total;
 return '<div class="agent-column-plot"><div class="chart-y-labels"><span>'+compactNumber(peak)+'</span><span>'+compactNumber(peak/2)+'</span><span>0</span></div><div class="agent-columns">'+top.map(a=>'<div class="agent-column"><div class="agent-bar-space"><div class="agent-bar" tabindex="0" role="img" aria-label="'+escHtml(a.id+': Agent '+compactNumber(a.agent)+', workers '+compactNumber(a.worker)+', total '+compactNumber(a.total))+'" style="height:'+Math.max(1,a.total/peak*100)+'%"><span style="height:'+(a.worker/a.total*100)+'%;background:var(--accent)"></span><span style="height:'+(a.agent/a.total*100)+'%;background:var(--blue)"></span><span class="agent-bar-total">'+compactNumber(a.total)+'</span><span class="chart-popover"><strong>'+escHtml(a.id)+'</strong><br>Agent · '+compactNumber(a.agent)+'<br>Workers · '+compactNumber(a.worker)+'</span></div></div><span class="agent-bar-label" title="'+escHtml(a.id)+'">'+escHtml(a.id)+'</span></div>').join('')+'</div></div><div class="chart-key"><span><i style="background:var(--blue)"></i>Agent</span><span><i style="background:var(--accent)"></i>Workers</span></div><p class="live-note">Top '+top.length+' of '+agents.length+' active agents · ranked by recorded tokens.</p>';
}
function chartModels(data){
 const models=new Map();data.agents.forEach(a=>a.models.forEach(m=>models.set(m.name,(models.get(m.name)||0)+m.tokens)));
 const sorted=[...models].map(([name,tokens])=>({name,tokens})).sort((a,b)=>b.tokens-a.tokens||a.name.localeCompare(b.name));
 const total=sorted.reduce((n,m)=>n+m.tokens,0);if(!total)return chartEmpty();
 const top=sorted.slice(0,5);if(sorted.length>5)top.push({name:'Other models ('+(sorted.length-5)+')',tokens:sorted.slice(5).reduce((n,m)=>n+m.tokens,0)});
 let offset=0;const circumference=2*Math.PI*72;
 const arcs=top.map((m,i)=>{const length=m.tokens/total*circumference,arc='<circle cx="100" cy="100" r="72" fill="none" stroke="'+chartColors[i]+'" stroke-width="22" stroke-dasharray="'+length+' '+(circumference-length)+'" stroke-dashoffset="'+(-offset)+'" transform="rotate(-90 100 100)" tabindex="0"><title>'+escHtml(m.name)+' · '+compactNumber(m.tokens)+' · '+(m.tokens/total*100).toFixed(1)+'%</title></circle>';offset+=length;return arc;}).join('');
 return '<div class="model-donut-layout"><div class="model-donut"><svg viewBox="0 0 200 200" role="img" aria-label="Recorded tokens by model">'+arcs+'</svg><div class="donut-center"><strong>'+compactNumber(total)+'</strong><span>Total tokens</span></div></div><ul class="model-chart-legend">'+top.map((m,i)=>'<li><i style="background:'+chartColors[i]+'"></i><span title="'+escHtml(m.name)+'">'+escHtml(m.name)+'</span><strong>'+compactNumber(m.tokens)+'</strong><small>'+(m.tokens/total*100).toFixed(1)+'%</small></li>').join('')+'</ul></div><p class="live-note">Agent + worker tokens · includes cache reads and writes.</p>';
}
function chartReuse(data){
 const sum=data.agents.reduce((r,a)=>{Object.keys(r).forEach(k=>r[k]+=a.reuse[k]||0);return r;},{fresh:0,write:0,read:0,measuredTurns:0,missingTurns:0});
 const total=sum.fresh+sum.write+sum.read;if(!total)return '<p class="empty">No measured input breakdown in this period.</p>';
 const pct=sum.read/total*100;
 const pieces=[['Reused input',sum.read,'var(--blue)','Cache read · existing input used again'],['New · saved for reuse',sum.write,'var(--accent)','Cache write · new input stored for later requests'],['New · not cached',sum.fresh,'var(--orange)','Fresh input · newly processed input']];
 return '<div class="reuse-headline"><strong>'+pct.toFixed(1)+'<small>%</small></strong><div>of measured input reused<span>Less input processed from scratch.</span></div></div><div class="reuse-bar" role="img" aria-label="'+pct.toFixed(1)+' percent of measured input reused">'+pieces.map(([label,n,color,hint])=>'<span style="width:'+(n/total*100)+'%;background:'+color+'" title="'+hint+': '+compactNumber(n)+'"></span>').join('')+'</div><ul class="reuse-legend">'+pieces.map(([label,n,color,hint])=>'<li title="'+hint+'"><i style="background:'+color+'"></i><span>'+label+'</span><strong>'+compactNumber(n)+'</strong><small>'+(n/total*100).toFixed(1)+'%</small></li>').join('')+'</ul><p class="live-note">Based on input tokens only. Reuse is not a cost-saving percentage.'+(sum.missingTurns?' '+compactNumber(sum.missingTurns)+' turns excluded: incomplete measurements.':'')+'</p>';
}
function drawOverviewChart(key,data){
 const card=document.querySelector('[data-chart="'+key+'"]'),element=card.querySelector('.chart-content');
 card.querySelector('.chart-period').textContent=chartPeriod(data);
 element.innerHTML=key==='activity'?chartActivity(data):key==='agents'?chartAgents(data,element):key==='models'?chartModels(data):chartReuse(data);
 card.querySelector('.chart-status').textContent='';
}
function refreshOverviewCharts(force=false){
 if(document.hidden||document.getElementById('view-overview').style.display==='none')return;
 Object.keys(overviewChartRanges).forEach(key=>document.querySelectorAll('[data-chart="'+key+'"] [data-chart-range]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.chartRange===overviewChartRanges[key]))));
 [...new Set(Object.values(overviewChartRanges))].forEach(scope=>{
  const old=overviewChartSnapshots.get(scope);if(!force&&old&&Date.now()-old.at<10000)return;
  if(overviewChartInflight.has(scope))return;
  const request=fetch(apiUrl('/dashboard/charts')+'?scope='+scope,{signal:AbortSignal.timeout(15000)}).then(async response=>{if(!response.ok)throw Error('Chart data temporarily unavailable');return response.json();}).then(data=>{
   overviewChartSnapshots.set(scope,{data,at:Date.now()});Object.keys(overviewChartRanges).forEach(key=>{if(overviewChartRanges[key]===scope)drawOverviewChart(key,data);});
  }).catch(()=>Object.keys(overviewChartRanges).forEach(key=>{if(overviewChartRanges[key]===scope)document.querySelector('[data-chart="'+key+'"] .chart-status').textContent='Could not refresh. Retrying automatically.';})).finally(()=>overviewChartInflight.delete(scope));
  overviewChartInflight.set(scope,request);
 });
}
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-chart-range]');if(button){
  const key=button.closest('[data-chart]').dataset.chart,scope=button.dataset.chartRange;overviewChartRanges[key]=scope;
  try{sessionStorage.setItem('gateway-overview-charts',JSON.stringify(overviewChartRanges));}catch{}
  const cached=overviewChartSnapshots.get(scope);if(cached)drawOverviewChart(key,cached.data);else {document.getElementById('chart-'+key).innerHTML='<p class="empty">Loading recorded usage…</p>';document.querySelector('[data-chart="'+key+'"] .chart-period').textContent='';}
  refreshOverviewCharts();
 }else if(event.target.closest('#tab-overview'))refreshOverviewCharts();
});
document.addEventListener('DOMContentLoaded',()=>refreshOverviewCharts());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOverviewCharts();});
setInterval(()=>refreshOverviewCharts(true),10000);
let chartResizeWidth=0;new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width===chartResizeWidth)return;chartResizeWidth=width;const snapshot=overviewChartSnapshots.get(overviewChartRanges.agents);if(snapshot)drawOverviewChart('agents',snapshot.data);}).observe(document.getElementById('chart-agents'));
`;
