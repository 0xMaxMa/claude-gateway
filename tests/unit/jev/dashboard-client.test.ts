import { createContext, runInContext } from 'node:vm';
import { dashboardClient } from '../../../src/ui/dashboard-client';
import { compactNumber, dashboardEscape } from '../../../src/ui/dashboard-presentation';

function fixture() {
  const handlers = new Map<string, (event?: unknown) => void>();
  const elements = new Map<string, { style: { display: string }; disabled: boolean; textContent: string; innerHTML: string; addEventListener: (type: string, cb: (event?: unknown) => void) => void }>();
  const node = (id: string) => {
    if (!elements.has(id)) elements.set(id, { style: { display: 'block' }, disabled: false, textContent: '', innerHTML: '', addEventListener: (type, cb) => { handlers.set(id + ':' + type, cb); } });
    return elements.get(id)!;
  };
  const fetch = jest.fn();
  const context = createContext({
    document: { hidden: false, getElementById: node, querySelectorAll: () => [] },
    dashboardScope: '24h', dashboardAgent: '', dashboardOffset: 0, dashboardTimezone: 'UTC',
    apiUrl: (path: string) => path, fetch, onUnauthorized: jest.fn(),
    dashText: dashboardEscape, dashCount: compactNumber, dashStatus: dashboardEscape, agentBadge: dashboardEscape,
    setInterval: jest.fn(), setTimeout, dashClose: jest.fn(), refresh: jest.fn(), connectDashboardStream: jest.fn(), window: {},
  });
  const start = dashboardClient.indexOf('let jevUsageOffset=');
  const end = dashboardClient.indexOf('let dashboardFocus=', start);
  runInContext(dashboardClient.slice(start, end), context);
  const scopeHandler = dashboardClient.split('\n').find(line => line.startsWith("document.getElementById('dash-scope').addEventListener"))!;
  runInContext(scopeHandler, context);
  return { fetch, context, node, handlers, refresh: () => runInContext('refreshJevUsage()', context) as Promise<void> };
}
const response = (records: unknown[], total = records.length) => ({ ok: true, json: async () => ({ records, total }) });
const row = { requestId: '<img src=x>', agentId: 'a', consumer: 'browser', requestedModel: '<script>alert(1)</script>', startedAt: 1000, elapsedMs: 20, outcome: 'completed' };

test('evaluation history distinguishes missing measurements from zero and escapes metadata', async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(response([row, { ...row, usage: { input_tokens: 0, output_tokens: 0 }, billing: { charged_credits: 0 } }]));
  await f.refresh();
  const html = f.node('jev-usage-results').innerHTML;
  expect(html).toContain('&lt;img src=x&gt;'); expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>'); expect(html).toContain('<td>— / —</td><td>—</td>');
  expect(html).toContain('<td>0 / 0</td><td>0</td>');
});

test('changing scope invalidates an outstanding evaluation request immediately without waiting for status', async () => {
  const f = fixture(); let resolveOld!: (value: unknown) => void;
  f.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const old = f.refresh();
  f.fetch.mockResolvedValue(response([{ ...row, consumer: 'new-scope' }]));
  f.handlers.get('dash-scope:click')!({ target: { closest: () => ({ dataset: { range: '7d' } }) } });
  await Promise.resolve(); await Promise.resolve();
  expect(f.fetch).toHaveBeenLastCalledWith('/dashboard/jev?scope=7d&agentId=&offset=0');
  resolveOld(response([{ ...row, consumer: 'old-scope' }])); await old;
  expect(f.node('jev-usage-results').innerHTML).toContain('new-scope');
  expect(f.node('jev-usage-results').innerHTML).not.toContain('old-scope');
});

test('pager is disabled during fetch and recovers an offset beyond the retained results', async () => {
  const f = fixture(); f.fetch.mockResolvedValue(response(Array.from({ length: 25 }, () => row), 30));
  await f.refresh(); expect(f.node('jev-usage-next').disabled).toBe(false);
  let resolveNext!: (value: unknown) => void;
  f.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
  f.handlers.get('jev-usage-next:click')!();
  expect(f.node('jev-usage-next').disabled).toBe(true); expect(f.node('jev-usage-prev').disabled).toBe(true);
  f.fetch.mockResolvedValue(response([row], 1)); resolveNext(response([], 1));
  await new Promise(resolve => setImmediate(resolve));
  expect(f.fetch).toHaveBeenLastCalledWith('/dashboard/jev?scope=24h&agentId=&offset=0');
  expect(f.node('jev-usage-page').textContent).toBe('1–1 of 1');
});
