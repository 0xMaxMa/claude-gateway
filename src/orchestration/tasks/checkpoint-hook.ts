/** Installed into the attempt directory; never invokes a shell with task/tool data.
 * Claude Code PostToolUse/Failure supplies context before its next model call.
 * Stop handles an update arriving after the last tool. Empty checkpoints are silent.
 */
export const CHECKPOINT_HOOK = String.raw`
const fs = require('fs'), http = require('http');
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 8*1024*1024) process.exit(0); });
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(input);
    if (event.agent_id || !['PostToolUse','PostToolUseFailure','Stop'].includes(event.hook_event_name)) return;
    const ticket = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const call = args => new Promise((resolve,reject) => {
      const url = ticket.socket ? null : new URL(ticket.url);
      const options = ticket.socket ? { socketPath: ticket.socket, path: '/call' } : { hostname:url.hostname, port:url.port, path:url.pathname };
      const request = http.request({...options, method: 'POST', headers: { Authorization: 'Bearer '+ticket.token, 'Content-Type': 'application/json' } }, response => {
        let body = ''; response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; if(body.length > 2*1024*1024) response.destroy(); });
        response.on('error', reject);
        response.on('end', () => { try { if(response.statusCode !== 200) return reject(Error('checkpoint')); resolve(JSON.parse(body)); } catch(error) { reject(error); } });
      });
      request.on('error',reject); request.setTimeout(2000,()=>request.destroy(Error('timeout')));
      request.end(JSON.stringify({tool:'task_checkpoint', action_id:'hook', args:{sessionId:event.session_id,...args}}));
    });
    const next = await call({});
    const context = [next.directive ? 'Task revision '+next.revision+' received at a tool boundary. Continue this same task; do not redo completed actions.\n'+next.directive : '', next.feedback?.message].filter(Boolean).join('\n\n');
    if (!context) return;
    // Monitoring advice cannot keep a completed worker alive. Explicit task
    // amendments still block Stop so new user work cannot be silently dropped.
    if (event.hook_event_name === 'Stop' && next.directiveKind === 'advice') {
      await call({ackRevision:next.revision,ackFeedback:next.feedback?.id}); return;
    }
    // Stop blocks only for a new revision, never because monitoring wants more work.
    if (event.hook_event_name === 'Stop' && !next.directive) return;
    const output = event.hook_event_name === 'Stop' ? {decision:'block',reason:context} : {hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext:context}};
    await new Promise(resolve => process.stdout.write(JSON.stringify(output)+'\n',resolve));
    await call({ackRevision:next.revision,ackFeedback:next.feedback?.id});
  } catch { /* A bridge failure cannot kill or authorize a task; its revision stays pending. */ }
});
`;
export function checkpointSettings(command: string) {
  return { disableAllHooks: false, hooks: Object.fromEntries(['PostToolUse','PostToolUseFailure','Stop'].map(event => [event, [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] }]])) };
}
