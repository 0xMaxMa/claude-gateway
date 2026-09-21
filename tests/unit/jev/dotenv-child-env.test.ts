import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { managedJevChildEnv } from '../../../src/jev/child-env';

test('managed CLI dotenv bootstrap and real descendant cannot restore vendor credentials; standalone bootstrap is unchanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'jev-dotenv-child-'));
  try {
    mkdirSync(join(home, '.claude-gateway'));
    writeFileSync(join(home, '.claude-gateway', '.env'), [
      'TYPESAFE_API_KEY=vendor-a', 'JEV_API_KEY=vendor-b', 'PRIVATE_BOOTSTRAP_TOKEN=vendor-c',
      'ANTHROPIC_API_KEY=native-claude', 'OPENAI_API_KEY=native-codex',
    ].join('\n'));
    const names = ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'PRIVATE_BOOTSTRAP_TOKEN'];
    const inspect = `console.log(JSON.stringify({vendor:${JSON.stringify(names)}.map(k=>Object.prototype.hasOwnProperty.call(process.env,k)),claude:process.env.ANTHROPIC_API_KEY,codex:process.env.OPENAI_API_KEY}))`;
    const bootstrap = `require(${JSON.stringify(resolve('src/load-dotenv.ts'))}).loadGatewayDotenv();`;
    const script = bootstrap + `process.stdout.write(require('child_process').execFileSync(process.execPath,['-r','ts-node/register/transpile-only','-e',${JSON.stringify(bootstrap + inspect)}]));`;
    const base: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    for (const key of [...names, 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GATEWAY_CHILD_ENV_EXCLUSIONS']) delete base[key];
    const run = (env: NodeJS.ProcessEnv) => JSON.parse(execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], { env, encoding: 'utf8' }));
    const managed = managedJevChildEnv(base, { apiKeyEnv: 'PRIVATE_BOOTSTRAP_TOKEN' });
    // Even a later overlay must not reintroduce the key during CLI bootstrap.
    managed.PRIVATE_BOOTSTRAP_TOKEN = 'overlaid-secret';
    expect(run(managed)).toEqual({ vendor: [false, false, false], claude: 'native-claude', codex: 'native-codex' });
    expect(run(base)).toEqual({ vendor: [true, true, true], claude: 'native-claude', codex: 'native-codex' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
