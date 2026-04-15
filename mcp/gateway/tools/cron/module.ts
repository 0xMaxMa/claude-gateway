/**
 * Cron tool module — implements ToolModule interface.
 * Provides cron job management tools via the gateway REST API.
 * Not a chat channel — tool-only module with "all-configured" visibility.
 */

import * as path from 'path';
import type {
  ToolModule,
  McpToolDefinition,
  McpToolResult,
  ToolVisibility,
} from '../../types';
import { CronClient } from './client';

export class CronModule implements ToolModule {
  id = 'cron';
  toolVisibility: ToolVisibility = 'all-configured';
  skillsDir = path.join(__dirname, 'skills');

  private client: CronClient | null = null;

  isEnabled(): boolean {
    return Boolean(process.env.GATEWAY_API_URL && process.env.GATEWAY_AGENT_ID);
  }

  private getClient(): CronClient {
    if (!this.client) {
      const apiUrl = process.env.GATEWAY_API_URL!;
      const agentId = process.env.GATEWAY_AGENT_ID!;
      const apiKey = process.env.GATEWAY_API_KEY;
      this.client = new CronClient(apiUrl, agentId, apiKey);
    }
    return this.client;
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'cron_list',
        description: 'List scheduled cron jobs for this agent',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'cron_create',
        description: 'Create a new cron job',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Job name' },
            schedule: { type: 'string', description: '5-field cron expression' },
            type: { type: 'string', enum: ['command', 'agent'], description: 'Job type' },
            command: { type: 'string', description: 'Shell command (type=command)' },
            prompt: { type: 'string', description: 'Agent prompt (type=agent)' },
            telegram: { type: 'string', description: 'Telegram chat_id for response' },
            timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
          },
          required: ['name', 'schedule', 'type'],
          additionalProperties: false,
        },
      },
      {
        name: 'cron_delete',
        description: 'Delete a cron job by ID',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID to delete' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'cron_run',
        description: 'Run a cron job immediately',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID to run' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'cron_get_runs',
        description: 'Get run history for a cron job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const client = this.getClient();

    try {
      switch (name) {
        case 'cron_list': {
          const jobs = await client.list();
          return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
        }
        case 'cron_create': {
          const job = await client.create(args);
          return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
        }
        case 'cron_delete': {
          await client.delete(args.job_id as string);
          return { content: [{ type: 'text', text: `deleted job ${args.job_id}` }] };
        }
        case 'cron_run': {
          const run = await client.run(args.job_id as string);
          return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] };
        }
        case 'cron_get_runs': {
          const runs = await client.getRuns(args.job_id as string);
          return { content: [{ type: 'text', text: JSON.stringify(runs, null, 2) }] };
        }
        default:
          return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true };
    }
  }
}
