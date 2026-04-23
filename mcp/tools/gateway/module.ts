/**
 * Gateway tool module — exposes gateway management tools via MCP.
 * Tool visibility: "all-configured" (callable from any channel).
 */

import { spawn } from 'child_process';
import * as path from 'path';
import type {
  ToolModule,
  McpToolDefinition,
  McpToolResult,
  ToolVisibility,
} from '../../types';

export class GatewayModule implements ToolModule {
  id = 'gateway';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    return true;
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'gateway_restart',
        description:
          'Restart the claude-gateway process. Kills all gateway processes, rebuilds, and starts a new instance. Sends a notification to the originating channel when complete.',
        inputSchema: {
          type: 'object',
          properties: {
            notify_target_id: {
              type: 'string',
              description:
                'Chat ID (Telegram) or Channel ID (Discord) to send the completion notification to.',
            },
            reason: {
              type: 'string',
              description: 'Optional reason for the restart (informational only).',
            },
          },
          required: ['notify_target_id'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'gateway_restart') return this.handleRestart(args);
    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    };
  }

  private handleRestart(args: Record<string, unknown>): McpToolResult {
    const notifyTargetId = String(args.notify_target_id ?? '');
    const originChannel = process.env.GATEWAY_ORIGIN_CHANNEL ?? '';
    const botToken =
      originChannel === 'telegram'
        ? (process.env.TELEGRAM_BOT_TOKEN ?? '')
        : (process.env.DISCORD_BOT_TOKEN ?? '');

    const workerPath = path.resolve(__dirname, 'restart-worker.ts');
    const gatewayRoot = path.resolve(__dirname, '..', '..', '..');

    const child = spawn('bun', [workerPath], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        RESTART_ORIGIN_CHANNEL: originChannel,
        RESTART_NOTIFY_TARGET_ID: notifyTargetId,
        RESTART_NOTIFY_BOT_TOKEN: botToken,
        GATEWAY_ROOT: gatewayRoot,
      },
    });
    child.unref();

    return {
      content: [
        {
          type: 'text',
          text: '🔄 Gateway restart initiated. A notification will be sent to your channel when complete (usually ~15 seconds).',
        },
      ],
    };
  }
}
