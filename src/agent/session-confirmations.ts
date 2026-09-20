import { randomUUID } from 'crypto';
import type { ControlMenu, ControlScope } from '../orchestration/channel-controls';
type Operation = 'compact' | 'restart';
type Entry = { scope: string; expires: number; operation: Operation; yes: boolean; consumed: boolean; group: string };
/** One-use confirmation, bound to the originating person, chat, thread and active session. */
export class SessionConfirmations {
  private entries = new Map<string, Entry>();
  private key(scope: ControlScope): string { return JSON.stringify(scope); }
  owns(text: string): boolean { return text.startsWith('/orch ') && this.entries.has(text.replace(/^\/orch\s+/, '').trim()); }
  open(scope: ControlScope, operation: Operation): ControlMenu {
    const key = this.key(scope);
    for (const [id, entry] of this.entries) {
      if (entry.expires < Date.now()) this.entries.delete(id);
      else if (entry.scope === key) entry.consumed = true;
    }
    while (this.entries.size > 1998) this.entries.delete(this.entries.keys().next().value!);
    const group = randomUUID();
    const buttons = [true, false].map(yes => {
      const id = randomUUID();
      this.entries.set(id, {scope:key, expires:Date.now()+300000, operation, yes, consumed:false, group});
      return {label:yes?'Yes':'No', data:`orch:${id}`};
    });
    return {text:operation === 'compact'
      ? 'Compact Claude Code context? Chat history stays unchanged. Choose Yes or No.'
      : 'Restart this session process? Chat history stays unchanged. This does not restart the gateway or app. Choose Yes or No.', buttons};
  }
  choose(scope: ControlScope, text: string): Operation | 'cancel' {
    const entry = this.entries.get(text.replace(/^\/orch\s+/, '').trim());
    if (!entry || entry.consumed || entry.expires < Date.now() || entry.scope !== this.key(scope)) throw Error('Confirmation expired or unavailable. Run the command again.');
    for (const item of this.entries.values()) if (item.group === entry.group) item.consumed = true;
    return entry.yes ? entry.operation : 'cancel';
  }
}
