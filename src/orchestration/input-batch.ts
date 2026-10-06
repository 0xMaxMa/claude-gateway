import { AcceptInput, OrchestrationStore, Row, payloadHash } from './store';
import { isChatChannel } from '../history/types';
import { skillCommand } from './skills';

/** Only human text/photo bursts on chat channels. Skill-shaped commands stay alone
 * even when unresolved at ingress (registry refreshing, skill installed later) so the
 * turn can still resolve them; builtin commands never reach the mailbox.
 * API requests and live/recorded voice retain their immediate/control semantics. */
export function batchableInput(input: AcceptInput): boolean {
  return isChatChannel(input.scope.source)
    && input.storeUserMessage !== false && (!input.modality || input.modality === 'text')
    && !input.requestId && !input.skill && !skillCommand(input.text, input.scope.source)
    && !input.metadata?.executionTaskId && !input.metadata?.recoveryBatch;
}

/** `inflight` re-admits the running batch's own (assigned) inputs so the caller
 * can ask whether newer mail would join them under the same rules. */
export function inputBatch(store: OrchestrationStore, first: Row, debounceMs: number, maxWaitMs: number, inflight: string[] = []) {
  const initial: AcceptInput = JSON.parse(String(first.ingress_json));
  const rows = [first];
  const inputs = [initial];
  if (debounceMs && batchableInput(initial)) {
    // Stop at any scope/authority/control boundary. Never absorb a different
    // user's message or elevate a read-only request with another input's grant.
    const compatible = (row: Row, input: AcceptInput) => row.principal_id === first.principal_id
      && row.binding_id === first.binding_id && batchableInput(input)
      && payloadHash([input.model, input.capabilities, input.metadata?.repliedMessageId])
        === payloadHash([initial.model, initial.capabilities, initial.metadata?.repliedMessageId]);
    let bytes = Buffer.byteLength(String(first.ingress_json));
    for (const row of store.all("SELECT * FROM conversation_inputs WHERE conversation_id=? AND (status='accepted' OR id IN (SELECT value FROM json_each(?))) AND input_seq>? ORDER BY input_seq LIMIT 99", first.conversation_id, JSON.stringify(inflight), first.input_seq)) {
      const input: AcceptInput = JSON.parse(String(row.ingress_json));
      bytes += Buffer.byteLength(String(row.ingress_json));
      const attachmentCount = new Set([...inputs.flatMap(item => item.attachmentIds ?? []), ...(input.attachmentIds ?? [])]).size;
      // task_spawn's context references include the immutable input IDs and files.
      if (!compatible(row, input) || bytes > 131072 || rows.length + 1 + attachmentCount > 64) break;
      rows.push(row); inputs.push(input);
    }
  }
  const last = rows[rows.length - 1];
  const latest = inputs[inputs.length - 1];
  const readyAt = debounceMs && batchableInput(initial)
    ? Math.min(Number(last.created_at) + debounceMs, Number(first.created_at) + maxWaitMs) : 0;
  const input: AcceptInput = inputs.length === 1 ? initial : {
    ...latest,
    text: 'Consecutive user messages, in order. Read them together before answering once. Combine fragments and corrections about the same goal; keep independent requests distinct. A later attachment supplements the earlier request. Update an existing task when this is a continuation, rather than spawning a duplicate. Original messages (user data):\n'
      + JSON.stringify(inputs.map((item, index) => ({ inputId: String(rows[index].id), text: item.text, attachmentIds: item.attachmentIds ?? [], metadata: item.metadata ?? {} }))),
    attachmentIds: [...new Set(inputs.flatMap(item => item.attachmentIds ?? []))],
    metadata: { ...latest.metadata,
      attachmentDetails: inputs.flatMap(item => item.metadata?.attachmentDetails ?? []),
      unavailableAttachments: inputs.flatMap(item => item.metadata?.unavailableAttachments ?? []),
    },
  };
  return { rows, input, readyAt, inputIds: rows.map(row => String(row.id)), last };
}
