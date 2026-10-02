/** Lossless value tables for the parent prompt, not the MCP/receipt contract.
 * Every frame is self-contained: no prior refs or cached UI state are needed.
 * Native optional fields use null cells to mean not reported; empty/false stay distinct.
 */
export function compactComputerPromptState(state: unknown): unknown {
 if(!state||typeof state!=='object'||Array.isArray(state))return state;
 const result={...state as Record<string,unknown>};
 for(const name of ['controls','apps']){
  const items=result[name];
  if(!Array.isArray(items)||!items.length||items.some(item=>!item||typeof item!=='object'||Array.isArray(item)))continue;
  const columns=[...new Set(items.flatMap(item=>Object.keys(item)))].sort();
  const table={columns,rows:items.map(item=>columns.map(key=>Object.hasOwn(item,key)?item[key]:null))};
  // Tiny observations already have a simpler, shorter object representation.
  if(JSON.stringify(table).length<JSON.stringify(items).length)result[name]=table;
 }
 return result;
}
