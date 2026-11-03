import type {ComputerProgress} from '../automation/computer-use';
import type {TaskSnapshot} from './types';

/** What a Computer Use run is doing, for the on-screen overlay of the device it controls (GET /v1/computer/activity).
 *  The relay passes no extra command fields to the device, so the desktop app reads this from the pod instead,
 *  keyed by its relay grant. In memory only: after a restart the app shows its generic "Working…". */
export type ComputerLivePhase='acting'|'thinking'|'waiting_for_user'|'ended';
export interface ComputerLiveRun {taskId:string;requestId:string;updatedAt:number;phase:Exclude<ComputerLivePhase,'ended'>;label:string;step?:number;total?:number}
/** What the device is told: no goal text beyond the short label, no screenshots, no conversation. */
export interface ComputerLiveView {taskId:string;phase:ComputerLivePhase;label:string;step?:number;total?:number;updatedAt:number}

const LABEL_MAX=120;
const clip=(text:string)=>{const one=text.replace(/\s+/g,' ').trim();return one.length>LABEL_MAX?one.slice(0,LABEL_MAX-1)+'…':one;};
/** A bundle id or executable as a short name when it has one: com.google.Chrome → Chrome, spotify.exe → spotify;
 *  com.spotify.client stays whole (its last part names no app). */
const appName=(id?:string)=>{if(!id)return '';const base=id.replace(/\.exe$/i,''),last=base.slice(base.lastIndexOf('.')+1);return /^[A-Z]/.test(last)?last:base;};
const inApp=(e:ComputerProgress)=>{const name=appName(e.application);return name?` in ${name}`:'';};

const ACTION_LABEL:Record<NonNullable<ComputerProgress['action']>,(e:ComputerProgress)=>string>={
 open:e=>`Opening ${appName(e.appId)||'an app'}`,
 press:e=>`Clicking ${e.role?`a ${e.role}`:'a control'}${inApp(e)}`,
 type:e=>`Typing${inApp(e)}`,
 key:e=>`Pressing ${e.key??'a key'}${inApp(e)}`,
 scroll:e=>`Scrolling${inApp(e)}`,
 navigate:e=>`Navigating${inApp(e)}`,
 WAIT:()=>'Waiting for the app',
 DONE:()=>'Finishing',
 BLOCKED:()=>'Stopping',
};

/** The owner-facing line for one progress event of a goal run (no step list). */
export function computerActionLabel(e:ComputerProgress):string{
 if((e.phase==='acting'||e.phase==='acted')&&e.action)return ACTION_LABEL[e.action](e);
 if(e.phase==='observing')return `Looking at ${appName(e.application)||'the screen'}`;
 if(e.phase==='evaluating'||e.phase==='decided'||e.phase==='thinking')return 'Deciding the next step';
 if(e.phase==='reconciling')return 'Checking whether the last action ran';
 if(e.phase==='waiting')return 'Waiting for the app';
 if(e.phase==='terminal')return 'Finished this round';
 return 'Checking the result';
}

/** Latest run per relay grant (one device session runs one task at a time). */
export class ComputerLiveRuns {
 private runs=new Map<string,ComputerLiveRun>();
 constructor(private readonly now:()=>number=Date.now){}
 start(grantId:string,taskId:string,requestId:string){this.runs.set(grantId,{taskId,requestId,updatedAt:this.now(),phase:'acting',label:'Starting'});}
 /** The owner is asked to approve access on the device. */
 awaitingAccess(grantId:string,requestId:string){this.update(grantId,requestId,{phase:'waiting_for_user',label:'Approve access in the GetPod app'});}
 /** `steps`: the user's step list when the run follows one; the event's round is the 1-based step. */
 progress(grantId:string,requestId:string,e:ComputerProgress,steps?:readonly string[]){
  const phase=e.phase==='evaluating'||e.phase==='decided'||e.phase==='thinking'?'thinking':'acting';
  if(steps?.length){const step=Math.min(Math.max(1,e.round),steps.length);this.update(grantId,requestId,{phase,label:clip(steps[step-1]),step,total:steps.length});return;}
  this.update(grantId,requestId,{phase,label:clip(computerActionLabel(e)),step:Math.max(1,e.steps+(e.phase==='acted'||e.phase==='terminal'?0:1)),total:undefined});
 }
 get(grantId:string){return this.runs.get(grantId);}
 private update(grantId:string,requestId:string,next:Partial<ComputerLiveRun>){
  const run=this.runs.get(grantId);
  // A late event of an earlier round never overwrites the current one.
  if(!run||run.requestId!==requestId)return;
  this.runs.set(grantId,{...run,...next,updatedAt:this.now()});
 }
}

/** The run as the device sees it: the task's own state decides waiting and ended. */
export function computerLiveView(run:ComputerLiveRun,task:Pick<TaskSnapshot,'taskId'|'state'|'pendingQuestion'|'automationController'>):ComputerLiveView{
 const base={taskId:task.taskId,label:run.label,updatedAt:run.updatedAt,...(run.step?{step:run.step}:{}),...(run.total?{total:run.total}:{})};
 if(['completed','failed','cancelled'].includes(task.state))return {...base,phase:'ended'};
 // A settled round of a session the user drives waits for their next command; the agent's own goal run waits for the agent.
 if(task.state==='waiting_input')return {...base,phase:task.pendingQuestion||task.automationController==='user'?'waiting_for_user':'thinking'};
 if(task.state==='needs_reconciliation')return {...base,phase:'waiting_for_user'};
 return {...base,phase:run.phase};
}
