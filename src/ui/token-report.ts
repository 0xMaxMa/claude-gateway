/** Read-only admin report. Escape all stored model/tool metadata as untrusted text. */
export interface TokenReportView {
  sessionId: string;
  coverage: string;
  totals: { agentTokens: number | null; workerTokens: number | null; totalTokens: number | null };
  backgroundReviews?: Array<{ ts: string | number; outcome: string | null; tokensSpent: number; triggerReason: string | null }>;
  turns: Array<{
    id: string; role: string; category: string; taskId?: string;
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
function backgroundDetails(reviews: TokenReportView['backgroundReviews']): string {
  return `<section><h2>Background skill learning</h2><p class="muted">Excluded from agent + worker totals and distribution. Historical cache accounting may be incomplete; recorded token counts are not a billing total.</p>${reviews?.length ? '<div class="table-scroll"><table><thead><tr><th>Time</th><th>Outcome</th><th>Recorded tokens</th><th>Trigger</th></tr></thead><tbody>' + reviews.map(review => `<tr><td>${escape(review.ts)}</td><td>${escape(review.outcome)}</td><td>${n(review.tokensSpent)}</td><td>${escape(review.triggerReason)}</td></tr>`).join('') + '</tbody></table></div>' : '<p>No background review records available for this session.</p>'}</section>`;
}
export function generateTokenReportHtml(agentId: string, report: TokenReportView): string {
  const labels: Record<string, string> = { input: 'Agent handling user input', report: 'Agent reporting progress / results', worker: 'Workers executing', learning: 'Background skill learning' };
  const categories = new Map<string, number>();
  for (const turn of report.turns.filter(turn => turn.usage)) categories.set(turn.category, (categories.get(turn.category) ?? 0) + (turn.usage?.totalTokens ?? 0));
  const measured = report.turns.some(turn => turn.usage);
  const roleMeasured = (role: string) => report.turns.some(turn => turn.role === role && turn.usage);
  const total = [...categories.values()].reduce((sum, value) => sum + value, 0);
  const distribution = [...categories].map(([category, value]) => `<div class="distribution"><span>${escape(labels[category] ?? category)}</span><strong>${n(value)} · ${total ? (value / total * 100).toFixed(1) : '0.0'}%</strong><progress max="${total || 1}" value="${value}"></progress></div>`).join('');
  const rows = report.turns.map((turn, index) => `<tr><td>${index + 1}<br><span class="muted">${escape(turn.id)}</span></td><td>${escape(labels[turn.category] ?? turn.category)}<br><span class="muted">Role: ${escape(turn.role)}<br>${escape(turn.model ?? 'Model unavailable')}<br>${escape(typeof turn.startedAt === 'number' ? new Date(turn.startedAt).toISOString() : turn.startedAt)}${turn.endedAt ? '<br>Ended: ' + escape(typeof turn.endedAt === 'number' ? new Date(turn.endedAt).toISOString() : turn.endedAt) : ''}${turn.taskId ? '<br>Task: ' + escape(turn.taskId) : ''}</span></td><td>${n(turn.usage?.inputTokens)}</td><td>${n(turn.usage?.cacheCreationTokens)}<br><span class="muted">5m: ${turn.usage?.cacheCreation5mTokens === undefined ? 'Unavailable' : n(turn.usage?.cacheCreation5mTokens)}<br>1h: ${turn.usage?.cacheCreation1hTokens === undefined ? 'Unavailable' : n(turn.usage?.cacheCreation1hTokens)}</span></td><td>${n(turn.usage?.cacheReadTokens)}</td><td>${n(turn.usage?.outputTokens)}</td><td>${n(turn.usage?.totalTokens)}</td><td>${tools('Loaded', turn.loadedTools)}${tools('Used', turn.usedTools)}</td></tr><tr><td colspan="8">${conversationDetails(turn)}${requestDetails(turn.requests, turn.usage)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session token report · Claude Gateway</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#0f1117;color:#e2e8f0;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}main{max-width:1600px;margin:auto}h1{font-size:24px}h2{font-size:18px;color:#90cdf4}.muted{color:#a0aec0;font-size:12px;overflow-wrap:anywhere}.cards{display:flex;gap:16px;flex-wrap:wrap}.card,section{background:#1a202c;border:1px solid #2d3748;border-radius:8px;padding:16px;margin:16px 0}.card{flex:1;min-width:180px}.card strong{display:block;font-size:24px;margin-top:8px}.distribution{display:grid;grid-template-columns:1fr auto;gap:8px;margin:16px 0}progress{grid-column:1/-1;width:100%;height:10px;accent-color:#90cdf4}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #2d3748;vertical-align:top}th{color:#a0aec0;white-space:nowrap}details{margin:4px 0}summary{cursor:pointer}details p{overflow-wrap:anywhere}a{color:#90cdf4}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.5;background:#0f1117;padding:12px;border-radius:6px}h3{font-size:14px;color:#a0aec0;margin:16px 0 8px}
</style></head><body><main><a href="../dashboard">← Dashboard</a><h1>Session token report</h1><p class="muted">Agent: ${escape(agentId)} · Session: ${escape(report.sessionId)}</p><div class="cards"><div class="card">Agent tokens<strong>${roleMeasured('agent') ? n(report.totals.agentTokens) : 'Unavailable'}</strong></div><div class="card">Worker tokens<strong>${roleMeasured('worker') ? n(report.totals.workerTokens) : 'Unavailable'}</strong></div><div class="card">Combined tokens<strong>${measured ? n(report.totals.totalTokens) : 'Unavailable'}</strong></div></div><p class="muted">Recorded turns only. Older turns without instrumentation are unavailable. Token volume includes fresh input, cache creation, cache reads and output; these percentages are not monetary costs. Thinking is included in output, never added twice. Background learning is shown separately when recorded.</p><section><h2>Token distribution</h2>${distribution || '<p>No recorded token usage.</p>'}</section><section><h2>Turn details</h2><div class="table-scroll"><table><thead><tr><th>Turn</th><th>Purpose / model / task</th><th>Fresh input</th><th>Cache creation</th><th>Cache reads</th><th>Output</th><th>Total</th><th>Tools</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No recorded turns available.</td></tr>'}</tbody></table></div></section>${backgroundDetails(report.backgroundReviews)}</main></body></html>`;
}
