import { Router, Request, Response } from 'express';
import { CronManager } from '../cron/manager';
import { ApiKey, CronJobCreate, CronJobUpdate } from '../types';
import { createApiAuthMiddleware, canAccessAgent } from './auth';
import { defineRoute } from './route-registry';

type AuthedRequest = Request & { apiKey: ApiKey };

/**
 * Creates Express routes for managing persistent cron jobs.
 *
 * All routes require a valid API key (Authorization: Bearer or X-Api-Key header).
 * Write operations (create/update/delete/run) additionally verify that the key
 * has access to the job's agentId via canAccessAgent().
 *
 * Routes are registered via defineRoute(), so each one also contributes its
 * `<noun> <verb>` CLI mapping (noun `crons`) to the route manifest that drives
 * the CLI and its generated docs. See src/api/route-registry.ts.
 *
 * Routes:
 *   GET    /v1/crons           — crons list      — List jobs accessible by this key
 *   GET    /v1/crons/status    — crons status    — Overall scheduler status
 *   POST   /v1/crons           — crons create    — Create a new job
 *   GET    /v1/crons/:id       — crons get       — Get a single job
 *   PUT    /v1/crons/:id       — crons update    — Update a job
 *   DELETE /v1/crons/:id       — crons delete    — Delete a job
 *   POST   /v1/crons/:id/run   — crons run       — Trigger a job manually
 *   GET    /v1/crons/:id/runs  — crons runs      — Get run history
 */
export function createCronRouter(manager: CronManager, apiKeys?: ApiKey[], knownAgentIds?: Set<string>): Router {
  const router = Router();

  // Apply auth middleware if apiKeys are provided
  if (apiKeys?.length) {
    router.use(createApiAuthMiddleware(apiKeys));
  }

  // Helper: check agent access for jobs retrieved by id
  function checkJobAccess(req: Request, res: Response, agentId: string): boolean {
    if (!apiKeys?.length) return true; // no auth configured — allow all
    const apiKey = (req as AuthedRequest).apiKey;
    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return false;
    }
    return true;
  }

  // List jobs — filtered to agents this key can access
  defineRoute(
    router,
    {
      method: 'GET',
      path: '/v1/crons',
      auth: 'key',
      summary: 'List cron jobs accessible by this key',
      cli: { noun: 'crons', verb: 'list', flags: [{ name: 'agent', in: 'query', description: 'Filter by agent id' }] },
    },
    (_req: Request, res: Response) => {
      const agentId = _req.query.agent as string | undefined;
      let jobs = manager.list(agentId);

      // Filter by key's agent scope
      if (apiKeys?.length) {
        const apiKey = (_req as AuthedRequest).apiKey;
        if (apiKey.agents !== '*') {
          const allowed = apiKey.agents as string[];
          jobs = jobs.filter((j) => allowed.includes(j.agentId));
        }
      }

      res.json({ jobs });
    },
  );

  // Overall status
  defineRoute(
    router,
    { method: 'GET', path: '/v1/crons/status', auth: 'key', summary: 'Cron scheduler status', cli: { noun: 'crons', verb: 'status' } },
    (_req: Request, res: Response) => {
      res.json(manager.status());
    },
  );

  // Create job
  defineRoute(
    router,
    {
      method: 'POST',
      path: '/v1/crons',
      auth: 'key',
      summary: 'Create a cron job',
      cli: {
        noun: 'crons',
        verb: 'create',
        flags: [
          { name: 'agentId', in: 'body', required: true, description: 'Owning agent id' },
          { name: 'name', in: 'body', required: true, description: 'Job name' },
          { name: 'type', in: 'body', description: 'command | agent' },
          { name: 'schedule', in: 'body', description: '5-field cron expression (scheduleKind=cron)' },
          { name: 'scheduleKind', in: 'body', description: 'cron | at' },
          { name: 'scheduleAt', in: 'body', description: 'ISO-8601 timestamp (scheduleKind=at)' },
          { name: 'command', in: 'body', description: 'Shell command (type=command)' },
          { name: 'prompt', in: 'body', description: 'Agent prompt (type=agent)' },
        ],
      },
    },
    async (req: Request, res: Response) => {
      const body = req.body as Partial<CronJobCreate>;

      if (!body.agentId || !body.name) {
        res.status(400).json({ error: 'Required fields: agentId, name' });
        return;
      }

      if (!checkJobAccess(req, res, body.agentId)) return;

      if (knownAgentIds && !knownAgentIds.has(body.agentId)) {
        res.status(404).json({ error: `Agent '${body.agentId}' not found` });
        return;
      }

      const scheduleKind = body.scheduleKind ?? 'cron';
      const type = body.type ?? 'command';

      // Schedule validation
      if (scheduleKind === 'cron' && !body.schedule) {
        res.status(400).json({ error: 'schedule is required for scheduleKind=cron' });
        return;
      }
      if (scheduleKind === 'at' && !body.scheduleAt) {
        res.status(400).json({ error: 'scheduleAt is required for scheduleKind=at' });
        return;
      }
      if (scheduleKind === 'at' && body.scheduleAt && isNaN(Date.parse(body.scheduleAt))) {
        res.status(400).json({ error: `Invalid ISO-8601 timestamp: "${body.scheduleAt}"` });
        return;
      }
      // Payload validation
      if (type === 'command' && !body.command) {
        res.status(400).json({ error: 'command is required for type=command' });
        return;
      }
      if (type === 'agent' && !body.prompt) {
        res.status(400).json({ error: 'prompt is required for type=agent' });
        return;
      }
      // Note: telegram/discord are optional for type=agent. A channel-less job still
      // runs and persists its result to Run History (executeJob → appendRunLog is
      // unconditional; delivery is skipped when no channel is set). See #253.

      try {
        const job = await manager.create(body as CronJobCreate);
        res.status(201).json({ job });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    },
  );

  // Get single job
  defineRoute(
    router,
    { method: 'GET', path: '/v1/crons/:id', auth: 'key', summary: 'Get a single cron job', cli: { noun: 'crons', verb: 'get', args: ['id'] } },
    (req: Request, res: Response) => {
      const job = manager.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (!checkJobAccess(req, res, job.agentId)) return;
      res.json({ job });
    },
  );

  // Update job
  defineRoute(
    router,
    {
      method: 'PUT',
      path: '/v1/crons/:id',
      auth: 'key',
      summary: 'Update a cron job',
      cli: {
        noun: 'crons',
        verb: 'update',
        args: ['id'],
        // Declared so the fields are reachable as flags at all. Without them the
        // CLI had nothing to build a body from, so `crons update <id> --name x`
        // sent an empty PUT that the manager applied as a no-op and the CLI
        // printed as success. Mirrors CronJobUpdate; `agentId` is absent because
        // ownership is not transferable.
        flags: [
          { name: 'name', in: 'body', description: 'Job name' },
          { name: 'type', in: 'body', description: 'command | agent' },
          { name: 'schedule', in: 'body', description: '5-field cron expression (scheduleKind=cron)' },
          { name: 'scheduleKind', in: 'body', description: 'cron | at' },
          { name: 'scheduleAt', in: 'body', description: 'ISO-8601 timestamp (scheduleKind=at)' },
          { name: 'timezone', in: 'body', description: 'IANA timezone for the schedule' },
          { name: 'command', in: 'body', description: 'Shell command (type=command)' },
          { name: 'prompt', in: 'body', description: 'Agent prompt (type=agent)' },
          { name: 'telegram', in: 'body', description: 'Telegram chat id for the result' },
          { name: 'discord', in: 'body', description: 'Discord channel id for the result' },
          { name: 'timeoutMs', in: 'body', description: 'Per-run timeout in milliseconds' },
          { name: 'deleteAfterRun', in: 'body', boolean: true, description: 'Delete the job after its next run' },
          { name: 'enabled', in: 'body', boolean: true, description: 'Enable or disable the job' },
        ],
      },
    },
    async (req: Request, res: Response) => {
      const job = manager.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (!checkJobAccess(req, res, job.agentId)) return;
      try {
        const updated = await manager.update(req.params.id, req.body as CronJobUpdate);
        res.json({ job: updated });
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('not found')) {
          res.status(404).json({ error: message });
        } else {
          res.status(400).json({ error: message });
        }
      }
    },
  );

  // Delete job
  defineRoute(
    router,
    { method: 'DELETE', path: '/v1/crons/:id', auth: 'key', summary: 'Delete a cron job', cli: { noun: 'crons', verb: 'delete', args: ['id'] } },
    async (req: Request, res: Response) => {
      const job = manager.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (!checkJobAccess(req, res, job.agentId)) return;
      try {
        await manager.remove(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        const message = (err as Error).message;
        res.status(500).json({ error: message });
      }
    },
  );

  // Manual trigger
  defineRoute(
    router,
    { method: 'POST', path: '/v1/crons/:id/run', auth: 'key', summary: 'Trigger a cron job now', cli: { noun: 'crons', verb: 'run', args: ['id'] } },
    async (req: Request, res: Response) => {
      const job = manager.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (!checkJobAccess(req, res, job.agentId)) return;
      try {
        const log = await manager.run(req.params.id);
        res.json({ run: log });
      } catch (err) {
        const message = (err as Error).message;
        res.status(500).json({ error: message });
      }
    },
  );

  // Run history
  defineRoute(
    router,
    {
      method: 'GET',
      path: '/v1/crons/:id/runs',
      auth: 'key',
      summary: 'Get cron job run history',
      cli: { noun: 'crons', verb: 'runs', args: ['id'], flags: [{ name: 'limit', in: 'query', description: 'Max runs to return (default 20)' }] },
    },
    async (req: Request, res: Response) => {
      const job = manager.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      if (!checkJobAccess(req, res, job.agentId)) return;
      const limit = parseInt(req.query.limit as string) || 20;
      try {
        const runs = await manager.getRuns(req.params.id, limit);
        res.json({ runs });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  return router;
}
