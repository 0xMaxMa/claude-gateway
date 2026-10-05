import { resolveOrchestrationConfig } from '../../../src/orchestration/config';
test('voice.narrate rejects zero, negative and undefined limits',()=>{ for (const v of [0,-1,undefined]) expect(()=>resolveOrchestrationConfig(undefined,{enabled:true,narrate:{maxChars:v as any}} as any)).toThrow(); });
