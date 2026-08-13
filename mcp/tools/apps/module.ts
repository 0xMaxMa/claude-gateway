/**
 * Apps tool module — install, list, and manage app store apps via gateway REST API.
 */

import * as path from 'path';
import type {
  ToolModule,
  McpToolDefinition,
  McpToolResult,
  ToolVisibility,
} from '../../types';
import { AppsClient } from './client';

export class AppsModule implements ToolModule {
  id = 'apps';
  toolVisibility: ToolVisibility = 'all-configured';
  skillsDir = path.join(__dirname, 'skills');

  private client: AppsClient | null = null;

  isEnabled(): boolean {
    return Boolean(process.env.GATEWAY_API_URL);
  }

  private getClient(): AppsClient {
    if (!this.client) {
      const apiUrl = process.env.GATEWAY_API_URL!;
      const apiKey = process.env.GATEWAY_API_KEY;
      this.client = new AppsClient(apiUrl, apiKey);
    }
    return this.client;
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'browse_registry',
        description: 'Browse the community app registry. Omit name to list all apps; provide name to get versions for a specific app.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'App name to look up. Omit to list all.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'install_app',
        description: 'Install an app from the registry or a GitHub URL. Returns a jobId to poll with poll_install_job.',
        inputSchema: {
          type: 'object',
          properties: {
            registry_app: { type: 'string', description: 'Registry app name (e.g. "getpod-manager")' },
            version: { type: 'string', description: 'Registry version to install (default: latest)' },
            github_url: { type: 'string', description: 'GitHub repo URL' },
            commit: { type: 'string', description: '40-char hex commit hash to pin (optional; with github_url, omit to auto-resolve the default branch HEAD)' },
            local_path: { type: 'string', description: 'Local app path within ~/.claude-gateway/apps/' },
            env_vars: {
              type: 'object',
              description: 'Environment variables / secrets to inject',
              additionalProperties: { type: 'string' },
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'poll_install_job',
        description: 'Poll the status of an app install job. Returns status (pending/running/completed/failed), logs, and result on completion.',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID returned by install_app' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'inspect_app',
        description: 'Preview an install source WITHOUT installing: fetch and parse the app.yaml and return the required secrets (secretKeys, must be provided) and auto-generated secrets (generatedKeys, filled by the gateway), plus name, version, ports, and warnings. Also returns secretDefaults — defaults for prompt-with-default secrets declared as KEY=!default:<value>: the key is still in secretKeys (prompted/editable) but this default pre-fills the field and is written to .env when left blank. Call this BEFORE install_app for a GitHub URL — such apps have no registry entry, so browse_registry cannot reveal their required secrets. Pass github_url (+ optional commit), registry_app (+ optional version), or local_path.',
        inputSchema: {
          type: 'object',
          properties: {
            registry_app: { type: 'string', description: 'Registry app name' },
            version: { type: 'string', description: 'Registry version (default: latest)' },
            github_url: { type: 'string', description: 'GitHub repo URL' },
            commit: { type: 'string', description: '40-char hex commit hash to pin (optional; with github_url, omit to auto-resolve the default branch HEAD)' },
            local_path: { type: 'string', description: 'Local app path within ~/.claude-gateway/apps/' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'list_apps',
        description: 'List all installed apps with their status and proxy URLs.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'app_status',
        description: 'Get detailed status and version info for an installed app.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'App name' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: 'update_app',
        description: 'Update an installed app. Registry apps update to their latest published version; GitHub-URL (custom) apps update to their repo default-branch HEAD. Returns a jobId.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'App name to update' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: 'uninstall_app',
        description: 'Uninstall an app — stops containers, removes images, deletes files.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'App name to uninstall' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: 'start_stop_app',
        description: 'Start, stop, or restart an installed app.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'App name' },
            action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Action to perform' },
          },
          required: ['name', 'action'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const client = this.getClient();

    switch (name) {
      case 'browse_registry': {
        const appName = args['name'] as string | undefined;
        const data = appName
          ? await client.getRegistry(appName)
          : await client.listRegistry();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'install_app': {
        const params: Record<string, unknown> = {};
        if (args['registry_app']) params['registry_app'] = args['registry_app'];
        if (args['version']) params['version'] = args['version'];
        if (args['github_url']) params['github_url'] = args['github_url'];
        if (args['commit']) params['commit'] = args['commit'];
        if (args['local_path']) params['local_path'] = args['local_path'];
        if (args['env_vars']) params['env_vars'] = args['env_vars'];
        const data = await client.install(params);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'poll_install_job': {
        const jobId = args['job_id'] as string;
        const data = await client.pollJob(jobId);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'inspect_app': {
        const params: Record<string, unknown> = {};
        if (args['registry_app']) params['registry_app'] = args['registry_app'];
        if (args['version']) params['version'] = args['version'];
        if (args['github_url']) params['github_url'] = args['github_url'];
        if (args['commit']) params['commit'] = args['commit'];
        if (args['local_path']) params['local_path'] = args['local_path'];
        const data = await client.inspect(params);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'list_apps': {
        const data = await client.listApps();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'app_status': {
        const appName = args['name'] as string;
        const [entry, version] = await Promise.all([
          client.getApp(appName),
          client.getVersion(appName).catch(() => null),
        ]);
        const result = { ...(entry as object), version_info: version };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'update_app': {
        const appName = args['name'] as string;
        const data = await client.update(appName);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'uninstall_app': {
        const appName = args['name'] as string;
        const data = await client.uninstall(appName);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'start_stop_app': {
        const appName = args['name'] as string;
        const action = args['action'] as 'start' | 'stop' | 'restart';
        const data = await client.startStop(appName, action);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  }
}
