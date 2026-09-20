import { CONTAINER_CRON_TOOLS } from '../cron/tool-schemas';
import { WORKFLOW_SCHEMA } from './workflow';

/** Container task-only MCP inventory; no host media/browser/memory delegation.
 * Invariant per role for the same reason as AGENT_TASK_TOOLS: this array becomes the
 * container agent's advertised tool list, i.e. the head of its cached prompt prefix. */
export function containerTaskTools(role: 'agent' | 'worker') {
  const text = { type: 'string' };
  const entries: Array<[string, Record<string, unknown>, string[], string]> = role === 'agent' ? [
    ['capabilities_list',{query:text,catalog_version:text,offset:{type:'integer',minimum:0}},[],'Read this app agent capability catalog without granting host access. Follow next_offset with catalog_version for the complete list; restart at 0 on CAPABILITY_CATALOG_CHANGED.'],
    ['conversation_intake',{mode:{type:'string',enum:['ready','wait','update','resolve']},resolution:text,acknowledgement:text,preparation:text,clarification:text,task_id:text},['mode'],'Only when this turn\'s instructions explicitly ask you to run intake: classify readiness, acknowledge complete instructions before execution, or prepare incomplete materials and wait. Without that instruction this turn, answer directly and use the task tools directly instead.'],
    ['task_spawn', { retry_of:text, title:text, instructions:text, target_profile:text, spoken_acknowledgement:text, skill_name:text, skill_args:text, continue_task_id:text, continuation_policy:{type:'string',enum:['after_success','after_terminal']}, context_refs:{type:'array',items:text} }, ['title','instructions','target_profile'], 'Queue work inside this app container and return a durable receipt.'],
    ['task_status',{task_id:text},[],'Read task status without waiting. Pass task_id to retrieve its complete stored result and evidence; task indexes in conversation context are not result reports.'],
    ['task_cancel',{task_id:text},['task_id'],'Request cancellation.'],
    ['task_update',{retry_of:text,task_id:text,expected_revision:{type:'integer'},instruction:text,mode:{type:'string',enum:['when_ready','interrupt_and_resume']}},['task_id','expected_revision','instruction','mode'],'Replace the current task instructions when the user changes the goal or constraints. Write the complete updated brief, preserving unchanged requirements and citing relevant user input IDs.'],
    ['task_question',{action:{type:'string',enum:['ask','discuss','defer','mute','resume']},question_ids:{type:'array',items:text,minItems:1,maxItems:20},text,delay_ms:{type:'integer',minimum:60000,maximum:2592000000}},['action','question_ids'],'Manage pending questions without answering or resuming work. Ask stages one natural separate message after your reply; discuss marks ongoing consultation; defer/mute/resume persist the user reminder preference.'],
    ['task_answer',{task_id:text,question_id:text,answer:text},['task_id','question_id','answer'],'Answer a pending worker question. Cite the user input IDs supporting any authorization; distinguish direct user statements from your interpretation. For a changed goal, prefer task_update with a complete replacement brief instead of repeatedly answering the same question.'],
  ] : [
    ['task_report_progress',{text,checkpoint:WORKFLOW_SCHEMA},['text'],'Report current phase, versioned evidence, checks and findings internally; no user notification is implied.'],
    ['task_request_input',{question:text},['question'],'Ask for input then end the turn.'],
    ['task_stage_file',{path:text,caption:text},['path'],'Stage a finished file from /workspace or /tmp inside the container.'],
  ];
  return [...entries.map(([name,properties,required,description])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}})), ...(role === 'worker' ? CONTAINER_CRON_TOOLS : [])];
}
