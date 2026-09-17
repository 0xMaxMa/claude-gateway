import { generateTokenReportHtml, TokenReportView } from '../../src/ui/token-report';
import { generateDashboardHtml } from '../../src/ui/web-ui';

const report: TokenReportView = {
  sessionId: 'session', coverage: 'recorded-turns-only',
  totals: { agentTokens: 30, workerTokens: 70, totalTokens: 100 },
  turns: [
    { id: 'agent-turn', role: 'agent', category: 'input', startedAt: '2026-09-17', usage: { inputTokens: 10, cacheCreationTokens: 5, cacheReadTokens: 10, outputTokens: 5, totalTokens: 30 }, loadedTools: null, usedTools: [] },
    { id: 'worker-turn', role: 'worker', category: 'worker', taskId: 'task', startedAt: '2026-09-17', usage: { inputTokens: 10, cacheCreationTokens: 20, cacheReadTokens: 30, outputTokens: 10, totalTokens: 70 }, loadedTools: ['Bash', 'Read'], usedTools: ['Read'] },
  ],
};
test('report separates categories, cache categories and missing inventory without estimating', () => {
  const html = generateTokenReportHtml('agent', report);
  expect(html).toContain('30.0%'); expect(html).toContain('70.0%');
  expect(html).toContain('Loaded: Unavailable'); expect(html).toContain('Loaded: 2');
  expect(html).toContain('Used: 1'); expect(html).toContain('Cache reads');
  expect(html).toContain('5m: Unavailable'); expect(html).toContain('not monetary costs');
});
test('stored metadata cannot inject markup or executable scripts', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const html = generateTokenReportHtml(malicious, { ...report, sessionId: malicious, turns: [{ ...report.turns[0], model: malicious, loadedTools: [malicious] }] });
  expect(html).not.toContain(malicious); expect(html).toContain('&lt;img');
});
test('dashboard inline script stays valid with token/tool details and separate report tab', () => {
  const html = generateDashboardHtml();
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) expect(() => new Function(match[1])).not.toThrow();
  }
  expect(html).toContain('View token report'); expect(html).toContain('target="_blank"');
  expect(html).toContain('Agent / Total tokens');
});
test('missing usage is unavailable and per-request records remain separate from the turn aggregate', () => {
  const missing = generateTokenReportHtml('agent', { ...report, turns: [{ ...report.turns[0], usage: null }] });
  expect(missing).toContain('No recorded token usage.');
  expect(missing).toContain('Agent tokens<strong>Unavailable');
  expect(missing).toContain('Per-request usage: Unavailable');
  const measured = generateTokenReportHtml('agent', { ...report, turns: [{ ...report.turns[0], requests: [{ id: 'request-id', usage: report.turns[0].usage! }] }] });
  expect(measured).toContain('Observed model requests: 1'); expect(measured).toContain('request-id');
  expect(measured).toContain('Role: agent');
});
test('conversation and assignments preserve full text while escaping all supplied content', () => {
  const text = '<script>bad()</script>' + 'long result '.repeat(1000) + 'END-OF-RESULT';
  const html = generateTokenReportHtml('agent', { ...report, turns: [{ ...report.turns[1], inputTexts: ['First input', '<b>Second input</b>'], taskTitle: '<b>Assignment</b>', state: '<img onerror=x>', responseText: text }] });
  expect(html).toContain('First input'); expect(html).toContain('&lt;b&gt;Second input&lt;/b&gt;');
  expect(html).toContain('&lt;b&gt;Assignment&lt;/b&gt;'); expect(html).toContain('END-OF-RESULT');
  expect(html).not.toContain('<script>bad()'); expect(html).toContain('&lt;img onerror=x&gt;');
});
test('background reviews stay separately labelled and incomplete request observations are explicit', () => {
  const html = generateTokenReportHtml('agent', { ...report, backgroundReviews: [{ ts: '2026-09-17', outcome: '<updated>', tokensSpent: 9999, triggerReason: '<reason>' }], turns: [{ ...report.turns[0], requests: [{ id: 'observed-request', usage: { ...report.turns[0].usage!, totalTokens: 2 } }] }] });
  expect(html).toContain('Combined tokens<strong>100');
  expect(html).toContain('Excluded from agent + worker totals');
  expect(html).toContain('Historical cache accounting may be incomplete');
  expect(html).toContain('&lt;updated&gt;'); expect(html).toContain('&lt;reason&gt;');
  expect(html).toContain('Observed requests do not cover the full turn aggregate');
});

test('one measured role never turns another role with unknown usage into zero', () => {
  const html = generateTokenReportHtml('agent', { ...report,
    totals: {agentTokens: null,workerTokens: 70,totalTokens: 70},
    turns: [{...report.turns[0],usage: null},report.turns[1]],
  });
  expect(html).toContain('Agent tokens<strong>Unavailable');
  expect(html).toContain('Worker tokens<strong>70');
  expect(html).toContain('Combined tokens<strong>70');
  const onlyAgent = generateTokenReportHtml('agent', {...report,turns:[report.turns[0]]});
  expect(onlyAgent).toContain('Worker tokens<strong>Unavailable');
});

test('worker rows describe latest-attempt token and inventory scope', () => {
  const html = generateDashboardHtml();
  expect(html).toContain('Latest attempt tokens');
  expect(html).toContain('Latest attempt tools');
  expect(html).toContain("fmtRecordedTokens(s.tokenSummary.agentTokens)");
  expect(html).toContain("n == null ? 'Unavailable' : n === 0 ? '0'");
});
