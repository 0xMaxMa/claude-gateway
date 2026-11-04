import { NextFunction, Request, Response, Router } from 'express';
import * as os from 'os';
import * as path from 'path';
import { ApiKey, Logger } from '../types';
import { createApiAuthMiddleware, isAdmin } from './auth';
import { guardAsyncRoutes } from './async-guard';
import { defineRoute } from './route-registry';
import { FILES_ERRORS } from './files-router';
import { resolveDir, resolveRealDir } from '../files/fs';
import { parseRelPath, RelPath } from '../files/paths';
import { collectListeners, Listener, listenersIn } from '../processes/listeners';
import { STOP_TERM_WAIT_MS, stopFolder, StopOptions } from '../processes/stop';
import { DEFAULT_PORT_RANGE, parsePort, START_TIMEOUT_MS, StartErrorCode, StartFailure, startFolder, StartOptions } from '../processes/start';
import { pathWithin } from '../utils/paths';

type AuthedRequest = Request & { apiKey: ApiKey };

/** Every error code the processes routes answer, with its status. Path errors are the files API's. */
export const PROCESSES_ERRORS: Record<StartErrorCode, { status: number; message: string }> = {
  invalid_path: FILES_ERRORS.invalid_path,
  invalid_name: FILES_ERRORS.invalid_name,
  not_a_directory: FILES_ERRORS.not_a_directory,
  invalid_port: { status: 400, message: 'port must be an integer from 1024 to 65535' },
  path_escape: FILES_ERRORS.path_escape,
  permission_denied: FILES_ERRORS.permission_denied,
  forbidden_key: FILES_ERRORS.forbidden_key,
  not_found: FILES_ERRORS.not_found,
  already_exists: FILES_ERRORS.already_exists,
  symlink_in_path: FILES_ERRORS.symlink_in_path,
  cross_device: FILES_ERRORS.cross_device,
  already_running: { status: 409, message: 'A process working in this folder already listens, or a start of it is running' },
  port_in_use: { status: 409, message: 'Something already listens on this port' },
  no_free_port: { status: 409, message: `Every port from ${DEFAULT_PORT_RANGE[0]} to ${DEFAULT_PORT_RANGE[1]} is in use` },
  no_start_command: { status: 422, message: 'The configured start script is missing or not a regular file' },
  internal: FILES_ERRORS.internal,
  start_failed: { status: 502, message: 'The start script exited or did not listen in time' },
};

function fail(res: Response, error: StartErrorCode | StartFailure): void {
  const body = typeof error === 'string' ? { code: error } : error;
  const { status, message } = PROCESSES_ERRORS[body.code];
  res.status(status).json({ error: message, ...body });
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isAdmin((req as AuthedRequest).apiKey)) next();
  else fail(res, 'forbidden_key');
}

/** A non-empty folder path under the root, as the files API parses it. */
function folderPath(raw: unknown): { ok: true; value: RelPath } | { ok: false; error: 'invalid_path' | 'invalid_name' } {
  const rel = parseRelPath(raw);
  if (!rel.ok) return rel;
  return rel.value === '' ? { ok: false, error: 'invalid_path' } : rel;
}

export interface ProcessesResponse {
  path: RelPath;
  running: boolean;
  listeners: Listener[];
}

export interface ProcessesRouterDeps {
  logger: Logger;
  /** Overrides for tests; the defaults are the gateway's. */
  start?: Partial<StartOptions>;
  stop?: Partial<StopOptions>;
}

/**
 * Which servers folders under the files root run, starting one with the configured script, and
 * stopping them. All routes need an admin key.
 */
export function createProcessesRouter(apiKeys: ApiKey[], root: string, deps: ProcessesRouterDeps): Router {
  const { logger } = deps;
  const startOptions: StartOptions = {
    logDir: path.join(os.homedir(), '.claude-gateway', 'process-logs'),
    portRange: DEFAULT_PORT_RANGE,
    timeoutMs: START_TIMEOUT_MS,
    ...deps.start,
    scriptPath: deps.start?.scriptPath ?? '',
  };
  const stopOptions: StopOptions = { termWaitMs: STOP_TERM_WAIT_MS, ...deps.stop };
  const router = guardAsyncRoutes(Router(), (req, res, e) => {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    logger.error(`processes: ${req.method} ${req.path} failed: ${e instanceof Error ? e.name : typeof e}${typeof code === 'string' ? ` ${code}` : ''}`);
    if (res.headersSent) res.end();
    else fail(res, 'internal');
  });
  const auth = createApiAuthMiddleware(apiKeys);

  defineRoute(
    router,
    { method: 'GET', path: '/v1/processes', auth: 'admin', summary: 'The TCP listeners of processes working in a folder under the files root', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      if (req.query.path === undefined) {
        const rootDir = await resolveDir(root, '' as RelPath, true);
        if (!rootDir.ok) return fail(res, rootDir.error);
        const realRoot = rootDir.value;
        const grouped = new Map<string, Listener[]>();
        for (const listener of await collectListeners()) {
          for (const owner of listener.owners) {
            if (!owner.cwd || !pathWithin(realRoot, owner.cwd) || owner.cwd === realRoot) continue;
            const folder = path.relative(realRoot, owner.cwd).split(path.sep)[0];
            if (!folder || !parseRelPath(folder).ok) continue;
            const listed = grouped.get(folder) ?? [];
            if (!listed.some((entry) => entry.port === listener.port && entry.address === listener.address)) {
              listed.push({ port: listener.port, pids: listener.owners.map((o) => o.pid), command: listener.owners[0].command, address: listener.address });
            }
            grouped.set(folder, listed);
          }
        }
        return res.json({ processes: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([folder, listeners]) => ({ path: folder, running: true, listeners: listeners.sort((a, b) => a.port - b.port) })) });
      }
      const rel = folderPath(req.query.path);
      if (!rel.ok) return fail(res, rel.error);
      const dir = await resolveRealDir(root, rel.value);
      if (!dir.ok) return fail(res, dir.error);
      const listeners = listenersIn(await collectListeners(), dir.value);
      const body: ProcessesResponse = { path: rel.value, running: listeners.length > 0, listeners };
      res.json(body);
    },
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/processes/start', auth: 'admin', summary: 'Start a folder with the configured script', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { path?: unknown; port?: unknown };
      if (!startOptions.scriptPath) return fail(res, 'no_start_command');
      const rel = folderPath(body.path);
      if (!rel.ok) return fail(res, rel.error);
      const port = parsePort(body.port);
      if (!port.ok) return fail(res, port.error);
      const started = await startFolder(root, rel.value, port.value, startOptions);
      if (!started.ok) {
        if (started.error.code === 'start_failed') logger.warn(`processes: start of ${rel.value} failed`);
        return fail(res, started.error);
      }
      logger.info(`processes: started ${rel.value} on port ${started.value.port} (pid ${started.value.pid})`);
      res.status(202).json(started.value);
    },
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/processes/stop', auth: 'admin', summary: 'Stop the processes that listen and work in a folder under the files root', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const rel = folderPath(((req.body ?? {}) as { path?: unknown }).path);
      if (!rel.ok) return fail(res, rel.error);
      const stopped = await stopFolder(root, rel.value, stopOptions);
      if (!stopped.ok) return fail(res, stopped.error);
      if (stopped.value.stopped.length + stopped.value.remaining.length > 0) {
        logger.info(`processes: stopped ${rel.value}: ports ${stopped.value.stopped.map((p) => p.port).join(',') || '-'}, remaining ${stopped.value.remaining.map((p) => p.port).join(',') || '-'}`);
      }
      res.json(stopped.value);
    },
  );

  return router;
}
