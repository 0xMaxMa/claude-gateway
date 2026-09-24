import {validateBrowserIntegration} from '../../../src/jev/browser-connector';
import {sanitizeJevChildEnv} from '../../../src/jev/child-env';
import {validateJevConfig} from '../../../src/jev/validation';
test('legacy thinking settings remain readable and their unused secrets stay excluded from children',()=>{
 const config={baseUrl:'https://legacy.example/v1',model:'unused',apiKeyEnv:'OLD_TEXT_SECRET'};
 validateBrowserIntegration({bindings:[],textHelper:config});validateJevConfig({thinking:config});
 expect(sanitizeJevChildEnv({OLD_TEXT_SECRET:'fixture',NORMAL:'ok'},{thinking:config})).toEqual({NORMAL:'ok'});
 expect(()=>validateBrowserIntegration({bindings:[],textHelper:{...config,apiKeyEnv:'ANTHROPIC_API_KEY'}})).toThrow();
});
