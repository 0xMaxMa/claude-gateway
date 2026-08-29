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
    repoUrl: 'https://github.com/github/github-mcp-server',
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
  // ── Google connectors — real OAuth (authorization_code + refresh), but the
  // whole client_secret-touching flow lives in getpod-ai's services/api, NOT
  // here — this gateway only ever receives a short-lived access_token via
  // POST /v1/connectors/:id/oauth/receive (connectors-router.ts). Reason: this
  // gateway runs inside the user's own VM, reachable by that user's own
  // shell/SSH — a client_secret shared across every user can't live here
  // safely. See types.ts's 'oauth' auth kind doc comment.
  //
  // Both community servers below (io.github.domdomegg/{gmail,google-drive,
  // google-cal}-mcp on the MCP registry) read the SAME env var name
  // (GOOGLE_ACCESS_TOKEN) in their process, but each catalog entry stores its
  // OWN secret under a distinct key (GMAIL_ACCESS_TOKEN / GDRIVE_ACCESS_TOKEN /
  // GCAL_ACCESS_TOKEN) so connecting one doesn't silently mark the others
  // "connected" too.
  {
    id: 'gmail',
    label: 'Gmail',
    description: 'Read, search, and send email via Gmail.',
    transport: 'stdio',
    auth: { kind: 'oauth', secretEnv: 'GMAIL_ACCESS_TOKEN' },
    repoUrl: 'https://github.com/domdomegg/gmail-mcp',
    build: (secret) => ({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'gmail-mcp'],
      env: { GOOGLE_ACCESS_TOKEN: secret ?? '' },
    }),
  },
  {
    id: 'google-drive',
    label: 'Google Drive',
    description: 'List, search, and manage files in Google Drive.',
    transport: 'stdio',
    auth: { kind: 'oauth', secretEnv: 'GDRIVE_ACCESS_TOKEN' },
    repoUrl: 'https://github.com/domdomegg/google-drive-mcp',
    build: (secret) => ({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'google-drive-mcp'],
      env: { GOOGLE_ACCESS_TOKEN: secret ?? '' },
    }),
  },
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    description: 'List, create, and manage calendar events.',
    transport: 'stdio',
    auth: { kind: 'oauth', secretEnv: 'GCAL_ACCESS_TOKEN' },
    repoUrl: 'https://github.com/domdomegg/google-cal-mcp',
    build: (secret) => ({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'google-cal-mcp'],
      env: { GOOGLE_ACCESS_TOKEN: secret ?? '' },
    }),
  },
  // Microsoft 365 (Outlook/OneDrive/Teams) — the one registry entry
  // (com.proscendia/microsoft-365) is a remote streamable-http server with NO
  // static header/token: it does its own Microsoft OAuth at connect-time
  // (server-side, once the MCP client opens the connection), so there is
  // nothing for us to store — auth.kind 'none'. UNVERIFIED whether Claude
  // Code's MCP client actually completes that handshake; enabling this for an
  // agent is the live test.
  {
    id: 'microsoft-365',
    label: 'Microsoft 365',
    description: 'Outlook, OneDrive, and Teams via the user\'s own Microsoft account.',
    transport: 'http',
    auth: { kind: 'none' },
    // No GitHub repo published by the vendor — link to their site instead.
    repoUrl: 'https://proscendia.com',
    build: () => ({
      type: 'http',
      url: 'https://microsoft-mcp.proscendia.com/mcp',
    }),
  },
];

export function getConnectorSpec(id: string): ConnectorSpec | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}
