import fs from 'fs';
import os from 'os';
import path from 'path';
import { splitNativeParams, inspectNativeParams } from '../../../src/safemode/params';
import { parseCliArgs } from '../../../src/cli/args';
import { buildNativeInvocation } from '../../../src/safemode/native';
import { SafemodeStore } from '../../../src/safemode/store';

const id = '11111111-2222-4333-8444-555555555555';
test('quoted --params starting with flags is one CLI value', () => {
  const raw = '--dangerously-bypass-approvals-and-sandbox resume ' + id;
  expect(parseCliArgs(['safemode', '--cli', 'codex', '--params', raw]).flags.params).toBe(raw);
  const parsed = inspectNativeParams('codex', splitNativeParams(raw));
  expect(parsed).toEqual({ args: ['--dangerously-bypass-approvals-and-sandbox'], resumeId: id, resumeIndex: 1 });
  const invocation = buildNativeInvocation({ cli: 'codex', mode: 'interactive', cwd: '/tmp', nativeArgs: parsed.args, nativeResumeIndex: parsed.resumeIndex, resume: true, nativeSessionId: parsed.resumeId });
  expect(invocation.args).toEqual(['--dangerously-bypass-approvals-and-sandbox', 'resume', id, '--cd', '/tmp']);
});
test('quotes preserve spaces and shell syntax stays literal', () => {
  expect(splitNativeParams("--model 'name with spaces' --config x=\"a b\" '' '$HOME; $(touch /tmp/not-run)'")).toEqual(['--model', 'name with spaces', '--config', 'x=a b', '', '$HOME; $(touch /tmp/not-run)']);
  expect(() => splitNativeParams("'open")).toThrow('Unclosed');
  expect(() => splitNativeParams('trailing\\')).toThrow('escape');
});
test('Claude imports an exact native ID without conflicting permission or model flags', () => {
  const parsed = inspectNativeParams('claude', splitNativeParams('--dangerously-skip-permissions --model opus --resume=' + id));
  const result = buildNativeInvocation({ cli: 'claude', mode: 'interactive', cwd: '/tmp', nativeArgs: parsed.args, nativeSessionId: parsed.resumeId, resume: true, model: 'sonnet' });
  expect(result.args).toEqual(['--dangerously-skip-permissions', '--model', 'opus', '--resume', id]);
});
test.each(['codex', 'claude'] as const)('headless %s cannot accept passthrough', cli => {
  expect(() => buildNativeInvocation({ cli, mode: 'headless', cwd: '/tmp', nativeArgs: [] })).toThrow('interactive-only');
});
test.each([
  ['codex', 'resume --last'], ['codex', 'exec --json'], ['codex', '--remote ws://localhost'],
  ['claude', '--resume'], ['claude', '--print'], ['claude', '--fork-session'],
] as const)('rejects untrackable or noninteractive %s args %s', (cli, text) => {
  expect(() => inspectNativeParams(cli, splitNativeParams(text))).toThrow();
});
test('native session binding is unique and released only by its own investigation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safemode-params-'));
  try {
    const store = new SafemodeStore(root);
    const first = store.create('one', 'codex', 'inherit'), second = store.create('two', 'codex', 'inherit');
    first.nativeSessionId = id; store.save(first);
    second.nativeSessionId = id;
    expect(() => store.save(second)).toThrow('already belongs');
    store.removeName(second);
    expect(() => store.save(second)).toThrow('already belongs');
    const firstDir = store.dir(first.id); store.removeName(first); fs.rmSync(firstDir, {recursive: true});
    store.save(second);
    expect(store.read(second.id).nativeSessionId).toBe(id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('option values are not mistaken for native commands', () => {
  expect(inspectNativeParams('codex', ['--model', 'review', '--profile', 'resume']).args).toEqual(['--model', 'review', '--profile', 'resume']);
});
test('Codex resume-specific options remain after the resume subcommand', () => {
  const native = inspectNativeParams('codex', ['--no-alt-screen', 'resume', id, '--all']);
  const inv = buildNativeInvocation({cli:'codex', mode:'interactive', cwd:'/tmp', nativeArgs:native.args,
    nativeResumeIndex: native.resumeIndex, nativeSessionId:native.resumeId, resume:true});
  expect(inv.args).toEqual(['--no-alt-screen', 'resume', id, '--all', '--cd', '/tmp']);
});
