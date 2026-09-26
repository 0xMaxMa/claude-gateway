import { sanitizeJevChildEnv, jevCredentialEnvNames } from '../../../src/jev/child-env';
import { validateJevConfig } from '../../../src/jev/validation';
test('removes vendor keys after overlays without mutating gateway or CLI auth', () => {
  const env={TYPESAFE_API_KEY:'a',JEV_API_KEY:'b',PRIVATE_JEV_TOKEN:'c',ANTHROPIC_API_KEY:'claude',OPENAI_API_KEY:'codex',GATEWAY_CODEX_API_KEY:'worker',HOME:'/home/user'};
  expect(sanitizeJevChildEnv(env,{apiKeyEnv:'PRIVATE_JEV_TOKEN'})).toEqual({ANTHROPIC_API_KEY:'claude',OPENAI_API_KEY:'codex',GATEWAY_CODEX_API_KEY:'worker',HOME:'/home/user'});
  expect(env.PRIVATE_JEV_TOKEN).toBe('c');
  expect(jevCredentialEnvNames()).toEqual(expect.arrayContaining(['TYPESAFE_API_KEY','JEV_API_KEY']));
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
