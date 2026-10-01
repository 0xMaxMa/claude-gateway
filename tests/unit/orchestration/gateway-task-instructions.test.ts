import { GATEWAY_TASK_INSTRUCTIONS } from '../../../src/orchestration/runtime';

// Live E2E (task e6149724): the agent added "if the link cannot be clicked, go to
// getpod.ai" to a Remote Browser step list; the verbatim rule named Computer Use only.
test('a user step list is copied verbatim for Remote Browser as well as Computer Use, with nothing added',()=>{
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('ordered step list for Computer Use or Remote Browser');
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('fallback, alternative URL or other added instructions');
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('browserReport.stepRun');
});
