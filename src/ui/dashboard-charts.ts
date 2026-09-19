export function dashboardChartsHtml(timezone: string): string {
  const zone=timezone.replace(/[^A-Za-z0-9_+\/.-]/g,'');
  return '<div id="overview-charts" class="overview-chart-grid">'+[
    ['activity','Token activity'],['agents','Tokens by agent'],['models','Tokens by model'],['reuse','Context reuse'],
  ].map(([key,title])=>'<section class="dash-panel overview-chart-card" data-chart="'+key+'"><div class="chart-card-header"><h2>'+title+'</h2><div class="range-toggle chart-range" role="group" aria-label="'+title+' date range">'+['24h','7d','30d','90d'].map(range=>'<button type="button" data-chart-range="'+range+'" aria-pressed="'+(range==='24h')+'" title="'+(range==='24h'?'Today from 00:00 ':range+' including today · ')+zone+'">'+range+'</button>').join('')+'</div></div><p class="live-note chart-period"></p><div class="chart-content" id="chart-'+key+'"><p class="empty">Loading recorded usage…</p></div><p class="live-note chart-status" role="status"></p></section>').join('')+'</div>';
}

export const dashboardChartsClient=String.raw`
const overviewChartRanges={activity:'24h',agents:'24h',models:'24h',reuse:'24h'};
const overviewChartSnapshots=new Map(),overviewChartInflight=new Map();
const chartColors=dashboardChartPalette;
const chartRendered=new WeakMap();
let chartPointer=null;
document.addEventListener('pointermove',event=>{chartPointer={x:event.clientX,y:event.clientY};});
document.addEventListener('pointerout',event=>{if(!event.relatedTarget)chartPointer=null;});
const chartPreferenceKey='gateway-overview-charts:'+location.pathname.replace(/\/$/,'');
try{
 const saved=JSON.parse(localStorage.getItem(chartPreferenceKey)||'{}');
 Object.keys(overviewChartRanges).forEach(key=>{if(['24h','7d','30d','90d'].includes(saved?.[key]))overviewChartRanges[key]=saved[key];});
}catch{}
// Restore controls before the first fetch, including when Overview is initially hidden.
Object.keys(overviewChartRanges).forEach(key=>document.querySelectorAll('[data-chart="'+key+'"] [data-chart-range]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.chartRange===overviewChartRanges[key]))));
function chartPeriod(data){const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:data.timezone,day:'numeric',month:'short'});return (data.scope==='24h'?'Today · from 00:00':fmt.format(data.since)+' – '+fmt.format(data.asOf))+' · '+data.timezone;}
function chartEmpty(){return '<p class="empty">No recorded token usage in this period.</p>';}
function chartTooltipRow(label,value,color='var(--text)',detail){
 return '<span class="chart-tooltip-row"><span>'+escHtml(label)+'</span><strong style="color:'+color+'">'+escHtml(value)+(detail==null?'':' <span class="chart-tooltip-detail">('+escHtml(detail)+')</span>')+'</strong></span>';
}
function chartInputShare(value,total){return total>0?(value/total*100).toFixed(1)+'%':'—';}
function chartActivity(data,reuse=false){
 const reuseLegend={read:'Reused (Cached Read)',write:'New saved (Cached write)',fresh:'New not cached (Input)'};
 const series=reuse?[['read','Reused','var(--token-agent)'],['write','New · saved','var(--token-worker)'],['fresh','New · not cached','var(--token-report)']]:[['agent','Agent','var(--token-agent)'],['worker','Workers','var(--token-worker)']];
 const blank=()=>Object.fromEntries(series.map(([key])=>[key,0]));
 const slots=new Map();
 if(data.scope==='24h')for(let i=0;i<24;i++)slots.set(String(i).padStart(2,'0'),blank());
 else{
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const parts=fmt.formatToParts(data.asOf),v=k=>Number(parts.find(p=>p.type===k).value),end=Date.UTC(v('year'),v('month')-1,v('day'));
  for(let i=Number(data.scope.slice(0,-1))-1;i>=0;i--)slots.set(new Date(end-i*86400000).toISOString().slice(0,10),blank());
 }
 data.agents.forEach(a=>a.buckets.forEach(b=>{if(slots.has(b.key)){const slot=slots.get(b.key);series.forEach(([key])=>slot[key]+=Number(b[key]||0));}}));
 const values=[...slots].map(([key,value])=>({key,...value})),peak=Math.max(0,...values.flatMap(v=>series.map(([key])=>v[key])));
 if(!peak)return chartEmpty();
 const label=key=>data.scope==='24h'?key+':00':key.slice(8,10)+'/'+key.slice(5,7);
 const points=role=>values.map((v,i)=>(i*600/(values.length-1)).toFixed(2)+','+(180-v[role]/peak*170).toFixed(2)).join(' ');
 return '<div class="activity-frame"><div class="chart-y-labels"><span>'+compactNumber(peak)+'</span><span>'+compactNumber(peak/2)+'</span><span>0</span></div><div class="activity-plot"><svg viewBox="0 0 600 190" preserveAspectRatio="none" aria-label="'+(reuse?'Recorded input reuse':'Agent and worker recorded token activity')+'" role="img"><path d="M0 10H600M0 95H600M0 180H600" fill="none" stroke="var(--line)" stroke-dasharray="3 5" vector-effect="non-scaling-stroke"/>'+series.map(([role,label,color])=>'<polyline points="'+points(role)+'" fill="none" stroke="'+color+'" stroke-width="1.5" vector-effect="non-scaling-stroke"/>').join('')+'</svg><div class="chart-hit-grid" style="grid-template-columns:repeat('+values.length+',minmax(0,1fr))">'+values.map((v,i)=>'<div class="chart-hit" data-chart-point="'+escHtml(v.key)+'" tabindex="0" role="img" aria-label="'+escHtml(label(v.key)+': '+series.map(([key,label])=>label+' '+compactNumber(v[key])).join(', '))+'">'+series.map(([role,label,color])=>'<i class="chart-line-dot" style="top:'+((180-v[role]/peak*170)/190*100)+'%;left:'+((i/(values.length-1)*values.length-i)*100)+'%;--dot-color:'+color+'"></i>').join('')+'<span class="chart-popover '+(i>values.length/2?'align-right':'align-left')+'"><strong>'+label(v.key)+'</strong>'+series.map(([key,label,color])=>chartTooltipRow(label,reuse?chartInputShare(v[key],v.read+v.write+v.fresh):compactNumber(v[key]),color,reuse&&v.read+v.write+v.fresh>0?compactNumber(v[key]):undefined)).join('')+chartTooltipRow(reuse?'Total input':'Total',compactNumber(series.reduce((n,[key])=>n+v[key],0)))+'</span></div>').join('')+'</div><div class="chart-x-labels"><span>'+label(values[0].key)+'</span><span>'+label(values[Math.floor(values.length/2)].key)+'</span><span>'+label(values[values.length-1].key)+'</span></div></div></div><div class="chart-key reuse-key">'+series.map(([key,label,color])=>'<span><i style="background:'+color+'"></i>'+(reuse?reuseLegend[key]:label)+'</span>').join('')+'</div><p class="live-note">'+(reuse?'Input tokens only. Not billing savings.':'Recorded tokens, including cache. Not billing cost.')+'</p>';
}
function chartAgents(data,element){
 const agents=data.agents.map(a=>({...a,total:a.agent+a.worker})).filter(a=>a.total>0).sort((a,b)=>b.total-a.total||a.id.localeCompare(b.id));
 if(!agents.length)return chartEmpty();
 const capacity=Math.max(2,Math.min(8,Math.floor((element.clientWidth-40)/76))),top=agents.slice(0,capacity),peak=top[0].total;
 return '<div class="agent-column-plot"><div class="chart-y-labels"><span>'+compactNumber(peak)+'</span><span>'+compactNumber(peak/2)+'</span><span>0</span></div><div class="agent-columns">'+top.map(a=>'<div class="agent-column" data-chart-point="'+escHtml(a.id)+'" style="--agent-hue:'+agentHue(a.id)+'" tabindex="0" role="img" aria-label="'+escHtml(a.id+': Agent '+compactNumber(a.agent)+', workers '+compactNumber(a.worker)+', total '+compactNumber(a.total))+'"><div class="agent-bar-space"><div class="agent-bar" style="height:'+Math.max(1,a.total/peak*100)+'%"><span class="agent-bar-total">'+compactNumber(a.total)+'</span></div></div><span class="agent-bar-label" title="'+escHtml(a.id)+'"><i></i><span>'+escHtml(a.id)+'</span></span><span class="chart-popover"><strong>'+escHtml(a.id)+'</strong>'+chartTooltipRow('Agent',compactNumber(a.agent),'var(--token-agent)')+chartTooltipRow('Workers',compactNumber(a.worker),'var(--token-worker)')+chartTooltipRow('Total',compactNumber(a.total),'var(--agent-chart-color)')+'</span></div>').join('')+'</div></div><div class="chart-key"><span>Agent + worker tokens · colors match Agents below</span></div><p class="live-note">Top '+top.length+' of '+agents.length+' active agents · ranked by recorded tokens.</p>';
}
function chartModels(data){
 const models=new Map();data.agents.forEach(a=>a.models.forEach(m=>models.set(m.name,(models.get(m.name)||0)+m.tokens)));
 const sorted=[...models].map(([name,tokens])=>({name,tokens})).sort((a,b)=>b.tokens-a.tokens||a.name.localeCompare(b.name));
 const total=sorted.reduce((n,m)=>n+m.tokens,0);if(!total)return chartEmpty();
 const top=sorted.slice(0,5);if(sorted.length>5)top.push({name:'Other models ('+(sorted.length-5)+')',tokens:sorted.slice(5).reduce((n,m)=>n+m.tokens,0)});
 let offset=0;const circumference=2*Math.PI*72;
 const arcs=top.map((m,i)=>{const length=m.tokens/total*circumference,arc='<circle cx="100" cy="100" r="72" fill="none" stroke="'+chartColors[i]+'" stroke-width="22" stroke-dasharray="'+length+' '+(circumference-length)+'" stroke-dashoffset="'+(-offset)+'" transform="rotate(-90 100 100)" tabindex="0" data-chart-point="'+escHtml(m.name)+'" data-model-name="'+escHtml(m.name)+'" data-model-tokens="'+compactNumber(m.tokens)+'" data-model-share="'+(m.tokens/total*100).toFixed(1)+'%" aria-label="'+escHtml(m.name)+' · '+compactNumber(m.tokens)+' · '+(m.tokens/total*100).toFixed(1)+'%"></circle>';offset+=length;return arc;}).join('');
 return '<div class="model-donut-layout"><div class="model-donut"><svg viewBox="0 0 200 200" role="img" aria-label="Recorded tokens by model">'+arcs+'</svg><span class="chart-popover model-tooltip" role="tooltip"></span><div class="donut-center"><strong>'+compactNumber(total)+'</strong><span>Total tokens</span></div></div><ul class="model-chart-legend">'+top.map((m,i)=>'<li><i style="background:'+chartColors[i]+'"></i><span title="'+escHtml(m.name)+'">'+escHtml(m.name)+'</span><strong>'+compactNumber(m.tokens)+'</strong><small>'+(m.tokens/total*100).toFixed(1)+'%</small></li>').join('')+'</ul></div><p class="live-note">Agent + worker tokens · includes cache reads and writes.</p>';
}
function chartReuse(data){
 const day=key=>data.agents.reduce((r,a)=>{const value=a.reuseComparison?.[key];if(value)Object.keys(r).forEach(k=>r[k]+=value[k]||0);return r;},{fresh:0,write:0,read:0,missingTurns:0});
 const today=day('today'),yesterday=day('yesterday');
 const rate=d=>{const total=d.fresh+d.write+d.read;return total>0?100*d.read/total:null;};
 const current=rate(today),previous=rate(yesterday),delta=current!==null&&previous!==null?current-previous:null;
 const comparison=delta===null?'Yesterday: no measured input to compare.':(delta===0?'Unchanged':(delta>0?'Up ':'Down ')+Math.abs(delta).toFixed(1)+' percentage points')+' vs yesterday ('+previous.toFixed(1)+'%).';
 return chartActivity(data,true)+'<p class="reuse-summary"><strong>'+(current===null?'—':current.toFixed(1)+'%')+'</strong> of today’s measured input reused</p><p class="live-note">'+(current===null?'No measured input today.':comparison)+' Today so far vs yesterday’s full day · '+escHtml(data.timezone)+(today.missingTurns?' · '+compactNumber(today.missingTurns)+' turns excluded today: incomplete measurements.':'')+'</p>';
}
function drawOverviewChart(key,data){
 const card=document.querySelector('[data-chart="'+key+'"]'),element=card.querySelector('.chart-content');
 const sameScope=element.dataset.scope===data.scope;
 const html=key==='activity'?chartActivity(data):key==='agents'?chartAgents(data,element):key==='models'?chartModels(data):chartReuse(data);
 card.querySelector('.chart-period').textContent=chartPeriod(data);
 if(chartRendered.get(element)!==html){
  const active=document.activeElement,hadFocus=element.contains(active);
  const point=hadFocus&&sameScope?active.closest('[data-chart-point]')?.dataset.chartPoint:null;
  element.innerHTML=html;chartRendered.set(element,html);
  if(hadFocus){
   const replacement=point==null?null:[...element.querySelectorAll('[data-chart-point]')].find(node=>node.dataset.chartPoint===point);
   (replacement||card.querySelector('[data-chart-range="'+data.scope+'"]')).focus({preventScroll:true});
  }
  // A stationary pointer does not emit pointerover after replacing SVG nodes.
  if(chartPointer){const hovered=document.elementFromPoint(chartPointer.x,chartPointer.y);if(hovered&&element.contains(hovered))showModelTooltip(hovered);}
 }
 element.dataset.scope=data.scope;
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
function showModelTooltip(target){
 const arc=target.closest('[data-model-name]');if(!arc)return;
 const tip=arc.closest('.model-donut').querySelector('.model-tooltip');
 const color=arc.getAttribute('stroke');
 // Stroke comes only from our fixed chart palette, never provider metadata.
 tip.innerHTML='<strong>'+escHtml(arc.dataset.modelName)+'</strong>'+chartTooltipRow('Tokens',arc.dataset.modelShare,color,arc.dataset.modelTokens);
 tip.style.display='block';
}
document.addEventListener('pointerover',event=>showModelTooltip(event.target));
document.addEventListener('focusin',event=>showModelTooltip(event.target));
function hideModelTooltip(event){const arc=event.target.closest('[data-model-name]');if(arc)arc.closest('.model-donut').querySelector('.model-tooltip').style.display='none';}
document.addEventListener('pointerout',hideModelTooltip);
document.addEventListener('focusout',hideModelTooltip);
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-chart-range]');if(button){
  const key=button.closest('[data-chart]').dataset.chart,scope=button.dataset.chartRange;overviewChartRanges[key]=scope;
  try{localStorage.setItem(chartPreferenceKey,JSON.stringify(overviewChartRanges));}catch{}
  const cached=overviewChartSnapshots.get(scope);if(cached)drawOverviewChart(key,cached.data);else {chartRendered.delete(document.getElementById('chart-'+key));document.getElementById('chart-'+key).innerHTML='<p class="empty">Loading recorded usage…</p>';document.querySelector('[data-chart="'+key+'"] .chart-period').textContent='';}
  refreshOverviewCharts();
 }else if(event.target.closest('#tab-overview'))refreshOverviewCharts();
});
document.addEventListener('DOMContentLoaded',()=>refreshOverviewCharts());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOverviewCharts();});
setInterval(()=>refreshOverviewCharts(true),10000);
let chartResizeWidth=0;new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width===chartResizeWidth)return;chartResizeWidth=width;const snapshot=overviewChartSnapshots.get(overviewChartRanges.agents);if(snapshot)drawOverviewChart('agents',snapshot.data);}).observe(document.getElementById('chart-agents'));
`;
