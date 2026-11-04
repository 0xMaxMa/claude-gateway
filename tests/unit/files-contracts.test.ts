import Ajv2020 from 'ajv/dist/2020';
import * as fs from 'fs';
import * as path from 'path';
import { FILES_ERRORS } from '../../src/api/files-router';
import { PROCESSES_ERRORS } from '../../src/api/processes-router';
import { SESSION_CWD_ERRORS } from '../../src/api/router';
import { CONTRACTS_DIR, Fixture, FIXTURES_DIR, recordFixtures, SchemaName } from '../../scripts/contracts-fixtures';

const SCHEMA_FILES: Record<SchemaName, string> = {
  FilesList: 'files-list', FilesMkdirResponse: 'files-mkdir-response', FilesDeleteResponse: 'files-delete-response',
  GitStatus: 'git-status', GitSummary: 'git-summary', Capabilities: 'capabilities', Error: 'error',
  SessionCreateResponse: 'session-create-response', SessionList: 'session-list', SessionError: 'session-error',
  ProcessesList: 'processes-list', ProcessesFolder: 'processes-folder', ProcessesStartResponse: 'processes-start-response',
  ProcessesStopResponse: 'processes-stop-response', ProcessesError: 'processes-error',
};
const REQUEST_SCHEMAS: Record<string, string> = {
  'POST /api/v1/files/mkdir': 'files-mkdir-request', 'DELETE /api/v1/files': 'files-delete-request',
  'POST /api/v1/processes/start': 'processes-start-request', 'POST /api/v1/processes/stop': 'processes-stop-request',
};

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

function committedFixtures(): Record<string, Fixture> {
  const out: Record<string, Fixture> = {};
  for (const dir of fs.readdirSync(FIXTURES_DIR)) {
    for (const file of fs.readdirSync(path.join(FIXTURES_DIR, dir))) out[`${dir}/${file}`] = readJson(path.join(FIXTURES_DIR, dir, file)) as Fixture;
  }
  return out;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const file of fs.readdirSync(path.join(CONTRACTS_DIR, 'schemas'))) ajv.addSchema(readJson(path.join(CONTRACTS_DIR, 'schemas', file)) as object);
const validate = (name: string, value: unknown): string[] => {
  const fn = ajv.getSchema(`https://claude-gateway.dev/contracts/files-git/${name}.schema.json`)!;
  return fn(value) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

const fixtures = committedFixtures();

describe('files and git contracts', () => {
  it.each(Object.entries(fixtures))('%s matches its schema', (_name, fixture) => {
    expect(validate(SCHEMA_FILES[fixture.schema], fixture.body)).toEqual([]);
    const requestSchema = REQUEST_SCHEMAS[`${fixture.request.method} ${fixture.request.url}`];
    if (requestSchema && fixture.status < 400) expect(validate(requestSchema, fixture.request.body)).toEqual([]);
  });

  it('records the committed fixtures from the routers as they are now (rerun npm run contracts:fixtures on a change)', async () => {
    expect(await recordFixtures()).toEqual(fixtures);
  }, 60_000);

  it('records an error fixture for the success and the failure side of every route', () => {
    const routes = new Set(Object.keys(fixtures).map((f) => f.split('/')[0]));
    expect([...routes].sort()).toEqual(['capabilities', 'errors', 'files-delete', 'files-list', 'files-mkdir', 'git-status', 'git-summary', 'processes-list', 'processes-start', 'processes-stop', 'sessions-create', 'sessions-list']);
    for (const route of ['files-delete', 'files-list', 'files-mkdir', 'git-status', 'sessions-create']) {
      const statuses = Object.entries(fixtures).filter(([f]) => f.startsWith(`${route}/`)).map(([, x]) => x.status);
      expect([route, statuses.some((s) => s < 300), statuses.some((s) => s >= 400)]).toEqual([route, true, true]);
    }
  });

  it('covers every process-specific error code and its HTTP status', () => {
    const errors = Object.values(fixtures).filter((f) => f.schema === 'ProcessesError');
    expect(new Set(errors.map((f) => (f.body as { code: string }).code))).toEqual(new Set([
      'invalid_port', 'invalid_script', 'invalid_executable', 'no_start_command', 'already_running',
      'port_in_use', 'no_free_port', 'start_failed',
    ]));
    expect(errors.find((f) => (f.body as { starting?: boolean }).starting)?.status).toBe(409);
    for (const fixture of errors) {
      const body = fixture.body as { code: keyof typeof PROCESSES_ERRORS; error: string };
      expect(fixture.status).toBe(PROCESSES_ERRORS[body.code].status);
      expect(body.error).toBe(PROCESSES_ERRORS[body.code].message);
    }
    for (const [name, fixture] of Object.entries(fixtures).filter(([name]) => name.startsWith('processes-start/'))) {
      const caseName = name.split('/')[1].replace(/\.json$/, '');
      const expected = caseName === 'already_running_starting' ? 'already_running' : caseName;
      if (expected !== 'started') expect((fixture.body as { code: string }).code).toBe(expected);
    }
    expect(fixtures['processes-start/already_running_starting.json']!.body).toMatchObject({ starting: true });
    expect(fixtures['processes-start/started.json']!.status).toBe(202);
    expect(fixtures['processes-stop/stopped.json']!.status).toBe(200);
  });

  it('documents each process-specific error code', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../website/api/processes.md'), 'utf8');
    for (const code of ['invalid_port', 'invalid_script', 'invalid_executable', 'no_start_command',
      'already_running', 'port_in_use', 'no_free_port', 'start_failed']) {
      expect(doc).toContain(`\`${code}\``);
    }
  });

  it('rejects a body with a field missing, an extra field or an unknown error code', () => {
    const entry = (fixtures['files-list/root.json']!.body as { entries: Record<string, unknown>[] }).entries[0]!;
    const { abs: _abs, ...withoutAbs } = entry;
    expect(validate('files-list', { root: '/r', exists: true, path: '', abs: '/r', entries: [withoutAbs] })).not.toEqual([]);
    expect(validate('files-list', { root: '/r', exists: true, path: '', abs: '/r', entries: [{ ...entry, extra: 1 }] })).not.toEqual([]);
    expect(validate('files-list', { root: '/r', exists: true, path: '../x', abs: '/r', entries: [] })).not.toEqual([]);
    expect(validate('error', { error: 'x', code: 'project_exists' })).not.toEqual([]);
    expect(validate('git-status', { ...(fixtures['git-status/repo.json']!.body as object), remote: { name: 'origin', url: 'https://u:t@github.com/a/b.git', host: 'github', web_url: null } })).not.toEqual([]);
  });

  it('lists exactly the error codes the router answers, and every fixture status agrees with the table', () => {
    const schema = readJson(path.join(CONTRACTS_DIR, 'schemas', 'error.schema.json')) as { properties: { code: { enum: string[] } } };
    expect([...schema.properties.code.enum].sort()).toEqual(Object.keys(FILES_ERRORS).sort());
    for (const [name, f] of Object.entries(fixtures)) {
      if (f.schema === 'Error') expect([name, f.status]).toEqual([name, FILES_ERRORS[(f.body as { code: keyof typeof FILES_ERRORS }).code].status]);
    }
  });

  it('lists exactly the session cwd error codes the sessions route answers, with their statuses', () => {
    const schema = readJson(path.join(CONTRACTS_DIR, 'schemas', 'session-error.schema.json')) as { properties: { code: { enum: string[] } } };
    expect([...schema.properties.code.enum].sort()).toEqual(Object.keys(SESSION_CWD_ERRORS).sort());
    for (const [name, f] of Object.entries(fixtures)) {
      if (f.schema === 'SessionError') expect([name, f.status]).toEqual([name, SESSION_CWD_ERRORS[(f.body as { code: keyof typeof SESSION_CWD_ERRORS }).code].status]);
    }
  });

  it('documents every error code once in website/api/files.md, with the status the router answers', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../website/api/files.md'), 'utf8');
    const table = doc.slice(doc.indexOf('## Errors'), doc.indexOf('\n## ', doc.indexOf('## Errors') + 1));
    const rows = [...table.matchAll(/^\| (\d{3}) \| `(\w+)` \|/gm)].map(([, status, code]) => [code, Number(status)]);
    expect(rows.map(([code]) => code).sort()).toEqual(Object.keys(FILES_ERRORS).sort());
    expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(Object.entries(FILES_ERRORS).map(([code, { status }]) => [code, status])));
  });
});
