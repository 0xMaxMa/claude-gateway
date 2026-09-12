/** A single live task browser per private chat. All reads are session-bound and
 * serialized with navigation, replacement, and explicit cancellation. */
export interface TaskBrowserMessage {
  chatId: string; userId: string; messageId: number; sessionId: string;
  view: { page?: number; action?: 'detail'; task_id?: string };
}
export interface TaskBrowserResult {
  sessionId: string;
  task?: { taskId: string; state: string };
  page?: number;
}
export interface TaskBrowserMenu { text: string; reply_markup: unknown }
interface Entry extends TaskBrowserMessage { fingerprint?: string; retryAt?: number; finished?: boolean }
interface Dependencies {
  read(chat: string, user: string, payload: Record<string, unknown>): Promise<TaskBrowserResult>;
  render(result: TaskBrowserResult): TaskBrowserMenu;
  send(chat: string, menu: TaskBrowserMenu): Promise<number>;
  edit(chat: string, id: number, menu: TaskBrowserMenu): Promise<unknown>;
  remove(chat: string, id: number): Promise<unknown>;
  close(chat: string, id: number): Promise<unknown>;
  allowed(chat: string, user: string): boolean;
  persist(entries: TaskBrowserMessage[]): void;
  now?: () => number;
}
const description = (e: any) => String(e?.description ?? e?.message ?? '');
const absent = (e: any) => /message to (?:edit|delete) not found|message_id_invalid/i.test(description(e));
const unchanged = (e: any) => /message is not modified/i.test(description(e));
export class LiveTaskBrowser {
  private entries = new Map<string, Entry>();
  private locks = new Map<string, Promise<unknown>>();
  private nextEditAt = 0;
  constructor(private io: Dependencies, restored: TaskBrowserMessage[] = []) {
    for (const e of restored) {
      if (e && typeof e === 'object' && /^\d+$/.test(e.chatId) && e.userId === e.chatId && Number.isSafeInteger(e.messageId) && e.messageId > 0 && typeof e.sessionId === 'string' && e.view &&
        (e.view.action === 'detail' ? typeof e.view.task_id === 'string' : Number.isSafeInteger(e.view.page ?? 0))) this.entries.set(e.chatId, { ...e });
    }
  }
  private now() { return this.io.now?.() ?? Date.now(); }
  private persist() {
    this.io.persist([...this.entries.values()].map(({chatId,userId,messageId,sessionId,view}) => ({chatId,userId,messageId,sessionId,view})));
  }
  private serial<T>(chat: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(chat) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(work);
    this.locks.set(chat, job);
    void job.finally(() => { if (this.locks.get(chat) === job) this.locks.delete(chat); }).catch(() => {});
    return job;
  }
  private async retire(e: Entry) {
    try { await this.io.remove(e.chatId, e.messageId); }
    catch (error) {
      if (!absent(error)) {
        try { await this.io.close(e.chatId, e.messageId); }
        catch (closed) { if (!absent(closed) && !unchanged(closed)) throw closed; }
      }
    }
    this.entries.delete(e.chatId); this.persist();
  }
  open(chatId: string, userId: string) {
    return this.serial(chatId, async () => {
      if (!this.io.allowed(chatId, userId)) throw Error('TASK_BROWSER_UNAUTHORIZED');
      const result = await this.io.read(chatId, userId, { page: 0 });
      const menu = this.io.render(result);
      const previous = this.entries.get(chatId);
      if (previous) await this.retire(previous);
      const messageId = await this.io.send(chatId, menu);
      this.entries.set(chatId, {chatId,userId,messageId,sessionId:result.sessionId,view:{page:result.page ?? 0},fingerprint:JSON.stringify(menu)});
      this.persist();
    });
  }
  navigate(chatId: string, userId: string, messageId: number, payload: Record<string, unknown>) {
    return this.serial(chatId, async () => {
      const e = this.entries.get(chatId);
      if (!e || e.messageId !== messageId || e.userId !== userId || !this.io.allowed(chatId,userId)) throw Error('TASK_BROWSER_EXPIRED');
      if (payload.action === 'dismiss') { await this.retire(e); return; }
      try {
        const result = await this.io.read(chatId,userId,{...payload,session_id:e.sessionId});
        // Never repeat a mutation during auto-refresh, even if Telegram edit fails.
        e.view = result.task ? {action:'detail',task_id:result.task.taskId} : {page:result.page ?? 0};
        this.persist();
        await this.update(e,result);
      } catch (error) { await this.failure(e,error); throw error; }
    });
  }
  private async update(e: Entry, result: TaskBrowserResult) {
    if (result.sessionId !== e.sessionId) throw Error('TASK_SESSION_CHANGED');
    const view = result.task ? { action: 'detail' as const, task_id: result.task.taskId } : { page: result.page ?? 0 };
    if (JSON.stringify(view) !== JSON.stringify(e.view)) { e.view = view; this.persist(); }
    const finished = !!result.task && ['completed','failed','cancelled'].includes(result.task.state);
    const menu = this.io.render(result), fingerprint = JSON.stringify(menu);
    if (fingerprint === e.fingerprint) { e.finished = finished; return; }
    try { await this.io.edit(e.chatId,e.messageId,menu); }
    catch (error) { if (!unchanged(error)) throw error; }
    e.fingerprint = fingerprint; e.retryAt = undefined; e.finished = finished;
  }
  private async failure(e: Entry, error: any) {
    if (description(error).includes('TASK_SESSION_CHANGED')) { await this.retire(e); return; }
    if (absent(error) || error?.error_code === 403) { this.entries.delete(e.chatId); this.persist(); return; }
    const retry = Number(error?.parameters?.retry_after);
    e.retryAt = this.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 10000);
    if (retry > 0) this.nextEditAt = Math.max(this.nextEditAt,e.retryAt);
  }
  async tick() {
    // One tick cannot overlap a previous read/edit or user action for this chat.
    for (const e of [...this.entries.values()]) {
      if (e.finished || this.locks.has(e.chatId) || this.now() < Math.max(e.retryAt ?? 0,this.nextEditAt)) continue;
      await this.serial(e.chatId, async () => {
        if (this.entries.get(e.chatId) !== e) return;
        if (!this.io.allowed(e.chatId,e.userId)) {
          this.entries.delete(e.chatId); this.persist(); return;
        }
        try { await this.update(e,await this.io.read(e.chatId,e.userId,{...e.view,session_id:e.sessionId})); }
        catch (error) { await this.failure(e,error).catch(() => {}); }
      });
    }
  }
}
