import { Router, Request, Response } from 'express';
import { ApiKey } from '../types';
import { CHAT_CHANNELS, type ChatChannel } from '../history/types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { GATEWAY_VERSION } from './gateway-version';
import { gatewayOrchestrationEnabled } from '../orchestration/gateway-config';
import { filesEnabled, resolveFilesRoot } from '../files/config';
import { reportedRoot } from '../files/fs';
import type { GatewayConfig } from '../types';

/**
 * Capability manifest — the single place that declares which optional features
 * this gateway build supports, so clients can feature-detect instead of pinning
 * to a version number.
 *
 * Contract (documented in website/api/system.md → "GET /api/v1/capabilities"):
 *   - keys are additive-only and never change meaning; dropping a feature means
 *     dropping its key, not flipping its value,
 *   - a missing key means "unsupported", and a 404 on the endpoint itself means
 *     the gateway predates capability discovery and supports none of these.
 *
 * Add a new capability here (plus its website/api/system.md entry); never inline a feature list
 * in a route handler.
 */

/**
 * Channels whose sessions accept a message injected by another client via
 * `POST /api/v1/agents/:id/chats/:chatId/sessions/:sessionId/messages` — the
 * injected text is delivered into the channel conversation and echoed back to
 * the channel's users. Values are the gateway's own channel identifiers
 * ({@link ChatChannel}), the same strings a session reports as its channel.
 *
 * The web→channel echo (runner.ts `writeAutoForward`, reached from
 * `sendMessageToSession`/`sendOrchestratedChannel`) has a delivery branch for
 * every {@link CHAT_CHANNELS} member and, since the echo's telegram-only guard
 * was removed (#539, "echo web channel messages back to the originating
 * channel (all channels)"), fires for every channel — so this manifest lists
 * all of them. Deriving from CHAT_CHANNELS keeps it in lockstep: a new channel
 * added there (which must also gain a `writeAutoForward` branch) is advertised
 * automatically, and nothing here can drift out of the canonical union.
 */
export const CROSS_CHANNEL_MESSAGE_CHANNELS: readonly ChatChannel[] = [...CHAT_CHANNELS];

/**
 * Folder operations served by files-router.ts under the one files root. Clients gate listing on `includes('list')`,
 * `POST /v1/files/mkdir` on `includes('create')`, `DELETE /v1/files` on `includes('delete')`, and
 * The gateway serves no file contents; they are viewed in code-server.
 */
export const FILES_CAPABILITIES = ['list', 'create', 'delete'] as const;
export type FilesCapability = (typeof FILES_CAPABILITIES)[number];

/** The operations files-router.ts serves only to an admin key; every other token is open to any key. */
export const FILES_ADMIN_CAPABILITIES: ReadonlySet<FilesCapability> = new Set(['create', 'delete']);

/** Read-only git routes served by git-router.ts: `GET /v1/git/status` and `GET /v1/git/summary`. */
export const GIT_CAPABILITIES = ['status', 'summary'] as const;
export type GitCapability = (typeof GIT_CAPABILITIES)[number];

/**
 * `cwd`: `POST /v1/agents/:agentId/sessions` accepts `cwd`, a folder under the files root, and runs the chat there.
 * It is accepted through the queued-admission path, which needs orchestration, so a gateway without it does not
 * advertise the token and a client never sends a cwd it would not honour.
 */
export const SESSIONS_CAPABILITIES = ['cwd'] as const;
export type SessionsCapability = (typeof SESSIONS_CAPABILITIES)[number];

/**
 * Routes served by processes-router.ts for folders under the files root: `list` is `GET /v1/processes`, `start` is
 * `POST /v1/processes/start` and `stop` is `POST /v1/processes/stop`; all three need an admin key.
 */
export const PROCESSES_CAPABILITIES = ['list', 'start', 'stop'] as const;
export type ProcessesCapability = (typeof PROCESSES_CAPABILITIES)[number];

export interface CapabilitiesResponse {
  /** Gateway version from package.json. Informational — clients should key off `capabilities`, not parse this. */
  version: string;
  capabilities: {
    cross_channel_message: ChatChannel[];
    files: FilesCapability[];
    git: GitCapability[];
    sessions: SessionsCapability[];
    processes: ProcessesCapability[];
  };
  /** Why `files`, `git`, `sessions` and `processes` are empty; absent when the files API is usable. */
  filesUnavailable?: FilesUnavailable;
  /** The absolute files root, the value `GET /v1/files` reports as `root`; absent when the files API is off. */
  filesRoot?: string;
}

/** `disabled`: the gateway serves no files or git API. */
export type FilesUnavailable = 'disabled';

type FilesAvailability = Pick<CapabilitiesResponse['capabilities'], 'files' | 'git' | 'sessions' | 'processes'> & { filesUnavailable?: FilesUnavailable };

/**
 * The tokens `apiKey` may use. A non-admin key gets every token but the admin-only ones. A gateway with orchestration
 * off does not advertise `sessions: ['cwd']`. Without a config or a key (tests) the gateway-wide answer is given.
 */
export function filesAvailability(config?: GatewayConfig, apiKey?: ApiKey): FilesAvailability {
  if (config && !filesEnabled(config)) return { files: [], git: [], sessions: [], processes: [], filesUnavailable: 'disabled' };
  const orchestrated = !config || gatewayOrchestrationEnabled(config.gateway.orchestration);
  const admin = !apiKey || isAdmin(apiKey);
  return {
    files: FILES_CAPABILITIES.filter((c) => admin || !FILES_ADMIN_CAPABILITIES.has(c)),
    git: [...GIT_CAPABILITIES],
    sessions: orchestrated ? [...SESSIONS_CAPABILITIES] : [],
    processes: admin ? PROCESSES_CAPABILITIES.filter((c) => c !== 'start' || Boolean(config?.gateway.processes?.startScript)) : [],
  };
}

export function buildCapabilitiesResponse(version: string = GATEWAY_VERSION, config?: GatewayConfig, apiKey?: ApiKey, filesRoot?: string | null): CapabilitiesResponse {
  const { filesUnavailable, ...tokens } = filesAvailability(config, apiKey);
  return {
    version,
    capabilities: { cross_channel_message: [...CROSS_CHANNEL_MESSAGE_CHANNELS], ...tokens },
    ...(filesUnavailable ? { filesUnavailable } : {}),
    ...(!filesUnavailable && filesRoot ? { filesRoot } : {}),
  };
}

/**
 * `GET /api/v1/capabilities`. Always behind API-key auth — the response carries
 * the gateway version, which `/health` deliberately withholds from
 * unauthenticated callers, so this route sits behind the same auth as the rest
 * of `/api/v1`. The gateway only mounts this router when `gateway.api.keys` is
 * non-empty (see GatewayRouter), so a keyless install never reaches it: the
 * endpoint 404s rather than serving open access. `apiKeys` is therefore always
 * the configured, non-empty key set.
 */
export function createCapabilitiesRouter(apiKeys: ApiKey[], config?: GatewayConfig): Router {
  const router = Router();
  router.use(createApiAuthMiddleware(apiKeys));
  router.get('/v1/capabilities', async (req: Request, res: Response) => {
    const filesRoot = config && filesEnabled(config) ? await reportedRoot(resolveFilesRoot(config)) : null;
    res.json(buildCapabilitiesResponse(GATEWAY_VERSION, config, (req as Request & { apiKey: ApiKey }).apiKey, filesRoot));
  });
  return router;
}
