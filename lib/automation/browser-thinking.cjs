'use strict';
const {thinkJson}=require('./thinking.cjs');
const {reasoningInstructions:policy}=require('./reasoning-instructions.cjs');
async function thinkBrowserField(config,input,signal,requestFetch){
 const {output}=await thinkJson(config,{instruction:policy+' Return exactly {"text":string|null}: the literal value to type into the selected field. Use prepared facts, field meaning, current page and recent actions. For search/autocomplete, give only a concise query, not a sentence explaining it. If the value requires a missing user fact or ambiguous decision, return null. Maximum 2000 characters. Do not put reasoning or next steps in text.',input},signal,requestFetch);
 if(Object.keys(output).length!==1||!Object.hasOwn(output,'text')||!(output.text===null||typeof output.text==='string'&&output.text.trim()&&output.text.length<=2000))throw Error('THINKING_INVALID_RESPONSE');
 return output;
}
module.exports={thinkBrowserField};
