/**
 * disable_archive (#609): an app agent that keeps its own per-tenant memory
 * files (memory/family-<id>.md) can turn the searchable archive off. Without
 * the switch the archive is one index over every tenant's file, so a search
 * made while serving one family returns another family's notes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { indexAgentArchive, archiveDbPath } from '../../src/agent/knowledge/indexer';
import { ArchiveDB } from '../../src/agent/knowledge/archive-db';
import { loadWorkspace } from '../../src/agent/workspace-loader';

let workspace: string;

beforeEach(() => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disable-archive-'));
  workspace = path.join(agentDir, 'workspace');
  fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent: family-bot\nOne memory file per family.');
  // Over budget, so core-shrink would swap MEMORY.md for an index that points at memory_search.
  fs.writeFileSync(path.join(workspace, 'MEMORY.md'), Array.from({ length: 200 }, (_, i) => `## Section ${i}\n- fact ${i}`).join('\n'));
  // Two conversations, each writing to its own tenant file.
  fs.writeFileSync(path.join(workspace, 'memory', 'family-a.md'), '# Family A\n- Family A bank account ends 4321');
  fs.writeFileSync(path.join(workspace, 'memory', 'family-b.md'), '# Family B\n- Family B kid allergic to peanuts');
});

afterEach(() => {
  ArchiveDB.evict(archiveDbPath(workspace));
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
});

describe('regression baseline: the archive has no tenant boundary', () => {
  it("indexes every tenant's memory file into one kb.sqlite that any conversation can search", () => {
    indexAgentArchive(workspace);
    expect(fs.existsSync(archiveDbPath(workspace))).toBe(true);
    const db = ArchiveDB.forPath(archiveDbPath(workspace));
    // A search made while serving family B returns family A's note, and vice versa.
    expect(db.search('bank account').map(hit => hit.path)).toContain('memory/family-a.md');
    expect(db.search('peanuts').map(hit => hit.path)).toContain('memory/family-b.md');
  });
});

describe('loadWorkspace disableArchive', () => {
  const budget = { memoryBudgetChars: 500, writeRouting: true };

  it('without the switch, CLAUDE.md points the agent at memory_search', async () => {
    const { systemPrompt } = await loadWorkspace(workspace, { coreShrink: true, memoryBudget: budget });
    expect(systemPrompt).toContain('--- MEMORY RETRIEVAL ---');
    expect(systemPrompt).toContain('memory_search');
  });

  it('never mentions memory_search/memory_get, even when the archive config is on', async () => {
    const { systemPrompt } = await loadWorkspace(workspace, { coreShrink: true, disableArchive: true, memoryBudget: budget });
    expect(systemPrompt).not.toContain('--- MEMORY RETRIEVAL ---');
    expect(systemPrompt).not.toContain('memory_search');
    expect(systemPrompt).not.toContain('memory_get');
    expect(systemPrompt).not.toContain('Memory Tiers');
    // The shared memory stays in the prompt: disableArchive does not imply isolateMemory.
    expect(systemPrompt).toContain('--- LONG-TERM MEMORY ---');
    expect(systemPrompt).toContain('--- USER PROFILE ---');
    expect(systemPrompt).toContain('fact 0');
  });
});
