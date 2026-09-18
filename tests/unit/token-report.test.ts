import { runInNewContext } from 'vm';
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
  expect(html).toContain('Loaded: —'); expect(html).not.toContain('Available (2)');
  expect(html).toContain('Used: 1'); expect(html).toContain('Cache read');
  expect(html).not.toContain('5m: —'); expect(html).toContain('not monetary costs');
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
  expect(html).toContain('Agent / total · recorded only');
});
test('missing usage is unavailable and per-request records remain separate from the turn aggregate', () => {
  const missing = generateTokenReportHtml('agent', { ...report, turns: [{ ...report.turns[0], usage: null }] });
  expect(missing).toContain('No recorded token usage.');
  expect(missing).toContain('Agent tokens<strong>—');
  expect(missing).toContain('Per-request usage: —');
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
test('background reviews are omitted and incomplete request observations remain explicit', () => {
  const html = generateTokenReportHtml('agent', { ...report, backgroundReviews: [{ ts: '2026-09-17', outcome: '<updated>', tokensSpent: 9999, triggerReason: '<reason>' }], turns: [{ ...report.turns[0], requests: [{ id: 'observed-request', usage: { ...report.turns[0].usage!, totalTokens: 2 } }] }] });
  expect(html).toContain('Total tokens<strong>100');
  expect(html).not.toContain('Background skill learning');
  expect(html).not.toContain('&lt;updated&gt;'); expect(html).not.toContain('&lt;reason&gt;');
  expect(html).toContain('Observed requests do not cover the full turn aggregate');
});

test('one measured role never turns another role with unknown usage into zero', () => {
  const html = generateTokenReportHtml('agent', { ...report,
    totals: {agentTokens: null,workerTokens: 70,totalTokens: 70},
    turns: [{...report.turns[0],usage: null},report.turns[1]],
  });
  expect(html).toContain('Agent tokens<strong>—');
  expect(html).toContain('Worker tokens<strong>70');
  expect(html).toContain('Total tokens<strong>70');
  const onlyAgent = generateTokenReportHtml('agent', {...report,turns:[report.turns[0]]});
  expect(onlyAgent).toContain('Worker tokens<strong>—');
});

test('worker rows describe latest-attempt token and inventory scope', () => {
  const html = generateDashboardHtml();
  expect(html).toContain('Latest attempt');
  expect(html).toContain('Latest attempt tools');
  expect(html).toContain("dashCount(s.tokenSummary?.agentTokens)");
  expect(html).toContain("n == null ? '—' : n === 0 ? '0'");
});

test('paginated reports keep whole-session totals and distribution when a role is absent from the page',()=>{
 const html=generateTokenReportHtml('a', {...report,turns:[report.turns[0]],pagination:{offset:0,limit:1,total:2},distribution:[{category:'input',tokens:30},{category:'worker',tokens:70}]});
 expect(html).toContain('Worker tokens<strong>70');expect(html).toContain('70.0%');expect(html).toContain('Next →');expect(html).toContain('offset=1');
});

test('a slow prior-page response cannot replace a newer session page', async()=>{
 const html=generateDashboardHtml();
 const start=html.indexOf('async function refresh()');
 const end=html.indexOf('// ── Process Tree',start);
 let complete!: (value:unknown)=>void;
 const apply=jest.fn();
 const context:any={dashboardBusy:false,dashboardOffset:0,dashboardScope:"current",document:{hidden:false,getElementById:()=>({textContent:'',style:{}})},apiUrl:(p:string)=>p,
  fetch:()=>new Promise(resolve=>{complete=resolve;}),applyDashboardSnapshot:apply,onUnauthorized:jest.fn()};
 const pending=runInNewContext(html.slice(start,end)+';refresh()',context);
 context.dashboardOffset=25;
 complete({ok:true,status:200,json:async()=>({agents:[]})});
 await pending;
 expect(apply).not.toHaveBeenCalled();expect(context.dashboardBusy).toBe(false);
});

test('report shows readable input previews, voice badges and a scope-preserving pager',()=>{
 const html=generateTokenReportHtml('voice-agent',{...report,since:1,source:'telegram',pagination:{offset:0,limit:1,total:2},turns:[{...report.turns[0],inputTexts:['Please check my task'],inputModalities:['voice_note'],inputSequences:[7]}]});
 expect(html).toContain('Please check my task');expect(html).toContain('Voice message');expect(html).toContain('Input #7');expect(html).toContain('Telegram');expect(html).toContain('scope=24h');expect(html).toContain('stacked-distribution');expect(html).toContain('data-range="24h"');
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())expect(()=>new Function(match[1])).not.toThrow();
});

test('report distinguishes measured usage from unavailable per-file attribution',()=>{
 const html=generateTokenReportHtml('a',{...report,usageByRole:[{role:'agent',inputTokens:10,cacheCreationTokens:20,cacheReadTokens:30,outputTokens:40}]});
 expect(html).not.toContain('What makes up these tokens?');
 expect(html).toContain('not historical turn attribution');
 expect(html).toContain('setInterval(refreshReport,5000)');
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))expect(()=>new Function(match[1])).not.toThrow();
});

test('conversation and request details have only one disclosure level',()=>{
 const html=generateTokenReportHtml('a',{...report,turns:[{...report.turns[0],inputTexts:['Hello'],requests:[{id:'request',usage:report.turns[0].usage!}]}]});
 expect(html).toContain('<h3>Conversation / assignment / result</h3>');
 expect(html).toContain('<h3>Observed model requests: 1</h3>');
 expect(html).not.toContain('<summary>Observed model requests');
 expect(html).not.toContain('<summary>Conversation / assignment');
});

test('footprint bar hides empty sections and excludes duplicate parent and raw-file totals',()=>{
 const row=(name:string,tokens:number,hasContent=true)=>({name,tokens,hasContent,characters:10,note:''});
 const html=generateTokenReportHtml('a',{...report,contextFootprint:{observedAt:1,rows:[row('CLAUDE.md · composed workspace context',9000),row('AGENTS.md · source file',8000),row('↳ AGENTS.md',1000),row('↳ USER.md',1,false),row('Agent gateway tool schemas (8)',500)]}});
 const footprint=html.split('<section id="report-footprint">')[1].split('<section id="report-distribution">')[0];
 expect(footprint).toContain('1.50K estimated tokens');expect(footprint).toContain('AGENTS.md');expect(footprint).not.toContain('USER.md');expect(footprint).not.toContain('<table');expect(footprint).not.toContain('source file</');
});

test('request rows omit repeated tool inventories while the turn retains its measured count', () => {
 const turn={...report.turns[0],contextTools:['Bash','Read'],requests:Array.from({length:101},(_,i)=>({id:'request-'+i,usage:report.turns[0].usage!,toolSchemas:{messageId:'msg-'+i,requestId:'req-'+i,loaded:['Bash','Read'],deferred:[],source:'cli-request-body' as const}}))};
 const html=generateTokenReportHtml('agent',{...report,turns:[turn]});
 expect(html).toContain('Observed model requests: 101');
 expect(html).toContain('Loaded: 2');
 const requests=html.split('<div class="request-details">')[1].split('</tbody></table></div>')[0];
 expect(requests).not.toContain('Loaded');expect(requests).not.toContain('Bash');
});

// ── Context window box: '-' only for a genuinely stopped session, never a mid-turn gap ──
function contextWindowBox(view: Partial<TokenReportView>): string {
 const html = generateTokenReportHtml('agent', { ...report, contextWindow: { used: 42000, total: 200000, model: 'claude-sonnet-5' }, ...view });
 return html.split('class="card box-context">')[1].split('</div>')[0];
}
test('Context window shows "-" only when sessionStatus is stopped AND there is no active/idle-kept-alive activity', () => {
 expect(contextWindowBox({ sessionStatus: 'stopped', activityStatus: 'idle' })).toContain('<strong>-</strong>');
 expect(contextWindowBox({ sessionStatus: 'stopped', activityStatus: '' })).toContain('<strong>-</strong>');
});
test('Context window does NOT show "-" while activity is reported, even if the per-turn session process already tore down (sessionStatus stopped)', () => {
 for (const activityStatus of ['thinking', 'working', 'waiting_input', 'queued']) {
  const box = contextWindowBox({ sessionStatus: 'stopped', activityStatus });
  expect(box).not.toContain('<strong>-</strong>');
  expect(box).toContain('42.00K / 200K'); // the real measured window, not suppressed
 }
});
test('Context window does NOT show "-" for a live (running/idle) session even with no activity', () => {
 expect(contextWindowBox({ sessionStatus: 'running', activityStatus: '' })).not.toContain('<strong>-</strong>');
 expect(contextWindowBox({ sessionStatus: 'idle', activityStatus: 'idle' })).not.toContain('<strong>-</strong>');
});
test('Context window falls back to an em dash (unmeasured), distinct from the stopped hyphen, when no window snapshot exists yet', () => {
 const html = generateTokenReportHtml('agent', { ...report, contextWindow: null, sessionStatus: 'running', activityStatus: '' });
 const box = html.split('class="card box-context">')[1].split('</div>')[0];
 expect(box).toContain('<strong>—</strong>');
 expect(box).not.toContain('<strong>-</strong>');
});


test('live refresh updates status without replacing the scope toggle or its handler', async () => {
 const {tokenReportClient} = require('../../src/ui/token-report-client');
 const scope = {onclick: jest.fn()};
 const nodes: Record<string, any> = Object.fromEntries(['report-status','report-totals','report-footprint','report-distribution','report-live'].map(id=>[id,{innerHTML:id==='report-status'?'Thinking':'old'}]));
 nodes['report-scope']=scope;
 const body={innerHTML:'old rows'};
 const fresh={getElementById:(id:string)=>id==='login-form'?null:{innerHTML:id==='report-status'?'Idle':'new'},querySelector:()=>({innerHTML:'new rows'}),querySelectorAll:()=>[]};
 const context:any={document:{hidden:false,getElementById:(id:string)=>nodes[id],querySelector:()=>body,querySelectorAll:()=>[],addEventListener:jest.fn()},
  fetch:async()=>({ok:true,status:200,text:async()=>''}),DOMParser:class{parseFromString(){return fresh;}},location:{href:'https://fixture/report'},setInterval:jest.fn(),scrollX:0,scrollY:0,scrollTo:jest.fn(),filter:jest.fn()};
 runInNewContext(tokenReportClient,context);
 await context.refreshReport();
 expect(nodes['report-status'].innerHTML).toBe('Idle');
 expect(body.innerHTML).toBe('new rows');
 expect(nodes['report-scope']).toBe(scope);
 expect(typeof scope.onclick).toBe('function');
});
