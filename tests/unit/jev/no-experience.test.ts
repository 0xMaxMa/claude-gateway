import {validateJevConfig} from '../../../src/jev/validation';
test('removed experience configuration is not silently activated',()=>{
 expect(()=>validateJevConfig({enabled:false})).not.toThrow();
 expect(()=>validateJevConfig({experience:{enabled:true}} as any)).toThrow('Unknown Jev configuration field');
});
