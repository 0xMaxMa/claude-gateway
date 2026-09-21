import { codexContextPolicy, observeCodexContext } from '../../../src/session/codex-context';
import { codexContextHtml } from '../../../src/ui/codex-context';
it('does not conflate Mini with its larger model or infer arbitrary namespaces',()=>{
 expect(codexContextPolicy('gpt-5.4-mini',1000000)).toMatchObject({requested:1000000,configured:400000,limitSource:'documented-model'});
 expect(codexContextPolicy('gpt-5.4-mini',200000).configured).toBe(200000);
 expect(codexContextPolicy('gpt-5.4',1000000).configured).toBe(1000000);
 expect(codexContextPolicy('custom/gpt-5.4-mini',1000000).providerLimit).toBeNull();
 expect(codexContextPolicy('gpt-5.4-mini-next').configured).toBeNull();
});
it('uses centralized exact model limits without affecting unrelated models',()=>{
 expect(codexContextPolicy('openai/gpt-5.4-mini',1000000).configured).toBe(400000);
 expect(codexContextPolicy('chatgpt/gpt-5.4-mini',1000000).configured).toBe(400000);
 expect(codexContextPolicy('gpt-5.4-mini-next',1000000).providerLimit).toBeNull();
 expect(codexContextPolicy('toString',1000000).providerLimit).toBeNull();
});
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid requested windows %s',value=>expect(()=>codexContextPolicy('gpt-test',value)).toThrow());
it('keeps native measurements independent from configuration and cumulative tokens',()=>{
 const policy=codexContextPolicy('gpt-future',1000000);
 const measured=observeCodexContext(policy,{modelContextWindow:828400,total:{totalTokens:8000000},last:{totalTokens:42000}});
 expect(measured).toMatchObject({requested:1000000,configured:1000000,observed:828400,used:42000});
 expect(observeCodexContext(measured,{total:{totalTokens:8000000}})).toMatchObject({observed:null,used:null,status:'unverified'});
 expect(codexContextHtml(measured)).toContain('42.00K / 828.40K');
 expect(codexContextHtml(measured)).toContain('5.1%');
 expect(codexContextHtml(policy)).toContain('— / —');
 expect(codexContextHtml()).toBe('');
});
