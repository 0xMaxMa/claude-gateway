'use strict';
const {thinkJson}=require('./thinking.cjs');
const {reasoningInstructions}=require('./reasoning-instructions.cjs');
async function thinkComputerField(config,request,signal,requestFetch){
 const {screenshot,...input}=request;
 const {output}=await thinkJson(config,{instruction:reasoningInstructions+' Return exactly {"text":string|null} for the selected desktop field. Use its application, window title, label, current value and the user goal. Maximum 2000 characters. Return null if a required user fact is missing; never put an explanation or inability-to-control message in text.',input,...(screenshot?{images:[screenshot]}:{})},signal,requestFetch);
 if(Object.keys(output).length!==1||!Object.hasOwn(output,'text')||!(output.text===null||typeof output.text==='string'&&output.text.trim()&&output.text.length<=2000))throw Error('THINKING_INVALID_RESPONSE');
 return output;
}
module.exports={thinkComputerField};
