import type { OrchestrationStore } from './store';

/** Transport detach preserves intent; only an explicit text-mode action ends it. */
export class BrowserVoice {
  constructor(private readonly store: OrchestrationStore) {}
  enabled(sessionId: string, principalId: string): boolean {
    return Boolean(this.store.get('SELECT 1 FROM browser_voice WHERE session_id=? AND principal_id=? AND enabled=1', sessionId, principalId));
  }
  set(sessionId: string, principalId: string, enabled: boolean): void {
    this.store.run(`INSERT INTO browser_voice VALUES(?,?,?,?) ON CONFLICT(session_id,principal_id) DO UPDATE SET
      since=CASE WHEN browser_voice.enabled=0 AND excluded.enabled=1 THEN excluded.since ELSE browser_voice.since END,
      enabled=excluded.enabled`, sessionId, principalId, enabled ? 1 : 0, Date.now());
  }
  pending(sessionId: string, principalId: string, claimed: string[] = []): Array<{ responseId: string; text: string; spoken: string }> {
    const mode = this.store.get('SELECT since FROM browser_voice WHERE session_id=? AND principal_id=? AND enabled=1', sessionId, principalId);
    if (!mode) return [];
    return this.store.all(`SELECT r.id,r.generated_text,s.text AS spoken FROM assistant_responses r
      JOIN conversations c ON c.id=r.conversation_id JOIN response_speech s ON s.response_id=r.id
      WHERE c.agent_session_id=? AND r.created_at>=? AND r.state='completed' AND length(trim(s.text))>0
      AND r.id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.response_id=r.id AND d.modality='audio' AND d.state IN ('played','interrupted'))
      ORDER BY r.created_at,r.id LIMIT 100`, sessionId, mode.since, JSON.stringify(claimed)).map(row => ({ responseId: String(row.id), text: String(row.generated_text), spoken: String(row.spoken) }));
  }
}
