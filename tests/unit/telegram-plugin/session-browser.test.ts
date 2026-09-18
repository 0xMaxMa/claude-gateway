import {parseSessionInfo} from '../../../mcp/tools/telegram/session-browser';
import {LiveTaskBrowser} from '../../../mcp/tools/telegram/task-browser';

test('empty session is displayed, refreshed and replaced without an error or duplicate',async()=>{
 let result:unknown={success:true,sessionId:null,text:'No active session found.'};
 let id=0;
 const io={read:async()=>parseSessionInfo(true,result),render:(r:any)=>({text:r.text,reply_markup:{inline_keyboard:[]}}),
  send:jest.fn(async()=>++id),edit:jest.fn(async()=>{}),remove:jest.fn(async()=>{}),close:jest.fn(async()=>{}),allowed:()=>true,persist:()=>{}};
 const browser=new LiveTaskBrowser(io);
 await browser.open('1','1');
 expect(io.send.mock.calls[0]).toEqual(['1',{text:'No active session found.',reply_markup:{inline_keyboard:[]}}]);
 await browser.tick();expect(io.edit).not.toHaveBeenCalled();
 await browser.open('1','1');expect(io.remove).toHaveBeenCalledWith('1',1);
 result={success:true,sessionId:'real-session',text:'Context: 1K'};
 await browser.tick();expect(io.remove).toHaveBeenLastCalledWith('1',2);
 await browser.open('1','1');expect(io.send).toHaveBeenCalledTimes(3);
 result={success:true,sessionId:null,text:'No active session found.'};
 await browser.tick();expect(io.remove).toHaveBeenLastCalledWith('1',3);
});

test.each([null,{}, {success:false,sessionId:null,text:'failure'}, {success:true,text:'missing ID'}, {success:true,sessionId:17,text:'invalid'}])('malformed callback is still rejected: %p',value=>{
 expect(()=>parseSessionInfo(true,value)).toThrow('Session info unavailable');
});
test('HTTP failure cannot be presented as an empty session',()=>{
 expect(()=>parseSessionInfo(false,{success:true,sessionId:null,text:'No active session found.'})).toThrow();
});
