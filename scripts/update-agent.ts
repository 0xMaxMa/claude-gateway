/**
 * update-agent: CLI to update an existing agent's agent.md or manage channels.
 *
 * After selecting an agent, user chooses:
 *  a) Update agent.md — Claude regenerates it
 *  b) Manage channels — add / remove Telegram, Discord, etc.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { loadWorkspace } from '../src/agent/workspace-loader';
import { buildUpdatePrompt } from './create-agent-prompts';
import {
  expandHome,
  printFilePreview,
  promptBotToken,
  appendToConfig,
  verifyDiscordBotToken,
  DISCORD_TOKEN_REGEX,
} from './create-agent';
import { interactiveSelect } from './interactive-select';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentEntry {
  id: string;
  workspace: string;
  signatureEmoji?: string;
  telegram?: { botToken: string; allowedUsers?: number[]; dmPolicy?: string };
  discord?: { botToken: string };
  [key: string]: unknown;
}

export interface GatewayConfig {
  agents: AgentEntry[];
  [key: string]: unknown;
}

export type ChannelId = 'telegram' | 'discord';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function gatewayDir(): string {
  return path.join(os.homedir(), '.claude-gateway');
}

function configPath(): string {
  const envPath = process.env['GATEWAY_CONFIG'];
  if (envPath) return expandHome(envPath);
  return path.join(gatewayDir(), 'config.json');
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function loadConfig(): GatewayConfig {
  const cp = configPath();
  try {
    return JSON.parse(fs.readFileSync(cp, 'utf8')) as GatewayConfig;
  } catch (err) {
    console.error(`Cannot read config at ${cp}: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function findAgent(config: GatewayConfig, agentId: string): AgentEntry | undefined {
  return config.agents.find((a) => a.id === agentId);
}

function saveConfig(config: GatewayConfig): void {
  const cp = configPath();
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, JSON.stringify(config, null, 2), 'utf8');
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
    rl.question(question, resolve);
  });
}

// ---------------------------------------------------------------------------
// Agent selection
// ---------------------------------------------------------------------------

async function selectAgent(): Promise<{ agentId: string; wsDir: string; agent: AgentEntry; config: GatewayConfig }> {
  const config = loadConfig();
  const agents = config.agents;

  if (agents.length === 0) {
    console.error('No agents found in config.json. Run "make create-agent" first.');
    process.exit(1);
  }

  const selected = await interactiveSelect(
    agents.map((a) => a.id),
    'Select an agent (↑/↓ to move, Enter to select):'
  );
  const agent = agents[selected];
  const wsDir = expandHome(agent.workspace);
  console.log(`\n  Selected: ${agent.id}\n`);
  return { agentId: agent.id, wsDir, agent, config };
}

// ---------------------------------------------------------------------------
// Update agent.md helpers
// ---------------------------------------------------------------------------

function generateUpdatedAgent(agentId: string, currentContent: string): string | null {
  const agentName = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  console.log('\nGenerating updated agent.md with Claude...');

  const updatePrompt = buildUpdatePrompt(agentName, currentContent);
  const result = spawnSync('claude', ['--print'], {
    input: updatePrompt,
    encoding: 'utf8',
    timeout: 60000,
  });

  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    console.error('  Error: Claude generation failed.');
    if (result.stderr) console.error(result.stderr);
    return null;
  }

  let raw = result.stdout.trim();

  const fenceMatch = raw.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) raw = fenceMatch[1].trim();

  const yamlStart = raw.indexOf('---\n');
  const headingStart = raw.indexOf('# ');
  const start = yamlStart >= 0 ? yamlStart : headingStart;
  if (start < 0) {
    console.error('  Error: Could not parse agent.md from Claude output.');
    return null;
  }
  return raw.slice(start).replace(/\n```\s*$/, '').trim();
}

async function confirmAndSave(
  rl: readline.Interface,
  _agentMdPath: string,
  initialContent: string
): Promise<string | null> {
  let currentContent = initialContent;

  while (true) {
    const answer = await prompt(rl, 'Accept? (y/edit/n) [y]: ');
    const choice = answer.trim().toLowerCase() || 'y';

    if (choice === 'y' || choice === 'yes') return currentContent;
    if (choice === 'n' || choice === 'no') {
      console.log('  Cancelled. No changes made.');
      return null;
    }
    if (choice === 'edit') {
      const tmpFile = path.join(os.tmpdir(), 'claude-gateway-agent.md');
      fs.writeFileSync(tmpFile, currentContent, 'utf8');

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
        const result = spawnSync(candidate, [tmpFile], { stdio: 'inherit' });
        if (!result.error) {
          editResult = result;
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
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } else {
        const edited = fs.readFileSync(tmpFile, 'utf8');
        fs.unlinkSync(tmpFile);
        currentContent = edited;
        printFilePreview('AGENTS.md', currentContent);
        console.log(`  (edited with ${usedEditor})`);
      }
    } else {
      console.log('  Please enter y, edit, or n.');
    }
  }
}

// ---------------------------------------------------------------------------
// Channel management
// ---------------------------------------------------------------------------

const SUPPORTED_CHANNELS = [
  { id: 'telegram' as ChannelId, label: 'Telegram' },
  { id: 'discord' as ChannelId, label: 'Discord' },
];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function detectConnectedChannels(agent: AgentEntry): ChannelId[] {
  const connected: ChannelId[] = [];
  const workspace = expandHome(agent.workspace);

  if (agent.telegram?.botToken) {
    connected.push('telegram');
  } else if (fs.existsSync(path.join(workspace, '.telegram-state', '.env'))) {
    connected.push('telegram');
  }

  if (agent.discord?.botToken) {
    connected.push('discord');
  } else if (fs.existsSync(path.join(workspace, '.discord-state', '.env'))) {
    connected.push('discord');
  }

  return connected;
}

export function removeChannel(config: GatewayConfig, agent: AgentEntry, channel: ChannelId): void {
  const stateDir = path.join(expandHome(agent.workspace), `.${channel}-state`);
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {}

  const agentEnvFile = path.join(gatewayDir(), 'agents', agent.id, '.env');
  try {
    const prefix =
      channel === 'telegram'
        ? agent.id.toUpperCase().replace(/-/g, '_') + '_BOT_TOKEN='
        : agent.id.toUpperCase().replace(/-/g, '_') + '_DISCORD_BOT_TOKEN=';
    const filtered = fs.readFileSync(agentEnvFile, 'utf8').split('\n').filter((l) => !l.startsWith(prefix));
    fs.writeFileSync(agentEnvFile, filtered.join('\n'), { mode: 0o600 });
  } catch {}

  const idx = config.agents.findIndex((a) => a.id === agent.id);
  if (idx >= 0) delete config.agents[idx][channel];

  saveConfig(config);
  console.log(`  ✓ ${capitalize(channel)} removed from agent "${agent.id}"`);
}

function readAgentsMd(wsDir: string): string {
  try {
    return fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8');
  } catch {
    return '';
  }
}

async function setupChannel(agent: AgentEntry, channel: ChannelId, config: GatewayConfig): Promise<void> {
  const wsDir = expandHome(agent.workspace);
  const rl2 = createRl();

  if (channel === 'telegram') {
    console.log('Setting up Telegram:\n');
    console.log('  1. Open Telegram and search for @BotFather');
    console.log('  2. Send: /newbot, follow prompts, copy the token.\n');
    const { token } = await promptBotToken(rl2, agent.id);
    rl2.close();
    await appendToConfig(agent.id, wsDir, readAgentsMd(wsDir), { channel: 'telegram', token });
    console.log(`  ✓ Telegram configured for agent "${agent.id}"`);
    console.log(`  Run: make pair agent=${agent.id} code=<code>`);
  } else {
    console.log('Setting up Discord:\n');
    console.log('  1. Go to https://discord.com/developers/applications');
    console.log('  2. Create/select app → Bot → Enable MESSAGE CONTENT INTENT → Copy token.\n');

    let token = '';
    let username = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await new Promise<string>((resolve) => rl2.question('Discord bot token: ', resolve));
      const t = raw.trim();
      if (!DISCORD_TOKEN_REGEX.test(t)) {
        console.log('  Invalid token format.');
        continue;
      }
      process.stdout.write('  Verifying...');
      const { ok, username: u } = await verifyDiscordBotToken(t);
      process.stdout.write('\r              \r');
      if (ok) {
        token = t;
        username = u;
        break;
      }
      console.log(`  Verification failed. ${3 - attempt} attempt(s) remaining.`);
    }
    rl2.close();
    if (!token) {
      console.error('Could not verify Discord token. Aborting.');
      process.exit(1);
    }
    console.log(`  ✓ Bot @${username} verified`);

    const discordEnvVar = agent.id.toUpperCase().replace(/-/g, '_') + '_DISCORD_BOT_TOKEN';
    const agentEnvFile = path.join(gatewayDir(), 'agents', agent.id, '.env');
    fs.mkdirSync(path.dirname(agentEnvFile), { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(agentEnvFile, 'utf8');
    } catch {}
    if (!existing.includes(`${discordEnvVar}=`)) {
      fs.appendFileSync(agentEnvFile, `${discordEnvVar}=${token}\n`, { mode: 0o600 });
    }

    await appendToConfig(agent.id, wsDir, readAgentsMd(wsDir), { channel: 'discord', token });
    console.log(`  ✓ Discord configured for agent "${agent.id}"`);
    console.log(`  Run: make pair agent=${agent.id} code=<code> channel=discord`);
  }
}

export async function runMenu(agentId: string): Promise<void> {
  const config = loadConfig();
  const agent = findAgent(config, agentId);

  if (!agent) {
    console.error(`Agent "${agentId}" not found in config`);
    console.error(`Available: ${config.agents.map((a) => a.id).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const rl = createRl();

  while (true) {
    const connected = detectConnectedChannels(agent);
    const connectedLabels = connected.map((c) => `${capitalize(c)} ✓`).join(', ') || '(none)';

    console.log('\n═══════════════════════════════════════');
    console.log(`  Agent: ${agent.id}  (connected: ${connectedLabels})`);
    console.log('═══════════════════════════════════════\n');
    console.log('  1) Add a channel');
    console.log('  2) Remove a channel');
    console.log('  3) Exit\n');

    const choice = (await prompt(rl, 'Choose (1-3): ')).trim();

    if (choice === '3' || choice.toLowerCase() === 'exit') {
      console.log('Done.');
      rl.close();
      return;
    }

    if (choice === '1') {
      const available = SUPPORTED_CHANNELS.filter((c) => !connected.includes(c.id));
      if (available.length === 0) {
        console.log('\n  All supported channels are already connected.');
        continue;
      }
      console.log('\nAvailable channels to add:');
      available.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
      const sel = (await prompt(rl, 'Choose channel: ')).trim();
      const chIdx = parseInt(sel, 10) - 1;
      if (chIdx < 0 || chIdx >= available.length) {
        console.log('  Invalid choice.');
        continue;
      }
      rl.close();
      console.log(`\nSetting up ${available[chIdx].label}...\n`);
      await setupChannel(agent, available[chIdx].id, config);
      return;
    }

    if (choice === '2') {
      if (connected.length === 0) {
        console.log('\n  No channels connected.');
        continue;
      }
      console.log('\nConnected channels:');
      connected.forEach((c, i) => console.log(`  ${i + 1}) ${capitalize(c)}`));
      const sel = (await prompt(rl, 'Choose channel to remove: ')).trim();
      const chIdx = parseInt(sel, 10) - 1;
      if (chIdx < 0 || chIdx >= connected.length) {
        console.log('  Invalid choice.');
        continue;
      }
      const ch = connected[chIdx];
      const confirm = (
        await prompt(rl, `  Remove ${capitalize(ch)} from "${agent.id}"? This will delete .${ch}-state/ (y/N): `)
      )
        .trim()
        .toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') {
        console.log('  Cancelled.');
        continue;
      }
      const freshConfig = loadConfig();
      const freshAgent = findAgent(freshConfig, agentId)!;
      removeChannel(freshConfig, freshAgent, ch);
      Object.assign(agent, freshAgent);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════');
  console.log('  Claude Gateway — Update Agent');
  console.log('═══════════════════════════════════════\n');

  const { agentId, wsDir, agent, config } = await selectAgent();

  process.stdin.resume();
  const actionIdx = await interactiveSelect(
    ['Manage channels', 'Regenerate agent.md'],
    'What would you like to do? (↑/↓ to move, Enter to select):'
  );

  if (actionIdx === 0) {
    await runMenu(agentId);
    return;
  }

  process.stdin.resume();
  const rl = createRl();

  const agentMdPath = path.join(wsDir, 'AGENTS.md');
  if (!fs.existsSync(agentMdPath)) {
    console.error(`  Error: AGENTS.md not found at ${agentMdPath}`);
    rl.close();
    process.exit(1);
  }

  const currentContent = fs.readFileSync(agentMdPath, 'utf8');
  const newContent = generateUpdatedAgent(agentId, currentContent);
  if (!newContent) {
    rl.close();
    process.exit(1);
  }

  printFilePreview('AGENTS.md', newContent);
  console.log('\n  Warning: this will overwrite the existing AGENTS.md');

  const finalContent = await confirmAndSave(rl, agentMdPath, newContent);
  rl.close();

  if (finalContent === null) process.exit(0);

  fs.writeFileSync(agentMdPath, finalContent + '\n', 'utf8');
  console.log('  ✓ AGENTS.md saved');

  // Signature emoji
  const currentEmoji = agent.signatureEmoji;
  let signatureEmoji: string | undefined = currentEmoji;

  if (!currentEmoji) {
    console.log('\n  No signature emoji set. Generating suggestion...');
    const emojiResult = spawnSync('claude', ['--print'], {
      input: `Based on this agent description, suggest a single emoji that best represents the agent's personality or role. Output ONLY the emoji, nothing else.\n\n${finalContent.slice(0, 500)}`,
      encoding: 'utf8',
      timeout: 15000,
    });
    const suggested = emojiResult.stdout?.trim() || '🤖';
    const defaultEmoji = suggested.length <= 8 ? suggested : '🤖';

    process.stdin.resume();
    const rlEmoji = createRl();
    const emojiInput = await prompt(
      rlEmoji,
      `  Signature emoji [${defaultEmoji}] (Enter to accept, or type a new one): `
    );
    signatureEmoji = emojiInput.trim() || defaultEmoji;
    rlEmoji.close();
    console.log(`  ✓ Signature emoji: ${signatureEmoji}`);
  } else {
    console.log(`\n  Current signature emoji: ${currentEmoji}`);
    process.stdin.resume();
    const rlEmoji = createRl();
    const emojiInput = await prompt(
      rlEmoji,
      `  Change emoji? [${currentEmoji}] (Enter to keep, or type a new one): `
    );
    if (emojiInput.trim()) signatureEmoji = emojiInput.trim();
    rlEmoji.close();
    console.log(`  ✓ Signature emoji: ${signatureEmoji}`);
  }

  agent.signatureEmoji = signatureEmoji;
  saveConfig(config);
  console.log('  ✓ config.json updated');

  try {
    const loaded = await loadWorkspace(wsDir);
    const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, loaded.systemPrompt, 'utf8');
    console.log('  ✓ CLAUDE.md regenerated');
  } catch (err) {
    console.error(`  Warning: Could not regenerate CLAUDE.md: ${(err as Error).message}`);
  }

  console.log('\nDone! Restart the gateway to apply changes.');
}

main().catch((err) => {
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
});
