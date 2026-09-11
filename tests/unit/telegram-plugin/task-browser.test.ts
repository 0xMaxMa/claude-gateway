import { LiveTaskBrowser, TaskBrowserMessage, TaskBrowserMenu } from '../../../mcp/tools/telegram/task-browser';
const setup = (restored: TaskBrowserMessage[] = []) => {
  let result: any = {sessionId:'session-a',page:0,state:'queued'};
  let now=0,id=10;
  const io={
    read:jest.fn(async(_chat:string,_user:string,_payload:Record<string,unknown>)=>result),render:(r:any)=>({text:JSON.stringify(r),reply_markup:{inline_keyboard:[]}}),
    send:jest.fn(async()=>++id),edit:jest.fn(async(_chat:string,_id:number,_menu:TaskBrowserMenu)=>{}),remove:jest.fn(async()=>{}),close:jest.fn(async()=>{}),
    allowed:jest.fn(()=>true),persist:jest.fn((_entries:TaskBrowserMessage[])=>{}),now:()=>now,
  };
  return {io,browser:new LiveTaskBrowser(io,restored),set:(r:any)=>{result=r},time:(n:number)=>{now=n}};
};
test('one latest message per chat; replacement deletes old and unchanged polls do not edit',async()=>{
 const {io,browser,set}=setup();await browser.open('1','1');await browser.tick();expect(io.edit).not.toHaveBeenCalled();
 set({sessionId:'session-a',page:0,state:'running'});await browser.tick();expect(io.edit).toHaveBeenCalledTimes(1);
 await browser.open('1','1');expect(io.remove).toHaveBeenCalledWith('1',11);expect(io.send).toHaveBeenCalledTimes(2);
 await expect(browser.navigate('1','1',11,{action:'cancel',task_id:'old'})).rejects.toThrow('EXPIRED');
 expect(io.read).toHaveBeenCalledTimes(4);
});
test('detail stays on task, follows progress, and stops polling after final state is shown',async()=>{
 const {io,browser,set}=setup();await browser.open('1','1');
 set({sessionId:'session-a',task:{taskId:'t',state:'running'},progress:'first'});
 await browser.navigate('1','1',11,{action:'detail',task_id:'t'});
 set({sessionId:'session-a',task:{taskId:'t',state:'running'},progress:'second'});await browser.tick();
 expect(io.read).toHaveBeenLastCalledWith('1','1',{action:'detail',task_id:'t',session_id:'session-a'});
 expect(io.edit.mock.calls.at(-1)?.[2].text).toContain('second');
 set({sessionId:'session-a',task:{taskId:'t',state:'completed'}});await browser.tick();
 const calls=io.read.mock.calls.length;await browser.tick();expect(io.read).toHaveBeenCalledTimes(calls);
 expect(io.edit.mock.calls.at(-1)?.[2].text).toContain('completed');
});
test('auto refresh never repeats an explicit stop even when its Telegram edit fails',async()=>{
 const {io,browser,set,time}=setup();await browser.open('1','1');set({sessionId:'session-a',task:{taskId:'t',state:'cancel_requested'}});
 io.edit.mockRejectedValueOnce(Error('network'));
 await expect(browser.navigate('1','1',11,{action:'cancel',task_id:'t'})).rejects.toThrow('network');
 time(11000);await browser.tick();
 expect(io.read.mock.calls.filter((c:any)=>c[2].action==='cancel')).toHaveLength(1);
 expect(io.read).toHaveBeenLastCalledWith('1','1',{action:'detail',task_id:'t',session_id:'session-a'});
});
test('a session switch closes the old browser without reading tasks from the new session',async()=>{
 const {io,browser}=setup();await browser.open('1','1');io.read.mockRejectedValueOnce(Error('TASK_SESSION_CHANGED'));
 await browser.tick();expect(io.remove).toHaveBeenCalledWith('1',11);const calls=io.read.mock.calls.length;
 await browser.tick();expect(io.read).toHaveBeenCalledTimes(calls);
});
test('dismiss stops refresh and persisted state supports replacement after a receiver restart',async()=>{
 const first=setup();await first.browser.open('1','1');const state=first.io.persist.mock.calls.at(-1)![0];
 const next=setup(state);await next.browser.open('1','1');expect(next.io.remove).toHaveBeenCalledWith('1',11);
 await next.browser.navigate('1','1',11,{action:'dismiss'});const calls=next.io.read.mock.calls.length;
 await next.browser.tick();expect(next.io.read).toHaveBeenCalledTimes(calls);expect(next.io.persist).toHaveBeenLastCalledWith([]);
});
test('Telegram rate limits delay edits and reads according to retry_after',async()=>{
 const {io,browser,set,time}=setup();await browser.open('1','1');set({sessionId:'session-a',page:0,state:'running'});
 io.edit.mockRejectedValueOnce({error_code:429,parameters:{retry_after:20}});await browser.tick();
 const calls=io.read.mock.calls.length;time(19000);await browser.tick();expect(io.read).toHaveBeenCalledTimes(calls);
 time(20000);await browser.tick();expect(io.edit).toHaveBeenCalledTimes(2);
});
test('deleted messages and revoked access remove subscriptions',async()=>{
 const {io,browser,set}=setup();await browser.open('1','1');set({sessionId:'session-a',page:0,state:'running'});
 io.edit.mockRejectedValueOnce(Error('Bad Request: message to edit not found'));await browser.tick();
 expect(io.persist).toHaveBeenLastCalledWith([]);
 await browser.open('1','1');io.allowed.mockReturnValue(false);await browser.tick();expect(io.persist).toHaveBeenLastCalledWith([]);
});
test('replacement falls back to closing buttons; failed closure never creates a second live box',async()=>{
 const {io,browser}=setup();await browser.open('1','1');io.remove.mockRejectedValue(Error('cannot delete'));
 await browser.open('1','1');expect(io.close).toHaveBeenCalledWith('1',11);
 io.close.mockRejectedValue(Error('unavailable'));await expect(browser.open('1','1')).rejects.toThrow('unavailable');expect(io.send).toHaveBeenCalledTimes(2);
});
test('rapid opens and refresh in flight serialize so old updates cannot overwrite the new box',async()=>{
 const {io,browser,set}=setup();await Promise.all([browser.open('1','1'),browser.open('1','1')]);
 let release!:(value:any)=>void;
 io.read.mockImplementationOnce(()=>new Promise(r=>{release=r}));
 const tick=browser.tick();await Promise.resolve();await Promise.resolve();
 const opened=browser.open('1','1');release({sessionId:'session-a',page:0,state:'running'});await tick;await opened;
 expect(io.remove).toHaveBeenLastCalledWith('1',12);
 expect(io.send).toHaveBeenCalledTimes(3);
 set({sessionId:'session-a',page:0,state:'done'});await browser.tick();expect(io.edit.mock.calls.at(-1)?.[1]).toBe(13);
});
