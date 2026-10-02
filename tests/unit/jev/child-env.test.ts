import { sanitizeJevChildEnv, jevCredentialEnvNames } from '../../../src/jev/child-env';
import { validateJevConfig } from '../../../src/jev/validation';
test('removes vendor keys after overlays without mutating gateway or CLI auth', () => {
  const env={TYPESAFE_API_KEY:'a',JEV_API_KEY:'b',PRIVATE_JEV_TOKEN:'c',ANTHROPIC_API_KEY:'claude',OPENAI_API_KEY:'codex',GATEWAY_CODEX_API_KEY:'worker',HOME:'/home/user'};
  expect(sanitizeJevChildEnv(env,{apiKeyEnv:'PRIVATE_JEV_TOKEN'})).toEqual({TYPESAFE_API_KEY:'a',JEV_API_KEY:'b',ANTHROPIC_API_KEY:'claude',OPENAI_API_KEY:'codex',GATEWAY_CODEX_API_KEY:'worker',HOME:'/home/user'});
  expect(env.PRIVATE_JEV_TOKEN).toBe('c');
  expect(sanitizeJevChildEnv(env,{enabled:true,provider:'typesafe',model:'jev'})).toEqual({JEV_API_KEY:'b',ANTHROPIC_API_KEY:'claude',OPENAI_API_KEY:'codex',GATEWAY_CODEX_API_KEY:'worker',HOME:'/home/user'});
  expect(jevCredentialEnvNames()).toEqual(expect.arrayContaining(['TYPESAFE_API_KEY','PRIVATE_JEV_TOKEN']));
});
test.each(['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','CODEX_HOME','GATEWAY_CODEX_API_KEY','PATH','HOME','BASH_ENV'])('rejects reserved credential reference %s rather than stripping native authentication/control', apiKeyEnv => {
  expect(()=>validateJevConfig({enabled:true,provider:'typesafe',model:'jev',apiKeyEnv})).toThrow('dedicated credential');
  expect(()=>sanitizeJevChildEnv({}, {apiKeyEnv})).toThrow('dedicated credential');
});
test('allows explicitly dedicated names and keeps disabled config credential isolation', () => {
  expect(()=>validateJevConfig({enabled:true,provider:'typesafe',model:'jev',apiKeyEnv:'GATEWAY_JEV_API_KEY'})).not.toThrow();
  expect(sanitizeJevChildEnv({PRIVATE_JEV_KEY:'hidden'},{enabled:false,apiKeyEnv:'PRIVATE_JEV_KEY'})).toEqual({});
});

test('retains credential-name isolation across configuration reload and disablement', () => {
  validateJevConfig({enabled:true,provider:'typesafe',model:'jev',apiKeyEnv:'RETIRED_EVALUATOR_TOKEN'});
  validateJevConfig({enabled:true,provider:'typesafe',model:'jev',apiKeyEnv:'REPLACEMENT_EVALUATOR_TOKEN'});
  expect(sanitizeJevChildEnv({RETIRED_EVALUATOR_TOKEN:'old',REPLACEMENT_EVALUATOR_TOKEN:'new',NATIVE_UNRELATED:'kept'},{enabled:false})).toEqual({NATIVE_UNRELATED:'kept'});
});

test('vendor default key names stay available to other children unless Jev owns them', () => {
  jest.isolateModules(() => {
    const { sanitizeJevChildEnv: sanitize } = require('../../../src/jev/child-env') as typeof import('../../../src/jev/child-env');
    const env = { TYPESAFE_API_KEY: 'mcp', JEV_API_KEY: 'other', JEV_TEXT_API_KEY: 'text', UNRELATED: 'kept' };
    // No Jev configuration: another MCP connector may legitimately use these names.
    expect(sanitize(env)).toEqual(env);
    expect(sanitize(env, { enabled: true, provider: 'typesafe', model: 'jev', apiKeyFile: '/run/jev-key' })).toEqual(env);
    expect(sanitize(env, { enabled: true, provider: 'typesafe', model: 'jev', apiKeyEnv: 'GATEWAY_JEV_API_KEY' })).toEqual(env);
    // Jev reads TYPESAFE_API_KEY by default; from then on it is private for the process lifetime.
    const owned = { TYPESAFE_API_KEY: 'jev', JEV_API_KEY: 'other', JEV_TEXT_API_KEY: 'text', UNRELATED: 'kept' };
    expect(sanitize(owned, { enabled: true, provider: 'typesafe', model: 'jev' })).toEqual({ JEV_API_KEY: 'other', JEV_TEXT_API_KEY: 'text', UNRELATED: 'kept' });
    expect(sanitize(owned)).toEqual({ JEV_API_KEY: 'other', JEV_TEXT_API_KEY: 'text', UNRELATED: 'kept' });
  });
});
