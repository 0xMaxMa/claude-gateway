import { browserFieldText } from '../../../src/jev/browser-text-helper';
import { validateBrowserIntegration } from '../../../src/jev/browser-connector';
import { sanitizeJevChildEnv } from '../../../src/jev/child-env';
const config={baseUrl:'https://models.example/v1',model:'small',apiKeyEnv:'TEST_BROWSER_TEXT_SECRET'};
beforeEach(()=>{process.env.TEST_BROWSER_TEXT_SECRET='test-key';});
afterEach(()=>{delete process.env.TEST_BROWSER_TEXT_SECRET;});
function response(content:unknown,finish='stop'){return new Response(JSON.stringify({choices:[{finish_reason:finish,message:{content:JSON.stringify(content)}}]}));}
test.each([{text:'Zurich'},{text:null}])('bounded text or missing fact: %j',async value=>{
 const fetcher=jest.fn(async()=>response(value));
 expect(await browserFieldText(config,{goal:'From Zurich',field:{label:'From'}},new AbortController().signal,fetcher)).toEqual(value);
 const args=fetcher.mock.calls as unknown as Array<[string,RequestInit]>;
 const body=JSON.parse(String(args[0][1].body));expect(body.tools).toBeUndefined();expect(args[0][1].redirect).toBe('error');expect(body.messages[0].content).toContain('untrusted');
});
test.each([{text:''},{text:'a'.repeat(2001)},{text:'valid',action:'click'},{text:42},[]])('invalid helper output rejected: %j',async value=>{
 await expect(browserFieldText(config,{},new AbortController().signal,async()=>response(value))).rejects.toThrow('BROWSER_TEXT_INVALID_RESPONSE');
});
test('provider errors do not leak response bodies',async()=>{
 await expect(browserFieldText(config,{},new AbortController().signal,async()=>new Response('private provider body',{status:401}))).rejects.toThrow('BROWSER_TEXT_HTTP_401');
});
test('helper config and credential isolation',()=>{
 validateBrowserIntegration({adapterModule:'runner',bindings:[],textHelper:config});
 expect(()=>validateBrowserIntegration({adapterModule:'runner',bindings:[],textHelper:{...config,apiKeyEnv:'ANTHROPIC_API_KEY'}})).toThrow();
 expect(sanitizeJevChildEnv({TEST_BROWSER_TEXT_SECRET:'test-key'},{browser:{adapterModule:'runner',bindings:[],textHelper:config}})).toEqual({});
});
test('Anthropic messages protocol produces the same bounded field contract',async()=>{
 const fetcher=jest.fn(async()=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:'{"text":"London"}'}]})));
 expect(await browserFieldText({...config,api:'anthropic-messages'},{goal:'To London'},new AbortController().signal,fetcher)).toEqual({text:'London'});
 const args=fetcher.mock.calls as unknown as Array<[string,RequestInit]>;
 expect(args[0][0]).toBe('https://models.example/v1/messages');
 expect(JSON.parse(String(args[0][1].body)).tools).toBeUndefined();
});
test('central Thinking credentials are excluded independently of legacy browser settings',()=>{
 const {validateJevConfig}=require('../../../src/jev/validation');
 validateJevConfig({thinking:config});
 expect(sanitizeJevChildEnv({TEST_BROWSER_TEXT_SECRET:'test-key'},{thinking:config})).toEqual({});
 expect(()=>validateJevConfig({thinking:{...config,api:'unknown'}})).toThrow();
});
