import type { TaskRevision } from '../types';
import type { OrchestrationStore } from '../store';

/** Decode append-only legacy answers without rewriting durable history. Explicit updates reset the directive. */
export function normalizeTaskRevisions(rows: TaskRevision[]): TaskRevision {
  let result = rows[0];
  for (let i=1;i<rows.length;i++) {
    const row=rows[i], prior=rows[i-1];
    const prefix=prior.instructions+'\n\nAnswer to ';
    if (!row.answers && row.instructions.startsWith(prefix)) {
      const suffix=row.instructions.slice(prefix.length), separator=suffix.indexOf(': ');
      result=separator>=0 ? {...row,instructions:result.instructions,answers:[...(result.answers??[]),{questionId:suffix.slice(0,separator),text:suffix.slice(separator+2),inputId:row.originatingInputId}]} : row;
    } else result=row;
  }
  return result;
}
export function taskDirective(store: OrchestrationStore, conversationId: string, revision: TaskRevision): string {
  const anchor=store.get('SELECT input_seq FROM conversation_inputs WHERE id=? AND conversation_id=?',revision.originatingInputId,conversationId);
  const messages=anchor ? store.all(`SELECT id,text,input_seq FROM conversation_inputs WHERE conversation_id=? AND input_seq<=? AND store_user_message=1 ORDER BY input_seq DESC LIMIT 40`,conversationId,anchor.input_seq).reverse() : [];
  const latest=revision.answers?.[revision.answers.length-1];
  return [
    'Current delegated task. Later answers amend conflicting parts of the initial brief; unchanged requirements still apply. Historical observed state describes what exists, not what the user wants next. A later user correction may intentionally change it.',
    latest ? `Latest answer from the orchestrator (not a verbatim user quote):\n${JSON.stringify(latest)}` : '',
    `Initial/current task brief${latest ? ' (historical where amended above)' : ''}:\n${revision.instructions}`,
    revision.answers?.length ? `Earlier answers, oldest first (historical where superseded):\n${JSON.stringify(revision.answers.slice(0,-1))}` : '',
    `User messages from this conversation through the originating turn (bounded recent history; absence is not proof that approval was never given):\n${JSON.stringify(messages)}`,
    'Distinguish user messages from the orchestrator’s interpretation. Carry forward explicit user authorization within its scope; a later status question does not revoke it. Do not treat an orchestrator claim alone as user approval. If something material remains unclear, cite the specific conflicting input IDs and missing decision. Do not ask an already answered question solely because the old brief or current state differs from the requested result.',
  ].filter(Boolean).join('\n\n');
}
