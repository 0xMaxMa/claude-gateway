import { CRON_TOOLS } from '../../../dist/cron/tool-schemas.js';
import { callTaskBridge } from '../tasks/module';
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
    return Boolean((process.env.GATEWAY_ORCHESTRATION_ROLE === 'worker' && process.env.GATEWAY_ORCHESTRATION_CRON === 'true' && process.env.GATEWAY_ORCHESTRATION_TICKET_FILE) || (process.env.GATEWAY_API_URL && process.env.GATEWAY_AGENT_ID));
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
    return CRON_TOOLS;
  }

  async handleTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (process.env.GATEWAY_ORCHESTRATION_ROLE === 'worker') {
      return callTaskBridge(name, args, crypto.randomUUID(), signal ?? AbortSignal.timeout(20000));
    }
    const client = this.getClient();

    try {
      switch (name) {
        case 'cron_list': {
          const jobs = await client.list();
          return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
        }
        case 'cron_create': {
          // Fix 3: Default deleteAfterRun=true for at-type one-shot jobs so they are
          // automatically cleaned up after firing, preventing re-fire on gateway restart.
          const scheduleKind = (args.scheduleKind as string | undefined) ?? 'cron';
          const deleteAfterRun = args.deleteAfterRun !== undefined
            ? args.deleteAfterRun
            : scheduleKind === 'at';
          const job = await client.create({ ...args, scheduleKind, deleteAfterRun });
          return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
        }
        case 'cron_delete': {
          await client.delete(args.job_id as string);
          return { content: [{ type: 'text', text: `deleted job ${args.job_id}` }] };
        }
        case 'cron_update': {
          const { job_id, ...rest } = args as { job_id?: string } & Record<string, unknown>;
          if (!job_id) {
            return { content: [{ type: 'text', text: 'cron_update failed: job_id is required' }], isError: true };
          }
          const job = await client.update(job_id, rest);
          return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
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
