import { formatTaskDetail } from '../../../mcp/tools/telegram/task-detail';
import { formatTaskElapsed } from '../../../mcp/tools/telegram/task-elapsed';
import { executionDetails, executionDescription, ExecutionObservation } from '../../../src/orchestration/execution-observation';

test('elapsed formats active and finished work without counting queued time',()=>{
 expect(formatTaskElapsed(undefined,undefined,5000)).toBe('Not started');
 expect(formatTaskElapsed(1000,undefined,910000)).toBe('15m 9s');
 expect(formatTaskElapsed(1000,62000,999999)).toBe('1m 1s');
 expect(formatTaskElapsed(1000,undefined,3662000)).toBe('1h 1m 1s');
});
test('activity age and active tools each get their own line',()=>{
 const text=executionDescription({status:'waiting_for_tool',lastActivityAt:Date.now(),activeTools:['TaskOutput'],quiet:false,process:{available:false}} as ExecutionObservation);
 expect(text).toContain('\nLast activity: 0s ago.\nActive tools: TaskOutput.');
 expect(text).not.toContain('Last observed activity');
});


test('Telegram task detail separates progress from process counters and generic tool outcomes', () => {
 const clock=jest.spyOn(Date,'now').mockReturnValue(1636000);
 try {
  const activity=executionDetails({status:'process_activity',lastActivityAt:1630000,activeTools:['Bash'],quiet:false,process:{available:true,processCount:2,cpuTicksDelta:22,childCpuTicksDelta:2,ioAvailable:true,readBytesDelta:1072925,writeBytesDelta:106457},lastTool:{name:'mcp__browser__navigate',status:'returned',observedAt:0}} as ExecutionObservation);
  const text=formatTaskDetail({title:'Rebase PR',state:'running',startedAt:0,progressText:'Built final branch.',activityDetails:activity},'🔥 Running');
  expect(text).toBe('Rebase PR\n🔥 Running · Elapsed: 27m 16s\n\nProgress\nBuilt final branch.\nActive tools: Bash\nLast activity: 6s ago.\n\nDiagnostics\nProcesses: 2\nCPU: +22 ticks · Children: +2 ticks\nI/O: Read +1.07 MB · Write +106.46 KB\nLast tool: mcp__browser__navigate · Result received\nReported at: 1970-01-01 00:00:00 UTC\nProcess activity detected (not proof of task progress).');
  expect(text).not.toContain('? failed');
  expect(formatTaskDetail({title:'Queued task',state:'queued',progressText:''},'⏳ Queued')).toBe('Queued task\n⏳ Queued · Elapsed: Not started');
  const idle=formatTaskDetail({title:'Waiting',state:'running',progressText:'',activityDetails:{counters:'',activeTools:[],age:10,status:'Waiting for model output.'}},'🔥 Running');
  expect(idle).toContain('Progress\nLast activity: 10s ago.\n\nDiagnostics\nWaiting for model output.');
  expect(idle).not.toContain('Active tools:');
 } finally {clock.mockRestore();}
});
