import { progressReviewResult } from '../../../src/orchestration/progress-review';

test('silence is explicit, and incidental text or malformed control output never becomes a report',()=>{
 for(const raw of [JSON.stringify({notify_user:false,display_text:'Do not send this',spoken_text:'Do not speak'}),'Still running','{"notify_user":true', 'null'])
 expect(progressReviewResult(raw,[])).toEqual({display:'',spoken:'',silent:true});
});
test('new milestone is delivered while exact repetitions are suppressed across persisted previous messages',()=>{
 const raw=JSON.stringify({notify_user:true,display_text:'Tests passed. Reviewing PR.',spoken_text:'Tests passed.'});
 expect(progressReviewResult(raw,[])).toMatchObject({display:'Tests passed. Reviewing PR.',spoken:'Tests passed.',silent:false});
 expect(progressReviewResult(raw,['Tests passed.\n Reviewing PR.'])).toMatchObject({silent:true});
 expect(progressReviewResult('Checking...\n'+raw,['Previous step'])).toMatchObject({silent:false});
});
