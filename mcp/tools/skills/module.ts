/**
 * Skills tool module — implements ToolModule interface.
 * Provides skill management tools: skill_create, skill_delete, skill_install.
 * Tool-only module with "all-configured" visibility.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  ToolModule,
  McpToolDefinition,
  McpToolResult,
  ToolVisibility,
} from '../../types';
import {
  createSkill,
  deleteSkill,
  installSkill,
  type CreateSkillParams,
  type DeleteSkillParams,
  type InstallSkillParams,
} from './handlers';

export class SkillsModule implements ToolModule {
  id = 'skills';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    // Skills tools are available when workspace dir is known
    return Boolean(process.env.GATEWAY_WORKSPACE_DIR);
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'skill_create',
        description: 'Create a new skill from content. The skill will be available immediately via hot-reload.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Skill slug name (lowercase, hyphens allowed, e.g. "my-helper")',
            },
            description: {
              type: 'string',
              description: 'One-line description of what the skill does',
            },
            content: {
              type: 'string',
              description: 'Full SKILL.md body content (instructions for the agent)',
            },
            scope: {
              type: 'string',
              enum: ['workspace', 'shared'],
              description: 'Where to save: "workspace" (this agent only) or "shared" (all agents). Default: workspace',
            },
          },
          required: ['name', 'description', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'skill_delete',
        description: 'Delete a skill by name.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Skill name to delete',
            },
            scope: {
              type: 'string',
              enum: ['workspace', 'shared'],
              description: 'Where to look: "workspace" or "shared". Default: workspace',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: 'skill_install',
        description: 'Install a skill from a GitHub URL or raw URL pointing to a SKILL.md file.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to SKILL.md (GitHub URLs auto-converted to raw)',
            },
            scope: {
              type: 'string',
              enum: ['workspace', 'shared'],
              description: 'Where to install: "workspace" or "shared". Default: workspace',
            },
            name: {
              type: 'string',
              description: 'Override skill name (default: parsed from frontmatter)',
            },
            force: {
              type: 'boolean',
              description: 'Overwrite if skill already exists. Default: false',
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
      {
        name: 'skill_metrics',
        description: 'Read the skill self-improvement effectiveness rollup for this agent: adoption funnel (auto-skill stickiness), cost-to-complete deltas, recovery-rate trend, enabled/disabled cohort, and the net-token ledger (tokens saved by reuse minus tokens spent reviewing). Read-only.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const workspaceDir = process.env.GATEWAY_WORKSPACE_DIR!;
    const sharedSkillsDir = process.env.GATEWAY_SHARED_SKILLS_DIR ||
      path.join(process.env.HOME || '/tmp', '.claude-gateway', 'shared-skills');

    try {
      switch (name) {
        case 'skill_create': {
          const params: CreateSkillParams = {
            name: args.name as string,
            description: args.description as string,
            content: args.content as string,
            scope: (args.scope as 'workspace' | 'shared') || 'workspace',
            workspaceDir,
            sharedSkillsDir,
          };
          const result = await createSkill(params);
          return { content: [{ type: 'text', text: result }] };
        }
        case 'skill_delete': {
          const params: DeleteSkillParams = {
            name: args.name as string,
            scope: (args.scope as 'workspace' | 'shared') || 'workspace',
            workspaceDir,
            sharedSkillsDir,
          };
          const result = await deleteSkill(params);
          return { content: [{ type: 'text', text: result }] };
        }
        case 'skill_install': {
          const params: InstallSkillParams = {
            url: args.url as string,
            scope: (args.scope as 'workspace' | 'shared') || 'workspace',
            name: args.name as string | undefined,
            force: args.force as boolean | undefined,
            workspaceDir,
            sharedSkillsDir,
          };
          const result = await installSkill(params);
          return { content: [{ type: 'text', text: result }] };
        }
        case 'skill_metrics': {
          const apiUrl = (process.env.GATEWAY_API_URL || '').replace(/\/+$/, '');
          const apiKey = process.env.GATEWAY_API_KEY;
          const agentId = process.env.GATEWAY_AGENT_ID;
          if (!apiUrl || !apiKey || !agentId) {
            return {
              content: [{ type: 'text', text: 'skill_metrics unavailable: gateway API env not configured' }],
              isError: true,
            };
          }
          const res = await fetch(`${apiUrl}/api/v1/agents/${encodeURIComponent(agentId)}/skill-metrics`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          const body = await res.text();
          if (!res.ok) {
            return { content: [{ type: 'text', text: `skill_metrics failed (${res.status}): ${body}` }], isError: true };
          }
          return { content: [{ type: 'text', text: body }] };
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
