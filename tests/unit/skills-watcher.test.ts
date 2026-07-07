/**
 * Tests for src/skills/watcher.ts — Skill file watcher (hot-reload)
 * W1: Adding SKILL.md → onChange fires
 * W2: Deleting SKILL.md → onChange fires
 * W3: Modifying SKILL.md → onChange fires
 * W4: Multiple rapid changes → debounced to single call
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { watchSkills } from '../../src/skills/watcher';

let tmpDir: string;
let skillsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-watcher-'));
  skillsDir = path.join(tmpDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SKILL_CONTENT = `---
name: test-skill
description: A test skill
---

Test instructions
`;

// Use default inotify (no polling) — inotify is event-driven and not affected by CPU load.
// usePolling is unreliable under parallel test load since setInterval gets starved.
const TEST_CHOKIDAR_OPTS = {};

function writeSkillFile(name: string): void {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_CONTENT);
}

function deleteSkillFile(name: string): void {
  fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
}

function modifySkillFile(name: string): void {
  const file = path.join(skillsDir, name, 'SKILL.md');
  fs.writeFileSync(file, SKILL_CONTENT + '\nModified!');
}

async function pollUntil(condition: () => boolean, intervalMs = 50, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

describe('Skill File Watcher', () => {
  test('W1: detects new SKILL.md file', async () => {
    let callCount = 0;
    const watcher = watchSkills({
      dirs: [skillsDir],
      onChange: () => { callCount++; },
      debounceMs: 50,
      chokidarOpts: TEST_CHOKIDAR_OPTS,
    });

    await watcher.ready;
    writeSkillFile('new-skill');
    await pollUntil(() => callCount >= 1);

    await watcher.close();
    expect(callCount).toBeGreaterThanOrEqual(1);
  }, 12000);

  test('W2: detects SKILL.md deletion', async () => {
    writeSkillFile('to-delete');

    let callCount = 0;
    const watcher = watchSkills({
      dirs: [skillsDir],
      onChange: () => { callCount++; },
      debounceMs: 50,
      chokidarOpts: TEST_CHOKIDAR_OPTS,
    });

    await watcher.ready;
    deleteSkillFile('to-delete');
    await pollUntil(() => callCount >= 1);

    await watcher.close();
    expect(callCount).toBeGreaterThanOrEqual(1);
  }, 12000);

  test('W3: detects SKILL.md modification', async () => {
    writeSkillFile('to-modify');

    let callCount = 0;
    const watcher = watchSkills({
      dirs: [skillsDir],
      onChange: () => { callCount++; },
      debounceMs: 50,
      chokidarOpts: TEST_CHOKIDAR_OPTS,
    });

    await watcher.ready;
    modifySkillFile('to-modify');
    await pollUntil(() => callCount >= 1);

    await watcher.close();
    expect(callCount).toBeGreaterThanOrEqual(1);
  }, 12000);

  test('W4: debounces multiple rapid changes into fewer calls', async () => {
    let callCount = 0;
    const debounceMs = 200;
    const watcher = watchSkills({
      dirs: [skillsDir],
      onChange: () => { callCount++; },
      debounceMs,
      chokidarOpts: TEST_CHOKIDAR_OPTS,
    });

    await watcher.ready;

    for (let i = 0; i < 5; i++) {
      writeSkillFile(`rapid-${i}`);
    }

    // Wait for at least one call, then let the debounce window fully settle
    // before asserting the upper bound — scaled off debounceMs rather than a
    // hardcoded constant, so it doesn't go stale if debounceMs changes.
    await pollUntil(() => callCount >= 1);
    await new Promise((r) => setTimeout(r, debounceMs * 2));

    await watcher.close();
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(3);
  }, 12000);

  test('returns no-op handle for empty dirs', async () => {
    const watcher = watchSkills({
      dirs: [],
      onChange: () => {},
    });
    await watcher.close();
  });
});
