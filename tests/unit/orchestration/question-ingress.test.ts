import {createHmac} from 'crypto';
import {createSlackWebhookHandler} from '../../../src/api/slack-webhook-router';
import {createLineWebhookHandler} from '../../../src/api/line-webhook-router';
import type {AgentRunner} from '../../../src/agent/runner';

const id='11111111-1111-4111-8111-111111111111', secret='question-control-fixture';
function response() {
  const res={headersSent:false,status:jest.fn(),json:jest.fn(),end:jest.fn()};
  res.status.mockReturnValue(res);
  res.json.mockImplementation(()=>{res.headersSent=true;return res;});
  res.end.mockImplementation(()=>{res.headersSent=true;return res;});
  return res;
}

describe.each(['slack','line'] as const)('%s question control ingress', channel=>{
  const config={id:'a',slack:{botToken:'fixture',signingSecret:secret,dmPolicy:'allowlist',dmAllowlist:['U-owner']},line:{channelAccessToken:'fixture',channelSecret:secret,dmPolicy:'allowlist',dmAllowlist:['U-owner']}};
  const runner={getAgentConfig:()=>config,getCallbackPort:()=>1234,getGatewayPublicUrl:()=>undefined,handleLinePostback:jest.fn()} as unknown as AgentRunner;
  const handler=channel==='slack'?createSlackWebhookHandler(new Map([['a',runner]]),'/tmp'):createLineWebhookHandler(new Map([['a',runner]]),'/tmp');
  let forwarded:jest.SpyInstance;
  beforeEach(()=>{forwarded=jest.spyOn(globalThis,'fetch').mockResolvedValue({ok:true} as Response);});
  afterEach(()=>forwarded.mockRestore());

  async function post(data:string,user='U-owner',signed=true,slash=false) {
    const payload=channel==='slack'
      ? slash?new URLSearchParams({command:'/task_question',text:`${id} answer Use the existing database.`,channel_id:'D-chat',user_id:user}).toString()
        :new URLSearchParams({payload:JSON.stringify({type:'block_actions',user:{id:user},channel:{id:'D-chat'},actions:[{value:data}],message:{ts:'123.4',thread_ts:'100.1'}})}).toString()
      :JSON.stringify({events:[{type:'postback',timestamp:Date.now(),source:{type:'user',userId:user},replyToken:'reply-token',postback:{data}}]});
    const body=Buffer.from(payload),ts=String(Math.floor(Date.now()/1000));
    const headers:Record<string,string>=channel==='slack'
      ? {'content-type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':`v0=${createHmac('sha256',signed?secret:'wrong').update(`v0:${ts}:${payload}`).digest('hex')}`}
      : {'x-line-signature':createHmac('sha256',signed?secret:'wrong').update(body).digest('base64')};
    const res=response();
    await handler.handlePost({params:{agentId:'a'},body,headers:{},header:(name:string)=>headers[name.toLowerCase()]} as never,res as never);
    return res;
  }

  test.each(['snooze','mute'])('forwards authenticated %s callbacks with the question identity and channel scope',async action=>{
    await post(`orch:q:${id}:${action}`);
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveBeenCalledWith('http://127.0.0.1:1234/channel',expect.objectContaining({method:'POST'}));
    expect(JSON.parse(forwarded.mock.calls[0][1].body)).toMatchObject({content:`/orch q:${id}:${action}`,meta:channel==='slack'
      ?{source:'slack',chat_id:'D-chat',user_id:'U-owner',thread_ts:'100.1',control_message_id:'123.4'}
      :{source:'line',chat_id:'U-owner',user_id:'U-owner',reply_token:'reply-token'}});
  });

  test('preserves existing controls and rejects malformed question controls',async()=>{
    await post(`orch:${id}`);
    expect(JSON.parse(forwarded.mock.calls[0][1].body).content).toBe(`/orch ${id}`);
    forwarded.mockClear();
    for(const data of [`orch:q:${id}:answer`,`orch:q:${id}:mute:extra`,'orch:q:------------------------------------:mute'])await post(data);
    expect(forwarded).not.toHaveBeenCalled();
  });

  test('rejects unauthorized senders and invalid signatures before forwarding',async()=>{
    await post(`orch:q:${id}:mute`,'U-stranger');
    expect(forwarded).not.toHaveBeenCalled();
    const res=await post(`orch:q:${id}:mute`,'U-owner',false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(forwarded).not.toHaveBeenCalled();
  });

  if(channel==='slack')test('forwards an authenticated task-question slash answer intact',async()=>{
    await post('', 'U-owner',true,true);
    expect(JSON.parse(forwarded.mock.calls[0][1].body)).toMatchObject({content:`/task_question ${id} answer Use the existing database.`,meta:{source:'slack',chat_id:'D-chat',user_id:'U-owner'}});
  });
});
