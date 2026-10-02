import type {ComputerUseDependencies} from './computer-use';
import {readChoice} from './computer-policy';

/** Keep opaque app/control IDs out of the provider's choice vocabulary.
 * Maps live for this request only. Descriptions, state and correlation stay intact.
 * Decode and validate every answer before a controller can select an action.
 */
export async function evaluateComputerChoices(
 request:Parameters<ComputerUseDependencies['evaluate']>[0],
 evaluate: (request:Parameters<ComputerUseDependencies['evaluate']>[0])=>ReturnType<ComputerUseDependencies['evaluate']>,
):ReturnType<ComputerUseDependencies['evaluate']> {
 const ids=new Map(Object.entries(request.questions).map(([name,q])=>[name,Object.keys(q.criteria)]));
 const questions=Object.fromEntries(Object.entries(request.questions).map(([name,q])=>[name,{...q,
  criteria:Object.fromEntries(ids.get(name)!.map((id,i)=>[String(i),q.criteria[id]])),
 }]));
 const response=await evaluate({...request,questions});
 if(Object.keys(response.answers).length!==ids.size||Object.keys(response.answers).some(name=>!ids.has(name)))throw Error('INVALID_DECISION');
 const answers=Object.fromEntries(Object.entries(questions).map(([name,q])=>{
  const answer=readChoice(response.answers[name],q.criteria),keys=ids.get(name)!;
  return [name,{type:'choice',choice:keys[Number(answer.choice)],confidence:answer.confidence,
   probabilities:Object.fromEntries(Object.entries(answer.probabilities).map(([id,p])=>[keys[Number(id)],p]))}];
 }));
 return {...response,answers};
}
