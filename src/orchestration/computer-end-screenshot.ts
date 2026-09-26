import {createHash} from 'crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'fs';
import {dirname} from 'path';
import {MediaStore} from '../history/media-store';
import {OrchestrationStore} from './store';

/** Attach recorded bytes to the scoped closing report, never capture after access ends. */
export function attachComputerEndScreenshot(store:OrchestrationStore,agentsRoot:string,input:{taskId:string;responseId:string;principalId:string;conversationId:string;capturedAt:number;data:string}){
 const task=store.task(input.taskId);
 const response=store.get('SELECT conversation_id,state FROM assistant_responses WHERE id=?',input.responseId);
 if(!task||task.state!=='cancelled'||task.gatewayTarget?.adapter!=='computer'||task.ownerPrincipalId!==input.principalId||task.conversationId!==input.conversationId||response?.conversation_id!==input.conversationId||response.state!=='generating')throw Error('ACCESS_DENIED');
 if(!Number.isFinite(input.capturedAt)||input.capturedAt<task.createdAt||input.capturedAt>Date.now()+1000||input.data.length>160000||!/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(input.data))return;
 const bytes=Buffer.from(input.data,'base64'),hash=createHash('sha256').update(bytes).digest('hex');
 const attempt='computer-end:'+task.taskId,action='last-screenshot';
 const old=store.get('SELECT * FROM task_files WHERE attempt_id=? AND action_id=?',attempt,action);
 if(old?.response_id===input.responseId)return;
 if(old?.response_id&&store.get('SELECT state FROM assistant_responses WHERE id=?',old.response_id)?.state==='completed')return;
 const relative=`media/api-${task.agentSessionId}/computer-end-${hash}.jpg`,path=MediaStore.resolvePath(agentsRoot,store.agentId,relative);
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 try{writeFileSync(path,bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(createHash('sha256').update(readFileSync(path)).digest('hex')!==hash)throw Error('SCREENSHOT_FILE_MISMATCH');}
 const caption=`Last recorded Computer Use screenshot · ${new Date(input.capturedAt).toISOString()}. Captured before the session ended; not a live view.`;
 store.run('INSERT INTO task_files VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id,action_id) DO UPDATE SET response_id=excluded.response_id',createHash('sha256').update(attempt).digest('hex'),task.taskId,attempt,action,relative,'computer-use-last-screenshot.jpg','image',caption,input.responseId,Date.now(),hash);
}
