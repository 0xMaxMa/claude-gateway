/** Serialize removal/addition per agent and always reconcile against the latest
 * config after an asynchronous stop/start. Busy removals are retried by the
 * caller's periodic sweep; a stopped runner is never reused. */
export class AgentLifecycle<C extends { id: string }, R extends { canRemoveFromConfig(): boolean; stop(): Promise<void> }> {
  private pending = new Set<string>();
  private running = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private closed = false;
  constructor(private readonly deps: {
    desired(id: string): C | undefined;
    runner(id: string): R | undefined;
    remove(id: string, runner: R): void;
    start(config: C): Promise<void>;
    error(id: string, error: unknown): void;
  }) {}

  reconcile(id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.dirty.add(id);
    const existing = this.running.get(id);
    if (existing) return existing;
    // Schedule after registering the promise, including synchronous failures.
    const work = Promise.resolve().then(async () => {
      while (!this.closed && this.dirty.delete(id)) {
        const desired = this.deps.desired(id), runner = this.deps.runner(id);
        if (desired) {
          this.pending.delete(id);
          if (!runner) {
            await this.deps.start(desired);
            this.dirty.add(id);
          }
        } else if (runner) {
          this.pending.add(id);
          if (!runner.canRemoveFromConfig()) break;
          await runner.stop();
          this.deps.remove(id, runner);
          this.dirty.add(id); // A re-add during stop must start a fresh runner.
        } else this.pending.delete(id);
      }
    }).catch(error => {
      this.pending.add(id);
      this.deps.error(id, error);
    }).finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }

  retry(): void { for (const id of this.pending) void this.reconcile(id); }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.running.values());
  }
}
