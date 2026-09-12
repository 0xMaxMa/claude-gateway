import type { AgentConfig } from '../types';
import { OrchestrationStore } from './store';
import { scrubText } from '../agent/incident';
import { extractToolDetail } from '../utils/tool-labels';

type Status = {since: number; messageId?: number; text?: string; details?: string; nextAt: number; seenAt: number; sentAt?: number; moveAttemptAt?: number; obsoleteMessageId?: number; cleanupAt?: number};
/** One editable, best-effort status message per conversation. It never owns task execution. */
export class TelegramToolStatus {
  private readonly startedAt = Date.now();
  private readonly statuses = new Map<string, Status>();
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private token = '';
  constructor(private store: OrchestrationStore, private agent: () => AgentConfig,
    private enabled: () => boolean, private request: typeof fetch = fetch) {}
  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 2000);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.ticking || this.abort.signal.aborted || !this.enabled()) return;
    const token = this.agent().telegram?.botToken;
    if (!token) return;
    if (token !== this.token) { this.statuses.clear(); this.token = token; }
    this.ticking = true;
    try {
      const rows = this.store.all(`SELECT c.* FROM conversations c WHERE c.source='telegram' AND (
        EXISTS(SELECT 1 FROM tasks t WHERE t.conversation_id=c.id AND t.state IN ('queued','starting','running','interrupting','cancel_requested')) OR
        EXISTS(SELECT 1 FROM conversation_decisions d WHERE d.conversation_id=c.id AND d.state IN ('running','interrupting')) OR
        EXISTS(SELECT 1 FROM conversation_events e WHERE e.conversation_id=c.id AND e.type='tool.activity' AND e.occurred_at>=?)
      ) LIMIT 100`, Math.max(this.startedAt, Date.now()-10000));
      const ids = new Set(rows.map(row => String(row.id)));
      for (const [id,status] of this.statuses) {
        if (Date.now()-status.seenAt>1800000) { this.statuses.delete(id); continue; }
        if (!ids.has(id)) {
          const row=this.store.get('SELECT * FROM conversations WHERE id=?',id);
          if (row) rows.push(row);
        }
      }
      for (const row of rows) {
        if (this.abort.signal.aborted || !this.enabled()) break;
        const id=String(row.id);
        const activeSince=this.statuses.has(id)?undefined:this.store.get(`SELECT MIN(at) AS at FROM (
          SELECT created_at AS at FROM tasks WHERE conversation_id=? AND state IN ('queued','starting','running','interrupting','cancel_requested')
          UNION ALL SELECT started_at AS at FROM conversation_decisions WHERE conversation_id=? AND state IN ('running','interrupting'))`,id,id)?.at;
        const status: Status=this.statuses.get(id) ?? {nextAt:0,seenAt:Date.now(),since:activeSince==null?this.startedAt:Number(activeSince)};
        if (Date.now()<status.nextAt) continue;
        const busy=Boolean(this.store.get("SELECT id FROM tasks WHERE conversation_id=? AND state IN ('queued','starting','running','interrupting','cancel_requested') LIMIT 1",id)
          ||this.store.get("SELECT id FROM conversation_decisions WHERE conversation_id=? AND state IN ('running','interrupting') LIMIT 1",id));
        // A replacement is sent first. Retry deleting only the known old ID;
        // keep the new status editable and avoid creating further replacements.
        if (status.obsoleteMessageId && Date.now()>=(status.cleanupAt??0)) {
          const cleanup=await this.deleteMessage(token,String(row.chat_id),status.obsoleteMessageId,status);
          if (cleanup==='deleted') status.obsoleteMessageId=undefined;
          else if(cleanup==='rate_limited') { this.statuses.set(id,status); continue; }
        }
        if (!busy) {
          status.nextAt=Date.now()+10000;
          if (!status.messageId || await this.deleteMessage(token,String(row.chat_id),status.messageId,status)==='deleted') {
            status.messageId=undefined;
            if (!status.obsoleteMessageId) this.statuses.delete(id);
          }
          continue;
        }
        // Telegram has no viewport/page signal. Count only observed, visible
        // messages in this account/chat/topic, excluding synthetic task reports
        // as inputs and excluding this best-effort status message itself.
        const canMove = Boolean(status.messageId && status.sentAt !== undefined && !status.obsoleteMessageId && Date.now()-(status.moveAttemptAt??status.sentAt??Date.now())>=30000);
        const newer = canMove ? Number(this.store.get(`SELECT (
          SELECT COUNT(*) FROM conversation_inputs i JOIN conversation_bindings b ON b.id=i.binding_id
          WHERE b.channel='telegram' AND b.account_id=? AND b.chat_id=? AND b.thread_key=?
            AND i.store_user_message=1 AND i.created_at>?
        ) + (
          SELECT COUNT(*) FROM deliveries d JOIN conversation_bindings b ON b.id=d.binding_id
          WHERE b.channel='telegram' AND b.account_id=? AND b.chat_id=? AND b.thread_key=?
            AND d.state='delivered' AND d.provider_message_id IS NOT NULL AND d.updated_at>?
        ) AS n`,row.account_id,row.chat_id,row.thread_key,status.sentAt!,
          row.account_id,row.chat_id,row.thread_key,status.sentAt!)?.n ?? 0) : 0;
        const move = newer>=6;
        const events=this.store.all("SELECT payload_json FROM conversation_events WHERE conversation_id=? AND type='tool.activity' AND occurred_at>=? ORDER BY seq DESC LIMIT 48",id,status.since);
        const details:string[]=[];
        const seen=new Set<string>();
        for (const event of events.slice().reverse()) {
          const e=JSON.parse(String(event.payload_json)).payload;
          if (e.type!=='tool_use' || e.name==='StructuredOutput' || seen.has(e.id)) continue;
          seen.add(e.id);
          const detail=telegramToolDetail(String(e.name),e.input??{});
          if (detail!==details.at(-1)) details.push(detail);
        }
        // Same history/current/elapsed layout as main's Telegram typing manager.
        const last=details.slice(-5), current=last.pop()??'🧠 Processing, please wait...';
        if (!status.messageId && !details.length && Date.now()-status.since<5000) continue;
        const signature=[...last,current].join('\n');
        if (!move && status.details===signature && Date.now()-status.seenAt<10000) continue;
        const totalSecs=Math.max(0,Math.floor((Date.now()-status.since)/1000));
        const hours=Math.floor(totalSecs/3600),mins=Math.floor((totalSecs%3600)/60),secs=totalSecs%60;
        const elapsed=hours>0?`${hours}h ${mins}m`:mins>0?(secs>0?`${mins}m ${secs}s`:`${mins}m`):`${secs}s`;
        const secrets=Object.entries(process.env).filter(([k,v])=>/TOKEN|SECRET|PASSWORD|API_KEY/i.test(k)&&v&&v.length>=8).map(([,v])=>v!);
        const text=scrubText([...last.map(d=>`☑️ : ${d}`),last.length?`🕐 : ${current}`:current,`(elapsed: ${elapsed})`].join('\n'),[token,...secrets]).slice(0,3500);
        if (!move && status.text===text) continue;
        status.nextAt=Date.now()+4000;status.seenAt=Date.now();
        if (this.statuses.size>=1000 && !this.statuses.has(id)) continue;
        this.statuses.set(id,status);
        try {
          const previousMessageId=status.messageId;
          const edit=Boolean(status.messageId) && !move;
          if (move) status.moveAttemptAt=Date.now();
          const response=await this.request(`https://api.telegram.org/bot${token}/${edit?'editMessageText':'sendMessage'}`,{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({chat_id:row.chat_id,text,...(edit?{message_id:status.messageId}:{disable_notification:true,...(row.thread_key?{message_thread_id:Number(row.thread_key)}:{})}),link_preview_options:{is_disabled:true}}),
            signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)]),
          });
          const body=await response.json() as {ok?:boolean;result?:{message_id?:number};parameters?:{retry_after?:number};description?:string};
          if (body.ok && (edit || body.result?.message_id)) {
            status.messageId=body.result?.message_id??status.messageId;status.text=text;status.details=signature;
            if (!edit) status.sentAt=Date.now();
            if (move && previousMessageId && previousMessageId!==status.messageId) {
              status.obsoleteMessageId=previousMessageId;
              if (await this.deleteMessage(token,String(row.chat_id),previousMessageId,status)==='deleted') status.obsoleteMessageId=undefined;
            }
          }
          else if(response.status===429)status.nextAt=Date.now()+Math.max(4000,(body.parameters?.retry_after??30)*1000);
          else if(edit && response.status===400 && body.description?.includes('message is not modified'))status.text=text;
          else if(edit && response.status===400 && body.description?.includes('message to edit not found'))status.messageId=undefined;
        } catch { status.nextAt=Date.now()+30000; /* Back off uncertain sends; never resubmit the underlying task. */ }
      }
    } finally {this.ticking=false;}
  }
  private async deleteMessage(token:string,chatId:string,messageId:number,status:Status):Promise<'deleted'|'retry'|'rate_limited'> {
    status.cleanupAt=Date.now()+10000;
    try {
      const response=await this.request(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,message_id:messageId}),
        signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)]),
      });
      const body=await response.json() as {ok?:boolean;description?:string;parameters?:{retry_after?:number}};
      if (body.ok || (response.status===400 && body.description?.includes('message to delete not found'))) return 'deleted';
      if(response.status===429) {status.nextAt=Date.now()+Math.max(10000,(body.parameters?.retry_after??30)*1000);return 'rate_limited';}
    } catch { /* Keep the known message ID for a later cleanup attempt. */ }
    return 'retry';
  }
  close():void {if(this.timer)clearInterval(this.timer);this.abort.abort();}
}

/** Use the legacy human-readable labels rather than raw MCP names/task IDs. */
export function telegramToolDetail(name:string,input:Record<string,unknown>):string {
  if (name==='mcp__gateway__task_spawn') return `🔥 ${String(input.title??'Starting work').slice(0,250)}`;
  if (name==='mcp__gateway__task_status') return '🔎 Checking task progress';
  if (name==='mcp__gateway__task_cancel') return '⏹ Stopping task';
  if (name==='mcp__gateway__task_update'||name==='mcp__gateway__task_answer') return '📝 Updating task';
  if (name==='Skill') return `📚 Using skill: ${String(input.skill??'assigned skill').replace(/^orchestration-task:/,'').slice(0,200)}`;
  return extractToolDetail(name,input);
}
