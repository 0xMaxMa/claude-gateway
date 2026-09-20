import { SessionConfirmations } from '../../src/agent/session-confirmations';
const scope={channel:'line',chatId:'group',thread:'thread',sessionId:'session',principalId:'line:owner'};
const command=(menu:any,index=0)=>'/orch '+menu.buttons[index].data.slice(5);
test('confirmation is bound to principal, thread and session and cannot be replayed',()=>{
 const controls=new SessionConfirmations(),text=command(controls.open(scope,'compact'));
 for(const changed of [{principalId:'line:other'},{thread:'other'},{sessionId:'new'},{chatId:'other'}]) expect(()=>controls.choose({...scope,...changed},text)).toThrow();
 expect(controls.choose(scope,text)).toBe('compact');
 expect(()=>controls.choose(scope,text)).toThrow();
});
test('No consumes both buttons; a new prompt invalidates the earlier one',()=>{
 const controls=new SessionConfirmations(),menu=controls.open(scope,'restart');
 expect(controls.choose(scope,command(menu,1))).toBe('cancel');
 expect(()=>controls.choose(scope,command(menu))).toThrow();
 const old=command(controls.open(scope,'compact'));controls.open(scope,'restart');
 expect(()=>controls.choose(scope,old)).toThrow();
});
test('expired confirmation never executes',()=>{
 const controls=new SessionConfirmations(),text=command(controls.open(scope,'compact'));
 const now=Date.now();const clock=jest.spyOn(Date,'now').mockReturnValue(now+300001);
 try{expect(()=>controls.choose(scope,text)).toThrow();}finally{clock.mockRestore();}
});
