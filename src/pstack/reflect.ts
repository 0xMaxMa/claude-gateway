import { existsSync } from 'fs';
import { transcriptPath } from '../config/claude-settings';
import type { OrchestrationStore } from '../orchestration/store';
import type { TaskAttempt, TaskSnapshot } from '../orchestration/types';

/**
 * pstack's reflect reviews "the active transcript", found by a finder among the
 * worker's own project transcripts. A gateway chat session is several Claude
 * Code sessions: the agent's decision turns, which hold the user's messages, and
 * one per task, which hold the work. The reflect worker is a new session, so the
 * finder would match it. These are the session's other transcripts, oldest first;
 * a subagent's run is its own (as in Claude Code) and Codex leaves no transcript here.
 */
export function chatSessionTranscripts(store: OrchestrationStore, task: TaskSnapshot): string[] {
  const paths: string[] = [];
  if (store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_cli_sessions'")) {
    const decision = store.get('SELECT cli_session_id,cwd FROM agent_cli_sessions WHERE session_id=?', task.agentSessionId);
    if (decision && !String(decision.cwd).startsWith('container:')) paths.push(transcriptPath(String(decision.cwd), String(decision.cli_session_id)));
  }
  for (const row of store.all('SELECT id FROM tasks WHERE conversation_id=? AND id<>? ORDER BY created_at', task.conversationId, task.taskId)) {
    const earlier = store.task(String(row.id));
    const cwd = store.get('SELECT worktree_path FROM task_resources WHERE task_id=? ORDER BY rowid LIMIT 1', String(row.id))?.worktree_path;
    if (earlier?.agentSessionId !== task.agentSessionId || earlier.parentTaskId || !cwd) continue;
    for (const attempt of store.all('SELECT payload_json FROM task_attempts WHERE task_id=? ORDER BY generation', String(row.id))) {
      let parsed: TaskAttempt;
      // One unreadable row costs that transcript, not the whole review.
      try { parsed = JSON.parse(String(attempt.payload_json)); } catch (error) { console.warn(`[pstack] reflect skips an unreadable attempt of task ${String(row.id)}`, (error as Error).message); continue; }
      if (parsed.harness !== 'codex' && typeof parsed.sessionId === 'string') paths.push(transcriptPath(String(cwd), parsed.sessionId));
    }
  }
  return [...new Set(paths)].filter(path => existsSync(path));
}

/** Tells a `/pstack:reflect` worker which transcripts stand in for step 1's finder. */
export function pstackReflectNote(transcripts: string[]): string {
  return transcripts.length
    ? `For /pstack:reflect, this worker is a new Claude Code session, so its own transcript is not the conversation. This chat session's transcripts, oldest first (the agent's turns with the user, then each earlier task's worker), take the place of step 1's finder: give each reviewer every path.\n${transcripts.map(path => `- ${path}`).join('\n')}`
    : 'For /pstack:reflect, no transcript of this chat session is readable, and this worker is a new Claude Code session. Say so instead of reviewing this worker\'s own session.';
}
