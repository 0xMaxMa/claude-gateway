import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  loadWorkspace,
  migrateWorkspaceFiles,
  watchWorkspace,
  AGENT_WRITABLE_FILES,
  MEMORY_FILES,
  IDENTITY_FILES,
  SKILL_LEARNING_FILES,
  classifyWorkspaceRestart,
  resolveMemoryBudget,
  DEFAULT_MEMORY_BUDGET,
  OverBudgetMode,
  MissingRequiredFileError,
  buildMemoryIndex,
} from '../../src/agent/workspace-loader';
import { DIARY_FILENAME } from '../../src/agent/skill-learning/notifier';
import { waitFor } from '../helpers/wait-for';

const FIXTURES = path.join(__dirname, '../fixtures/workspaces');

describe('workspace-loader', () => {
  // -------------------------------------------------------------------------
  // U-WL-01: Load all workspace files
  // -------------------------------------------------------------------------
  it('U-WL-01: loads all workspace files and returns a system prompt', async () => {
    const result = await loadWorkspace(path.join(FIXTURES, 'valid-full'));
    expect(result.systemPrompt).toBeTruthy();
    expect(result.files.agentMd).toContain('Alfred');
    expect(result.files.soulMd).toContain('Tone');
    expect(result.files.userMd).toContain('User Profile');
    expect(result.files.heartbeatMd).toContain('morning-brief');
    expect(result.files.memoryMd).toContain('Memory');
  });

  // -------------------------------------------------------------------------
  // U-WL-03: Missing required file (AGENTS.md)
  // -------------------------------------------------------------------------
  it('U-WL-03: throws MissingRequiredFileError when AGENTS.md is absent', async () => {
    await expect(loadWorkspace(path.join(FIXTURES, 'missing-agent-md'))).rejects.toThrow(
      MissingRequiredFileError
    );
  });

  it('U-WL-03b: MissingRequiredFileError message references AGENTS.md', async () => {
    await expect(loadWorkspace(path.join(FIXTURES, 'missing-agent-md'))).rejects.toThrow(
      'AGENTS.md'
    );
  });

  // -------------------------------------------------------------------------
  // U-WL-04: File exceeds 20,000 char limit
  // -------------------------------------------------------------------------
  it('U-WL-04: truncates files exceeding 20,000 characters', async () => {
    // coreShrink:false exercises the legacy full-content path so the hard 20k cap
    // still applies to MEMORY.md (with K2 core-shrink on, an over-budget MEMORY.md
    // is replaced by a small index long before the 20k cap — that path is covered
    // by U-SHRINK-3). The safety-net truncation itself is unchanged.
    const result = await loadWorkspace(path.join(FIXTURES, 'oversized'), { coreShrink: false });
    // MEMORY.md has 25,000+ chars — should be truncated
    expect(result.files.memoryMd.length).toBeLessThanOrEqual(20_000 + 60); // +marker length
    expect(result.files.memoryMd).toContain('[TRUNCATED');
    expect(result.truncated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Memory budget discipline (issue #323): an over-budget memory file gets a
  // loud OVER BUDGET banner at compose instead of a silent truncation.
  // -------------------------------------------------------------------------
  const makeBudgetWs = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-budget-'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), files['AGENTS.md'] ?? '# Agent');
    for (const [name, content] of Object.entries(files)) {
      if (name === 'AGENTS.md') continue;
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  };

  it('U-BUDGET-1: MEMORY.md over soft budget gets a loud OVER BUDGET banner (not silent truncate)', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': 'M'.repeat(9_000) }); // > 8000 soft, < 20000 hard
    try {
      const result = await loadWorkspace(dir, { memoryBudget: { memoryBudgetChars: 8_000 } });
      expect(result.files.memoryMd).toContain('MEMORY.md OVER BUDGET');
      expect(result.files.memoryMd).toContain('⚠️');
      expect(result.files.memoryMd).toContain('consolidate');
      // Under the hard 20k cap → not truncated; full content kept after the banner.
      expect(result.files.memoryMd).not.toContain('[TRUNCATED');
      expect(result.systemPrompt).toContain('MEMORY.md OVER BUDGET');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-BUDGET-2: MEMORY.md under budget composes clean (no banner)', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': 'a small curated memory' });
    try {
      const result = await loadWorkspace(dir, { memoryBudget: { memoryBudgetChars: 8_000 } });
      expect(result.files.memoryMd).not.toContain('OVER BUDGET');
      expect(result.files.memoryMd).toBe('a small curated memory');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-BUDGET-3: USER.md over its own (smaller) budget gets the banner', async () => {
    const dir = makeBudgetWs({ 'USER.md': 'U'.repeat(4_000) }); // > 3000 soft
    try {
      const result = await loadWorkspace(dir, { memoryBudget: { userBudgetChars: 3_000 } });
      expect(result.files.userMd).toContain('USER.md OVER BUDGET');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-BUDGET-4: non-memory files never get a budget banner (only the hard truncate)', async () => {
    // SOUL.md is larger than the memory budget but is NOT a memory file.
    const dir = makeBudgetWs({ 'SOUL.md': 'S'.repeat(9_000) });
    try {
      const result = await loadWorkspace(dir, { memoryBudget: { memoryBudgetChars: 8_000 } });
      expect(result.files.soulMd).not.toContain('OVER BUDGET');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-BUDGET-5: overBudget "error" mode uses the stronger banner', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': 'M'.repeat(9_000) });
    try {
      const result = await loadWorkspace(dir, {
        memoryBudget: { memoryBudgetChars: 8_000, overBudget: 'error' },
      });
      expect(result.files.memoryMd).toContain('🛑');
      expect(result.files.memoryMd).toContain('MUST consolidate');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-BUDGET-6: budget 0 disables the banner (opt-out)', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': 'M'.repeat(9_000) });
    try {
      const result = await loadWorkspace(dir, { memoryBudget: { memoryBudgetChars: 0 } });
      expect(result.files.memoryMd).not.toContain('OVER BUDGET');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-BUDGET-7: default budget (no opts) still banners a large MEMORY.md', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': 'M'.repeat(9_000) });
    try {
      const result = await loadWorkspace(dir); // no memoryBudget → defaults (8000)
      expect(result.files.memoryMd).toContain('OVER BUDGET');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // K2 core-shrink (planning-64): an over-budget MEMORY.md is injected as a
  // compact auto-index + a pointer to memory_search, not the truncated body.
  // -------------------------------------------------------------------------
  // A > 8000-char MEMORY.md with headings; each section's distinctive DEEPMARKER
  // sits deep in padding (never in the first-line brief), so it must be absent
  // from the shrunk index but present in the full-content (legacy) form.
  const shrinkableMemory =
    `## Section Alpha\nBrief for alpha.\n${'x'.repeat(5000)}\nDEEPMARKERALPHA\n\n` +
    `## Section Beta\nBrief for beta.\n${'y'.repeat(5000)}\nDEEPMARKERBETA\n`;

  it('U-SHRINK-1: buildMemoryIndex returns a pointer + heading map for a file with headings', () => {
    const idx = buildMemoryIndex(shrinkableMemory);
    expect(idx).not.toBeNull();
    expect(idx).toContain('memory_search');
    expect(idx).toContain('## Section Alpha');
    expect(idx).toContain('## Section Beta');
    expect(idx).toContain('Brief for alpha.');
    expect(idx).not.toContain('DEEPMARKERALPHA'); // body stays out of the index
  });

  it('U-SHRINK-2: buildMemoryIndex returns null when there are no headings', () => {
    expect(buildMemoryIndex('M'.repeat(9_000))).toBeNull();
  });

  it('U-SHRINK-3: over-budget MEMORY.md with headings is injected as the index (coreShrink on)', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': shrinkableMemory });
    try {
      const result = await loadWorkspace(dir, {
        memoryBudget: { memoryBudgetChars: 8_000 },
        coreShrink: true,
      });
      // Banner + index + pointer; the deep body markers are NOT in the prompt.
      expect(result.files.memoryMd).toContain('MEMORY.md OVER BUDGET');
      expect(result.files.memoryMd).toContain('memory_search');
      expect(result.files.memoryMd).toContain('## Section Alpha');
      expect(result.files.memoryMd).not.toContain('DEEPMARKERALPHA');
      expect(result.files.memoryMd).not.toContain('DEEPMARKERBETA');
      // Shrink-aware banner steers away from rewriting from the prompt.
      expect(result.files.memoryMd).toContain('never rewrite it from this');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-SHRINK-6: buildMemoryIndex ignores headings inside fenced code blocks', () => {
    const idx = buildMemoryIndex('## Real Section\nBrief here.\n```bash\n# not a heading\nnpm i\n```\n');
    expect(idx).toContain('## Real Section');
    expect(idx).not.toContain('# not a heading');
  });

  it('U-RETRIEVAL-1: archive on (coreShrink) injects the retrieval note — even under budget', async () => {
    // Small, under-budget MEMORY.md: proves the note is gated on the archive being
    // on, NOT on the over-budget shrink path (the tools are useful for memory/*.md
    // notes and the shared KB regardless of core size).
    const dir = makeBudgetWs({ 'MEMORY.md': '## Small\njust a little memory' });
    try {
      const result = await loadWorkspace(dir, {
        memoryBudget: { memoryBudgetChars: 8_000 },
        coreShrink: true,
      });
      expect(result.systemPrompt).toContain('--- MEMORY RETRIEVAL ---');
      expect(result.systemPrompt).toContain('memory_search');
      expect(result.systemPrompt).toContain('memory_get');
      expect(result.systemPrompt).toContain('corpus');
      // Independent of the shrink banner: the file itself is under budget.
      expect(result.files.memoryMd).not.toContain('OVER BUDGET');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-RETRIEVAL-2: archive off (coreShrink:false default) omits the retrieval note', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': '## Small\njust a little memory' });
    try {
      const result = await loadWorkspace(dir, {
        memoryBudget: { memoryBudgetChars: 8_000 },
        coreShrink: false,
      });
      expect(result.systemPrompt).not.toContain('--- MEMORY RETRIEVAL ---');
      expect(result.systemPrompt).not.toContain('memory_search');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-SHRINK-4: coreShrink:false keeps the legacy banner + full body', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': shrinkableMemory });
    try {
      const result = await loadWorkspace(dir, {
        memoryBudget: { memoryBudgetChars: 8_000 },
        coreShrink: false,
      });
      expect(result.files.memoryMd).toContain('MEMORY.md OVER BUDGET');
      expect(result.files.memoryMd).toContain('DEEPMARKERALPHA'); // full body retained
      expect(result.files.memoryMd).not.toContain('memory_search');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-SHRINK-5: under-budget MEMORY.md is never shrunk (clean, no pointer)', async () => {
    const dir = makeBudgetWs({ 'MEMORY.md': '## Small\njust a little memory' });
    try {
      const result = await loadWorkspace(dir, { memoryBudget: { memoryBudgetChars: 8_000 } });
      expect(result.files.memoryMd).not.toContain('OVER BUDGET');
      expect(result.files.memoryMd).not.toContain('memory_search');
      expect(result.files.memoryMd).toContain('just a little memory');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('U-BUDGET-8: resolveMemoryBudget fills defaults and rejects invalid values (fail-safe)', () => {
    expect(resolveMemoryBudget(undefined)).toEqual(DEFAULT_MEMORY_BUDGET);
    // Unknown overBudget → warn
    expect(resolveMemoryBudget({ overBudget: 'nonsense' as OverBudgetMode }).overBudget).toBe('warn');
    // Negative / NaN budgets → defaults
    expect(resolveMemoryBudget({ memoryBudgetChars: -5 }).memoryBudgetChars).toBe(
      DEFAULT_MEMORY_BUDGET.memoryBudgetChars,
    );
    expect(resolveMemoryBudget({ userBudgetChars: NaN }).userBudgetChars).toBe(
      DEFAULT_MEMORY_BUDGET.userBudgetChars,
    );
    // Valid partial is honored
    expect(resolveMemoryBudget({ overBudget: 'error', memoryBudgetChars: 100 })).toEqual({
      memoryBudgetChars: 100,
      userBudgetChars: 3_000,
      overBudget: 'error',
      writeRouting: false,
    });
  });

  it('U-BUDGET-9: per-agent override wins field-by-field over the global default', () => {
    // Mirrors src/index.ts: `{ ...global, ...agent }` then resolveMemoryBudget.
    const global = { memoryBudgetChars: 8_000, userBudgetChars: 3_000, overBudget: 'warn' as OverBudgetMode };
    const agent = { memoryBudgetChars: 40_000 }; // an agent with a large curated memory
    expect(resolveMemoryBudget({ ...global, ...agent })).toEqual({
      memoryBudgetChars: 40_000, // agent wins
      userBudgetChars: 3_000, // global fills the rest
      overBudget: 'warn',
      writeRouting: false,
    });
  });

  // -------------------------------------------------------------------------
  // U-WL-05: Total context exceeds 150,000 chars
  // -------------------------------------------------------------------------
  it('U-WL-05: system prompt never exceeds total limit (per-file truncation keeps total under 150k)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
    try {
      // Each file is 25,000 chars — will be individually truncated to 20,000
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent\n' + 'A'.repeat(25_000));
      fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), 'S'.repeat(25_000));
      fs.writeFileSync(path.join(tmpDir, 'USER.md'), 'U'.repeat(25_000));
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), 'M'.repeat(25_000));
      fs.writeFileSync(path.join(tmpDir, 'HEARTBEAT.md'), 'H'.repeat(25_000));

      const result = await loadWorkspace(tmpDir);
      // Total must never exceed 150,000 + marker length
      expect(result.systemPrompt.length).toBeLessThanOrEqual(150_000 + 60);
      // Per-file truncation means truncated flag is set
      expect(result.truncated).toBe(true);
      // Each file must have been truncated
      expect(result.files.agentMd).toContain('[TRUNCATED');
      expect(result.files.soulMd).toContain('[TRUNCATED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // U-WL-06: System prompt section ordering
  // -------------------------------------------------------------------------
  it('U-WL-06: system prompt has correct section order', async () => {
    const result = await loadWorkspace(path.join(FIXTURES, 'valid-full'));
    const prompt = result.systemPrompt;

    const memoryRuleIdx = prompt.indexOf('--- MEMORY RULE ---');
    const agentIdx = prompt.indexOf('--- AGENT IDENTITY ---');
    const identityIdx = prompt.indexOf('--- IDENTITY ---');
    const soulIdx = prompt.indexOf('--- SOUL ---');
    const userIdx = prompt.indexOf('--- USER PROFILE ---');
    const memoryIdx = prompt.indexOf('--- LONG-TERM MEMORY ---');
    const heartbeatIdx = prompt.indexOf('--- HEARTBEAT CONFIG ---');

    expect(memoryRuleIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdx).toBeGreaterThan(memoryRuleIdx);
    expect(identityIdx).toBeGreaterThan(agentIdx);
    expect(soulIdx).toBeGreaterThan(identityIdx);
    expect(userIdx).toBeGreaterThan(soulIdx);
    expect(memoryIdx).toBeGreaterThan(userIdx);
    expect(heartbeatIdx).toBeGreaterThan(memoryIdx);
  });

  // -------------------------------------------------------------------------
  // U-WL-07: Section headers present
  // -------------------------------------------------------------------------
  it('U-WL-07: system prompt contains all section headers', async () => {
    const result = await loadWorkspace(path.join(FIXTURES, 'valid-full'));
    expect(result.systemPrompt).toContain('--- AGENT IDENTITY ---');
    expect(result.systemPrompt).toContain('--- IDENTITY ---');
    expect(result.systemPrompt).toContain('--- SOUL ---');
    expect(result.systemPrompt).toContain('--- USER PROFILE ---');
    expect(result.systemPrompt).toContain('--- LONG-TERM MEMORY ---');
    expect(result.systemPrompt).toContain('--- HEARTBEAT CONFIG ---');
    expect(result.systemPrompt).toContain('--- MEMORY RULE ---');
  });

  // -------------------------------------------------------------------------
  // TC-1: Memory rule is injected into system prompt
  // -------------------------------------------------------------------------
  it('TC-1: system prompt contains memory rule text', async () => {
    const result = await loadWorkspace(path.join(FIXTURES, 'valid-full'));
    expect(result.systemPrompt).toContain('## Memory Rule');
    expect(result.systemPrompt).toContain('MEMORY.md');
    expect(result.systemPrompt).toContain('AGENTS.md');
  });

  // -------------------------------------------------------------------------
  // U-WL-08: Empty optional file
  // -------------------------------------------------------------------------
  it('U-WL-08: empty optional files are included without error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent\nMinimal agent.');
      fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), ''); // empty

      const result = await loadWorkspace(tmpDir);
      expect(result.files.soulMd).toBe('');
      expect(result.systemPrompt).toContain('--- SOUL ---');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // IDENTITY.md tests
  // -------------------------------------------------------------------------
  it('IDENTITY.md present → included in prompt under --- IDENTITY ---', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent\nTest agent.');
      fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), 'Name: TestBot\nEmoji: 🤖');

      const result = await loadWorkspace(tmpDir);
      expect(result.systemPrompt).toContain('--- IDENTITY ---');
      expect(result.systemPrompt).toContain('Name: TestBot');
      expect(result.files.identityMd).toContain('Name: TestBot');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('IDENTITY.md missing → --- IDENTITY --- section present but empty', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent\nTest agent.');

      const result = await loadWorkspace(tmpDir);
      expect(result.systemPrompt).toContain('--- IDENTITY ---');
      expect(result.files.identityMd).toBe('');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // migrateWorkspaceFiles tests
  // -------------------------------------------------------------------------
  it('migrateWorkspaceFiles: agent.md exists, AGENTS.md absent → renamed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-migrate-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'agent.md'), '# Agent');

      migrateWorkspaceFiles(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, 'agent.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toBe('# Agent');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('migrateWorkspaceFiles: both agent.md and AGENTS.md exist → lowercase removed, AGENTS.md kept', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-migrate-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'agent.md'), 'lowercase content');
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'UPPERCASE content');

      migrateWorkspaceFiles(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, 'agent.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toBe('UPPERCASE content');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('migrateWorkspaceFiles: all 6 lowercase files → all renamed to uppercase', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-migrate-'));
    try {
      const files = ['agent.md', 'soul.md', 'user.md', 'memory.md', 'heartbeat.md'];
      for (const f of files) {
        fs.writeFileSync(path.join(tmpDir, f), `content of ${f}`);
      }

      migrateWorkspaceFiles(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'SOUL.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'USER.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'MEMORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'HEARTBEAT.md'))).toBe(true);

      // No lowercase files remain
      for (const f of files) {
        expect(fs.existsSync(path.join(tmpDir, f))).toBe(false);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('migrateWorkspaceFiles: AGENTS.md already exists, no agent.md → no-op', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-migrate-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'already uppercase');

      migrateWorkspaceFiles(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toBe('already uppercase');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // watchWorkspace: auto-rename test
  // -------------------------------------------------------------------------
  it('watchWorkspace: adding lowercase soul.md → auto-renamed to SOUL.md + onChange fires', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-watch-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent');

      let changeCount = 0;
      const handle = watchWorkspace(tmpDir, () => { changeCount++; });

      try {
        // Wait for watcher to initialize
        await handle.ready;

        // Write a lowercase soul.md — watcher should auto-rename it
        fs.writeFileSync(path.join(tmpDir, 'soul.md'), '# Soul\nContent');

        // The rename happens synchronously in onAddSync (before the debounce),
        // but onChange/changeCount only fires after the debounce timer — poll
        // on changeCount, not on SOUL.md's existence, or this resolves too early.
        await waitFor(() => changeCount > 0, 5000);

        // onChange should have fired
        expect(changeCount).toBeGreaterThan(0);
        // soul.md should no longer exist (renamed)
        expect(fs.existsSync(path.join(tmpDir, 'soul.md'))).toBe(false);
        // SOUL.md should now exist
        expect(fs.existsSync(path.join(tmpDir, 'SOUL.md'))).toBe(true);
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // Self-restart footgun guard: agent-writable files skip busy-session restart
  // -------------------------------------------------------------------------
  it('AGENT_WRITABLE_FILES: contains the memory + identity + skill-learning tiers (incl. IDENTITY.md, SKILLS_LEARNED.md), not HEARTBEAT/CLAUDE', () => {
    // Memory-rule files the agent writes about itself/the user
    expect(AGENT_WRITABLE_FILES.has('MEMORY.md')).toBe(true);
    expect(AGENT_WRITABLE_FILES.has('USER.md')).toBe(true);
    // Operator identity composed into CLAUDE.md — deferred, never SIGKILLed idle
    expect(AGENT_WRITABLE_FILES.has('SOUL.md')).toBe(true);
    expect(AGENT_WRITABLE_FILES.has('AGENTS.md')).toBe(true);
    expect(AGENT_WRITABLE_FILES.has('IDENTITY.md')).toBe(true);
    // Skill-learning diary — also agent-self-authored, also deferred, never
    // SIGKILLed idle (issue that motivated this: a skill-learning auto-edit
    // triggered a `restart` tier that immediately killed an idle session, taking
    // its in-flight background sub-agents down with it).
    expect(AGENT_WRITABLE_FILES.has(DIARY_FILENAME)).toBe(true);
    expect(AGENT_WRITABLE_FILES.has('SKILLS_LEARNED.md')).toBe(true);
    // Files outside all tiers → still trigger a normal restart-or-defer
    expect(AGENT_WRITABLE_FILES.has('HEARTBEAT.md')).toBe(false);
    expect(AGENT_WRITABLE_FILES.has('CLAUDE.md')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Tiered writable sets: memory vs identity vs skill-learning (issue #321,
  // extended for the skill-learning tier)
  // -------------------------------------------------------------------------
  it('MEMORY_FILES/IDENTITY_FILES/SKILL_LEARNING_FILES: partition the writable set correctly', () => {
    expect([...MEMORY_FILES].sort()).toEqual(['MEMORY.md', 'USER.md']);
    expect([...IDENTITY_FILES].sort()).toEqual(['AGENTS.md', 'IDENTITY.md', 'SOUL.md']);
    expect([...SKILL_LEARNING_FILES]).toEqual([DIARY_FILENAME]);
    // The three tiers are pairwise disjoint and their union is exactly
    // AGENT_WRITABLE_FILES.
    for (const f of MEMORY_FILES) expect(IDENTITY_FILES.has(f)).toBe(false);
    for (const f of MEMORY_FILES) expect(SKILL_LEARNING_FILES.has(f)).toBe(false);
    for (const f of IDENTITY_FILES) expect(SKILL_LEARNING_FILES.has(f)).toBe(false);
    expect([...AGENT_WRITABLE_FILES].sort()).toEqual(
      [...MEMORY_FILES, ...IDENTITY_FILES, ...SKILL_LEARNING_FILES].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // classifyWorkspaceRestart — the change-class → restart-strategy decision
  // that fixes the memory-write session-drop bug (issue #321).
  // -------------------------------------------------------------------------
  it('classifyWorkspaceRestart: memory-only change restarts NOTHING (none)', () => {
    expect(classifyWorkspaceRestart(['MEMORY.md'])).toBe('none');
    expect(classifyWorkspaceRestart(['USER.md'])).toBe('none');
    expect(classifyWorkspaceRestart(['MEMORY.md', 'USER.md'])).toBe('none');
  });

  it('classifyWorkspaceRestart: identity change (or mixed with memory) defers idle', () => {
    expect(classifyWorkspaceRestart(['SOUL.md'])).toBe('defer-idle');
    expect(classifyWorkspaceRestart(['AGENTS.md'])).toBe('defer-idle');
    // IDENTITY.md is API-writable + composed into CLAUDE.md exactly like
    // SOUL/AGENTS, so it must defer idle sessions — not SIGKILL them (issue #321
    // follow-up: it was previously omitted from the identity tier).
    expect(classifyWorkspaceRestart(['IDENTITY.md'])).toBe('defer-idle');
    expect(classifyWorkspaceRestart(['SOUL.md', 'IDENTITY.md'])).toBe('defer-idle');
    // A mix of memory + identity is NOT memory-only → must not restart nothing;
    // identity presence pulls it into the deferred tier.
    expect(classifyWorkspaceRestart(['MEMORY.md', 'SOUL.md'])).toBe('defer-idle');
  });

  it('classifyWorkspaceRestart: REGRESSION — a skill-learning diary change (or mixed with memory/identity) defers idle, never restarts immediately', () => {
    // Before this fix, SKILLS_LEARNED.md was outside every safe tier, so an
    // auto skill-create/update write fell through to the aggressive `restart`
    // action — which SIGKILLs any session that isn't mid-turn right now,
    // including one that's idle only because it just dispatched a background
    // Agent/Workflow sub-agent and is waiting on it.
    expect(classifyWorkspaceRestart([DIARY_FILENAME])).toBe('defer-idle');
    expect(classifyWorkspaceRestart(['SKILLS_LEARNED.md'])).toBe('defer-idle');
    expect(classifyWorkspaceRestart(['SKILLS_LEARNED.md', 'MEMORY.md'])).toBe('defer-idle');
    expect(classifyWorkspaceRestart(['SKILLS_LEARNED.md', 'SOUL.md'])).toBe('defer-idle');
  });

  it('classifyWorkspaceRestart: non-writable or empty change → normal restart', () => {
    expect(classifyWorkspaceRestart(['HEARTBEAT.md'])).toBe('restart');
    expect(classifyWorkspaceRestart(['MEMORY.md', 'HEARTBEAT.md'])).toBe('restart');
    expect(classifyWorkspaceRestart([])).toBe('restart');
  });

  it('watchWorkspace: onChange receives canonical changed filename (MEMORY.md)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-watch-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent');
      fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), 'initial');

      const batches: string[][] = [];
      const handle = watchWorkspace(tmpDir, (changed) => { batches.push(changed); });

      try {
        await handle.ready;
        fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), 'updated by agent');
        await waitFor(() => batches.flat().includes('MEMORY.md'), 5000);

        const all = batches.flat();
        expect(all).toContain('MEMORY.md');
        // self-written-only change → every changed file is agent-writable
        expect(all.every((f) => AGENT_WRITABLE_FILES.has(f))).toBe(true);
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('watchWorkspace: a lowercase memory.md write reaches classify() as MEMORY.md → none (end-to-end)', async () => {
    // Guards the full path: a lowercase alias write must be canonicalized to
    // MEMORY.md before classifyWorkspaceRestart sees it, so it classifies 'none'
    // (restart nothing) — not mis-routed to 'restart' because 'memory.md' is not
    // a MEMORY_FILES member. Proves the two halves (canonicalize + classify)
    // compose correctly through the real watcher.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-lc-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent');

      const batches: string[][] = [];
      const handle = watchWorkspace(tmpDir, (changed) => { batches.push(changed); });

      try {
        await handle.ready;
        // Lowercase alias write — the watcher auto-renames to MEMORY.md.
        fs.writeFileSync(path.join(tmpDir, 'memory.md'), 'a fact the agent learned');
        await waitFor(() => batches.flat().includes('MEMORY.md'), 5000);

        const changed = batches.flat();
        // Canonicalized, not the raw lowercase name.
        expect(changed).toContain('MEMORY.md');
        expect(changed).not.toContain('memory.md');
        // And the canonical batch classifies as a memory-only change (no restart).
        expect(classifyWorkspaceRestart(changed)).toBe('none');
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // U-WL-WATCH-DEPTH: watcher must NOT recurse into workspace subdirectories.
  // Regression guard for the inotify ENOSPC fan-out: chokidar with no depth
  // limit descended into .telegram-state/.discord-state and spawned one
  // watcher per nested dir across every agent, exhausting fs.inotify limits
  // and crashing the gateway. depth:0 means only top-level *.md is watched.
  // -------------------------------------------------------------------------
  it('watchWorkspace: does NOT fire for changes inside subdirectories (depth:0, no fan-out)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-depth-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent');
      // Mirror the real layout that caused the ENOSPC fan-out.
      const typingDir = path.join(tmpDir, '.telegram-state', 'typing');
      fs.mkdirSync(typingDir, { recursive: true });
      fs.writeFileSync(path.join(typingDir, 'chat.json'), 'initial');

      const batches: string[][] = [];
      const handle = watchWorkspace(tmpDir, (changed) => { batches.push(changed); });

      try {
        await handle.ready;

        // Churn deep inside .telegram-state — must be invisible to the watcher.
        fs.writeFileSync(path.join(typingDir, 'chat.json'), 'updated');
        fs.writeFileSync(path.join(typingDir, 'new.json'), 'new');
        // Absence assertion — no observable positive condition to poll for,
        // so this stays a fixed wait (safe direction: only risk is a false pass).
        await new Promise((r) => setTimeout(r, 1200));
        expect(batches.flat()).toHaveLength(0);

        // Sanity: top-level *.md still fires, so the watcher is alive.
        fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), 'top-level change');
        await waitFor(() => batches.flat().includes('MEMORY.md'), 5000);
        expect(batches.flat()).toContain('MEMORY.md');
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // U-WL-WATCH-DOTFILE: chokidar's `*.md` glob DOES match leading-dot files,
  // so the `ignored` dot-prefix branch is load-bearing (NOT redundant with
  // depth:0): without it a top-level `.foo.md` would spuriously trigger a
  // workspace reload. Guards against anyone "simplifying" the branch away.
  // -------------------------------------------------------------------------
  it('watchWorkspace: top-level dot-prefixed .md is ignored (no spurious reload)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-dotfile-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent');

      const batches: string[][] = [];
      const handle = watchWorkspace(tmpDir, (changed) => { batches.push(changed); });

      try {
        await handle.ready;

        // A top-level dotfile that the *.md glob matches — must be ignored.
        fs.writeFileSync(path.join(tmpDir, '.scratch.md'), 'noise');
        // Absence assertion — no observable positive condition to poll for,
        // so this stays a fixed wait (safe direction: only risk is a false pass).
        await new Promise((r) => setTimeout(r, 1000));
        expect(batches.flat()).toHaveLength(0);

        // Sanity: a normal top-level *.md still fires.
        fs.writeFileSync(path.join(tmpDir, 'USER.md'), 'real change');
        await waitFor(() => batches.flat().includes('USER.md'), 5000);
        expect(batches.flat()).toContain('USER.md');
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
