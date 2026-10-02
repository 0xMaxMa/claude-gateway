import {compactComputerPromptState} from '../../../src/orchestration/computer-prompt';

test('dense prompt tables preserve current target identity, missing fields and empty values',()=>{
 const controls=Array.from({length:100},(_,i)=>({ref:'c'+i,role:'AXTextField',label:'Field '+i,actions:['type'],...(i%2?{focused:false,value:''}:{})}));
 const apps=Array.from({length:60},(_,i)=>({id:'app.'+i,name:'Application '+i}));
 const state={generation:'fresh-frame',application:'test',controls,apps,screenshotAvailable:false,screenshotRestriction:'SCREENSHOT_OBSERVATION_INCOMPLETE'};
 const result=compactComputerPromptState(state) as any;
 expect(result.generation).toBe('fresh-frame');expect(result.screenshotRestriction).toBe(state.screenshotRestriction);
 for(const [name,original] of Object.entries({controls,apps})){
  const table=result[name];expect(table.rows).toHaveLength(original.length);
  table.rows.forEach((cells:unknown[],i:number)=>{
   const reconstructed=Object.fromEntries(table.columns.map((key:string,j:number)=>[key,cells[j]]));
   expect(reconstructed).toMatchObject(original[i]);
   for(const key of table.columns)if(!Object.hasOwn(original[i],key))expect(reconstructed[key]).toBeNull();
  });
 }
 expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(state).length*.8);
 expect(state.controls).toBe(controls);expect(Array.isArray(state.controls)).toBe(true);
});

test('small and unfamiliar shapes retain their original representation',()=>{
 for(const state of [null,'unknown',[],{controls:[]},{controls:[null]},{controls:[{ref:'c0'}]},{apps:[['legacy']]}])expect(compactComputerPromptState(state)).toEqual(state);
});
