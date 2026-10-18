import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../../src/history/db';
import { SkillLearningManager, skillCatalogUsage, managedTurnSkills, toolUseSkills, skillLearningHostHooks, REVIEW_IDLE_DEBOUNCE_MS, type SkillLearningManagerOpts } from '../../../src/agent/skill-learning';
import { extractFrontmatter } from '../../../src/skills/parser';
import type { ClaudeSpawnFn } from '../../../src/agent/skill-learning/reviewer';
import type { SkillLearningConfig } from '../../../src/agent/skill-learning/types';
import { resolveSkillLearningConfig } from '../../../src/agent/skill-learning/config';

const NOW = 1_000_000;

function setup(cfg: SkillLearningConfig = {}, spawn?: ClaudeSpawnFn, notifications: Pick<SkillLearningManagerOpts, 'sendNotification' | 'channels'> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mgr-'));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(path.join(ws, 'skills'), { recursive: true });
  const db = HistoryDB.forAgent(dir, `agent-${Math.random().toString(36).slice(2)}`);
  const mgr = new SkillLearningManager({
    db,
    agentId: 'agent-x',
    workspaceDir: ws,
    globalCfg: cfg,
    reviewSpawn: spawn,
    now: () => NOW,
    ...notifications,
  });
  return { db, ws, mgr, dir };
}

function seedTranscript(db: HistoryDB, sessionId: string): void {
  db.insertMessage({ chatId: `telegram-${sessionId}`, sessionId, source: 'telegram', role: 'user', content: 'deploy the thing', ts: NOW });
  db.insertMessage({ chatId: `telegram-${sessionId}`, sessionId, source: 'telegram', role: 'assistant', content: 'done', ts: NOW });
}

const createEnvelope = (name: string): ClaudeSpawnFn => async () => ({
  stdout: JSON.stringify({
    type: 'result',
    result: JSON.stringify({ action: 'create', name, desc: 'a reusable flow', body: 'do the steps' }),
    usage: { input_tokens: 120, output_tokens: 30 },
  }),
});

describe('SkillLearningManager — telemetry capture', () => {
  it('onTurnStart→onToolUse→onTurnEnd persists a turn_metrics row', () => {
    const { db, mgr, dir } = setup();
    mgr.onTurnStart('chat1', 'sess1', '/deploy prod', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onToolUse('chat1', 'id-2');
    mgr.onTokenUsage('chat1', 500, 200);
    mgr.onTurnEnd('chat1', 'sess1');
    const rows = db.getTurnMetricsForSession('sess1');
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toBe(2);
    expect(rows[0].intentHash).toBe('cmd:deploy');
    expect(rows[0].enabled).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dedups repeated tool_use ids (cumulative snapshots)', () => {
    const { db, mgr, dir } = setup();
    mgr.onTurnStart('chat1', 'sess1', 'hi', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onToolUse('chat1', 'id-1'); // duplicate snapshot
    mgr.onToolUse('chat1', 'id-2');
    mgr.onTurnEnd('chat1', 'sess1');
    expect(db.getTurnMetricsForSession('sess1')[0].toolCalls).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures telemetry even when disabled (baseline cohort enabled=0)', () => {
    const { db, mgr, dir } = setup({ enabled: false });
    mgr.onTurnStart('chat1', 'sess1', 'hello world task', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onTurnEnd('chat1', 'sess1');
    const rows = db.getTurnMetricsForSession('sess1');
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records skills-loaded and bumps skill_stats usage', () => {
    const { db, mgr, dir } = setup();
    mgr.onTurnStart('chat1', 'sess1', 'x', ['my-skill']);
    mgr.onTurnEnd('chat1', 'sess1');
    expect(db.getSkillStat('my-skill')!.timesLoaded).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SkillLearningManager — review path', () => {
  it('passes the originating session to notification delivery and never broadcasts from credentials alone', async () => {
    const send = jest.fn();
    for (const scoped of [true, false]) {
      const { db, ws, mgr, dir } = setup({ minToolCalls: 1, notify: true }, createEnvelope('origin-flow'), {
        channels: { telegramBotToken: 'unused-token' }, ...(scoped ? { sendNotification: send } : {}),
      });
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
      try {
        seedTranscript(db, 'web-session');
        mgr.onTurnStart('web-chat', 'web-session', 'work'); mgr.onToolUse('web-chat', 'tool'); mgr.onTurnEnd('web-chat', 'web-session');
        await mgr.runReviewNow('web-chat', 'web-session');
        expect(fs.readFileSync(path.join(ws, 'SKILLS_LEARNED.md'), 'utf8')).toContain('origin-flow');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally { fetchSpy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('origin-flow'), 'web-session');
  });

  it('a qualifying session writes a learned skill (origin:auto) live', async () => {
    const { db, ws, mgr, dir } = setup({ minToolCalls: 3 }, createEnvelope('deploy-flow'));
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'deploy the thing', []);
    for (let i = 0; i < 4; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');

    await mgr.runReviewNow('chat1', 'sess1');

    const file = path.join(ws, 'skills', 'deploy-flow', 'SKILL.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(extractFrontmatter(fs.readFileSync(file, 'utf-8'))!.frontmatter['origin']).toBe('auto');
    expect(db.getSkillStat('deploy-flow')!.origin).toBe('auto');
    expect(db.countReviewRunsSince(0)).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows installed plugin skills to the reviewer and refuses to re-learn one as an auto skill', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mgr-'));
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(path.join(ws, 'skills'), { recursive: true });
    const db = HistoryDB.forAgent(dir, `agent-${Math.random().toString(36).slice(2)}`);
    let reviewerInput = '';
    const spawn: ClaudeSpawnFn = async (args, stdin) => {
      reviewerInput = stdin;
      return createEnvelope('wtb-auto-pilot')(args, stdin);
    };
    const mgr = new SkillLearningManager({
      db, agentId: 'agent-x', workspaceDir: ws, globalCfg: { minToolCalls: 3 }, reviewSpawn: spawn, now: () => NOW,
      installedSkills: async () => [{ name: 'what-the-bug:wtb-auto-pilot', description: 'End-to-end bug auto-pilot', filePath: '/plugins/wtb/SKILL.md' }],
    });
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'deploy the thing', []);
    for (let i = 0; i < 4; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');

    await mgr.runReviewNow('chat1', 'sess1');

    expect(reviewerInput).toMatch(/<installed_skills>\n[^<]*- what-the-bug:wtb-auto-pilot: End-to-end bug auto-pilot[^<]*\n<\/installed_skills>/);
    expect(reviewerInput).not.toMatch(/<existing_skills>[^]*what-the-bug:wtb-auto-pilot[^]*<\/existing_skills>/);
    expect(fs.existsSync(path.join(ws, 'skills', 'wtb-auto-pilot'))).toBe(false);
    expect(db.getSkillStat('wtb-auto-pilot')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a successful live write appends the SKILLS_LEARNED.md diary (notifier wired)', async () => {
    const { db, ws, mgr, dir } = setup({ minToolCalls: 3 }, createEnvelope('ship-flow'));
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'deploy the thing', []);
    for (let i = 0; i < 4; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');

    await mgr.runReviewNow('chat1', 'sess1');

    const diary = fs.readFileSync(path.join(ws, 'SKILLS_LEARNED.md'), 'utf-8');
    expect(diary).toContain('**create** `ship-flow`');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a non-qualifying session (below minToolCalls, no recovery) does NOT review', async () => {
    const spawn = jest.fn(createEnvelope('should-not-exist'));
    const { db, ws, mgr, dir } = setup({ minToolCalls: 5 }, spawn as unknown as ClaudeSpawnFn);
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'hi', []);
    mgr.onToolUse('chat1', 'id-1');
    mgr.onTurnEnd('chat1', 'sess1');
    await mgr.runReviewNow('chat1', 'sess1');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ws, 'skills', 'should-not-exist'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('PROVENANCE e2e: reviewer proposes edit on a user skill → refused, file unchanged', async () => {
    const editEnvelope: ClaudeSpawnFn = async () => ({
      stdout: JSON.stringify({
        type: 'result',
        result: JSON.stringify({ action: 'edit', targetSkill: 'handcraft', desc: 'hijacked', body: 'malicious' }),
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const { db, ws, mgr, dir } = setup({ minToolCalls: 1 }, editEnvelope);
    // pre-seed a hand-authored (user) skill
    const skillDir = path.join(ws, 'skills', 'handcraft');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: handcraft\ndescription: "human made"\n---\noriginal body\n`, 'utf-8');
    seedTranscript(db, 'sess1');

    mgr.onTurnStart('chat1', 'sess1', 'x', []);
    for (let i = 0; i < 3; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');
    await mgr.runReviewNow('chat1', 'sess1');

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('original body');
    // a review run is still logged (as error/no-write), but no skill_stats auto row for handcraft
    expect(db.getSkillStat('handcraft')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mode:propose routes the write to the .pending queue, not live', async () => {
    const { db, ws, mgr, dir } = setup({ minToolCalls: 1, mode: 'propose' }, createEnvelope('queued-flow'));
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'x', []);
    for (let i = 0; i < 2; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');
    await mgr.runReviewNow('chat1', 'sess1');
    expect(fs.existsSync(path.join(ws, 'skills', '.pending', 'queued-flow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'skills', 'queued-flow', 'SKILL.md'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('review eligibility without another model call', () => {
  const none = async () => ({ stdout: JSON.stringify({ result: '{"action":"none"}' }) });
  function qualify(mgr: SkillLearningManager, correction = false) {
    mgr.onTurnStart('chat', 'session', correction ? 'wrong result' : 'work');
    mgr.onToolUse('chat', 'tool');
    mgr.onTurnEnd('chat', 'session');
  }
  it('skips exact unchanged content, but keeps novel content, recovery and corrections eligible', async () => {
    const spawn = jest.fn(none);
    const { db, mgr, dir } = setup({ minToolCalls: 1 }, spawn);
    try {
      seedTranscript(db, 'session');
      qualify(mgr); await mgr.runReviewNow('chat', 'session');
      qualify(mgr); await mgr.runReviewNow('chat', 'session');
      expect(spawn).toHaveBeenCalledTimes(1);
      qualify(mgr, true); await mgr.runReviewNow('chat', 'session');
      expect(spawn).toHaveBeenCalledTimes(2);
      qualify(mgr); mgr.onRecoveryFired('chat'); await mgr.runReviewNow('chat', 'session');
      expect(spawn).toHaveBeenCalledTimes(3);
      db.insertMessage({ chatId: 'chat', sessionId: 'session', source: 'telegram', role: 'assistant', content: 'new reusable procedure', ts: NOW + 1 });
      qualify(mgr); await mgr.runReviewNow('chat', 'session');
      expect(spawn).toHaveBeenCalledTimes(4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not erase a new qualifying turn while the previous reviewer is running', async () => {
    let finish!: (value: { stdout: string }) => void;
    const spawn = jest.fn<ReturnType<ClaudeSpawnFn>, Parameters<ClaudeSpawnFn>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementation(none);
    const { db, mgr, dir } = setup({ minToolCalls: 1 }, spawn);
    try {
      seedTranscript(db, 'session'); qualify(mgr);
      const pending = mgr.runReviewNow('chat', 'session');
      qualify(mgr, true);
      while (!finish) await new Promise((r) => setImmediate(r)); // reviewer spawned
      finish(await none()); await pending;
      await mgr.runReviewNow('chat', 'session');
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['invalid', JSON.stringify({type:'result',result:JSON.stringify({action:'create'})})])('retries after invalid reviewer output %s rather than caching it as unchanged', async stdout => {
    const spawn = jest.fn().mockResolvedValueOnce({ stdout }).mockImplementation(none);
    const { db, mgr, dir } = setup({ minToolCalls: 1 }, spawn);
    try {
      seedTranscript(db, 'session'); qualify(mgr); await mgr.runReviewNow('chat', 'session');
      qualify(mgr); await mgr.runReviewNow('chat', 'session');
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('managedTurnSkills', () => {
  it('counts Skill-tool calls for registry skills, alongside the task skill, once each', () => {
    const registry = { skills: new Map([['learned-flow', {}], ['task-skill', {}]]) } as never;
    expect(managedTurnSkills(['task-skill', 'pstack:arena'], ['learned-flow', 'pstack:tdd', 'task-skill'], registry).sort()).toEqual(['learned-flow', 'task-skill']);
    expect(managedTurnSkills(undefined, undefined, registry)).toEqual([]);
  });

  it('counts a task-plugin Skill call (orchestration-task:<name>) as the registry skill', () => {
    const registry = { skills: new Map([['learned-flow', {}]]) } as never;
    expect(managedTurnSkills([], ['orchestration-task:learned-flow'], registry)).toEqual(['learned-flow']);
  });
});

describe('direct-turn skill usage', () => {
  const registry = (ws: string) => ({
    skills: new Map([
      ['learned', { source: 'workspace', filePath: path.join(ws, 'skills', 'learned', 'SKILL.md') }],
      ['mod:tool', { source: 'module', filePath: '/mcp/mod/skills/tool/SKILL.md' }],
    ]),
  }) as never;

  it('maps a Skill-tool call, a Read of a registry SKILL.md, or a shell read of one to the skill', () => {
    const r = registry('/ws');
    expect(toolUseSkills({ name: 'Skill', input: { skill: 'learned' } }, r)).toEqual(['learned']);
    expect(toolUseSkills({ name: 'Read', input: { file_path: '/ws/skills/learned/SKILL.md' } }, r)).toEqual(['learned']);
    expect(toolUseSkills({ name: 'Read', input: { file_path: '/ws/skills/../skills/learned/SKILL.md' } }, r)).toEqual(['learned']);
    expect(toolUseSkills({ name: 'Read', input: { file_path: '/mcp/mod/skills/tool/SKILL.md' } }, r)).toEqual(['mod:tool']);
    // Codex (and a Bash-happy agent) reads files through the shell.
    expect(toolUseSkills({ name: 'Bash', input: { command: 'cat /ws/skills/learned/SKILL.md' } }, r)).toEqual(['learned']);
    expect(toolUseSkills({ name: 'Bash', input: { command: "sed -n '1,80p' skills/learned/SKILL.md && cat '/mcp/mod/skills/tool/SKILL.md'" } }, r).sort()).toEqual(['learned', 'mod:tool']);
    expect(toolUseSkills({ name: 'Skill', input: { skill: 'pstack:tdd' } }, r)).toEqual([]);
    expect(toolUseSkills({ name: 'Read', input: { file_path: '/ws/skills/learned/notes.md' } }, r)).toEqual([]);
    expect(toolUseSkills({ name: 'Read', input: { file_path: '/other/learned/SKILL.md' } }, r)).toEqual([]);
    expect(toolUseSkills({ name: 'Bash', input: { command: 'ls /ws/skills/learned' } }, r)).toEqual([]);
    expect(toolUseSkills({ name: 'Read', input: { file_path: 42 } }, r)).toEqual([]);
  });

  it('resolves ~, $HOME and a preceding cd in a shell read of SKILL.md', () => {
    const r = registry(path.join(os.homedir(), 'ws'));
    const bash = (command: string) => toolUseSkills({ name: 'Bash', input: { command } }, r).sort();
    expect(bash('cat ~/ws/skills/learned/SKILL.md')).toEqual(['learned']);
    expect(bash('head -50 "$HOME/ws/skills/learned/SKILL.md"')).toEqual(['learned']);
    expect(bash('cat ${HOME}/ws/skills/learned/SKILL.md')).toEqual(['learned']);
    expect(bash('cd ~/ws/skills/learned && cat SKILL.md')).toEqual(['learned']);
    expect(bash("cd '/mcp/mod/skills'; sed -n 1,40p tool/SKILL.md")).toEqual(['mod:tool']);
    expect(bash('cd skills/learned && cat SKILL.md')).toEqual(['learned']);
    expect(bash('cd /mcp/mod && cd skills/tool && cat SKILL.md')).toEqual(['mod:tool']);
    expect(bash('cat SKILL.md')).toEqual([]);
    expect(bash('cd /elsewhere && cat SKILL.md')).toEqual([]);
  });

  it('a container agent reads its workspace at /workspace: that still counts as the host skill', () => {
    const r = registry('/srv/agents/a/workspace');
    expect(toolUseSkills({ name: 'Read', input: { file_path: '/workspace/skills/learned/SKILL.md' } }, r)).toEqual(['learned']);
    expect(toolUseSkills({ name: 'Bash', input: { command: 'cat /workspace/skills/learned/SKILL.md' } }, r)).toEqual(['learned']);
    expect(toolUseSkills({ name: 'Bash', input: { command: 'cd /workspace/skills/learned && cat SKILL.md' } }, r)).toEqual(['learned']);
    expect(managedTurnSkills([], [], r, ['/workspace/skills/learned/SKILL.md'])).toEqual(['learned']);
    // Only the agent's own workspace is mounted there: a module skill is not.
    expect(toolUseSkills({ name: 'Read', input: { file_path: '/workspace/skills/tool/SKILL.md' } }, r)).toEqual([]);
  });

  it('only a command that reads SKILL.md counts as use, not one that edits, diffs, moves or deletes it', () => {
    const r = registry('/ws');
    const bash = (command: string) => toolUseSkills({ name: 'Bash', input: { command } }, r);
    for (const read of ['head -40 /ws/skills/learned/SKILL.md', 'tail /ws/skills/learned/SKILL.md', 'less /ws/skills/learned/SKILL.md', '/usr/bin/cat /ws/skills/learned/SKILL.md', 'cat -n /ws/skills/learned/SKILL.md | head'])
      expect([read, bash(read)]).toEqual([read, ['learned']]);
    for (const other of ['git diff /ws/skills/learned/SKILL.md', 'rm /ws/skills/learned/SKILL.md', 'grep -n deploy /ws/skills/learned/SKILL.md', "sed -i 's/a/b/' /ws/skills/learned/SKILL.md", 'echo x > /ws/skills/learned/SKILL.md', 'mv /ws/skills/learned/SKILL.md /tmp/', 'git add skills/learned/SKILL.md'])
      expect([other, bash(other)]).toEqual([other, []]);
  });

  it('reads inside a `bash -lc` wrapper (how Codex runs commands), including a cd', () => {
    const r = registry('/ws');
    const bash = (command: string) => toolUseSkills({ name: 'Bash', input: { command } }, r);
    expect(bash("/bin/bash -lc 'cd skills/learned && cat SKILL.md'")).toEqual(['learned']);
    expect(bash('bash -lc "sed -n 1,80p /ws/skills/learned/SKILL.md"')).toEqual(['learned']);
    expect(bash("/usr/bin/zsh -c 'cd /ws/skills/learned; head SKILL.md'")).toEqual(['learned']);
    expect(bash("bash -lc 'git diff skills/learned/SKILL.md'")).toEqual([]);
  });

  it('counts a SKILL.md an orchestration/worker turn read itself (Read or shell)', () => {
    const r = registry('/ws');
    expect(managedTurnSkills([], [], r, ['/ws/skills/learned/SKILL.md'])).toEqual(['learned']);
    expect(managedTurnSkills([], [], r, ['skills/learned/SKILL.md', '/mcp/mod/skills/tool/SKILL.md']).sort()).toEqual(['learned', 'mod:tool']);
    expect(managedTurnSkills([], [], r, ['/elsewhere/SKILL.md'])).toEqual([]);
  });

  it('a skill the agent loaded itself in a direct turn bumps its load count once per turn', () => {
    const { db, mgr, dir } = setup();
    mgr.onTurnStart('chat1', 'sess1', 'deploy it', []);
    mgr.onSkillUsed('chat1', 'learned');
    mgr.onSkillUsed('chat1', 'learned'); // cumulative snapshot re-emits the block
    mgr.onTurnEnd('chat1', 'sess1');
    expect(db.getSkillStat('learned')!.timesLoaded).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports loaded skills so a hidden skill can rejoin the catalog right away', () => {
    const loaded: string[][] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mgr-'));
    const live = new SkillLearningManager({ db: HistoryDB.forAgent(dir, 'agent-cb'), agentId: 'agent-cb', workspaceDir: dir, now: () => NOW, onSkillsLoaded: (names) => loaded.push(names) });
    live.onTurnStart('chat1', 'sess1', 'x', ['learned']);
    live.onTurnEnd('chat1', 'sess1');
    expect(loaded).toEqual([['learned']]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('onSkillsLoaded failure', () => {
  it('a throwing callback is logged and the idle review is still scheduled', () => {
    jest.useFakeTimers();
    try {
      const warnings: string[] = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mgr-'));
      const live = new SkillLearningManager({
        db: HistoryDB.forAgent(dir, 'agent-throw'), agentId: 'agent-throw', workspaceDir: dir, now: () => NOW, globalCfg: { enabled: true },
        logger: { info: () => {}, warn: (m) => warnings.push(m) },
        onSkillsLoaded: () => { throw new Error('menu boom'); },
      });
      const review = jest.spyOn(live, 'runReviewNow').mockResolvedValue();
      live.onTurnStart('chat1', 'sess1', 'x', ['learned']);
      live.onTurnEnd('chat1', 'sess1');
      jest.advanceTimersByTime(REVIEW_IDLE_DEBOUNCE_MS + 1);
      expect(review).toHaveBeenCalledWith('chat1', 'sess1');
      expect(warnings.join('\n')).toMatch(/menu boom/);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('skill-learning host hooks (src/index.ts wiring)', () => {
  const cli = [{ name: 'pstack:tdd', description: 'tdd' }];
  const hostWith = (registry: Record<string, unknown>) => {
    const calls = { discover: 0, refresh: 0 };
    const hooks = skillLearningHostHooks({
      registry: () => registry as never,
      discoverInstalled: async () => { calls.discover++; return [{ name: 'scanned', description: 'scan' }]; },
      refreshMenu: async () => { calls.refresh++; },
    });
    return { hooks, calls };
  };

  it('reuses the CLI skills the runner already discovered instead of scanning again', async () => {
    const { hooks, calls } = hostWith({ skills: new Map(), cliSkills: cli });
    expect(await hooks.installedSkills()).toEqual(cli);
    expect(calls.discover).toBe(0);
  });

  it('scans when the runner has no CLI skill list, or its discovery failed', async () => {
    const none = hostWith({ skills: new Map() });
    expect(await none.hooks.installedSkills()).toEqual([{ name: 'scanned', description: 'scan' }]);
    const failed = hostWith({ skills: new Map(), cliSkills: [], cliDiscoveryError: 'boom' });
    expect(await failed.hooks.installedSkills()).toEqual([{ name: 'scanned', description: 'scan' }]);
    expect(none.calls.discover + failed.calls.discover).toBe(2);
  });

  it('a hidden skill that gets used rejoins the catalog and recomposes the menu once', async () => {
    const hiddenUntilUsed = new Set(['learned', 'other']);
    const { hooks, calls } = hostWith({ skills: new Map(), hiddenUntilUsed });
    hooks.onSkillsLoaded(['learned']);
    hooks.onSkillsLoaded(['learned']); // already visible: no second rebuild
    hooks.onSkillsLoaded(['visible-skill']);
    await new Promise((r) => setImmediate(r));
    expect([...hiddenUntilUsed]).toEqual(['other']);
    expect(calls.refresh).toBe(1);
  });
});

describe('installed skills vs workspace skills', () => {
  it('an installed skill with the same name never shadows the workspace auto skill (still editable, listed once)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-mgr-'));
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(path.join(ws, 'skills', 'learned'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'skills', 'learned', 'SKILL.md'), '---\nname: learned\ndescription: "learned flow"\norigin: auto\ncreatedAt: 1\n---\nold body\n', 'utf-8');
    const db = HistoryDB.forAgent(dir, `agent-${Math.random().toString(36).slice(2)}`);
    let reviewerInput = '';
    const spawn: ClaudeSpawnFn = async (_args, stdin) => {
      reviewerInput = stdin;
      return { stdout: JSON.stringify({ type: 'result', result: JSON.stringify({ action: 'edit', targetSkill: 'learned', desc: 'learned flow', body: 'new body' }), usage: { input_tokens: 1, output_tokens: 1 } }) };
    };
    const mgr = new SkillLearningManager({
      db, agentId: 'agent-x', workspaceDir: ws, globalCfg: { minToolCalls: 3 }, reviewSpawn: spawn, now: () => NOW,
      // ~/.claude/skills copy under the same bare name (scanned without a plugin prefix).
      installedSkills: async () => [{ name: 'learned', description: 'learned flow', filePath: '/home/u/.claude/skills/learned/SKILL.md' }],
    });
    seedTranscript(db, 'sess1');
    mgr.onTurnStart('chat1', 'sess1', 'deploy the thing', []);
    for (let i = 0; i < 4; i++) mgr.onToolUse('chat1', `id-${i}`);
    mgr.onTurnEnd('chat1', 'sess1');

    await mgr.runReviewNow('chat1', 'sess1');

    expect(fs.readFileSync(path.join(ws, 'skills', 'learned', 'SKILL.md'), 'utf-8')).toContain('new body');
    expect(reviewerInput.match(/- learned: /g)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('skillCatalogUsage — the menu enforces the cap when the curator cannot archive', () => {
  const resolved = (over: SkillLearningConfig = {}) => resolveSkillLearningConfig({ maxAutoSkills: 3, ...over });

  it('sets the menu cap only when skills/.archive is unusable and learning is enabled', () => {
    const { db, ws, dir } = setup();
    expect(skillCatalogUsage(db, NOW, { workspaceDir: ws, cfg: resolved() }).maxListedAutoSkills).toBeUndefined();
    fs.writeFileSync(path.join(ws, 'skills', '.archive'), 'not a dir');
    expect(skillCatalogUsage(db, NOW, { workspaceDir: ws, cfg: resolved() }).maxListedAutoSkills).toBe(3);
    expect(skillCatalogUsage(db, NOW, { workspaceDir: ws, cfg: resolved({ enabled: false }) }).maxListedAutoSkills).toBeUndefined();
    expect(skillCatalogUsage(db, NOW, { workspaceDir: ws, cfg: resolved({ maxAutoSkills: 0 }) }).maxListedAutoSkills).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('carries each skill\'s last use for the LRU order', () => {
    const { db, dir } = setup();
    db.recordSkillCreated({ name: 's', origin: 'auto', createdAt: 5, createdFromSession: null, pinned: 0 });
    db.bumpSkillLoaded('s', 42);
    expect(skillCatalogUsage(db, NOW).stats.get('s')).toEqual({ timesLoaded: 1, createdAt: 5, lastUsedAt: 42 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
