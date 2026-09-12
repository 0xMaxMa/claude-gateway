/** Additive sidecar only. Canonical conversation history stays in the existing stores. */
export const ORCHESTRATION_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS orchestration_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE conversations(
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
 source TEXT NOT NULL, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, thread_key TEXT NOT NULL,
 owner_principal_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stream_id TEXT NOT NULL UNIQUE,
 last_event_seq INTEGER NOT NULL DEFAULT 0, last_input_seq INTEGER NOT NULL DEFAULT 0,
 epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(agent_id,source,account_id,chat_id,thread_key,agent_session_id));
CREATE TABLE conversation_members(conversation_id TEXT NOT NULL REFERENCES conversations(id), principal_id TEXT NOT NULL,
 role TEXT NOT NULL, PRIMARY KEY(conversation_id,principal_id));
CREATE TABLE conversation_bindings(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 channel TEXT NOT NULL, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, thread_key TEXT NOT NULL,
 reply_policy TEXT NOT NULL, capabilities_json TEXT NOT NULL,
 UNIQUE(conversation_id,channel,account_id,chat_id,thread_key));
CREATE TABLE conversation_inputs(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 input_seq INTEGER NOT NULL, principal_id TEXT NOT NULL, binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
 modality TEXT NOT NULL, text TEXT NOT NULL, attachment_refs_json TEXT NOT NULL, request_id TEXT,
 store_user_message INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'accepted', created_at INTEGER NOT NULL, ingress_json TEXT NOT NULL DEFAULT '{}',
 UNIQUE(conversation_id,input_seq));
CREATE INDEX pending_inputs ON conversation_inputs(conversation_id,status,input_seq);
CREATE TABLE ingress_receipts(ingress_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
 input_id TEXT NOT NULL REFERENCES conversation_inputs(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), accepted_at INTEGER NOT NULL);
CREATE TABLE conversation_decisions(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 epoch INTEGER NOT NULL, kind TEXT NOT NULL, request_id TEXT, state TEXT NOT NULL, session_id TEXT NOT NULL,
 input_ids_json TEXT NOT NULL, notification_ids_json TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE UNIQUE INDEX one_active_decision ON conversation_decisions(conversation_id) WHERE state IN ('running','interrupting');
CREATE TABLE assistant_responses(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 decision_id TEXT NOT NULL REFERENCES conversation_decisions(id), request_id TEXT, state TEXT NOT NULL,
 generated_text TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER);
CREATE TABLE tasks(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 state TEXT NOT NULL, state_version INTEGER NOT NULL, revision INTEGER NOT NULL,
 active_attempt_id TEXT, snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX task_queue ON tasks(state,created_at);
CREATE INDEX conversation_tasks ON tasks(conversation_id,state);
CREATE TABLE task_revisions(task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL, PRIMARY KEY(task_id,revision));
CREATE TABLE task_attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL,
 revision INTEGER NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(task_id,generation));
CREATE UNIQUE INDEX one_active_attempt ON task_attempts(task_id) WHERE state IN ('starting','running','unknown');
CREATE TABLE task_commands(action_id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), principal_id TEXT NOT NULL,
 decision_id TEXT, command_type TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE conversation_events(conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
 event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,seq));
CREATE TABLE worker_events(attempt_id TEXT NOT NULL REFERENCES task_attempts(id), local_seq INTEGER NOT NULL,
 type TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(attempt_id,local_seq));
CREATE TABLE outbox(id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE,
 payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL, lease_owner TEXT, lease_expires_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX pending_outbox ON outbox(state,available_at);
CREATE TABLE deliveries(id TEXT PRIMARY KEY, response_id TEXT REFERENCES assistant_responses(id), event_id TEXT,
 binding_id TEXT NOT NULL REFERENCES conversation_bindings(id), modality TEXT NOT NULL, state TEXT NOT NULL,
 provider_message_id TEXT, delivered_text TEXT, audio_progress_json TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE task_resources(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), workspace_id TEXT NOT NULL,
 mode TEXT NOT NULL, base_commit TEXT, worktree_path TEXT, context_snapshot_ref TEXT, lock_key TEXT,
 lifecycle_state TEXT NOT NULL, cleanup_after INTEGER);
CREATE UNIQUE INDEX resource_lock ON task_resources(lock_key) WHERE lock_key IS NOT NULL AND lifecycle_state = 'active';
CREATE TABLE notifications(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), task_state_version INTEGER NOT NULL,
 originating_binding_id TEXT NOT NULL REFERENCES conversation_bindings(id), status TEXT NOT NULL DEFAULT 'pending',
 decision_id TEXT, UNIQUE(task_id,task_state_version));
CREATE TABLE history_operations(operation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 input_id TEXT REFERENCES conversation_inputs(id), response_id TEXT REFERENCES assistant_responses(id),
 intended_action TEXT NOT NULL, canonical_message_ref TEXT, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE runtime_sessions(id TEXT PRIMARY KEY, role TEXT NOT NULL, conversation_id TEXT REFERENCES conversations(id),
 task_id TEXT REFERENCES tasks(id), attempt_id TEXT REFERENCES task_attempts(id), backend TEXT NOT NULL,
 generation INTEGER NOT NULL, lifecycle_state TEXT NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE TABLE task_files(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),attempt_id TEXT NOT NULL,
 action_id TEXT NOT NULL,path TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,caption TEXT NOT NULL,response_id TEXT,
 created_at INTEGER NOT NULL,args_hash TEXT NOT NULL,UNIQUE(attempt_id,action_id));
CREATE TABLE response_speech(response_id TEXT PRIMARY KEY REFERENCES assistant_responses(id),text TEXT NOT NULL);
CREATE TABLE voice_note_transcripts(input_id TEXT PRIMARY KEY REFERENCES conversation_inputs(id),state TEXT NOT NULL,text TEXT,error_code TEXT);
`;
