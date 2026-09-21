/** Track native task lifecycle metadata, never instructions embedded in text. */
export class BackgroundWork {
  private calls = new Set<string>();
  private tasks = new Map<string, string | undefined>();
  private ended = new Set<string>();

  observe(event: Record<string, any>): void {
    if (event.type === 'assistant') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block.type === 'tool_use' && typeof block.id === 'string' &&
          (block.name === 'Monitor' || (['Bash', 'Agent', 'Task', 'Workflow'].includes(block.name) && block.input?.run_in_background === true)) && !this.ended.has(block.id)) {
          this.calls.add(block.id);
        }
      }
    }
    if (event.type === 'user') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block.type === 'tool_result' && block.is_error === true) this.calls.delete(block.tool_use_id);
      }
    }
    if (event.type !== 'system' || typeof event.task_id !== 'string') return;
    const call = typeof event.tool_use_id === 'string' ? event.tool_use_id : undefined;
    if (event.subtype === 'task_started' && event.is_backgrounded === false) return;
    if (event.subtype === 'task_started' && !this.ended.has(event.task_id)) {
      this.tasks.set(event.task_id, call);
      if (call) this.calls.delete(call);
    }
    if (event.subtype === 'task_notification' && ['completed', 'failed', 'stopped'].includes(event.status)) {
      const trackedCall = this.tasks.get(event.task_id) ?? call;
      this.tasks.delete(event.task_id);
      this.ended.add(event.task_id);
      if (trackedCall) { this.calls.delete(trackedCall); this.ended.add(trackedCall); }
    }
  }

  get pending(): boolean { return this.calls.size > 0 || this.tasks.size > 0; }
}
