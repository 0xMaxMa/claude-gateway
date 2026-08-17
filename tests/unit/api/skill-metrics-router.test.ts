import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as supertest from 'supertest';
import { createSkillsRouter } from '../../../src/api/skills-router';
import { HistoryDB } from '../../../src/history/db';
import { SkillLearningManager } from '../../../src/agent/skill-learning';
import type { AgentConfig, ApiKey } from '../../../src/types';
import type { AgentRunner } from '../../../src/agent/runner';

const AGENT_ID = 'metrics-agent';
const READ_KEY: ApiKey = { key: 'sk-read', agents: [AGENT_ID] };
const OTHER_KEY: ApiKey = { key: 'sk-other', agents: ['someone-else'] };
const ALL_KEYS = [READ_KEY, OTHER_KEY];

function buildApp(workspace: string, withManager: boolean) {
  const config: AgentConfig = {
    id: AGENT_ID,
    description: 'test',
    workspace,
    env: '',
    telegram: { botToken: 'tok' },
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
  const configs = new Map([[AGENT_ID, config]]);

  let agents: Map<string, AgentRunner> | undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-router-'));
  if (withManager) {
    const db = HistoryDB.forAgent(dir, AGENT_ID);
    db.recordSkillCreated({ name: 'learned', origin: 'auto', createdAt: 1, createdFromSession: 's', pinned: 0 });
    const mgr = new SkillLearningManager({ db, agentId: AGENT_ID, workspaceDir: workspace });
    const stubRunner = {
      getSkillLearning: () => mgr,
      getSkillRegistry: () => ({ skills: new Map() }),
    } as unknown as AgentRunner;
    agents = new Map([[AGENT_ID, stubRunner]]);
  }

  const app = express();
  app.use(express.json());
  app.use('/api', createSkillsRouter(configs, ALL_KEYS, agents));
  return { app, dir };
}

describe('GET /api/v1/agents/:id/skill-metrics', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-router-ws-'));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const url = `/api/v1/agents/${AGENT_ID}/skill-metrics`;

  it('401 without an API key', async () => {
    const { app } = buildApp(workspace, true);
    const res = await supertest.default(app).get(url);
    expect(res.status).toBe(401);
  });

  it('403 for a key without access to the agent', async () => {
    const { app } = buildApp(workspace, true);
    const res = await supertest.default(app).get(url).set({ Authorization: `Bearer ${OTHER_KEY.key}` });
    expect(res.status).toBe(403);
  });

  it('404 when skill-learning is not active for the agent', async () => {
    const { app } = buildApp(workspace, false);
    const res = await supertest.default(app).get(url).set({ Authorization: `Bearer ${READ_KEY.key}` });
    expect(res.status).toBe(404);
  });

  it('200 returns the rollup shape for an authorized key', async () => {
    const { app } = buildApp(workspace, true);
    const res = await supertest.default(app).get(url).set({ Authorization: `Bearer ${READ_KEY.key}` });
    expect(res.status).toBe(200);
    expect(res.body.adoption.autoSkills).toBe(1);
    expect(res.body.netTokens).toHaveProperty('net');
    expect(res.body.cohort).toHaveProperty('enabledTurns');
  });
});

describe('DELETE /api/v1/agents/:id/skills/:name reconciles skill_stats', () => {
  it('clears the auto skill_stats row so no orphan remains', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-del-ws-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-del-'));
    const db = HistoryDB.forAgent(dir, AGENT_ID);
    // Auto skill present both on disk and in skill_stats.
    fs.mkdirSync(path.join(workspace, 'skills', 'learned'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'skills', 'learned', 'SKILL.md'), '---\nname: learned\ndescription: "x"\norigin: auto\n---\nbody\n', 'utf-8');
    db.recordSkillCreated({ name: 'learned', origin: 'auto', createdAt: 1, createdFromSession: 's', pinned: 0 });
    expect(db.getSkillStat('learned')).not.toBeNull();

    const config: AgentConfig = {
      id: AGENT_ID, description: 't', workspace, env: '',
      telegram: { botToken: 'tok' },
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    };
    const stubRunner = {
      getHistoryDb: () => db,
      setSkillRegistry: () => {},
    } as unknown as AgentRunner;
    const WRITE_KEY: ApiKey = { key: 'sk-write', write: true, agents: [AGENT_ID] };

    const app = express();
    app.use(express.json());
    app.use('/api', createSkillsRouter(new Map([[AGENT_ID, config]]), [WRITE_KEY], new Map([[AGENT_ID, stubRunner]])));

    const res = await supertest.default(app)
      .delete(`/api/v1/agents/${AGENT_ID}/skills/learned`)
      .set('Authorization', 'Bearer sk-write');

    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(workspace, 'skills', 'learned', 'SKILL.md'))).toBe(false);
    expect(db.getSkillStat('learned')).toBeNull(); // stat row reconciled

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
