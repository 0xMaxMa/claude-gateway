import { OrchestrationError } from './types';
import type { TaskRevision } from './types';

export const BROWSER_FIELDS_SCHEMA = {type:'array',maxItems:32,description:'Complete prepared browser field values for this goal. Use observed labels when available. Never guess personal facts. On task_update supply the full set for the revised goal; on task_answer additional values are merged.',items:{type:'object',additionalProperties:false,required:['label','text'],properties:{label:{type:'string',minLength:1,maxLength:250},text:{type:'string',minLength:1,maxLength:2000}}}};

export function preparedBrowserAnswers(value:unknown,inputId:string):TaskRevision['answers'] {
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length>32)throw new OrchestrationError('INVALID_BROWSER_FIELDS');
 const labels=new Set<string>();
 return value.map((f,index)=>{
  if(!f||typeof f!=='object'||Object.keys(f).some(k=>!['label','text'].includes(k))||typeof f.label!=='string'||!f.label.trim()||f.label.length>250||typeof f.text!=='string'||!f.text.trim()||f.text.length>2000)throw new OrchestrationError('INVALID_BROWSER_FIELDS');
  const key=f.label.normalize("NFKC").trim().replace(/\s+/g," ").toLowerCase();if(labels.has(key))throw new OrchestrationError('INVALID_BROWSER_FIELDS');labels.add(key);
  return {questionId:'prepared:'+index,inputId,text:f.text,browserFieldLabel:f.label};
 });
}
