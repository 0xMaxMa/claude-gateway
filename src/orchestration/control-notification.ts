/** Trusted SQL fragment for notification `n` and task `t` aliases.
 * Connection metadata can advance state_version after an action settles.
 * The notification still describes that round, but never a later dispatch.
 */
export const CURRENT_CONTROL_ROUND_SQL = `(
 t.state='waiting_input' AND t.active_attempt_id IS NULL
 AND COALESCE(json_extract(t.snapshot_json,'$.automationController'),'agent')='agent'
 AND COALESCE(json_extract(t.snapshot_json,'$.executionControl.phase'),'')!='paused'
 AND COALESCE(json_extract(t.snapshot_json,'$.browserReport.reason'),json_extract(t.snapshot_json,'$.computerReport.reason'))
   IN ('COMMAND_WAITING_INPUT','THINKING_WAITING_INPUT','COMPLETION_CANDIDATE','VERIFICATION_FAILED')
 AND EXISTS (SELECT 1 FROM conversation_events e
   WHERE e.conversation_id=n.conversation_id AND e.type='task.state_changed'
   AND json_extract(e.payload_json,'$.payload.taskId')=n.task_id
   AND json_extract(e.payload_json,'$.payload.stateVersion')=n.task_state_version
   AND json_extract(e.payload_json,'$.payload.state')='waiting_input'
   AND json_extract(e.payload_json,'$.payload.revision')=t.revision
   AND COALESCE(json_extract(e.payload_json,'$.payload.gatewayDispatch.requestId'),'')=
       COALESCE(json_extract(t.snapshot_json,'$.gatewayDispatch.requestId'),''))
)`;
