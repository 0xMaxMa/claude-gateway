import { spawnSync } from 'child_process';
import { CliConfigView, resolveUrlPlan, resolveReachableUrl, resolveKey, request } from '../http-client';
import { buildUpdatePrompt } from '../../agent/create-agent-prompts';
import { ask, askMultiline, createRl, previewAndAccept, printFilePreview, editInEditor } from '../prompt';
import { printResult, writeCommandHelp } from '../output';

/** Files the wizard always returns; only AGENTS.md is required to confirm. */
const WIZARD_OPTIONAL_FILES = new Set(['SOUL.md', 'USER.md', 'MEMORY.md']);

/** Channels the wizard's token-connect step supports at creation time (mirrors
 *  the server's `channel !== 'telegram' && channel !== 'discord'` check in
 *  POST /v1/agents/wizard/:wizardId/channel — src/api/router.ts). */
export const WIZARD_CHANNELS = ['telegram', 'discord'] as const;

/**
 * Per-channel PATCH field shape for `agents update`'s channel management.
 * Sourced from what PATCH /v1/agents/:agentId actually accepts (src/api/router.ts)
 * — telegram/discord take one token; LINE/Slack take a paired credential (both
 * required to connect, both empty to disconnect). Adding a future channel here
 * is a data entry; the connect/disconnect flow below doesn't change.
 */
interface ChannelFieldDef {
  label: string;
  connectedKey: string; // key in GET /v1/agents entries, e.g. "line_connected"
  fields: Array<{ patchKey: string; prompt: string }>;
}
export const UPDATE_CHANNELS: Record<string, ChannelFieldDef> = {
  telegram: { label: 'Telegram', connectedKey: 'telegram_connected', fields: [{ patchKey: 'telegram_bot_token', prompt: 'Telegram bot token' }] },
  discord: { label: 'Discord', connectedKey: 'discord_connected', fields: [{ patchKey: 'discord_bot_token', prompt: 'Discord bot token' }] },
  line: {
    label: 'LINE',
    connectedKey: 'line_connected',
    fields: [
      { patchKey: 'line_channel_access_token', prompt: 'LINE channel access token' },
      { patchKey: 'line_channel_secret', prompt: 'LINE channel secret' },
    ],
  },
  slack: {
    label: 'Slack',
    connectedKey: 'slack_connected',
    fields: [
      { patchKey: 'slack_bot_token', prompt: 'Slack bot token' },
      { patchKey: 'slack_signing_secret', prompt: 'Slack signing secret' },
    ],
  },
};

export async function runAgents(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const verb = positionals[0];
  if (!verb || flags.help === true) {
    // An explicit `--help` succeeds; a missing verb is a usage error.
    printHelp(flags.help === true);
    return flags.help === true ? 0 : 1;
  }
  const baseUrl = await resolveReachableUrl(
    resolveUrlPlan({ flagUrl: strFlag(flags.url), env: process.env, config }),
  );
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const compact = flags.json === true;

  switch (verb) {
    case 'list': {
      const result = await request({ method: 'GET', path: '/v1/agents', baseUrl, key });
      printResult(result.data, compact);
      return 0;
    }
    case 'create':
      return runCreate(positionals, flags, baseUrl, key);
    case 'update':
      return runUpdate(flags, baseUrl, key);
    default:
      process.stderr.write(`Unknown: agents ${verb} (expected list|create|update)\n\n`);
      printHelp(false);
      return 1;
  }
}

// ─── create ─────────────────────────────────────────────────────────────────

async function runCreate(
  positionals: string[],
  flags: Record<string, string | boolean>,
  baseUrl: string,
  key: string | undefined,
): Promise<number> {
  const rl = createRl();
  try {
    const id = strFlag(flags.id) || positionals[1] || (await ask(rl, 'Agent id (letters, numbers, hyphens; must start with a letter): ')).trim();
    if (!id) {
      process.stderr.write('Agent id is required.\n');
      return 1;
    }
    const description =
      strFlag(flags.description) ||
      (await askMultiline(rl, "\nDescribe the agent's role, personality, and capabilities.\n(blank line when done)"));
    if (!description.trim()) {
      process.stderr.write('Description is required.\n');
      return 1;
    }

    console.log('\nGenerating workspace files with Claude...');
    let start: { data: unknown };
    try {
      start = await request({ method: 'POST', path: '/v1/agents/wizard/start', baseUrl, key, body: { id, prompt: description } });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
    const startData = start.data as { wizardId: string; agentId: string; files: Record<string, string> };
    const files = new Map(Object.entries(startData.files));

    const accepted = await previewAndAccept(rl, files, WIZARD_OPTIONAL_FILES);
    if (!accepted.has('AGENTS.md')) {
      process.stderr.write('AGENTS.md was skipped but is required — aborting (nothing was written).\n');
      return 1;
    }

    const confirm = await request({
      method: 'POST',
      path: `/v1/agents/wizard/${startData.wizardId}/confirm`,
      baseUrl,
      key,
      body: { files: Object.fromEntries(accepted) },
    });
    const confirmData = confirm.data as { agentId: string };
    console.log(`\n  ✓ Agent "${confirmData.agentId}" created — workspace + config written, hot-reloading now.`);

    const channelChoice = (await ask(rl, `\nConnect a channel now? (${WIZARD_CHANNELS.join('/')}/skip) [skip]: `)).trim().toLowerCase();
    let connected: string | undefined;
    if ((WIZARD_CHANNELS as readonly string[]).includes(channelChoice)) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const token = (await ask(rl, `${channelChoice === 'telegram' ? 'Telegram' : 'Discord'} bot token: `)).trim();
        try {
          const chRes = await request({
            method: 'POST',
            path: `/v1/agents/wizard/${startData.wizardId}/channel`,
            baseUrl,
            key,
            body: { channel: channelChoice, botToken: token },
          });
          const chData = chRes.data as { botName: string };
          console.log(`  ✓ Bot ${chData.botName} connected`);
          connected = channelChoice;
          break;
        } catch (err) {
          console.log(`  ${(err as Error).message}`);
          if (attempt < 3) console.log(`  ${3 - attempt} attempt(s) remaining.`);
        }
      }
    }

    await request({ method: 'POST', path: `/v1/agents/wizard/${startData.wizardId}/complete`, baseUrl, key, body: {} });

    console.log('\n═══════════════════════════════════════');
    console.log(`  ✓ Agent "${confirmData.agentId}" is ready!`);
    console.log('═══════════════════════════════════════');
    if (connected) {
      console.log(`\nAsk the owner to DM the bot. Their request will show up under:`);
      console.log(`  claude-gateway channels pending --agent ${confirmData.agentId} --channel ${connected}`);
      console.log(`Then approve it with:`);
      console.log(`  claude-gateway channels approve --agent ${confirmData.agentId} --channel ${connected} --code <code>`);
    } else {
      console.log(`\nNo channel connected yet. Add one later with:`);
      console.log(`  claude-gateway agents update --agent ${confirmData.agentId}`);
    }
    return 0;
  } finally {
    rl.close();
  }
}

// ─── update ─────────────────────────────────────────────────────────────────

interface AgentSummary {
  id: string;
  [key: string]: unknown;
}

async function fetchAgents(baseUrl: string, key: string | undefined): Promise<AgentSummary[]> {
  const result = await request({ method: 'GET', path: '/v1/agents', baseUrl, key });
  return (result.data as { agents: AgentSummary[] }).agents;
}

async function runUpdate(flags: Record<string, string | boolean>, baseUrl: string, key: string | undefined): Promise<number> {
  const rl = createRl();
  try {
    let agentId = strFlag(flags.agent);
    let agents = await fetchAgents(baseUrl, key);
    if (!agentId) {
      if (agents.length === 0) {
        process.stderr.write('No agents found. Run `claude-gateway agents create` first.\n');
        return 1;
      }
      console.log('\nAgents:');
      agents.forEach((a, i) => console.log(`  ${i + 1}) ${a.id}`));
      const pick = (await ask(rl, 'Select agent number: ')).trim();
      const idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= agents.length) {
        process.stderr.write('Invalid selection.\n');
        return 1;
      }
      agentId = agents[idx].id;
    } else if (!agents.some((a) => a.id === agentId)) {
      process.stderr.write(`Agent '${agentId}' not found (or not accessible with this key).\n`);
      return 1;
    }
    console.log(`\n  Selected: ${agentId}\n`);

    while (true) {
      agents = await fetchAgents(baseUrl, key);
      // Re-fetched every iteration, so the agent can disappear mid-session —
      // deleted by another operator, or dropped from this key's scope by a
      // config reload. Without this guard the next line throws an opaque
      // TypeError out through the generic handler in `runCli`.
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) {
        process.stderr.write(`Agent '${agentId}' is no longer available (or not accessible with this key).\n`);
        return 1;
      }
      const connected = Object.entries(UPDATE_CHANNELS).filter(([, def]) => agent[def.connectedKey] === true);

      console.log('What do you want to do?');
      console.log('  1) Regenerate AGENTS.md');
      console.log(`  2) Connect/update a channel  [connected: ${connected.length ? connected.map(([, d]) => d.label).join(', ') : 'none'}]`);
      if (connected.length) console.log('  3) Disconnect a channel');
      console.log('  0) Done');

      const choice = (await ask(rl, 'Choose: ')).trim();
      if (choice === '0' || choice.toLowerCase() === 'done') return 0;
      if (choice === '1') {
        await regenerateAgentsMd(rl, agentId, baseUrl, key);
      } else if (choice === '2') {
        await connectChannel(rl, agentId, baseUrl, key);
      } else if (choice === '3' && connected.length) {
        await disconnectChannel(rl, agentId, connected.map(([id]) => id), baseUrl, key);
      } else {
        console.log('  Please choose a listed option.\n');
      }
    }
  } finally {
    rl.close();
  }
}

/** Strip a wrapping code fence and slice from the first YAML/heading marker —
 *  pure, so it can be unit-tested without spawning Claude. Returns null when
 *  no recognizable AGENTS.md content (YAML front-matter or a heading) is found. */
export function parseGeneratedAgentsMd(rawOutput: string): string | null {
  let raw = rawOutput.trim();
  const fenceMatch = raw.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) raw = (fenceMatch[1] ?? '').trim();
  const yamlStart = raw.indexOf('---\n');
  const headingStart = raw.indexOf('# ');
  const start = yamlStart >= 0 ? yamlStart : headingStart;
  if (start < 0) return null;
  return raw.slice(start).replace(/\n```\s*$/, '').trim();
}

async function regenerateAgentsMd(rl: ReturnType<typeof createRl>, agentId: string, baseUrl: string, key: string | undefined): Promise<void> {
  const current = await request({ method: 'GET', path: `/v1/agents/${encodeURIComponent(agentId)}/files/AGENTS.md`, baseUrl, key });
  const currentContent = (current.data as { content: string }).content;
  const agentName = agentId.charAt(0).toUpperCase() + agentId.slice(1);

  console.log('\nGenerating updated AGENTS.md with Claude...');
  const result = spawnSync('claude', ['--print'], { input: buildUpdatePrompt(agentName, currentContent), encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    console.log('  Claude generation failed.');
    return;
  }
  const parsed = parseGeneratedAgentsMd(result.stdout);
  if (parsed === null) {
    console.log('  Could not parse AGENTS.md from Claude output.');
    return;
  }
  let content = parsed;

  printFilePreview('AGENTS.md', content);
  while (true) {
    const answer = (await ask(rl, 'Accept? (y/edit/n) [y]: ')).trim().toLowerCase() || 'y';
    if (answer === 'y' || answer === 'yes') break;
    if (answer === 'n' || answer === 'no') {
      console.log('  Cancelled. No changes made.\n');
      return;
    }
    if (answer === 'edit') {
      const edited = editInEditor(content, 'AGENTS.md');
      if (edited === null) {
        console.log('  Could not open an editor (set $EDITOR and try again, or choose y/n).');
        continue;
      }
      content = edited;
      printFilePreview('AGENTS.md', content);
      continue;
    }
    console.log('  Please enter y, edit, or n.');
  }

  await request({ method: 'PUT', path: `/v1/agents/${encodeURIComponent(agentId)}/files/AGENTS.md`, baseUrl, key, body: { content } });
  console.log('  ✓ AGENTS.md saved (auto-reloads).\n');
}

async function connectChannel(rl: ReturnType<typeof createRl>, agentId: string, baseUrl: string, key: string | undefined): Promise<void> {
  const names = Object.keys(UPDATE_CHANNELS);
  console.log(`\nChannels: ${names.map((n, i) => `${i + 1}) ${UPDATE_CHANNELS[n].label}`).join('  ')}`);
  const pick = (await ask(rl, 'Select a channel number: ')).trim();
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= names.length) {
    console.log('  Invalid selection.\n');
    return;
  }
  const channel = names[idx];
  const def = UPDATE_CHANNELS[channel];
  const body: Record<string, string> = {};
  for (const f of def.fields) {
    body[f.patchKey] = (await ask(rl, `${f.prompt}: `)).trim();
  }
  try {
    await request({ method: 'PATCH', path: `/v1/agents/${encodeURIComponent(agentId)}`, baseUrl, key, body });
    console.log(`  ✓ ${def.label} connected.\n`);
  } catch (err) {
    console.log(`  ${(err as Error).message}\n`);
  }
}

async function disconnectChannel(
  rl: ReturnType<typeof createRl>,
  agentId: string,
  connectedIds: string[],
  baseUrl: string,
  key: string | undefined,
): Promise<void> {
  console.log(`\nConnected channels: ${connectedIds.map((n, i) => `${i + 1}) ${UPDATE_CHANNELS[n].label}`).join('  ')}`);
  const pick = (await ask(rl, 'Disconnect which number? ')).trim();
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= connectedIds.length) {
    console.log('  Invalid selection.\n');
    return;
  }
  const channel = connectedIds[idx];
  const def = UPDATE_CHANNELS[channel];
  const body: Record<string, null> = {};
  for (const f of def.fields) body[f.patchKey] = null;
  await request({ method: 'PATCH', path: `/v1/agents/${encodeURIComponent(agentId)}`, baseUrl, key, body });
  console.log(`  ✓ ${def.label} disconnected.\n`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function strFlag(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}



function printHelp(requested: boolean): void {
  writeCommandHelp(requested, 'agents', 'create and manage agents', 'claude-gateway agents <list|create|update> [--flags]', [
    '  agents list                           List agents accessible by this key',
    '  agents create [id] [--description v]  Interactive wizard (workspace files + optional channel)',
    '  agents update [--agent <id>]          Regenerate AGENTS.md, connect/update/disconnect channels',
  ]);
}
