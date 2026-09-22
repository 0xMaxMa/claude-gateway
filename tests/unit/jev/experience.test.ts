import {validateJevConfig} from '../../../src/jev/validation';
import {ExperienceLibrary} from '@0xmaxma/jev-loop/experience';
import {mkdtempSync,rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
test('Experience configuration rejects execution, secrets, unsafe URLs and invalid limits',()=>{
 for(const value of [{directory:'/tmp/a'},{scope:'another-user'},{apiKey:'secret'},{registryUrl:'http://remote.test/'},{registryUrl:'https://user:password@registry.test/'},{maxRecords:100000},{autoDownload:'true'}])expect(()=>validateJevConfig({experience:value as any})).toThrow();
 for(const value of [{},{enabled:false},{autoDownload:false,maxHints:3},{registryUrl:'https://registry.example/packs/'}])expect(()=>validateJevConfig({experience:value})).not.toThrow();
});
test.each(['host','app-container'])('%s learning remains principal and conversation scoped across restart',async kind=>{
 const directory=mkdtempSync(join(tmpdir(),'gateway-experience-'));try{
 const context={logic:'browser-use' as const,identity:{category:'web' as const,id:'https://fixture.test',path:'/search'},capabilities:['observe','type'] as any,controls:[{role:'input' as const,state:'empty' as const}]};
 const recipe={when:context.controls[0],action:'type' as const,expected:'value-changed' as const};
 const lib=(user:string,conversation:string,runId?:string)=>new ExperienceLibrary({directory,scope:JSON.stringify([kind,user,conversation]),autoDownload:false,runId});
 for(let i=0;i<3;i++){await lib('u','c','r'+i).record(context,recipe,'effect-only','op'+i);await lib('u','c').verifyRun('r'+i);}
 expect(await lib('u','c').stats()).toMatchObject({records:1,active:1});
 expect(await lib('v','c').stats()).toMatchObject({records:0});expect(await lib('u','other').stats()).toMatchObject({records:0});
 }finally{rmSync(directory,{recursive:true,force:true});}
});
