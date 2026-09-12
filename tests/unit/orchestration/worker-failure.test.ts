import {taskFailure} from '../../../src/orchestration/tasks/failure';
test('worker evidence keeps the error code while redacting credentials and bounding text',()=>{
 const old=process.env.TEST_API_KEY;process.env.TEST_API_KEY='private-credential-value';
 try {
  const error=taskFailure(Object.assign(Error('Failed with private-credential-value '+ 'x'.repeat(3000)),{code:'PROVIDER_FAILED'}));
  expect(error.code).toBe('PROVIDER_FAILED');expect(error.message).not.toContain('private-credential-value');expect(error.message.length).toBeLessThanOrEqual(2048);
 }finally{if(old===undefined)delete process.env.TEST_API_KEY;else process.env.TEST_API_KEY=old;}
});
