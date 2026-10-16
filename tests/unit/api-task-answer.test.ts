import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { createApiRouter } from '../../src/api/router';
import { apiPrincipal } from '../../src/orchestration/identity';
import { AgentRunner } from '../../src/agent/runner';
import { AgentConfig } from '../../src/types';

test('task answer requires authentication, agent and tool access, and explicit question identity', async () => {
  const answerApiTask=jest.fn(async () => ({taskId:'task-a',state:'queued'}));
  const config: Partial<AgentConfig>={};
  const runner=Object.assign(new EventEmitter(),{answerApiTask,getAgentConfig:()=>config}) as unknown as AgentRunner;
  const owner={key:'owner-fixture',agents:['a'],allow_tools:true};
  const app=express(); app.use(express.json());
  app.use('/api',createApiRouter(new Map([['a',runner]]),new Map([['a',{id:'a'} as AgentConfig]]),[owner,{key:'other-fixture',agents:['other'],allow_tools:true},{key:'read-fixture',agents:['a'],allow_tools:false}]));
  const path='/api/v1/agents/a/sessions/session-a/tasks/task-a/answer';
  const body={questionId:'question-a',answer:'Use the first option'};
  expect((await request(app).post(path).send(body)).status).toBe(401);
  expect((await request(app).post(path).set('Authorization','Bearer other-fixture').send(body)).status).toBe(403);
  expect((await request(app).post(path).set('Authorization','Bearer read-fixture').send(body)).status).toBe(403);
  expect((await request(app).post(path).set('Authorization','Bearer owner-fixture').send({answer:'yes'})).status).toBe(400);
  expect((await request(app).post(path).set('Authorization','Bearer owner-fixture').send({...body,answer:' '})).status).toBe(400);
  expect(answerApiTask).not.toHaveBeenCalled();
  expect((await request(app).post(path).set('Authorization','Bearer owner-fixture').send(body)).body.task.state).toBe('queued');
  expect(answerApiTask).toHaveBeenCalledWith('session-a',apiPrincipal(owner),'task-a','question-a','Use the first option');
  answerApiTask.mockRejectedValueOnce(new Error('QUESTION_ALREADY_ANSWERED'));
  expect((await request(app).post(path).set('Authorization','Bearer owner-fixture').send(body)).status).toBe(403);
  config.allow_tools=false;
  expect((await request(app).post(path).set('Authorization','Bearer owner-fixture').send(body)).status).toBe(403);
  expect(answerApiTask).toHaveBeenCalledTimes(2);
});

test('legacy mode rejects answers without opening orchestration', async () => {
  const runner=Object.create(AgentRunner.prototype) as any;
  runner.agentConfig={orchestration:{enabled:false}};
  runner.getOrchestration=jest.fn();
  await expect(runner.answerApiTask('s','owner','t','q','yes')).rejects.toThrow('ORCHESTRATION_DISABLED');
  expect(runner.getOrchestration).not.toHaveBeenCalled();
});

test('Telegram question controls authenticate the sender and resolve the current session', async () => {
  const runner=Object.create(AgentRunner.prototype) as any;
  runner.agentConfig={id:'a',orchestration:{enabled:true,channels:['telegram']}};
  runner.sessionStore={getActiveSessionId:jest.fn(async ()=>'active-session')};
  const handle=jest.fn(()=>({text:'Reminder muted.',buttons:[]}));
  runner.getOrchestration=jest.fn(async ()=>({questionControls:{handle}}));
  const res={writeHead:jest.fn(),end:jest.fn()};
  const body={command:'telegram_question',chat_id:'123',payload:{user_id:'456',question_id:'question-a',action:'mute'}};
  await runner.handleCommandRequest(JSON.stringify(body),res);
  expect(res.writeHead).toHaveBeenLastCalledWith(400,expect.anything());
  expect(handle).not.toHaveBeenCalled();
  body.payload.user_id='123';
  await runner.handleCommandRequest(JSON.stringify(body),res);
  expect(handle).toHaveBeenCalledWith({channel:'telegram',chatId:'123',thread:'',sessionId:'active-session',principalId:'telegram:123'},'/task_question question-a mute');
  expect(JSON.parse(res.end.mock.calls.at(-1)![0])).toEqual({success:true,text:'Reminder muted.'});
  handle.mockImplementationOnce(()=>{throw Error('STALE_QUESTION');});
  await runner.handleCommandRequest(JSON.stringify(body),res);
  expect(JSON.parse(res.end.mock.calls.at(-1)![0]).success).toBe(false);
});

test('Telegram text question confirmation sends a separate message in its topic', async () => {
  const runner=Object.create(AgentRunner.prototype) as any;
  runner.agentConfig={id:'a',telegram:{botToken:'fixture-token'}};
  const send=jest.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>({ok:true,result:{message_id:42}})} as Response);
  try {
    await runner.sendOrchestrationControl('telegram','123',{text:'Reminder muted.',buttons:[]},{message_thread_id:'9',control_message_id:'3'});
    expect(send).toHaveBeenCalledWith('https://api.telegram.org/botfixture-token/sendMessage',expect.objectContaining({method:'POST'}));
    expect(JSON.parse(send.mock.calls[0][1]!.body as string)).toMatchObject({chat_id:'123',message_thread_id:9,text:'Reminder muted.'});
  } finally { send.mockRestore(); }
});
