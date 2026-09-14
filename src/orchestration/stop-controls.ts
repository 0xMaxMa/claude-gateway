import { randomUUID } from 'crypto';
import { OrchestrationStore } from './store';
import { TaskService } from './tasks/service';
import { OrchestrationError } from './types';

export interface StopMenu {
  menuId: string; stopped: boolean;
  tasks: Array<{ taskId: string; title: string; state: string }>;
}
/** Selection numbers refer to a frozen task list, never to a reusable worker slot. */
export class StopControls {
  private menus = new Map<string, { sessionId: string; principalId: string; expiresAt: number; tasks: StopMenu['tasks'] }>();
  constructor(private store: OrchestrationStore, private tasks: TaskService, private stop: (id: string) => boolean) {}
  private prune(): void { for (const [id, m] of this.menus) if (m.expiresAt < Date.now()) this.menus.delete(id); }
  dismiss(sessionId: string, principalId: string): void {
    for (const [id, m] of this.menus) if (m.sessionId === sessionId && m.principalId === principalId) this.menus.delete(id);
  }
  open(sessionId: string, principalId: string): StopMenu {
    this.prune();
    const rows = this.store.all('SELECT id FROM conversations WHERE agent_session_id=?', sessionId);
    for (const row of rows) this.store.assertMember(String(row.id), principalId);
    const tasks = rows.flatMap(row => this.tasks.status(String(row.id), principalId))
      .filter(t => ['queued','starting','running','waiting_input','interrupting','recovering','needs_reconciliation'].includes(t.state))
      .sort((a,b) => a.createdAt-b.createdAt || a.taskId.localeCompare(b.taskId)).slice(0,30)
      .map(t => ({taskId:t.taskId,title:t.title.replace(/\s+/g,' ').slice(0,100),state:t.state}));
    const stopped = this.stop(sessionId), menuId = randomUUID();
    this.dismiss(sessionId, principalId);
    if (tasks.length) {
      if (this.menus.size >= 1000) this.menus.delete(this.menus.keys().next().value!);
      this.menus.set(menuId,{sessionId,principalId,expiresAt:Date.now()+300000,tasks});
    }
    return {menuId,stopped,tasks};
  }
  replyCommand(sessionId: string, principalId: string, text: string): string | undefined {
    this.prune();
    if (!/^\d+$/.test(text.trim())) { if (!text.trim().startsWith('/stop')) this.dismiss(sessionId,principalId); return; }
    for (const [id,m] of this.menus) if (m.sessionId===sessionId && m.principalId===principalId) return `/stop ${id} ${Number(text.trim())}`;
  }
  choose(sessionId: string, principalId: string, menuId: string, index: number): { text: string; taskId?: string; state?: string } {
    this.prune();
    const menu=this.menus.get(menuId);
    if (!menu || menu.sessionId!==sessionId || menu.principalId!==principalId) throw new OrchestrationError('STOP_MENU_EXPIRED');
    if (index===0) { this.menus.delete(menuId); return {text:'Dismissed. Tasks continue running.'}; }
    const entry=menu.tasks[index-1];
    if (!entry || !Number.isSafeInteger(index)) throw new OrchestrationError('INVALID_TASK_SELECTION');
    const task=this.store.task(entry.taskId);
    if (!task || task.agentSessionId!==sessionId) throw new OrchestrationError('ACCESS_DENIED');
    const result=this.tasks.cancelByUser(task.conversationId,principalId,task.taskId);
    this.menus.delete(menuId);
    return {taskId:task.taskId,state:result.state,text:result.state==='cancel_requested' ? `Stopping task: ${entry.title}.` : result.state==='cancelled' ? `Cancelled task: ${entry.title}.` : `Task already ${result.state}: ${entry.title}.`};
  }
}
export function stopMenuText(menu: StopMenu, buttons = false): string {
  const status=menu.stopped?'Agent reply stopped.':'The agent is not currently replying.';
  if (buttons) return menu.tasks.length ? `${menu.stopped ? 'Agent reply stopped.\n' : ''}Which task would you like to stop?` : menu.stopped ? 'Agent reply stopped.' : 'Nothing to stop.';
  return menu.tasks.length ? `${status}\nWhich task would you like to stop?\n\n${menu.tasks.map((t,i)=>`${i+1}. ${t.title} (${t.state})`).join('\n')}\n\nReply with a number, or 0 to dismiss. Use /stop to refresh the list.` : `${status}\nNo tasks available to stop.`;
}
