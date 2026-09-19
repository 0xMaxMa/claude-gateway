import { msUntilNextTime } from '../history/cleanup';
import { agentJitterMs } from './dreaming';
import type { ResolvedSessionCompaction } from '../orchestration/session-compaction';

export class SessionCompactionScheduler {
  private timer?:NodeJS.Timeout;
  nextRunAt:number|null=null;
  private stopped=true;
  private generation=0;
  constructor(private agentId:string,private settings:()=>{config:ResolvedSessionCompaction;hour:number;minute:number;timezone:string;stagger:number},private run:()=>Promise<unknown>,private failed:(error:unknown)=>void){}
  start():void {
    this.stop();this.stopped=false;
    this.schedule();
  }
  private schedule(generation=this.generation):void {
    const cfg=this.settings();
    if(this.stopped||generation!==this.generation||!cfg.config.enabled)return;
    const delay=msUntilNextTime(cfg.hour,cfg.minute,cfg.timezone)+agentJitterMs(this.agentId,cfg.stagger);
    this.nextRunAt=Date.now()+delay;
    this.timer=setTimeout(()=>{
      if(this.stopped||generation!==this.generation)return;
      this.timer=undefined;this.nextRunAt=null;
      void this.run().catch(this.failed).finally(()=>this.schedule(generation));
    },delay);
    this.timer.unref();
  }
  stop():void {this.generation++;this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.nextRunAt=null;}
}
