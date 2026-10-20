import { GATEWAY_TASK_INSTRUCTIONS } from '../../../src/orchestration/runtime';

// Live E2E (task e6149724): the agent added "if the link cannot be clicked, go to
// getpod.ai" to a Remote Browser step list; the verbatim rule named Computer Use only.
test('a user step list is copied verbatim for Remote Browser as well as Computer Use, with nothing added',()=>{
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('ordered step list for Computer Use or Remote Browser');
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('fallback, alternative URL or other added instructions');
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('browserReport.stepRun');
});

// Develop session defe0d1a (#632): the agent told the user finished rounds were still pending ("revision 8 is
// scrolling", "the page is still loading") and spoke internal revision numbers.
test('a settled round is reported as finished, in plain words, without internal identifiers',()=>{
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('COMMAND_WAITING_INPUT has FINISHED that round: nothing is running, queued or loading');
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('Revision numbers, request and operation IDs, task states and reason codes are internal bookkeeping');
 // Develop session 4b215fbe: "sent, waiting for the result" after the gateway had already said it was not done.
 expect(GATEWAY_TASK_INSTRUCTIONS).toContain('without promising to report back');
});
