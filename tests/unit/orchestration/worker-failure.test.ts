import {taskFailure} from '../../../src/orchestration/tasks/failure';
test('worker evidence keeps the error code while redacting credentials and bounding text',()=>{
 const old=process.env.TEST_API_KEY;process.env.TEST_API_KEY='private-credential-value';
 try {
  const error=taskFailure(Object.assign(Error('Failed with private-credential-value '+ 'x'.repeat(3000)),{code:'PROVIDER_FAILED'}));
  expect(error.code).toBe('PROVIDER_FAILED');expect(error.message).not.toContain('private-credential-value');expect(error.message.length).toBeLessThanOrEqual(2048);
 }finally{if(old===undefined)delete process.env.TEST_API_KEY;else process.env.TEST_API_KEY=old;}
});

test('inventory rejection evidence survives error conversion into the durable failure (#548)',()=>{
 const failure=taskFailure(Object.assign(new Error('inventory mismatch'),{code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'unexpected',rejectedTools:['mcp__gateway__task_stage_file']}));
 expect(failure.code).toBe('PROFILE_INVENTORY_MISMATCH');
 expect(failure.inventory).toEqual({kind:'unexpected',rejectedTools:['mcp__gateway__task_stage_file']});
});

test('missing and malformed inventories keep distinguishable durable diagnostics (#548)',()=>{
 const missing=taskFailure(Object.assign(new Error('x'),{code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'missing',rejectedTools:[]}));
 const malformed=taskFailure(Object.assign(new Error('x'),{code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'malformed',rejectedTools:[]}));
 expect(missing.inventory?.kind).toBe('missing');
 expect(malformed.inventory?.kind).toBe('malformed');
 expect(missing.inventory).not.toEqual(malformed.inventory);
 // kind is the source of truth; missing/malformed carry no per-tool names (F4).
 expect(missing.inventory?.rejectedTools).toEqual([]);
 expect(malformed.inventory?.rejectedTools).toEqual([]);
});

test('an ordinary failure with no inventory evidence carries no inventory field (#548)',()=>{
 const failure=taskFailure(Object.assign(new Error('boom'),{code:'PROVIDER_FAILED'}));
 expect(failure.inventory).toBeUndefined();
 // Guard against an unvalidated kind smuggling arbitrary data into the durable state.
 expect(taskFailure(Object.assign(new Error('boom'),{code:'X',inventoryKind:'bogus',rejectedTools:['a']})).inventory).toBeUndefined();
});

test('rejected tool names are sanitized and bounded, leaking no secrets, in the durable failure (#548)',()=>{
 const old=process.env.TEST_API_KEY;process.env.TEST_API_KEY='super-secret-token-value';
 try {
  const failure=taskFailure(Object.assign(new Error('x'),{code:'PROFILE_INVENTORY_MISMATCH',inventoryKind:'unexpected',
    rejectedTools:['contains super-secret-token-value here','n'.repeat(500),42,...Array(200).fill('tool')]}));
  expect(failure.inventory!.rejectedTools.length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(failure.inventory)).not.toContain('super-secret-token-value');
  expect(failure.inventory!.rejectedTools.every(name=>name.length<=160)).toBe(true);
  expect(failure.inventory!.rejectedTools).toContain('<invalid-name>');
 }finally{if(old===undefined)delete process.env.TEST_API_KEY;else process.env.TEST_API_KEY=old;}
});
