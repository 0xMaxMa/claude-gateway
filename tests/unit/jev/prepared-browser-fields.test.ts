import {preparedBrowserAnswers} from '../../../src/orchestration/browser-fields';
test('prepared field values reject ambiguity and oversized input before dispatch',()=>{
 for(const value of [null,{},[{label:'To',text:'Osaka'},{label:' to ',text:'Tokyo'}],[{label:'',text:'x'}],[{label:'Name',text:'x'.repeat(2001)}],Array.from({length:33},(_,i)=>({label:String(i),text:'x'}))])expect(()=>preparedBrowserAnswers(value,'i')).toThrow('INVALID_BROWSER_FIELDS');
 expect(preparedBrowserAnswers([{label:'To',text:'大阪'}],'i')).toEqual([{questionId:'prepared:0',inputId:'i',browserFieldLabel:'To',text:'大阪'}]);
});
