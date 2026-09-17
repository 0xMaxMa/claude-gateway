import type { RequestToolSchemas } from '../session/request-tool-capture';
import { dashboardRange, rangeButtons } from './dashboard-range';
import type { ContextFootprint } from '../orchestration/context-footprint';
import { tokenReportClient } from './token-report-client';
import { agentBadge, channelBadge, compactNumber, taskStatusBadge, toolNameList } from './dashboard-presentation';
import { dashboardTheme, dashboardFontLink } from './dashboard-theme';
/** Read-only admin report. Escape all stored model/tool metadata as untrusted text. */
export interface TokenReportView {
  contextFootprint?: ContextFootprint;
  contextWindow?: { used: number; total: number; model: string | null } | null;
  sessionId: string;
  scope?: string;
  since?: number; source?: string; chatId?: string;
  pagination?: {offset:number;limit:number;total:number};
  distribution?: Array<{category:string;tokens:number}>;
  usageByRole?: Array<{role:string;inputTokens:number;cacheCreationTokens:number;cacheReadTokens:number;outputTokens:number}>;
  coverage: string;
  totals: { agentTokens: number | null; workerTokens: number | null; totalTokens: number | null };
  backgroundReviews?: Array<{ ts: string | number; outcome: string | null; tokensSpent: number; triggerReason: string | null }>;
  turns: Array<{
    id: string; role: string; category: string; taskId?: string;
    inputModalities?: string[]; inputSequences?: number[];
    inputTexts?: string[]; responseText?: string; taskTitle?: string; state?: string; failureCode?: string;
    startedAt: string | number; endedAt?: string | number; model?: string;
    usage?: { inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number; totalTokens: number; cacheCreation5mTokens?: number; cacheCreation1hTokens?: number } | null;
    requests?: Array<{ id: string; model?: string; toolSchemas?: RequestToolSchemas; usage: NonNullable<TokenReportView['turns'][number]['usage']> }>;
    contextTools?: string[] | null; schemaCoverage?: {measured:number;total:number}; loadedTools?: string[] | null; usedTools?: string[];
  }>;
}
function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function n(value: number | undefined | null): string { return compactNumber(value); }
function tools(label: string, names: string[] | null | undefined): string {
  return `<div title="${escape(names?.join(', ')||'Not recorded')}">${label}: ${names == null ? '—' : n(names.length)}</div>`;
}
function cacheWrite(usage: TokenReportView['turns'][number]['usage']): string {
  const total=usage?.cacheCreationTokens;
  if(total==null || total===0)return n(total);
  const five=usage?.cacheCreation5mTokens, hour=usage?.cacheCreation1hTokens;
  const durations=[...(five&&five>0?['5m']:[]),...(hour&&hour>0?['1h']:[])];
  // A partial breakdown cannot label the duration of the whole total.
  if(!durations.length || (five??0)+(hour??0)!==total)return n(total);
  const title=[...(five&&five>0?['5m: '+n(five)+' tokens']:[]),...(hour&&hour>0?['1h: '+n(hour)+' tokens']:[])].join(' · ');
  return `<span class="cache-write" title="${escape(title)}">${n(total)} <span class="cache-duration">(${durations.join(' + ')})</span></span>`;
}
function requestDetails(requests: TokenReportView['turns'][number]['requests'], aggregate?: TokenReportView['turns'][number]['usage']): string {
  if (!requests?.length) return '<span class="muted">Per-request usage: —</span>';
  const incomplete = aggregate && aggregate.totalTokens > requests.reduce((sum, request) => sum + request.usage.totalTokens, 0);
  // Requests are captured oldest-first; show newest at the top.
  const ordered = [...requests].reverse();
  return `<div class="request-details"><h3>Observed model requests: ${requests.length}</h3>${incomplete ? '<p class="muted">Observed requests do not cover the full turn aggregate; additional request usage was not reported separately.</p>' : ''}<table><thead><tr><th>Request / model</th><th title="Uncached input only. Total input = input + cache write + cache read.">Input</th><th>Cache write</th><th>Cache read</th><th>Output</th><th>Total</th></tr></thead><tbody>${ordered.map(request => `<tr><td>${escape(request.id)}<br>${escape(request.model ?? '—')}</td><td>${n(request.usage.inputTokens)}</td><td>${cacheWrite(request.usage)}</td><td>${n(request.usage.cacheReadTokens)}</td><td>${n(request.usage.outputTokens)}</td><td>${n(request.usage.totalTokens)}</td></tr>`).join('')}</tbody></table></div>`;
}
const statusBadge = taskStatusBadge;
function conversationDetails(turn: TokenReportView['turns'][number]): string {
  const inputs = turn.inputTexts?.map(text => `<pre>${escape(text)}</pre>`).join('') ?? '';
  const assignment = turn.taskTitle === undefined ? '' : `<h3>Assignment</h3><pre>${escape(turn.taskTitle)}</pre>`;
  const response = turn.responseText === undefined ? '' : `<h3>Response / result</h3><pre>${escape(turn.responseText)}</pre>`;
  if (!inputs && !assignment && !response && !turn.state) return '<p class="muted">Conversation / assignment details: —</p>';
  return `<div class="conversation-details"><h3>Conversation / assignment / result</h3>${turn.state ? '<p class="turn-status"><span>Status</span> ' + statusBadge(turn.state) + '</p>' : ''}${turn.failureCode?'<p><strong>Failure:</strong> '+escape(turn.failureCode)+'</p>':''}${turn.state==='failed'&&turn.category==='report'?'<p class="muted">This progress/result reporting turn failed. It does not mean the worker task failed.</p>':''}${assignment}${inputs ? '<h3>Input</h3>' + inputs : ''}${response}</div>`;
}

function time(value: string | number): string {
 const date=new Date(value);return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'})+' UTC' : '—';
}
/** Turn/Date display: "Xs/m/h ago" within the last 24h (full datetime on hover),
 *  switching to the full inline datetime once older than a day. */
function relativeTime(value: string | number): { label: string; title: string } {
 const t=new Date(value).getTime();
 const full=time(value);
 if(!Number.isFinite(t))return {label:'—',title:''};
 const diff=Date.now()-t, day=86400000;
 if(diff>=day || diff<0)return {label:full,title:full};
 let label:string;
 if(diff<60000)label=Math.max(1,Math.round(diff/1000))+'s ago';
 else if(diff<3600000)label=Math.round(diff/60000)+'m ago';
 else label=Math.round(diff/3600000)+'h ago';
 return {label,title:full};
}
function footprintHtml(footprint?: ContextFootprint): string {
 const parts=(footprint?.rows||[]).filter(r=>(r.name.startsWith('↳ ')||r.name.startsWith('Agent gateway tool schemas'))&&r.hasContent!==false&&r.tokens!=null&&r.tokens>0);
 const total=parts.reduce((sum,r)=>sum+r.tokens!,0);
 const colors=['#e98524','#8e65d1','#258fca','#cf528b','#359986','#c19527','#5c78d2','#b66645','#77843f','#986499'];
 const names=['AGENTS.md','IDENTITY.md','SOUL.md','USER.md','MEMORY.md','HEARTBEAT.md','Skill catalog','Memory rules','Memory retrieval instructions'];
 const color=(name:string)=>{const i=names.indexOf(name.replace(/^↳ /,''));return colors[i<0?9:i];};
 const items=parts.map(r=>{const name=r.name.replace(/^↳ /,'');const source=footprint?.rows.find(row=>row.name===name+' · source file');return {name,tokens:r.tokens!,color:color(r.name),note:source?.tokens!=null?'Included in bootstrap: '+n(r.tokens)+'; full source file: '+n(source.tokens)+' estimated tokens.':r.note};});
 return `<section id="report-footprint"><div class="report-toolbar"><h2 style="margin:0">Context bootstrap</h2><strong style="margin-left:auto">${total?n(total)+' estimated tokens':'—'}</strong></div>${total?`<div class="stacked-distribution" aria-label="Estimated context tokens by source">${items.map(r=>`<span class="segment" style="background:${r.color};width:${r.tokens/total*100}%" title="${escape(r.name)}: ${n(r.tokens)} tokens"></span>`).join('')}</div><div class="distribution-legend">${items.map(r=>`<div class="distribution-item" title="${escape(r.note)}"><i style="background:${r.color}"></i><span>${escape(r.name)}</span><strong>${n(r.tokens)}</strong></div>`).join('')}</div>`:'<p class="muted">—</p>'}<p class="muted">Current CLAUDE.md sections after context budgets, plus Agent gateway tool schemas. Hover a file to compare its included portion with the full source file; MEMORY.md may be longer on disk. Estimated with cl100k_base, not historical turn attribution or the selected model’s exact token count. Excludes section headers, conversation history, runtime overlays, CLI instructions/tools and provider framing. ${footprint?'Checked '+escape(time(footprint.observedAt))+' · refreshes every 30s.':''}</p></section>`;
}
export function generateTokenReportHtml(agentId: string, report: TokenReportView): string {
 const labels:Record<string,string>={input:'Agent · User input',report:'Agent · Progress / results',worker:'Worker'};
 const categories=new Map<string,number>();
 for(const turn of report.turns.filter(t=>t.usage))categories.set(turn.category,(categories.get(turn.category)||0)+(turn.usage?.totalTokens||0));
 if(report.distribution){categories.clear();for(const item of report.distribution)categories.set(item.category,item.tokens);}
 const total=[...categories.values()].reduce((a,b)=>a+b,0);
 const roleMeasured=(role:string)=>report.pagination ? (role==='agent'?report.totals.agentTokens!==null:report.totals.workerTokens!==null):report.turns.some(t=>t.role===role&&t.usage);
 const measured=report.pagination?report.totals.totalTokens!==null:report.turns.some(t=>t.usage);
 const usageOf=(role:string)=>report.usageByRole?.find(u=>u.role===role);
 // Cached share = cache-read tokens / (input + cache read + cache write); output is not context.
 const cachedRatio=(input:number,cacheRead:number,cacheWrite:number)=>{const base=input+cacheRead+cacheWrite;return base?cacheRead/base*100:0;};
 const cachedLineFor=(u?:{inputTokens:number;cacheReadTokens:number;cacheCreationTokens:number})=>u?`<span class="card-cached">Cached: ${n(u.cacheReadTokens)} · ${cachedRatio(u.inputTokens,u.cacheReadTokens,u.cacheCreationTokens).toFixed(2)}%</span>`:'';
 const agentU=usageOf('agent'), workerU=usageOf('worker');
 const totalU=(agentU||workerU)?{inputTokens:(agentU?.inputTokens||0)+(workerU?.inputTokens||0),cacheReadTokens:(agentU?.cacheReadTokens||0)+(workerU?.cacheReadTokens||0),cacheCreationTokens:(agentU?.cacheCreationTokens||0)+(workerU?.cacheCreationTokens||0)}:undefined;
 const windowCap=(t:number)=>t>=1e6?+(t/1e6).toFixed(2)+'M':Math.round(t/1000)+'K';
 const cw=report.contextWindow;
 const contextWindowBox=`<div class="card">Context window<strong>${cw?n(cw.used)+' / '+windowCap(cw.total):'—'}</strong>${cw&&cw.model?`<span class="card-cached" title="${escape(cw.model)}">Model: ${escape(cw.model)}</span>`:''}</div>`;
 const models=[...new Set(report.turns.map(t=>t.model).filter((m):m is string=>Boolean(m)))].sort();
 const statuses=[...new Set(report.turns.map(t=>t.state).filter((s):s is string=>Boolean(s)))].sort();
 const prettyStatus=(s:string)=>s.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
 const scope=dashboardRange(report.scope);
 const link=(offset:number, selected=scope)=>'?agentId='+encodeURIComponent(agentId)+'&sessionId='+encodeURIComponent(report.sessionId)+'&scope='+selected+'&offset='+offset;
 const page=report.pagination;
 const pager=page?`<nav class="report-pager"><span>${page.total?page.offset+1:0}–${Math.min(page.offset+page.limit,page.total)} of ${page.total} recorded turns · Newest first</span><span class="report-pager-nav"><button type="button" data-report-href="${escape(link(Math.max(0,page.offset-page.limit)))}"${page.offset>0?'':' disabled'}>← Previous</button><button type="button" data-report-href="${escape(link(page.offset+page.limit))}"${page.offset+page.limit<page.total?'':' disabled'}>Next →</button></span></nav>`:'';
 const distribution=[...categories].map(([category,value])=>`<span class="segment ${escape(category)}" style="width:${total?value/total*100:0}%" title="${escape(labels[category]||category)}: ${n(value)}"></span>`).join('');
 const legend=[...categories].map(([category,value])=>`<div class="distribution-item"><i class="${escape(category)}"></i><span>${escape(labels[category]||category)}</span><strong>${n(value)} · ${total?(value/total*100).toFixed(1):'0.0'}%</strong></div>`).join('');
 const turns=[...report.turns].sort((a,b)=>new Date(b.startedAt).getTime()-new Date(a.startedAt).getTime()||b.id.localeCompare(a.id));
 const rows=turns.map((turn,index)=>{
  const modality=turn.inputModalities?.some(m=>m==='voice_note'||m==='live_voice')?'Voice message':'Message';
  const title=turn.category==='report' ? (turn.responseText||turn.taskTitle||'Task progress / results') : (turn.taskTitle||turn.inputTexts?.find(t=>t.trim())||turn.responseText||'No conversation text recorded');
  const number=turn.inputSequences?.length?'Input #'+turn.inputSequences.join(', #'):'Turn #'+((page?.total??turns.length)-(page?.offset??0)-index);
  const badge=turn.category==='input'?modality:labels[turn.category]||turn.category;
  const started=relativeTime(turn.startedAt);
  return `<tr class="turn-row" tabindex="0" aria-expanded="false" data-turn-id="${escape(turn.id)}" data-category="${escape(turn.category)}" data-model="${escape(turn.model||'')}" data-status="${escape(turn.state||'')}"><td><strong>${escape(number)}</strong><small title="${escape(started.title)}">${escape(started.label)}</small><small class="cell-model" title="${escape(turn.model)}">${escape(turn.model||'—')}</small></td><td><span class="turn-kind ${escape(turn.category)}">${escape(badge)}</span><strong class="turn-excerpt" title="${escape(title.slice(0,1000))}">${escape(title.slice(0,180))}${title.length>180?'…':''}</strong>${turn.state?statusBadge(turn.state):''}</td><td>${n(turn.usage?.inputTokens)}</td><td>${cacheWrite(turn.usage)}</td><td>${n(turn.usage?.cacheReadTokens)}</td><td>${n(turn.usage?.outputTokens)}</td><td><strong>${n(turn.usage?.totalTokens)}</strong></td><td>${turn.usage?cachedRatio(turn.usage.inputTokens,turn.usage.cacheReadTokens,turn.usage.cacheCreationTokens).toFixed(2)+'%':'—'}</td><td>${tools('Loaded',turn.contextTools)}${tools('Used',turn.usedTools)}</td></tr><tr class="turn-extra" hidden data-turn-id="${escape(turn.id)}" data-category="${escape(turn.category)}"><td colspan="9"><h3>Conversation & request details</h3><p class="muted">Role: ${escape(turn.role)} · Turn ${escape(turn.id)}${turn.taskId?' · Task '+escape(turn.taskId):''}${turn.endedAt?' · Ended '+escape(time(turn.endedAt)):''}</p>${conversationDetails(turn)}${requestDetails(turn.requests,turn.usage)}${turn.contextTools?'<h3>Loaded tools</h3>'+toolNameList(turn.contextTools):''}<h3>Used tools</h3>${toolNameList(turn.usedTools)}<p class="muted">Loaded counts distinct schemas observed in requests, including referenced deferred tools. Used counts distinct tool names executed. ${turn.schemaCoverage?`Schema capture: ${turn.schemaCoverage.measured}/${turn.schemaCoverage.total} observed requests.`:'Schema capture was not recorded for this turn.'}</p></td></tr>`;
 }).join('');
 return `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session token report · Claude Gateway</title>${dashboardFontLink}<style>${dashboardTheme}
body{padding:28px;background:var(--bg);color:var(--text);font:15px/1.7 system-ui,-apple-system,"Noto Sans Thai",sans-serif}main{max-width:1560px;margin:auto;min-width:0}h1{font-size:28px;margin:20px 0 12px}h2{font-size:17px;color:var(--text);margin:0 0 20px}.report-header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:24px}.report-toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}.cards .card{padding:22px;background:var(--peach)}.cards .card:nth-child(2){background:var(--mint)}.cards .card:nth-child(3){background:var(--sky)}.cards .card:nth-child(4){background:var(--lavender)}.card strong{display:block;font-size:30px;font-weight:500;margin-top:10px}section{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px;margin-top:22px}.muted{font-size:11px;color:var(--muted);overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto;background:var(--raised);padding:16px;border-radius:10px;font:12px/1.7 ui-monospace,monospace}a{color:var(--accent)}.report-pager{display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap;font-size:12px;padding:18px 0}.report-pager-nav{display:inline-flex;gap:8px;flex-wrap:wrap}.stacked-distribution{display:flex;height:24px;overflow:hidden;border-radius:8px;margin:14px 0 22px;background:var(--raised)}.segment{height:100%}.input{--category:#329eda}.report{--category:#ea8a23}.worker{--category:#9661d9}.segment+.segment{border-left:3px solid var(--panel)}.segment,.distribution-item i{background:var(--category)}.distribution-legend{display:flex;gap:24px;flex-wrap:wrap}.distribution-item{display:flex;gap:8px;align-items:center;font-size:11px}.distribution-item i{height:9px;width:9px;border-radius:3px}.turn-kind{display:inline-block;padding:3px 8px;border-radius:5px;background:color-mix(in srgb,var(--category) 12%,var(--panel));color:var(--category);font-size:10px;font-weight:550}.turn-excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.7;margin:7px 0;font-weight:500}.cache-write{display:inline-flex;flex-wrap:wrap;gap:0 4px;max-width:100%;white-space:normal}.cache-duration{font-size:11px;color:var(--muted);white-space:nowrap}.report-table{width:100%;min-width:1000px;table-layout:fixed}.report-table>thead>tr>th,.report-table>tbody>.turn-row>td{padding:12px 8px}.report-table>tbody>.turn-row>td:nth-child(n+3){white-space:nowrap}.report-table td:not(:first-child){font-variant-numeric:tabular-nums}.report-table .turn-extra td{padding-top:0}.turn-extra summary{font-size:11px;color:var(--muted);cursor:pointer}.turn-extra table{min-width:760px}.turn-extra details{margin:8px 0}.report-table details p{max-width:100%;overflow-wrap:anywhere;white-space:normal}.report-table th{white-space:normal;line-height:1.4}.report-table td small{font-size:10px}.report-table .turn-row>td:first-child>strong,.report-table .turn-row>td:first-child>small{display:block}.cell-model{overflow-wrap:anywhere;white-space:normal}.report-table td{border-bottom:0}.turn-extra td{border-bottom:1px solid var(--line)!important}.report-table details{font-size:11px}body[data-theme=dark]{color:var(--text)}@media(max-width:700px){body{padding:16px}.cards{grid-template-columns:1fr}section{padding:16px}}
.report-table,.footprint-table{font-size:13px;line-height:1.7}.report-table td small,.muted{font-size:12px}.turn-kind,.report-table details,.turn-extra summary,.distribution-item{font-size:12px}.turn-excerpt{font-weight:650}.report-table td>strong,.distribution-item strong,.footprint-table td:first-child,.footprint-table td:nth-child(2){font-weight:700}.report-table th,.footprint-table th{font-size:12px;letter-spacing:.03em}.footprint-table{min-width:800px;table-layout:fixed}.footprint-table th:first-child{width:30%}.footprint-table th:nth-child(2),.footprint-table th:nth-child(3){width:15%}.footprint-table td{overflow-wrap:anywhere}
.report-table .turn-extra{font-size:13px;line-height:1.7}.report-table .turn-extra p,.report-table .turn-extra .muted,.report-table .turn-extra summary,.report-table .turn-extra pre,.report-table .turn-extra td{font-size:13px;line-height:1.7}.report-table .turn-extra h3{font-size:13px;font-weight:700;margin:18px 0 8px}.report-table .turn-extra pre{font-family:inherit;font-weight:400}.turn-status{display:flex;align-items:center;gap:8px}.turn-status .badge{font-size:12px;font-weight:500}.turn-extra>td>details>summary{font-weight:600}
.report-table .turn-row[aria-expanded=true]{background:color-mix(in srgb,var(--accent) 14%,var(--panel))}#report-drawer h1{font-size:22px;margin:18px 0 12px}#report-drawer h3{font-size:14px;font-weight:700;margin:18px 0 8px}#report-drawer .muted{font-size:12px}#report-drawer table{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}#report-drawer th,#report-drawer td{padding:7px 8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}#report-drawer .request-details,#report-drawer .conversation-details{margin-top:10px}#report-drawer [data-report-close]{float:right;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:6px 12px;font-size:12px}
</style></head><body><main><div class="report-toolbar"><a href="../dashboard">← Dashboard</a><span id="report-live" class="muted" role="status">Live · every 5s</span><button id="report-theme" style="margin-left:auto">Light / dark</button></div><h1>Session token report</h1><div class="report-header">${agentBadge(agentId)}${channelBadge(report.source||'')}<span class="muted" title="${escape(report.sessionId)}">Session ${escape(report.sessionId)}</span>${rangeButtons("report-scope",scope)}</div><div class="cards" id="report-totals">${contextWindowBox}<div class="card">Agent tokens<strong>${roleMeasured('agent')?n(report.totals.agentTokens):'—'}</strong>${roleMeasured('agent')?cachedLineFor(agentU):''}</div><div class="card">Worker tokens<strong>${roleMeasured('worker')?n(report.totals.workerTokens):'—'}</strong>${roleMeasured('worker')?cachedLineFor(workerU):''}</div><div class="card">Total tokens<strong>${measured?n(report.totals.totalTokens):'—'}</strong>${measured?cachedLineFor(totalU):''}</div></div><p class="muted">${report.since?'Turns started since '+escape(time(report.since))+'.':'All recorded turns.'} Totals include all pages. Token volume includes input, cache creation, cache reads and output; these percentages are not monetary costs. Missing measurements are shown as —. Input is the uncached portion; cache write creates cached context; cache read reuses context; output includes reported thinking. Total tokens is the sum of input, cache write, cache read and output.</p>${footprintHtml(report.contextFootprint)}<section id="report-distribution"><h2>Token distribution</h2>${total?`<div class="stacked-distribution">${distribution}</div><div class="distribution-legend">${legend}</div>`:'<p>No recorded token usage.</p>'}</section><section><h2>Turn details</h2><div class="report-toolbar"><div id="turn-category" class="range-toggle" role="group" aria-label="Filter turns on this page by purpose">${[['','All'],['input','User input'],['report','Progress / result'],['worker','Worker']].map(([value,label])=>`<button type="button" data-purpose="${value}" aria-pressed="${value===''}">${label}</button>`).join('')}</div><select id="turn-model" aria-label="Filter turns on this page by model"><option value="">All models</option>${models.map(m=>`<option value="${escape(m)}">${escape(m)}</option>`).join('')}</select>${statuses.length?`<div id="turn-status" class="range-toggle" role="group" aria-label="Filter turns on this page by status"><button type="button" data-status="" aria-pressed="true">All statuses</button>${statuses.map(s=>`<button type="button" data-status="${escape(s)}" aria-pressed="false">${escape(prettyStatus(s))}</button>`).join('')}</div>`:''}<input id="turn-search" placeholder="Search this page's messages or models" aria-label="Search turns on this page"></div>${pager}<div class="table-scroll"><table class="data-table report-table"><colgroup>${[120,0,96,96,96,96,96,96,96].map(width=>width?`<col style="width:${width}px">`:'<col>').join('')}</colgroup><thead><tr><th>Turn / Date</th><th>Conversation / assignment</th><th title="Uncached input only. Total input = input + cache write + cache read.">Input</th><th>Cache write</th><th>Cache read</th><th>Output</th><th>Totals</th><th title="Cache read ÷ (input + cache read + cache write)">%Cached</th><th>Tools</th></tr></thead><tbody>${rows||'<tr><td colspan="9">No recorded turns in this scope.</td></tr>'}</tbody></table></div>${pager}</section></main><div id="report-drawer-back" class="dash-drawer-back"><section id="report-drawer" class="dash-drawer" role="dialog" aria-modal="true" aria-label="Recorded turn details" tabindex="-1"></section></div><script>
document.getElementById('report-scope').onclick=function(e){var button=e.target.closest('[data-range]');if(!button)return;var url=new URL(location.href);url.searchParams.set('scope',button.dataset.range);url.searchParams.set('offset','0');location.href=url.href;};
document.getElementById('report-theme').onclick=function(){var r=document.documentElement;r.dataset.theme=r.dataset.theme==='dark'?'light':'dark';};
var reportSelected=null,reportFocus=null;
function reportExtraFor(id){var found=null;document.querySelectorAll('.turn-extra').forEach(function(r){if(r.dataset.turnId===id)found=r;});return found;}
function reportRenderDrawer(){
 var back=document.getElementById('report-drawer-back'),panel=document.getElementById('report-drawer');
 document.querySelectorAll('.turn-row').forEach(function(r){r.setAttribute('aria-expanded',String(Boolean(reportSelected)&&r.dataset.turnId===reportSelected));});
 var extra=reportSelected?reportExtraFor(reportSelected):null,cell=extra?extra.querySelector('td'):null;
 if(!reportSelected||!cell){reportSelected=null;back.classList.remove('open');document.body.style.overflow='';if(panel.dataset.turn!==undefined){panel.innerHTML='';delete panel.dataset.turn;delete panel.dataset.html;}document.querySelectorAll('.turn-row').forEach(function(r){r.setAttribute('aria-expanded','false');});return;}
 var html='<button data-report-close aria-label="Close details">Close ×</button><h1>Turn details</h1>'+cell.innerHTML;
 back.classList.add('open');document.body.style.overflow='hidden';
 if(panel.dataset.turn===reportSelected&&panel.dataset.html===html)return;
 var sameTurn=panel.dataset.turn===reportSelected,scroll=panel.scrollTop,focused=panel.contains(document.activeElement),closeFocused=document.activeElement&&document.activeElement.hasAttribute('data-report-close');
 panel.innerHTML=html;panel.dataset.turn=reportSelected;panel.dataset.html=html;
 if(sameTurn){panel.scrollTop=scroll;if(focused)(closeFocused?panel.querySelector('[data-report-close]'):panel).focus({preventScroll:true});}
}
function reportOpen(id){if(reportSelected!==id)reportFocus=document.activeElement;reportSelected=id;reportRenderDrawer();var p=document.getElementById('report-drawer');if(reportSelected&&!p.contains(document.activeElement))p.focus({preventScroll:true});}
function reportClose(){var was=reportSelected;reportSelected=null;reportRenderDrawer();if(was&&reportFocus&&reportFocus.isConnected)reportFocus.focus({preventScroll:true});}
function filter(){var btn=document.querySelector('#turn-category button[aria-pressed=true]'),category=btn?btn.dataset.purpose:'',model=document.getElementById('turn-model').value,query=document.getElementById('turn-search').value.toLowerCase();var statuses=[].slice.call(document.querySelectorAll('#turn-status button[aria-pressed=true]')).map(function(b){return b.dataset.status;}).filter(function(s){return s;});document.querySelectorAll('.turn-row').forEach(function(row){var extra=row.nextElementSibling;var show=(!category||row.dataset.category===category)&&(!model||row.dataset.model===model)&&(!statuses.length||statuses.indexOf(row.dataset.status)>=0)&&(!query||(row.textContent+(extra?extra.textContent:'')).toLowerCase().includes(query));row.hidden=!show;if(extra)extra.hidden=true;if(!show&&reportSelected===row.dataset.turnId)reportClose();});}
document.addEventListener('click',function(e){
 if(e.target.closest('[data-report-close]')||e.target.id==='report-drawer-back'){reportClose();return;}
 var row=e.target.closest('.turn-row');if(!row||e.target.closest('a,button,input,select'))return;
 if(reportSelected===row.dataset.turnId)reportClose();else reportOpen(row.dataset.turnId);
});
document.addEventListener('keydown',function(e){
 if(e.key==='Escape'&&reportSelected){reportClose();return;}
 if((e.key==='Enter'||e.key===' ')&&e.target.matches('.turn-row')){e.preventDefault();e.target.click();return;}
 if(e.key==='Tab'&&document.getElementById('report-drawer-back').classList.contains('open')){var panel=document.getElementById('report-drawer'),nodes=[].slice.call(panel.querySelectorAll('button,a,summary,input,select')).filter(function(nd){return nd.getClientRects().length;});var first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel)){e.preventDefault();if(last)last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();if(first)first.focus();}}
});
document.getElementById('turn-category').addEventListener('click',function(e){var b=e.target.closest('button[data-purpose]');if(!b)return;this.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});filter();});
var turnStatus=document.getElementById('turn-status');
if(turnStatus)turnStatus.addEventListener('click',function(e){var b=e.target.closest('button[data-status]');if(!b)return;var all=this.querySelector('button[data-status=""]');if(b===all){this.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===all));});}else{b.setAttribute('aria-pressed',String(b.getAttribute('aria-pressed')!=='true'));var any=[].slice.call(this.querySelectorAll('button[data-status]')).some(function(x){return x.dataset.status&&x.getAttribute('aria-pressed')==='true';});if(all)all.setAttribute('aria-pressed',String(!any));}filter();});
document.getElementById('turn-model').onchange=filter;document.getElementById('turn-search').oninput=filter;
document.addEventListener('click',function(e){var b=e.target.closest('[data-report-href]');if(!b||b.disabled)return;var href=b.getAttribute('data-report-href');if(href)location.href=href;});
${tokenReportClient}
</script></body></html>`;
}
