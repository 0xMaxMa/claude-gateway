import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyProposal, type ExistingSkill, type WriterContext, PENDING_DIRNAME } from '../../../src/agent/skill-learning/writer';
import { extractFrontmatter } from '../../../src/skills/parser';
import type { ReviewProposal } from '../../../src/agent/skill-learning/types';

describe('skill-learning writer.applyProposal', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-writer-'));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const ctx = (over: Partial<WriterContext> = {}): WriterContext => ({
    workspaceDir: ws,
    sessionId: 'sess-1',
    now: 1_000,
    mode: 'auto',
    existing: [],
    ...over,
  });

  /** Seed an on-disk skill (so the writer can read its provenance for edits). */
  function seed(name: string, origin: 'auto' | 'user', description = 'seeded', extraFm: Record<string, string> = {}): ExistingSkill {
    const dir = path.join(ws, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const fm = [`name: ${name}`, `description: "${description}"`, `origin: ${origin}`, ...Object.entries(extraFm).map(([k, v]) => `${k}: ${v}`)];
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${fm.join('\n')}\n---\n\nold body\n`, 'utf-8');
    return { name, description, origin, filePath: path.join(dir, 'SKILL.md') };
  }

  function readSkill(name: string, queued = false): string {
    const base = queued ? path.join(ws, 'skills', PENDING_DIRNAME, name) : path.join(ws, 'skills', name);
    return fs.readFileSync(path.join(base, 'SKILL.md'), 'utf-8');
  }

  it('create stamps origin:auto + provenance', () => {
    const p: ReviewProposal = { action: 'create', name: 'deploy-flow', desc: 'how to deploy', body: 'step 1' };
    const out = applyProposal(p, ctx());
    expect(out).toMatchObject({ written: true, action: 'create', name: 'deploy-flow' });
    const fm = extractFrontmatter(readSkill('deploy-flow'))!.frontmatter;
    expect(fm['origin']).toBe('auto');
    expect(fm['createdFromSession']).toBe('sess-1');
    expect(fm['pinned']).toBe(false);
  });

  it('action none never writes', () => {
    expect(applyProposal({ action: 'none' }, ctx())).toEqual({ written: false, action: 'none' });
  });

  it('PROVENANCE GUARD: edit refuses when the target is not origin:auto', () => {
    const user = seed('handcraft', 'user');
    const out = applyProposal({ action: 'edit', targetSkill: 'handcraft', desc: 'x', body: 'y' }, ctx({ existing: [user] }));
    expect(out.written).toBe(false);
    expect(out.reason).toMatch(/provenance guard/i);
    expect(readSkill('handcraft')).toContain('old body'); // unchanged
  });

  it('PROVENANCE GUARD: create refuses on name collision with a non-auto skill', () => {
    const user = seed('handcraft', 'user');
    const out = applyProposal({ action: 'create', name: 'handcraft', desc: 'x', body: 'y' }, ctx({ existing: [user] }));
    expect(out.written).toBe(false);
    expect(out.reason).toMatch(/provenance guard/i);
  });

  it('edit succeeds on an origin:auto target and preserves createdAt', () => {
    const auto = seed('learned', 'auto', 'orig desc', { createdAt: '555', createdFromSession: 'old-sess' });
    const out = applyProposal({ action: 'edit', targetSkill: 'learned', desc: 'new desc', body: 'new body' }, ctx({ existing: [auto] }));
    expect(out.written).toBe(true);
    const fm = extractFrontmatter(readSkill('learned'))!.frontmatter;
    expect(fm['createdAt']).toBe(555); // preserved
    expect(fm['createdFromSession']).toBe('old-sess');
    expect(readSkill('learned')).toContain('new body');
  });

  it('priority/dedup: create with a name that duplicates an auto skill downgrades to edit', () => {
    const auto = seed('learned', 'auto');
    const out = applyProposal({ action: 'create', name: 'learned', desc: 'd', body: 'refined' }, ctx({ existing: [auto] }));
    expect(out).toMatchObject({ written: true, action: 'edit', name: 'learned' });
  });

  it('dedup: create whose description matches an auto skill downgrades to edit of that skill', () => {
    const auto = seed('learned', 'auto', 'deploy the app');
    const out = applyProposal({ action: 'create', name: 'brand-new', desc: 'Deploy The App', body: 'refined' }, ctx({ existing: [auto] }));
    expect(out).toMatchObject({ written: true, action: 'edit', name: 'learned' });
  });

  it('INSTALLED GUARD: create refuses a name an installed plugin skill already uses', () => {
    const plugin: ExistingSkill = { name: 'what-the-bug:wtb-auto-pilot', description: 'plugin auto-pilot', origin: 'user', filePath: '/plugins/wtb/SKILL.md' };
    const out = applyProposal({ action: 'create', name: 'wtb-auto-pilot', desc: 'my copy', body: 'b' }, ctx({ existing: [plugin] }));
    expect(out).toMatchObject({ written: false, action: 'create' });
    expect(out.reason).toContain('installed skill');
    expect(fs.existsSync(path.join(ws, 'skills', 'wtb-auto-pilot'))).toBe(false);
  });

  it('INSTALLED GUARD: create refuses a description an installed skill already has', () => {
    const shared: ExistingSkill = { name: 'gateway-code-review', description: 'Full end-to-end review of a PR', origin: 'user', filePath: '/shared/SKILL.md' };
    const out = applyProposal({ action: 'create', name: 'pr-review-loop', desc: '  full END-to-end review of a PR ', body: 'b' }, ctx({ existing: [shared] }));
    expect(out).toMatchObject({ written: false, action: 'create' });
    expect(out.reason).toContain('gateway-code-review');
  });

  it('rejects an invalid name', () => {
    const out = applyProposal({ action: 'create', name: 'Bad Name!', desc: 'd', body: 'b' }, ctx());
    expect(out.written).toBe(false);
    expect(out.reason).toMatch(/invalid skill name/i);
  });

  it('rejects a reserved name', () => {
    const out = applyProposal({ action: 'create', name: 'restart', desc: 'd', body: 'b' }, ctx());
    expect(out.written).toBe(false);
    expect(out.reason).toMatch(/reserved/i);
  });

  it('refuses when body or description is missing', () => {
    expect(applyProposal({ action: 'create', name: 'x-skill', desc: 'd' }, ctx()).written).toBe(false);
    expect(applyProposal({ action: 'create', name: 'x-skill', body: 'b' }, ctx()).written).toBe(false);
  });

  it('PROVENANCE GUARD: create refuses a non-auto file on disk even when absent from ctx.existing', () => {
    // Simulate a user skill the registry cannot see (unparseable frontmatter, or
    // frontmatter name != dir name): it exists at the exact target path but is
    // NOT in ctx.existing. The in-memory guard alone would miss it.
    const dir = path.join(ws, 'skills', 'orphan');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: something-else\norigin: user\n---\n\nHAND WRITTEN\n', 'utf-8');

    const out = applyProposal({ action: 'create', name: 'orphan', desc: 'd', body: 'b' }, ctx({ existing: [] }));
    expect(out.written).toBe(false);
    expect(out.reason).toMatch(/on-disk target is not origin:auto/i);
    expect(readSkill('orphan')).toContain('HAND WRITTEN'); // user content preserved
  });

  it('PROVENANCE GUARD: edit refuses an auto skill pinned in its on-disk frontmatter', () => {
    const pinned = seed('kept-flow', 'auto', 'seeded', { pinned: 'true' });
    const out = applyProposal({ action: 'edit', targetSkill: 'kept-flow', desc: 'x', body: 'new body' }, ctx({ existing: [pinned] }));
    expect(out.written).toBe(false);
    expect(out.reason).toMatch(/provenance guard/i);
    expect(readSkill('kept-flow')).toContain('old body');
  });

  it('PROVENANCE GUARD: never writes through a symlinked skill dir, even one that says origin:auto', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-writer-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: linked\ndescription: "d"\norigin: auto\n---\n\nOUTSIDE\n', 'utf-8');
      fs.mkdirSync(path.join(ws, 'skills'), { recursive: true });
      fs.symlinkSync(outside, path.join(ws, 'skills', 'linked'));
      const existing: ExistingSkill[] = [{ name: 'linked', description: 'd', origin: 'auto', filePath: path.join(ws, 'skills', 'linked', 'SKILL.md') }];

      const out = applyProposal({ action: 'edit', targetSkill: 'linked', desc: 'd', body: 'b' }, ctx({ existing }));
      expect(out.written).toBe(false);
      expect(out.reason).toMatch(/provenance guard/i);
      expect(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf-8')).toContain('OUTSIDE');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('create still succeeds when the target path is free', () => {
    const out = applyProposal({ action: 'create', name: 'fresh-skill', desc: 'd', body: 'b' }, ctx({ existing: [] }));
    expect(out.written).toBe(true);
  });

  it('desc ending in a backslash (plus quotes/newlines) stays valid YAML and re-parses', () => {
    // A trailing backslash is the sharp case: quote-only escaping emits
    // `description: "...\"` where the \" escapes the CLOSING quote → unterminated
    // scalar → js-yaml throws → the freshly written skill never loads.
    const nasty = 'win path C:\\tmp\nsays "hi" \\';
    const out = applyProposal({ action: 'create', name: 'nasty-desc', desc: nasty, body: 'b' }, ctx());
    expect(out.written).toBe(true);
    const parsed = extractFrontmatter(readSkill('nasty-desc'));
    expect(parsed).not.toBeNull(); // frontmatter still parses
    expect(typeof parsed!.frontmatter['description']).toBe('string');
    expect(parsed!.frontmatter['description']).toContain('hi');
  });

  it('mode:propose writes to the .pending review queue, not live', () => {
    const out = applyProposal({ action: 'create', name: 'queued-skill', desc: 'd', body: 'b' }, ctx({ mode: 'propose' }));
    expect(out).toMatchObject({ written: true, queued: true });
    expect(fs.existsSync(path.join(ws, 'skills', PENDING_DIRNAME, 'queued-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'skills', 'queued-skill', 'SKILL.md'))).toBe(false);
  });
});
