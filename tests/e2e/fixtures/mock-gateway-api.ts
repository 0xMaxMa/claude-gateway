/**
 * Mock Gateway REST API for E2E testing.
 * Simulates cron job management endpoints matching the real /api/v1/crons routes.
 */

import * as http from 'http';

export type CronJob = {
  id: string;
  agentId: string;
  name: string;
  schedule: string;
  type: string;
  enabled: boolean;
};

export type CronRun = {
  id: string;
  jobId: string;
  status: string;
  startedAt: number;
  finishedAt: number;
};

export class MockGatewayAPI {
  private server: http.Server;
  private crons: CronJob[] = [];
  private runs: CronRun[] = [];
  private nextId = 1;
  port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const rawUrl = req.url ?? '';
        const method = req.method ?? 'GET';
        const [pathname, queryString] = rawUrl.split('?');

        const params = new URLSearchParams(queryString ?? '');

        // Route: GET /api/v1/crons
        if (method === 'GET' && pathname === '/api/v1/crons') {
          const agentFilter = params.get('agent');
          const jobs = agentFilter
            ? this.crons.filter(c => c.agentId === agentFilter)
            : this.crons;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jobs }));
          return;
        }

        // Route: POST /api/v1/crons
        if (method === 'POST' && pathname === '/api/v1/crons') {
          const p = body ? JSON.parse(body) : {};
          const job: CronJob = {
            id: `cron-${this.nextId++}`,
            agentId: p.agentId ?? 'unknown',
            name: p.name ?? 'unnamed',
            schedule: p.schedule ?? '* * * * *',
            type: p.type ?? 'command',
            enabled: true,
          };
          this.crons.push(job);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(job));
          return;
        }

        // Route: DELETE /api/v1/crons/:jobId
        const deleteMatch = pathname.match(/^\/api\/v1\/crons\/([^/]+)$/);
        if (method === 'DELETE' && deleteMatch) {
          const jobId = deleteMatch[1];
          this.crons = this.crons.filter(c => c.id !== jobId);
          res.writeHead(204);
          res.end();
          return;
        }

        // Route: POST /api/v1/crons/:jobId/run
        const runMatch = pathname.match(/^\/api\/v1\/crons\/([^/]+)\/run$/);
        if (method === 'POST' && runMatch) {
          const jobId = runMatch[1];
          const run: CronRun = {
            id: `run-${this.nextId++}`,
            jobId,
            status: 'success',
            startedAt: Date.now(),
            finishedAt: Date.now() + 1000,
          };
          this.runs.push(run);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(run));
          return;
        }

        // Route: GET /api/v1/crons/:jobId/runs
        const runsMatch = pathname.match(/^\/api\/v1\/crons\/([^/]+)\/runs$/);
        if (method === 'GET' && runsMatch) {
          const jobId = runsMatch[1];
          const jobRuns = this.runs.filter(r => r.jobId === jobId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(jobRuns));
          return;
        }

        res.writeHead(404);
        res.end('not found');
      });
    });
  }

  async start(): Promise<void> {
    return new Promise(resolve => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => resolve());
    });
  }

  seedCrons(jobs: CronJob[]): void {
    this.crons = [...jobs];
  }

  getCrons(): CronJob[] {
    return [...this.crons];
  }

  getRuns(): CronRun[] {
    return [...this.runs];
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}
