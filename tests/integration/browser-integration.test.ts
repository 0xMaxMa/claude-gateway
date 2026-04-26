import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserModule } from '../../mcp/tools/browser/module';

const SESSION_BASE_DIR = '/tmp/browser-sessions';

function parseResult(mcpResult: { content: Array<{ type: 'text'; text: string }> }): any {
  return JSON.parse(mcpResult.content[0].text);
}

describe('BrowserModule tools - integration', () => {
  let mod: BrowserModule;
  const SID = 'test-tools';

  beforeEach(() => {
    mod = new BrowserModule();
  });

  afterEach(async () => {
    await mod.deleteSession(SID).catch(() => {});
  }, 30000);

  it('I1: navigate returns correct title, url, and vnc_url', async () => {
    const r = parseResult(
      await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' }),
    );
    expect(r.title).toContain('Example');
    expect(r.current_url).toMatch(/example\.com/);
    expect(r.vnc_url).toContain('/browser/vnc.html');
    expect(r.vnc_url).toMatch(/token%3D[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  }, 30000);

  it('I2: screenshot returns valid base64 PNG', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const r = parseResult(await mod.handleTool('browser_screenshot', { session_id: SID }));
    const buf = Buffer.from(r.image_base64, 'base64');
    expect(buf.slice(0, 4).toString('hex')).toBe('89504e47');
    expect(buf.length).toBeGreaterThan(1000);
  }, 30000);

  it('I3: click works on existing selector', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const r = parseResult(
      await mod.handleTool('browser_click', { session_id: SID, selector: 'a' }),
    );
    expect(r.success).toBe(true);
  }, 30000);

  it('I4: click throws on missing selector', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const result = await mod.handleTool('browser_click', {
      session_id: SID,
      selector: '#no-such-element-xyz',
    });
    expect(result.isError).toBe(true);
  }, 15000);

  it('I5: fill sets input value', async () => {
    await mod.handleTool('browser_navigate', {
      session_id: SID,
      url: 'https://www.w3schools.com/html/html_forms.asp',
    });
    const fillResult = parseResult(
      await mod.handleTool('browser_fill', {
        session_id: SID,
        selector: 'input[name="fname"]',
        value: 'TestUser',
      }),
    );
    expect(fillResult.success).toBe(true);
    const val = parseResult(
      await mod.handleTool('browser_evaluate', {
        session_id: SID,
        expression: 'document.querySelector(\'input[name="fname"]\').value',
      }),
    );
    expect(JSON.parse(val.result)).toBe('TestUser');
  }, 30000);

  it('I6: get_text without selector returns body text', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const r = parseResult(await mod.handleTool('browser_get_text', { session_id: SID }));
    expect(r.text).toContain('Example');
  }, 30000);

  it('I7: get_text with selector returns element text', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const r = parseResult(
      await mod.handleTool('browser_get_text', { session_id: SID, selector: 'h1' }),
    );
    expect(r.text).toBeTruthy();
  }, 30000);

  it('I8: evaluate returns JSON-serialized result', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const r = parseResult(
      await mod.handleTool('browser_evaluate', { session_id: SID, expression: '1 + 1' }),
    );
    expect(JSON.parse(r.result)).toBe(2);
  }, 30000);

  it('I9: close_session removes from memory but keeps disk', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const r = parseResult(
      await mod.handleTool('browser_close_session', { session_id: SID }),
    );
    expect(r.success).toBe(true);
    expect((mod as any)['contexts'].has(SID)).toBe(false);
    const stat = await fs.stat(path.join(SESSION_BASE_DIR, SID));
    expect(stat.isDirectory()).toBe(true);
  }, 30000);

  it('I10: delete_session removes context and disk', async () => {
    await mod.handleTool('browser_navigate', { session_id: SID, url: 'https://example.com' });
    const r = parseResult(
      await mod.handleTool('browser_delete_session', { session_id: SID }),
    );
    expect(r.success).toBe(true);
    expect((mod as any)['contexts'].has(SID)).toBe(false);
    await expect(fs.stat(path.join(SESSION_BASE_DIR, SID))).rejects.toThrow();
  }, 30000);

  it('I11: resume after close - localStorage persists on disk', async () => {
    const ctx1 = await mod.getContext(SID);
    const p1 = ctx1.pages().length > 0 ? ctx1.pages()[0] : await ctx1.newPage();
    await p1.goto('https://example.com');
    await p1.evaluate("localStorage.setItem('resume_key', 'resume_value')");
    await mod.closeSession(SID);

    const ctx2 = await mod.getContext(SID);
    const p2 = ctx2.pages().length > 0 ? ctx2.pages()[0] : await ctx2.newPage();
    await p2.goto('https://example.com');
    const val = await p2.evaluate("localStorage.getItem('resume_key')");
    expect(val).toBe('resume_value');
  }, 30000);

  it('I12: two sessions do not share localStorage', async () => {
    const SID2 = 'test-tools-2';
    try {
      const ctx1 = await mod.getContext(SID);
      const p1 = ctx1.pages().length > 0 ? ctx1.pages()[0] : await ctx1.newPage();
      await p1.goto('https://example.com');
      await p1.evaluate("localStorage.setItem('shared_key', 'session_A')");

      const ctx2 = await mod.getContext(SID2);
      const p2 = ctx2.pages().length > 0 ? ctx2.pages()[0] : await ctx2.newPage();
      await p2.goto('https://example.com');
      const val = await p2.evaluate("localStorage.getItem('shared_key')");
      expect(val).toBeNull();
    } finally {
      await mod.deleteSession(SID2).catch(() => {});
    }
  }, 30000);

  it('I13: server restart simulation - localStorage persists across instances', async () => {
    const ctx1 = await mod.getContext(SID);
    const p1 = ctx1.pages().length > 0 ? ctx1.pages()[0] : await ctx1.newPage();
    await p1.goto('https://example.com');
    await p1.evaluate("localStorage.setItem('restart_key', 'restart_ok')");
    await mod.closeSession(SID);

    // Simulate server restart: new BrowserModule instance, no in-memory state
    const mod2 = new BrowserModule();
    try {
      const ctx2 = await mod2.getContext(SID);
      const p2 = ctx2.pages().length > 0 ? ctx2.pages()[0] : await ctx2.newPage();
      await p2.goto('https://example.com');
      const val = await p2.evaluate("localStorage.getItem('restart_key')");
      expect(val).toBe('restart_ok');
    } finally {
      await mod2.deleteSession(SID).catch(() => {});
    }
  }, 30000);
});

describe('BrowserModule - handleTool unknown tool', () => {
  it('returns isError for unknown tool name', async () => {
    const mod = new BrowserModule();
    const result = await mod.handleTool('browser_unknown', { session_id: 'x' });
    expect(result.isError).toBe(true);
  });
});

describe('BrowserModule - VNC integration', () => {
  const SID_A = 'vnc-int-a';
  const SID_B = 'vnc-int-b';
  let mod: BrowserModule;

  beforeEach(() => {
    mod = new BrowserModule();
  });

  afterEach(async () => {
    await mod.deleteSession(SID_A).catch(() => {});
    await mod.deleteSession(SID_B).catch(() => {});
  }, 30000);

  it('I-VNC1: navigate returns vnc_url containing encoded session token', async () => {
    const r = parseResult(
      await mod.handleTool('browser_navigate', { session_id: SID_A, url: 'https://example.com' }),
    );
    expect(r.vnc_url).toContain('/browser/vnc.html');
    expect(r.vnc_url).toMatch(/token%3D[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(r.vnc_url).toContain('autoconnect=true');
  }, 30000);

  it('I-VNC2: two concurrent sessions have different VNC display numbers and ports', async () => {
    await mod.getContext(SID_A);
    await mod.getContext(SID_B);
    const vncA = (mod as any).vncSessions.get(SID_A) as { display: number; vncPort: number };
    const vncB = (mod as any).vncSessions.get(SID_B) as { display: number; vncPort: number };
    expect(vncA).toBeDefined();
    expect(vncB).toBeDefined();
    expect(vncA.display).not.toBe(vncB.display);
    expect(vncA.vncPort).not.toBe(vncB.vncPort);
  }, 30000);

  it('I-VNC3: closeSession removes VNC session from map and token file', async () => {
    await mod.getContext(SID_A);
    expect((mod as any).vncSessions.has(SID_A)).toBe(true);
    const vncToken = (mod as any).vncSessions.get(SID_A)!.token as string;

    await mod.closeSession(SID_A);

    expect((mod as any).vncSessions.has(SID_A)).toBe(false);
    const content = await fs.readFile('/tmp/vnc-tokens.cfg', 'utf-8').catch(() => '');
    expect(content).not.toContain(`${vncToken}:`);
  }, 30000);
});
