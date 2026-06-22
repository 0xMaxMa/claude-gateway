/**
 * Hardcoded connector catalog.
 *
 * The catalog is well-known server metadata (not user data), so it lives in code:
 * it doubles as the security boundary (only vetted servers can be injected) and
 * avoids a config-migration. Per-connector secrets live in mcp-token.env; per-agent
 * enablement lives in AgentConfig.connectors.
 *
 * To add a connector whose auth kind is already supported (none / secret), just add
 * an entry here — token-env, resolve, the router and the web panel are all generic.
 */

import type { ConnectorSpec } from './types';

export const CONNECTOR_CATALOG: ConnectorSpec[] = [
  {
    id: 'github',
    label: 'GitHub',
    description: 'Repos, issues, and pull requests via the official GitHub MCP server.',
    transport: 'http',
    auth: { kind: 'secret', secretEnv: 'GITHUB_TOKEN' },
    setup: {
      // GitHub's classic-PAT page accepts scopes + description query params
      // (fine-grained tokens do not); the GitHub MCP server works with a classic PAT.
      tokenUrl:
        'https://github.com/settings/tokens/new?scopes=repo,read:org&description=GetPod%20connector',
      label: 'Create a GitHub token',
      hint: 'Opens GitHub with repo + read:org scopes pre-filled. Generate it, then paste it here.',
    },
    build: (secret) => ({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: `Bearer ${secret ?? ''}` },
    }),
    // Local docker stdio alternative (kept for reference; needs the cached image and
    // does not work inside app-agent containers without docker-in-docker):
    //   transport: 'stdio',
    //   build: (secret) => ({
    //     command: 'docker',
    //     args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN',
    //            'ghcr.io/github/github-mcp-server'],
    //     env: { GITHUB_PERSONAL_ACCESS_TOKEN: secret ?? '' },
    //   }),
  },
];

export function getConnectorSpec(id: string): ConnectorSpec | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}
