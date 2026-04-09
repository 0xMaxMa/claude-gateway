import { Router, Request, Response } from 'express';
import { CronManager } from './cron-manager';
import { CronJobCreate, CronJobUpdate } from './types';

/**
 * Creates Express routes for managing persistent cron jobs.
 *
 * Routes:
 *   GET    /v1/crons           — List all jobs (optional ?agent= filter)
 *   GET    /v1/crons/status    — Overall scheduler status
 *   POST   /v1/crons           — Create a new job
 *   GET    /v1/crons/:id       — Get a single job
 *   PUT    /v1/crons/:id       — Update a job
 *   DELETE /v1/crons/:id       — Delete a job
 *   POST   /v1/crons/:id/run   — Trigger a job manually
 *   GET    /v1/crons/:id/runs  — Get run history
 */
export function createCronRouter(manager: CronManager): Router {
  const router = Router();

  // List jobs
  router.get('/v1/crons', (_req: Request, res: Response) => {
    const agentId = _req.query.agent as string | undefined;
    const jobs = manager.list(agentId);
    res.json({ jobs });
  });

  // Overall status
  router.get('/v1/crons/status', (_req: Request, res: Response) => {
    res.json(manager.status());
  });

  // Create job
  router.post('/v1/crons', async (req: Request, res: Response) => {
    const body = req.body as Partial<CronJobCreate>;

    if (!body.agentId || !body.name || !body.schedule || !body.command) {
      res.status(400).json({
        error: 'Required fields: agentId, name, schedule, command',
      });
      return;
    }

    try {
      const job = await manager.create(body as CronJobCreate);
      res.status(201).json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Get single job
  router.get('/v1/crons/:id', (req: Request, res: Response) => {
    const job = manager.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ job });
  });

  // Update job
  router.put('/v1/crons/:id', async (req: Request, res: Response) => {
    try {
      const job = await manager.update(req.params.id, req.body as CronJobUpdate);
      res.json({ job });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(400).json({ error: message });
      }
    }
  });

  // Delete job
  router.delete('/v1/crons/:id', async (req: Request, res: Response) => {
    try {
      await manager.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // Manual trigger
  router.post('/v1/crons/:id/run', async (req: Request, res: Response) => {
    try {
      const log = await manager.run(req.params.id);
      res.json({ run: log });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // Run history
  router.get('/v1/crons/:id/runs', async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    try {
      const runs = await manager.getRuns(req.params.id, limit);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
