import {computerThinking} from '../../../src/jev/computer-thinking';
import {thinkJson} from '@0xmaxma/jev-loop/thinking';
jest.mock('@0xmaxma/jev-loop/thinking',()=>({thinkJson:jest.fn()}));
const mock=jest.mocked(thinkJson),config={api:'openai-chat' as const,baseUrl:'https://example.test/v1',model:'helper',apiKeyEnv:'TEST_COMPUTER_KEY'};
const input={goal:'Find the latest macOS version in App Store',application:'com.apple.AppStore',control:{label:'Search',role:'AXTextField'}};
beforeEach(()=>{mock.mockReset();process.env.TEST_COMPUTER_KEY='test-key';});
afterEach(()=>{delete process.env.TEST_COMPUTER_KEY;});
function outputs(...values:Record<string,unknown>[]){for(const output of values)mock.mockResolvedValueOnce({output} as any);}
test('a capability refusal is not typed and the field helper retries with a valid query',async()=>{
 outputs({text:'I can’t access or control the Mac’s App Store from here, so I can’t verify the latest macOS version or whether an update/download button is shown.'},{valid:false},{text:'macOS'},{valid:true});
 await expect(computerThinking(config,input,new AbortController().signal)).resolves.toEqual({text:'macOS'});expect(mock).toHaveBeenCalledTimes(4);
});
test('repeated invalid answers fail closed rather than asking a fabricated user question',async()=>{
 outputs({text:'I cannot use a Mac'},{valid:false},{text:'Please do it yourself'},{valid:false});
 await expect(computerThinking(config,input,new AbortController().signal)).rejects.toThrow('COMPUTER_TEXT_UNGROUNDED');
});
test('missing text is retried once and only then becomes a missing-fact question',async()=>{
 outputs({text:null},{text:null});await expect(computerThinking(config,input,new AbortController().signal)).resolves.toEqual({text:null});expect(mock).toHaveBeenCalledTimes(2);
});
test('verification requires a boolean instead of accepting a textual claim',async()=>{
 outputs({verified:'yes'});await expect(computerThinking(config,input,new AbortController().signal,true)).rejects.toThrow('COMPUTER_VERIFICATION_INVALID');
});
