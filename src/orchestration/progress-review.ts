import { OrchestrationStore } from './store';

// Internal reviews may choose silence. They must finish before any prose/TTS
// is published, so a partial draft or a control JSON object cannot leak.
export const PROGRESS_REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    notify_user: { type: 'boolean' },
    display_text: { type: 'string', maxLength: 16000 },
    spoken_text: { type: 'string', maxLength: 600 },
  }, required: ['notify_user', 'display_text', 'spoken_text'],
};
export const PROGRESS_REVIEW_OVERLAY = `This is an internal progress review, not a request to send a message on every check. Inspect the task and offer scoped advice if needed. Independently decide whether the user needs a new update: a meaningful milestone, changed plan, concrete blocker, or decision they need to make. Routine tool activity, elapsed time, unchanged work and rephrasing the previous report are not new progress. Compare with the previously communicated updates provided as data. If nothing meaningful is new, return {"notify_user":false,"display_text":"","spoken_text":""}. Otherwise return {"notify_user":true,"display_text":"natural concise first-person update containing only new information","spoken_text":"short spoken version in the same language"}. This three-field schema overrides the ordinary two-field speech format for this internal review only. Never announce the review, supervision, forwarding advice, or silence decision. Do not send a reassurance that the task is not stuck. A planned next step is not a completed milestone. User questions and completion/failure/input-request notifications are handled separately and must not be suppressed by this policy.`;

export function isProgressReview(store: OrchestrationStore, decisionId: string): boolean {
  const tasks = store.all(`SELECT t.state,t.snapshot_json FROM notifications n JOIN tasks t ON t.id=n.task_id
    WHERE n.decision_id=? AND n.status='assigned'`, decisionId);
  return tasks.length > 0 && tasks.every(row => row.state === 'running' && Boolean(JSON.parse(String(row.snapshot_json)).supervision));
}
export function recentCommunicatedProgress(store: OrchestrationStore, conversationId: string): string[] {
  return store.all(`SELECT generated_text FROM assistant_responses WHERE conversation_id=? AND state='completed'
    AND generated_text!='' ORDER BY completed_at DESC,rowid DESC LIMIT 6`, conversationId)
    .map(row => String(row.generated_text));
}
export function progressReviewResult(raw: string, previous: string[]): { display: string; spoken: string; silent: boolean } {
  const normalized = raw.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, '');
  const starts = [...normalized.matchAll(/\{(?=\s*"(?:notify_user|display_text|spoken_text)"\s*:)/g)].slice(-32).map(m => m.index!);
  for (const candidate of [normalized, ...starts.map(index => normalized.slice(index))]) {
    try {
      const value = JSON.parse(candidate);
      if (value.notify_user === false) return {display:'',spoken:'',silent:true};
      if (value.notify_user !== true || typeof value.display_text !== 'string' || !value.display_text.trim()) continue;
      const display = value.display_text.trim();
      const canonical = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (previous.some(text => canonical(text) === canonical(display))) return {display:'',spoken:'',silent:true};
      return {display,spoken:typeof value.spoken_text === 'string' && value.spoken_text.length <= 600 ? value.spoken_text.trim() : '',silent:false};
    } catch { /* Only an explicit valid reporting decision can publish. */ }
  }
  return {display:'',spoken:'',silent:true};
}
