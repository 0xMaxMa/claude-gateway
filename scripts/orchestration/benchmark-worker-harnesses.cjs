#!/usr/bin/env node
'use strict';
// Opt-in, billable native CLI smoke benchmark; deliberately not a gateway benchmark.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (!args.includes('--run')) {
  console.log('Opt-in real calls: node scripts/orchestration/benchmark-worker-harnesses.cjs --run [--claude-model sonnet] [--codex-model gpt-5.6-luna] [--claude-base-url URL --claude-api-key-env ENV_NAME] [--codex-base-url URL --codex-api-key-env ENV_NAME] [--host-execution] [--output /tmp/worker-benchmark.json]');
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-worker-benchmark-'));
fs.chmodSync(root, 0o700);
const prompt = 'Implement sumIntegers(values) in sum.cjs, exporting { sumIntegers }. Accept an array of safe integers and return its sum. Throw TypeError for non-arrays or invalid elements and RangeError if any intermediate sum is not a safe integer. Empty arrays return 0. Use built-in Node only. Run a small Node verification. Modify only sum.cjs in this directory; do not inspect parent directories or credentials. Finish with a brief summary.';
const harness = `const assert=require('node:assert/strict');const {sumIntegers:s}=require(process.argv[1]);assert.equal(s([]),0);assert.equal(s([1,2,-3,4]),4);assert.equal(s([-4,-2]),-6);for(const x of [null,{},'1',[1.2],[NaN],[Infinity],['1'],[Number.MAX_SAFE_INTEGER+1]])assert.throws(()=>s(x),TypeError);assert.throws(()=>s([Number.MAX_SAFE_INTEGER,1]),RangeError);assert.throws(()=>s([-Number.MAX_SAFE_INTEGER,-1]),RangeError);`;
function execute(bin, argv, cwd, env) {
  return new Promise(resolve => {
    const started = Date.now(); let output = '', timedOut = false, spawnError = false;
    const p = spawn(bin, argv, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const kill = () => { try { process.platform === 'win32' ? p.kill('SIGKILL') : process.kill(-p.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 120000);
    p.stdout.on('data', b => { if (output.length < 8 * 1024 * 1024) output += b; else kill(); });
    // Never persist stderr: providers may echo account/endpoint/auth information.
    p.stderr.resume();
    p.on('error', () => { spawnError = true; });
    p.on('close', code => { clearTimeout(timer); kill(); resolve({ code, timedOut, spawnError, wallMs: Date.now() - started, output }); });
    p.stdin.on('error', () => {}); p.stdin.end(prompt);
  });
}
function metrics(harness, text) {
  const result = { inputTokens: null, cachedInputTokens: null, cacheCreationTokens: null, outputTokens: null, toolErrors: 0, providerErrors: 0, failureCategory: null, toolCalls: 0 };
  for (const line of text.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const diagnostic = JSON.stringify(event);
    if (event.is_error || event.type === 'error' || event.type === 'turn.failed') {
      result.failureCategory = /auth|token|credential|401|403/i.test(diagnostic) ? 'authentication' : /model.*(not|invalid|unknown)|unsupported.*model/i.test(diagnostic) ? 'model_unavailable' : /permission|sandbox|denied/i.test(diagnostic) ? 'permission' : 'provider_or_cli';
    }
    if (harness === 'codex') {
      if (event.type === 'item.completed' && ['command_execution','mcp_tool_call','file_change'].includes(event.item?.type)) result.toolCalls++;
      if (event.type === 'turn.completed' && event.usage) {
        result.inputTokens = event.usage.input_tokens ?? null;
        result.cachedInputTokens = event.usage.cached_input_tokens ?? null;
        result.outputTokens = event.usage.output_tokens ?? null;
      }
      if (event.type === 'item.completed' && (event.item?.status === 'failed' || (typeof event.item?.exit_code === 'number' && event.item.exit_code !== 0))) result.toolErrors++;
      if (event.type === 'turn.failed' || event.type === 'error') result.providerErrors++;
    } else {
      if (event.type === 'result') {
        const u = event.usage ?? {};
        result.inputTokens = u.input_tokens ?? null;
        result.cachedInputTokens = u.cache_read_input_tokens ?? null;
        result.cacheCreationTokens = u.cache_creation_input_tokens ?? null;
        result.outputTokens = u.output_tokens ?? null;
        if (event.is_error) result.providerErrors++;
      }
      for (const block of event.message?.content ?? []) if (block.type === 'tool_use') result.toolCalls++;
      for (const block of event.message?.content ?? []) if (block.type === 'tool_result' && block.is_error) result.toolErrors++;
    }
  }
  // Codex includes cache reads in input_tokens; Claude reports disjoint input categories.
  result.freshInputTokens = result.inputTokens === null ? null : harness === 'codex'
    ? Math.max(0, result.inputTokens - (result.cachedInputTokens ?? 0)) : result.inputTokens;
  result.totalInputTokens = result.inputTokens === null ? null : harness === 'codex'
    ? result.inputTokens : result.inputTokens + (result.cachedInputTokens ?? 0) + (result.cacheCreationTokens ?? 0);
  return result;
}
(async () => {
  let settings = {}; try { settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')); } catch {}
  const claudeEnv = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL']) if (!claudeEnv[key] && typeof settings.env?.[key] === 'string') claudeEnv[key] = settings.env[key];
  const claudeKeyEnv = option('--claude-api-key-env');
  if (claudeKeyEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(claudeKeyEnv) || !process.env[claudeKeyEnv]) throw new Error('Missing explicit Claude credential');
    delete claudeEnv.ANTHROPIC_AUTH_TOKEN;
    delete claudeEnv.CLAUDE_CODE_OAUTH_TOKEN;
    claudeEnv.ANTHROPIC_API_KEY = process.env[claudeKeyEnv];
  }
  if (option('--claude-base-url')) claudeEnv.ANTHROPIC_BASE_URL = option('--claude-base-url');
  const codexKeyEnv = option('--codex-api-key-env', 'OPENAI_API_KEY');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(codexKeyEnv)) throw new Error('Invalid credential environment name');
  const codexEnv = { ...process.env }; // CLI reads existing auth in-place; never copy it.
  const routes = [
    { harness: 'claude', bin: process.env.CLAUDE_BIN || 'claude', model: option('--claude-model','sonnet'), env: claudeEnv,
      auth: ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'].some(k => claudeEnv[k]) || fs.existsSync(path.join(os.homedir(),'.claude','.credentials.json')) },
    { harness: 'codex', bin: process.env.CODEX_BIN || 'codex', model: option('--codex-model','gpt-5.6-luna'), env: codexEnv,
      auth: Boolean(codexEnv[codexKeyEnv]) || (!option('--codex-base-url') && fs.existsSync(path.join(codexEnv.CODEX_HOME || path.join(os.homedir(),'.codex'),'auth.json'))) },
  ];
  const report = { kind: 'native-cli-smoke', codexSandbox: args.includes('--host-execution') ? 'danger-full-access' : 'workspace-write', note: 'Different models/provider/account routes may apply. Not a controlled timing/cost A/B, gateway integration test, or quality-parity claim. CLI token accounting differs; null means unavailable.', runs: [] };
  for (const route of routes) {
    if (!route.auth) { report.runs.push({ harness: route.harness, model: route.model, status: 'skipped_missing_credentials' }); continue; }
    const cwd = path.join(root,route.harness); fs.mkdirSync(cwd, {mode:0o700});
    fs.writeFileSync(path.join(cwd,'sum.cjs'),'module.exports = { sumIntegers() { throw new Error("TODO"); } };\n');
    const argv = route.harness === 'codex'
      ? ['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--json','--sandbox',args.includes('--host-execution') ? 'danger-full-access' : 'workspace-write','-c','project_doc_max_bytes=0','-c','approval_policy="never"','-c','model_reasoning_effort="medium"','--model',route.model,'-']
      : ['--print',...(claudeKeyEnv ? ['--bare','--setting-sources',''] : []),'--no-session-persistence','--output-format','stream-json','--verbose','--model',route.model,'--permission-mode','bypassPermissions','--tools','Read,Edit,Write,Bash','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'];
    if (route.harness === 'codex' && option('--codex-base-url')) {
      const url = new URL(option('--codex-base-url'));
      if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid endpoint');
      argv.splice(argv.length - 1, 0, '-c', 'model_provider="benchmark"', '-c', 'model_providers.benchmark.name="Benchmark"', '-c', 'model_providers.benchmark.wire_api="responses"', '-c', 'model_providers.benchmark.base_url=' + JSON.stringify(url.href), '-c', 'model_providers.benchmark.env_key=' + JSON.stringify(codexKeyEnv));
    }
    const run = await execute(route.bin,argv,cwd,route.env);
    const checked = spawnSync(process.execPath,['-e',harness,path.join(cwd,'sum.cjs')],{timeout:5000,encoding:'utf8'});
    report.runs.push({harness:route.harness,model:route.model,status:run.spawnError?'cli_unavailable':run.timedOut?'timeout':run.code===0?'finished':'cli_failed',exitCode:run.code,wallMs:run.wallMs,correctnessPassed:checked.status===0,validationFailure:checked.status===0?null:checked.error?'harness_error':(checked.stderr?.match(/(?:AssertionError|TypeError|RangeError|SyntaxError|ReferenceError|MODULE_NOT_FOUND)/)?.[0] ?? 'test_failed'),...metrics(route.harness,run.output)});
  }
  const json = JSON.stringify(report,null,2)+'\n';
  if (option('--output')) fs.writeFileSync(option('--output'),json,{mode:0o600});
  process.stdout.write(json);
  process.exitCode = report.runs.every(r=>r.status==='finished'&&r.correctnessPassed&&r.providerErrors===0) ? 0 : 1;
})().catch(() => { console.error('Benchmark failed; raw provider output suppressed.'); process.exitCode=1; }).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
