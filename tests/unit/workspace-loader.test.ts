import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  loadWorkspace,
  deleteBootstrap,
  markBootstrapComplete,
  migrateWorkspaceFiles,
  watchWorkspace,
  MissingRequiredFileError,
} from '../../src/workspace-loader';

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
    expect(result.files.toolsMd).toContain('Tools');
    expect(result.files.userMd).toContain('User Profile');
    expect(result.files.heartbeatMd).toContain('morning-brief');
    expect(result.files.memoryMd).toContain('Memory');
    expect(result.files.bootstrapMd).toContain('Bootstrap');
  });

  // -------------------------------------------------------------------------
  // U-WL-02: Missing optional file (BOOTSTRAP.md)
  // -------------------------------------------------------------------------
  it('U-WL-02: missing optional BOOTSTRAP.md does not throw', async () => {
    const result = await loadWorkspace(path.join(FIXTURES, 'valid-no-bootstrap'));
    expect(result.files.bootstrapMd).toBeNull();
    expect(result.systemPrompt).toBeTruthy();
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
    const result = await loadWorkspace(path.join(FIXTURES, 'oversized'));
    // MEMORY.md has 25,000+ chars — should be truncated
    expect(result.files.memoryMd.length).toBeLessThanOrEqual(20_000 + 60); // +marker length
    expect(result.files.memoryMd).toContain('[TRUNCATED');
    expect(result.truncated).toBe(true);
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
      fs.writeFileSync(path.join(tmpDir, 'TOOLS.md'), 'T'.repeat(25_000));
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

    const agentIdx = prompt.indexOf('--- AGENT IDENTITY ---');
    const identityIdx = prompt.indexOf('--- IDENTITY ---');
    const soulIdx = prompt.indexOf('--- SOUL ---');
    const userIdx = prompt.indexOf('--- USER PROFILE ---');
    const toolsIdx = prompt.indexOf('--- AVAILABLE TOOLS ---');
    const memoryIdx = prompt.indexOf('--- LONG-TERM MEMORY ---');
    const heartbeatIdx = prompt.indexOf('--- HEARTBEAT CONFIG ---');

    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(identityIdx).toBeGreaterThan(agentIdx);
    expect(soulIdx).toBeGreaterThan(identityIdx);
    expect(userIdx).toBeGreaterThan(soulIdx);
    expect(toolsIdx).toBeGreaterThan(userIdx);
    expect(memoryIdx).toBeGreaterThan(toolsIdx);
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
    expect(result.systemPrompt).toContain('--- AVAILABLE TOOLS ---');
    expect(result.systemPrompt).toContain('--- LONG-TERM MEMORY ---');
    expect(result.systemPrompt).toContain('--- HEARTBEAT CONFIG ---');
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
  // U-WL-09: isFirstRun = true when BOOTSTRAP.md exists
  // -------------------------------------------------------------------------
  it('U-WL-09: sets isFirstRun=true when BOOTSTRAP.md exists', async () => {
    const result = await loadWorkspace(path.join(FIXTURES, 'valid-full'));
    expect(result.files.isFirstRun).toBe(true);
    expect(result.files.bootstrapMd).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // U-WL-10: isFirstRun = false when BOOTSTRAP.md absent
  // -------------------------------------------------------------------------
  it('U-WL-10: sets isFirstRun=false when BOOTSTRAP.md is absent', async () => {
    const result = await loadWorkspace(path.join(FIXTURES, 'valid-no-bootstrap'));
    expect(result.files.isFirstRun).toBe(false);
    expect(result.files.bootstrapMd).toBeNull();
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
  // deleteBootstrap helper
  // -------------------------------------------------------------------------
  it('deleteBootstrap removes BOOTSTRAP.md from disk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent');
      fs.writeFileSync(path.join(tmpDir, 'BOOTSTRAP.md'), '# Bootstrap');

      expect(fs.existsSync(path.join(tmpDir, 'BOOTSTRAP.md'))).toBe(true);
      await deleteBootstrap(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, 'BOOTSTRAP.md'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('deleteBootstrap is idempotent when BOOTSTRAP.md does not exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
    try {
      // Should not throw even if file is absent
      await expect(deleteBootstrap(tmpDir)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // markBootstrapComplete
  // -------------------------------------------------------------------------
  it('markBootstrapComplete renames BOOTSTRAP.md → BOOTSTRAP.md.done', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent');
      fs.writeFileSync(path.join(tmpDir, 'BOOTSTRAP.md'), '# Bootstrap');

      await markBootstrapComplete(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, 'BOOTSTRAP.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'BOOTSTRAP.md.done'))).toBe(true);
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

  it('migrateWorkspaceFiles: all 8 lowercase files → all renamed to uppercase', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-migrate-'));
    try {
      const files = ['agent.md', 'soul.md', 'user.md', 'tools.md', 'memory.md', 'heartbeat.md', 'bootstrap.md', 'bootstrap.md.done'];
      for (const f of files) {
        fs.writeFileSync(path.join(tmpDir, f), `content of ${f}`);
      }

      migrateWorkspaceFiles(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'SOUL.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'USER.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'TOOLS.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'MEMORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'HEARTBEAT.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'BOOTSTRAP.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'BOOTSTRAP.md.done'))).toBe(true);

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
        await new Promise((r) => setTimeout(r, 100));

        // Write a lowercase soul.md — watcher should auto-rename it
        fs.writeFileSync(path.join(tmpDir, 'soul.md'), '# Soul\nContent');

        // Wait for debounce + rename (300ms debounce + buffer)
        await new Promise((r) => setTimeout(r, 700));

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
});
