import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {thinkingProvider} from '../../../src/jev/thinking-provider';
import {validateBrowserIntegration} from '../../../src/jev/browser-connector';
import {validateJevConfig} from '../../../src/jev/validation';

const file=join(mkdtempSync(join(tmpdir(),'think-auth-')),'key');writeFileSync(file,'fixture-key');
const helper={api:'anthropic-messages' as const,baseUrl:'https://proxy.example/v1',model:'small',apiKeyFile:file};

test('thinkingProvider carries the configured authScheme to the helper',async()=>{
 await expect(thinkingProvider({...helper,authScheme:'bearer'} as never)).resolves.toMatchObject({authScheme:'bearer'});
 await expect(thinkingProvider(helper)).resolves.not.toHaveProperty('authScheme','bearer');
});
test('textHelper validation accepts authScheme only as x-api-key|bearer on anthropic-messages',()=>{
 expect(()=>validateBrowserIntegration({bindings:[],textHelper:{...helper,authScheme:'bearer'}})).not.toThrow();
 expect(()=>validateJevConfig({thinking:{...helper,authScheme:'bearer'}} as never)).not.toThrow();
 expect(()=>validateBrowserIntegration({bindings:[],textHelper:{...helper,authScheme:'oauth'}} as never)).toThrow();
 expect(()=>validateBrowserIntegration({bindings:[],textHelper:{...helper,api:'openai-chat',authScheme:'bearer'}})).toThrow();
});
