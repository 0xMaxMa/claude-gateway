/**
 * update-agent: Interactive CLI to update an existing agent's agent.md with Claude.
 *
 * Steps:
 *  1. Select agent (from config.json)
 *  2. Claude reads current agent.md and generates updated version
 *  3. Preview + confirm (y/edit/n)
 *  4. Save agent.md + regenerate CLAUDE.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { loadWorkspace } from '../src/workspace-loader';
import { buildUpdatePrompt } from './create-agent-prompts';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function gatewayDir(): string {
  return path.join(os.homedir(), '.claude-gateway');
}

function configPath(): string {
  const envPath = process.env['GATEWAY_CONFIG'];
  if (envPath) return expandHome(envPath);
  return path.join(gatewayDir(), 'config.json');
}

function workspaceDir(agentId: string): string {
  return path.join(gatewayDir(), 'agents', agentId, 'workspace');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface RawAgentEntry {
  id: string;
  description: string;
  workspace: string;
}

interface RawConfig {
  gateway: { logDir: string; timezone: string };
  agents: RawAgentEntry[];
}

function loadOrCreateRawConfig(): RawConfig {
  const cp = configPath();
  if (fs.existsSync(cp)) {
    const raw = fs.readFileSync(cp, 'utf8');
    return JSON.parse(raw) as RawConfig;
  }
  return {
    gateway: { logDir: '~/.claude-gateway/logs', timezone: 'UTC' },
    agents: [],
  };
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Preview helper
// ---------------------------------------------------------------------------

const SEPARATOR_WIDTH = 42;

function printFilePreview(filename: string, content: string): void {
  const label = `─── ${filename} `;
  const padding = Math.max(0, SEPARATOR_WIDTH - label.length);
  console.log('\n' + label + '─'.repeat(padding));
  console.log(content);
  console.log('─'.repeat(SEPARATOR_WIDTH));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════');
  console.log('  Claude Gateway — Update Agent');
  console.log('═══════════════════════════════════════\n');

  // Step 1 — Select agent
  const config = loadOrCreateRawConfig();
  if (config.agents.length === 0) {
    console.error('No agents found in config.json. Run "make create-agent" first.');
    process.exit(1);
  }

  let agentId: string;

  if (config.agents.length === 1) {
    agentId = config.agents[0].id;
    console.log(`Using agent: ${agentId}\n`);
  } else {
    console.log('Select an agent to update:\n');
    config.agents.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.id}${a.description ? '  — ' + a.description : ''}`);
    });
    console.log('');

    const rlSelect = createRl();
    let selected: RawAgentEntry | undefined;

    while (!selected) {
      const answer = await prompt(rlSelect, `Enter number (1-${config.agents.length}): `);
      const num = parseInt(answer.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= config.agents.length) {
        selected = config.agents[num - 1];
      } else {
        console.log(`  Please enter a number between 1 and ${config.agents.length}.`);
      }
    }
    rlSelect.close();
    agentId = selected.id;
    console.log('');
  }

  // Resolve workspace dir
  const wsDir = workspaceDir(agentId);
  const agentMdPath = path.join(wsDir, 'agent.md');

  if (!fs.existsSync(agentMdPath)) {
    console.error(`Error: agent.md not found at ${agentMdPath}`);
    console.error('The agent workspace may be missing or incomplete.');
    process.exit(1);
  }

  const currentContent = fs.readFileSync(agentMdPath, 'utf8');
  const agentName = agentId.charAt(0).toUpperCase() + agentId.slice(1);

  // Step 2 — Claude generates updated content
  console.log('Generating updated agent.md with Claude...');
  const updatePrompt = buildUpdatePrompt(agentName, currentContent);

  const result = spawnSync('claude', ['--print'], {
    input: updatePrompt,
    encoding: 'utf8',
    timeout: 60000,
  });

  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    console.error('\nError: Claude generation failed.');
    if (result.error) {
      console.error(`  ${result.error.message}`);
    } else if (result.stderr?.trim()) {
      console.error(`  ${result.stderr.trim()}`);
    } else {
      console.error('  Claude exited with status', result.status);
    }
    process.exit(1);
  }

  let newContent = result.stdout.trim();

  // Step 3 — Preview + confirm loop
  const rl = createRl();

  printFilePreview('agent.md (updated)', newContent);
  console.log('\n  Warning: accepting will overwrite the existing agent.md');

  while (true) {
    const answer = await prompt(rl, '\nAccept? (y/edit/n) [y]: ');
    const choice = answer.trim().toLowerCase() || 'y';

    if (choice === 'y' || choice === 'yes') {
      break;
    } else if (choice === 'edit') {
      const tmpFile = path.join(os.tmpdir(), `claude-gateway-agent.md`);
      fs.writeFileSync(tmpFile, newContent, 'utf8');

      const editorCandidates = [
        process.env['VISUAL'],
        process.env['EDITOR'],
        'vim',
        'vi',
        'nano',
      ].filter(Boolean) as string[];

      let editResult: ReturnType<typeof spawnSync> | null = null;
      let usedEditor = '';
      for (const candidate of editorCandidates) {
        const r = spawnSync(candidate, [tmpFile], { stdio: 'inherit' });
        if (!r.error) {
          editResult = r;
          usedEditor = candidate;
          break;
        }
      }

      if (!editResult) {
        console.log(
          '  Could not open any editor (tried: ' +
            editorCandidates.join(', ') +
            ').\n  Set $EDITOR and try again, or choose y/n.'
        );
        fs.unlinkSync(tmpFile);
        // Loop continues — re-prompt
      } else {
        newContent = fs.readFileSync(tmpFile, 'utf8');
        fs.unlinkSync(tmpFile);
        printFilePreview('agent.md (edited)', newContent);
        console.log(`  (edited with ${usedEditor})`);
        // Loop continues — re-prompt for final accept
      }
    } else if (choice === 'n' || choice === 'no') {
      console.log('\nCancelled. No changes made.');
      rl.close();
      process.exit(0);
    } else {
      console.log('  Please enter y, edit, or n.');
    }
  }

  rl.close();

  // Step 4 — Save agent.md
  fs.writeFileSync(agentMdPath, newContent, 'utf8');
  console.log('\n  ✓ agent.md saved');

  // Regenerate CLAUDE.md
  try {
    const loaded = await loadWorkspace(wsDir);
    fs.writeFileSync(path.join(wsDir, 'CLAUDE.md'), loaded.systemPrompt, 'utf8');
    console.log('  ✓ CLAUDE.md regenerated');
  } catch (err) {
    console.log(`  Warning: Could not regenerate CLAUDE.md: ${(err as Error).message}`);
  }

  // Summary
  const displayWsDir = wsDir.replace(os.homedir(), '~');
  console.log('\n═══════════════════════════════════════');
  console.log(`  ✓ Agent "${agentId}" updated!`);
  console.log('═══════════════════════════════════════\n');
  console.log(`Workspace:  ${displayWsDir}/`);
  console.log('\nTo apply changes, restart the gateway.');
}

main().catch((err) => {
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
});
