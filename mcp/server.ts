#!/usr/bin/env bun
/**
 * Gateway MCP server — aggregates tools from all channel and tool modules.
 * Tool visibility follows openclaw pattern:
 *   "current-channel" — only visible when GATEWAY_ORIGIN_CHANNEL matches module.id
 *   "all-configured"  — always visible (e.g. cron)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TelegramModule } from './tools/telegram/module';
import { DiscordModule } from './tools/discord/module';
import { LineModule } from './tools/line/module';
import { CronModule } from './tools/cron/module';
import { SkillsModule } from './tools/skills/module';
import { AgentModule } from './tools/agent/module';
import { BrowserModule } from './tools/browser/module';
import { ImageModule } from './tools/image/module';
import { ShareImageModule } from './tools/share-image/module';
import { AppsModule } from './tools/apps/module';
import { ApiModule } from './tools/api/module';
import { MemoryModule } from './tools/memory/module';
import { buildChannelInstructions } from './instructions';
import type { ChannelModule, ToolModule, McpToolDefinition } from './types';

const ORIGIN_CHANNEL = process.env.GATEWAY_ORIGIN_CHANNEL ?? '';

type AnyModule = ChannelModule | ToolModule;

function isChannelModule(mod: AnyModule): mod is ChannelModule {
  return 'start' in mod && typeof (mod as ChannelModule).start === 'function';
}

const modules: AnyModule[] = [
  new TelegramModule(),
  new DiscordModule(),
  new LineModule(),
  new CronModule(),
  new SkillsModule(),
  new AgentModule(),
  new BrowserModule(),
  new ImageModule(),
  new ShareImageModule(),
  new AppsModule(),
  new ApiModule(),
  new MemoryModule(),
];

// Build tool-to-module mapping for enabled modules
const toolMap = new Map<string, AnyModule>();
const visibleTools: McpToolDefinition[] = [];

for (const mod of modules) {
  if (!mod.isEnabled()) continue;

  // Tool visibility filter
  const visible =
    mod.toolVisibility === 'all-configured' ||
    mod.id === ORIGIN_CHANNEL ||
    ORIGIN_CHANNEL === '';

  if (!visible) continue;

  for (const tool of mod.getTools()) {
    toolMap.set(tool.name, mod);
    visibleTools.push(tool);
  }
}

// Initialize channel modules so their bot API clients are ready for tool calls.
// initBot() returns immediately after creating the client — no blocking.
for (const mod of modules) {
  if (!mod.isEnabled()) continue;
  if (isChannelModule(mod) && typeof mod.initBot === 'function') {
    await mod.initBot();
  }
}

const shutdownController = new AbortController();

const imageEnabled = visibleTools.some((t) => t.name === 'generate_image');

const mcp = new Server(
  { name: 'gateway', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: buildChannelInstructions(imageEnabled),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: visibleTools,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const toolName = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  const mod = toolMap.get(toolName);
  if (!mod) {
    return {
      content: [{ type: 'text', text: `unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  // extra.signal fires on notifications/cancelled for THIS call (the SDK matches
  // it by requestId) — the CLI sends that when a user Stop/Ctrl-C interrupts an
  // in-flight tool call. Threaded through so a long-running module (image
  // generation's poll loop) can react instead of running to its full timeout.
  // Also combine with shutdownController.signal: the CLI sending that
  // notification is only a "SHOULD" in the MCP spec, not a "MUST", and in
  // practice a Stop that lets the CLI process exit cleanly (rather than
  // staying alive to keep chatting) closes this server's stdin without ever
  // sending notifications/cancelled — extra.signal would then never fire, and
  // an in-flight image generation would poll to its full timeout instead of
  // cancelling. stdin closing is a reliable, protocol-independent signal that
  // the turn is over either way, so it backstops the notification.
  const combinedSignal = AbortSignal.any([extra.signal, shutdownController.signal]);
  return mod.handleTool(toolName, args, combinedSignal);
});

// Connect MCP transport
await mcp.connect(new StdioServerTransport());

// Graceful shutdown — used by stdin-close, SIGINT, and SIGTERM paths.
// Awaits any in-flight image cancel (E3) before exiting so the provider
// actually stops generating when the user presses Stop, rather than the
// process dying mid-request and the cancel call never reaching the server.
const imageModuleRef = modules.find((m) => m.id === 'image') as { drainCancel?: () => Promise<void> } | undefined;
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownController.abort();
  // Give the event loop one tick so the poll loop's sleep() onAbort listener
  // fires and cancelledResult() sets activeCancelPromise before we try to drain it.
  setImmediate(async () => {
    try { await imageModuleRef?.drainCancel?.(); } catch { /* non-fatal */ }
    process.exit(0);
  });
}
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
