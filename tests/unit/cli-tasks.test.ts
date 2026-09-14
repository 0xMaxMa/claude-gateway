import { runCli } from '../../src/cli';
import { request, resolveReachableUrl } from '../../src/cli/http-client';
jest.mock('../../src/cli/http-client', () => ({
  ...jest.requireActual('../../src/cli/http-client'),
  resolveReachableUrl: jest.fn(async () => 'http://fixture'),
  request: jest.fn(),
}));
const flags = ['--agent','a','--session','s','--key','fixture','--json'];
let out: jest.SpyInstance, err: jest.SpyInstance;
beforeEach(()=>{jest.clearAllMocks();out=jest.spyOn(process.stdout,'write').mockImplementation(()=>true);err=jest.spyOn(process.stderr,'write').mockImplementation(()=>true);});
afterEach(()=>{out.mockRestore();err.mockRestore();jest.useRealTimers();});
test.each([['show'],['list','--page','-1'],['list','--all','oops'],['cancel','id','--all'],['list','--typo'],['list','extra']])('rejects malformed tasks invocation %j without transport',async(...args)=>{
 expect(await runCli(['tasks',...args,...flags])).toBe(1);expect(request).not.toHaveBeenCalled();expect(resolveReachableUrl).not.toHaveBeenCalled();
});
test('help is read only',async()=>{expect(await runCli(['tasks','--help'])).toBe(0);expect(request).not.toHaveBeenCalled();});
test('watch includes newly listed tasks and Ctrl+C cancels only the read',async()=>{
 jest.useFakeTimers();let calls=0;
 (request as jest.Mock).mockImplementation(async()=>({data:{tasks:++calls===1?[]:[{taskId:'new',state:'running'}]}}));
 const watch=runCli(['tasks','watch',...flags]);
 await jest.advanceTimersByTimeAsync(0);
 await jest.advanceTimersByTimeAsync(3000);
 expect(JSON.parse(String(out.mock.calls.at(-1)![0])).tasks[0].taskId).toBe('new');
 process.emit('SIGINT');expect(await watch).toBe(0);
 expect((request as jest.Mock).mock.calls.every(([opts])=>opts.method==='GET')).toBe(true);
});
test('Ctrl+C aborts an in-flight watch request and removes listeners',async()=>{
 const count=process.listenerCount('SIGINT');
 let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 (request as jest.Mock).mockImplementation(({signal})=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')));started();}));
 const watch=runCli(['tasks','watch',...flags]);await ready;process.emit('SIGINT');expect(await watch).toBe(0);
 expect(process.listenerCount('SIGINT')).toBe(count);
});
