import { agentBadge, channelBadge } from './dashboard-presentation';
import { dashboardTheme, dashboardFontLink } from './dashboard-theme';
/** Read-only admin report. Escape all stored model/tool metadata as untrusted text. */
export interface TokenReportView {
  sessionId: string;
  since?: number; source?: string; chatId?: string;
  pagination?: {offset:number;limit:number;total:number};
  distribution?: Array<{category:string;tokens:number}>;
  coverage: string;
  totals: { agentTokens: number | null; workerTokens: number | null; totalTokens: number | null };
  backgroundReviews?: Array<{ ts: string | number; outcome: string | null; tokensSpent: number; triggerReason: string | null }>;
  turns: Array<{
    id: string; role: string; category: string; taskId?: string;
    inputModalities?: string[]; inputSequences?: number[];
    inputTexts?: string[]; responseText?: string; taskTitle?: string; state?: string;
    startedAt: string | number; endedAt?: string | number; model?: string;
    usage?: { inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number; totalTokens: number; cacheCreation5mTokens?: number; cacheCreation1hTokens?: number } | null;
    requests?: Array<{ id: string; model?: string; usage: NonNullable<TokenReportView['turns'][number]['usage']> }>;
    loadedTools?: string[] | null; usedTools?: string[];
  }>;
}
function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function n(value: number | undefined | null): string { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : 'Unavailable'; }
function tools(label: string, names: string[] | null | undefined): string {
  return `<details><summary>${label}: ${names == null ? 'Unavailable' : n(names.length)}</summary><p>${names == null ? 'Inventory was not recorded.' : names.map(escape).join(', ') || 'None'}</p></details>`;
}
function requestDetails(requests: TokenReportView['turns'][number]['requests'], aggregate?: TokenReportView['turns'][number]['usage']): string {
  if (!requests?.length) return '<span class="muted">Per-request usage: Unavailable (turn aggregate may still be recorded).</span>';
  const incomplete = aggregate && aggregate.totalTokens > requests.reduce((sum, request) => sum + request.usage.totalTokens, 0);
  return `<details><summary>Observed model requests: ${requests.length}</summary>${incomplete ? '<p class="muted">Observed requests do not cover the full turn aggregate; additional request usage was not reported separately.</p>' : ''}<table><thead><tr><th>Request / model</th><th>Fresh input</th><th>Cache creation</th><th>Cache reads</th><th>Output</th><th>Total</th></tr></thead><tbody>${requests.map(request => `<tr><td>${escape(request.id)}<br>${escape(request.model ?? 'Model unavailable')}</td><td>${n(request.usage.inputTokens)}</td><td>${n(request.usage.cacheCreationTokens)}</td><td>${n(request.usage.cacheReadTokens)}</td><td>${n(request.usage.outputTokens)}</td><td>${n(request.usage.totalTokens)}</td></tr>`).join('')}</tbody></table></details>`;
}
function conversationDetails(turn: TokenReportView['turns'][number]): string {
  const inputs = turn.inputTexts?.map(text => `<pre>${escape(text)}</pre>`).join('') ?? '';
  const assignment = turn.taskTitle === undefined ? '' : `<h3>Assignment</h3><pre>${escape(turn.taskTitle)}</pre>`;
  const response = turn.responseText === undefined ? '' : `<h3>Response / result</h3><pre>${escape(turn.responseText)}</pre>`;
  if (!inputs && !assignment && !response && !turn.state) return '<p class="muted">Conversation / assignment details: Unavailable.</p>';
  return `<details><summary>Conversation / assignment / result</summary>${turn.state ? '<p>Status: ' + escape(turn.state) + '</p>' : ''}${assignment}${inputs ? '<h3>Input</h3>' + inputs : ''}${response}</details>`;
}

function time(value: string | number): string {
 const date=new Date(value);return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'})+' UTC' : 'Unavailable';
}
export function generateTokenReportHtml(agentId: string, report: TokenReportView): string {
 const labels:Record<string,string>={input:'Agent · User input',report:'Agent · Progress / results',worker:'Worker'};
 const categories=new Map<string,number>();
 for(const turn of report.turns.filter(t=>t.usage))categories.set(turn.category,(categories.get(turn.category)||0)+(turn.usage?.totalTokens||0));
 if(report.distribution){categories.clear();for(const item of report.distribution)categories.set(item.category,item.tokens);}
 const total=[...categories.values()].reduce((a,b)=>a+b,0);
 const roleMeasured=(role:string)=>report.pagination ? (role==='agent'?report.totals.agentTokens!==null:report.totals.workerTokens!==null):report.turns.some(t=>t.role===role&&t.usage);
 const measured=report.pagination?report.totals.totalTokens!==null:report.turns.some(t=>t.usage);
 const scope=report.since?'current':'all';
 const link=(offset:number, selected=scope)=>'?agentId='+encodeURIComponent(agentId)+'&sessionId='+encodeURIComponent(report.sessionId)+'&scope='+selected+'&offset='+offset;
 const page=report.pagination;
 const pager=page?`<nav class="report-pager">${page.offset?`<a href="${escape(link(Math.max(0,page.offset-page.limit)))}">← Previous turns</a>`:''}<span>${page.total?page.offset+1:0}–${Math.min(page.offset+page.limit,page.total)} of ${page.total} turns · Newest first</span>${page.offset+page.limit<page.total?`<a href="${escape(link(page.offset+page.limit))}">Next turns →</a>`:''}</nav>`:'';
 const distribution=[...categories].map(([category,value])=>`<span class="segment ${escape(category)}" style="width:${total?value/total*100:0}%" title="${escape(labels[category]||category)}: ${n(value)}"></span>`).join('');
 const legend=[...categories].map(([category,value])=>`<div class="distribution-item"><i class="${escape(category)}"></i><span>${escape(labels[category]||category)}</span><strong>${n(value)} · ${total?(value/total*100).toFixed(1):'0.0'}%</strong></div>`).join('');
 const turns=[...report.turns].sort((a,b)=>new Date(b.startedAt).getTime()-new Date(a.startedAt).getTime()||b.id.localeCompare(a.id));
 const rows=turns.map((turn,index)=>{
  const modality=turn.inputModalities?.some(m=>m==='voice_note'||m==='live_voice')?'Voice message':'Message';
  const title=turn.category==='report' ? (turn.responseText||turn.taskTitle||'Task progress / results') : (turn.taskTitle||turn.inputTexts?.find(t=>t.trim())||turn.responseText||'No conversation text recorded');
  const number=turn.inputSequences?.length?'Input #'+turn.inputSequences.join(', #'):'Turn #'+((page?.total??turns.length)-(page?.offset??0)-index);
  const badge=turn.category==='input'?modality:labels[turn.category]||turn.category;
  return `<tr class="turn-row" data-category="${escape(turn.category)}"><td><span class="turn-kind ${escape(turn.category)}">${escape(badge)}</span><strong class="turn-excerpt" title="${escape(title.slice(0,1000))}">${escape(title.slice(0,180))}${title.length>180?'…':''}</strong><small>${escape(number)} · ${escape(time(turn.startedAt))}</small><small class="cell-clip" title="${escape(turn.model)}">${escape(turn.model||'Model unavailable')}</small></td><td>${n(turn.usage?.inputTokens)}</td><td>${n(turn.usage?.cacheCreationTokens)}<small>5m: ${n(turn.usage?.cacheCreation5mTokens)}<br>1h: ${n(turn.usage?.cacheCreation1hTokens)}</small></td><td>${n(turn.usage?.cacheReadTokens)}</td><td>${n(turn.usage?.outputTokens)}</td><td><strong>${n(turn.usage?.totalTokens)}</strong></td><td>${tools('Loaded',turn.loadedTools)}${tools('Used',turn.usedTools)}</td></tr><tr class="turn-extra" data-category="${escape(turn.category)}"><td colspan="7"><details><summary>Conversation & request details</summary><p class="muted">Role: ${escape(turn.role)} · Turn ${escape(turn.id)}${turn.taskId?' · Task '+escape(turn.taskId):''}${turn.endedAt?' · Ended '+escape(time(turn.endedAt)):''}</p>${conversationDetails(turn)}${requestDetails(turn.requests,turn.usage)}</details></td></tr>`;
 }).join('');
 return `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session token report · Claude Gateway</title>${dashboardFontLink}<style>${dashboardTheme}
body{padding:28px;background:var(--bg);color:var(--text);font:13px 'Poppins',sans-serif}main{max-width:1560px;margin:auto;min-width:0}h1{font-size:28px;margin:20px 0 12px}h2{font-size:17px;color:var(--text);margin:0 0 20px}.report-header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:24px}.report-toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.cards .card{padding:22px;background:var(--mint)}.cards .card:nth-child(2){background:var(--sky)}.cards .card:nth-child(3){background:var(--lavender)}.card strong{display:block;font-size:30px;font-weight:500;margin-top:10px}section{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px;margin-top:22px}.muted{font-size:11px;color:var(--muted);overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto;background:var(--raised);padding:16px;border-radius:10px;font:12px/1.7 ui-monospace,monospace}a{color:var(--accent)}.report-pager{display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap;font-size:12px;padding:18px 0}.stacked-distribution{display:flex;height:24px;overflow:hidden;border-radius:8px;margin:14px 0 22px;background:var(--raised)}.segment{height:100%}.input{--category:#6965de}.report{--category:#279b85}.worker{--category:#468bce}.segment,.distribution-item i{background:var(--category)}.distribution-legend{display:flex;gap:24px;flex-wrap:wrap}.distribution-item{display:flex;gap:8px;align-items:center;font-size:11px}.distribution-item i{height:9px;width:9px;border-radius:3px}.turn-kind{display:inline-block;padding:3px 8px;border-radius:5px;background:color-mix(in srgb,var(--category) 12%,var(--panel));color:var(--category);font-size:10px;font-weight:550}.turn-excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.7;margin:7px 0;font-weight:500}.report-table{min-width:1120px}.report-table td:not(:first-child){font-variant-numeric:tabular-nums}.report-table .turn-extra td{padding-top:0}.turn-extra summary{font-size:11px;color:var(--muted);cursor:pointer}.turn-extra table{min-width:760px}.turn-extra details{margin:8px 0}.report-table details p{max-width:100%;overflow-wrap:anywhere;white-space:normal}.report-table th{white-space:nowrap}.report-table td small{font-size:10px}.report-table td{border-bottom:0}.turn-extra td{border-bottom:1px solid var(--line)!important}.report-table details{font-size:11px}body[data-theme=dark]{color:var(--text)}@media(max-width:700px){body{padding:16px}.cards{grid-template-columns:1fr}section{padding:16px}}
</style></head><body><main><div class="report-toolbar"><a href="../dashboard">← Dashboard</a><button id="report-theme" style="margin-left:auto">Light / dark</button></div><h1>Session token report</h1><div class="report-header">${agentBadge(agentId)}${channelBadge(report.source||'')}<span class="muted" title="${escape(report.sessionId)}">Session ${escape(report.sessionId.slice(0,8))}</span><select id="report-scope" aria-label="Gateway run"><option value="current" ${scope==='current'?'selected':''}>Current gateway run</option><option value="all" ${scope==='all'?'selected':''}>All history</option></select></div><div class="cards"><div class="card">Agent tokens<strong>${roleMeasured('agent')?n(report.totals.agentTokens):'Unavailable'}</strong></div><div class="card">Worker tokens<strong>${roleMeasured('worker')?n(report.totals.workerTokens):'Unavailable'}</strong></div><div class="card">Combined tokens<strong>${measured?n(report.totals.totalTokens):'Unavailable'}</strong></div></div><p class="muted">${report.since?'Turns started since '+escape(time(report.since))+'.':'All recorded turns.'} Totals include all pages. Token volume includes fresh input, cache creation, cache reads and output; these percentages are not monetary costs. Missing measurements are unavailable.</p><section><h2>Token distribution</h2>${total?`<div class="stacked-distribution">${distribution}</div><div class="distribution-legend">${legend}</div>`:'<p>No recorded token usage.</p>'}</section><section><h2>Turn details</h2><div class="report-toolbar"><select id="turn-category" aria-label="Filter turns on this page"><option value="">All purposes on this page</option><option value="input">User input</option><option value="report">Progress / results</option><option value="worker">Workers</option></select><input id="turn-search" placeholder="Search this page's messages or models" aria-label="Search turns on this page"></div>${pager}<div class="table-scroll"><table class="data-table report-table"><colgroup><col style="width:360px"><col style="width:120px"><col style="width:130px"><col style="width:120px"><col style="width:100px"><col style="width:120px"><col style="width:170px"></colgroup><thead><tr><th>Conversation / assignment</th><th>Fresh input</th><th>Cache creation</th><th>Cache reads</th><th>Output</th><th>Total</th><th>Tools</th></tr></thead><tbody>${rows||'<tr><td colspan="7">No recorded turns in this scope.</td></tr>'}</tbody></table></div>${pager}</section></main><script>
document.getElementById('report-scope').onchange=function(){var url=new URL(location.href);url.searchParams.set('scope',this.value);url.searchParams.set('offset','0');location.href=url.href;};
document.getElementById('report-theme').onclick=function(){var r=document.documentElement;r.dataset.theme=r.dataset.theme==='dark'?'light':'dark';};
function filter(){var category=document.getElementById('turn-category').value,query=document.getElementById('turn-search').value.toLowerCase();document.querySelectorAll('.turn-row').forEach(function(row){var show=(!category||row.dataset.category===category)&&(!query||(row.textContent+row.nextElementSibling.textContent).toLowerCase().includes(query));row.hidden=!show;row.nextElementSibling.hidden=!show;});}
document.getElementById('turn-category').onchange=filter;document.getElementById('turn-search').oninput=filter;
</script></body></html>`;
}
