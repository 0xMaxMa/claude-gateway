import {validateBrowserIntegration} from '../../../src/jev/browser-connector';
import {sanitizeJevChildEnv} from '../../../src/jev/child-env';
import {validateJevConfig} from '../../../src/jev/validation';
test('thinking settings validate and credentials stay excluded from child processes',()=>{
 const config={baseUrl:'https://legacy.example/v1',model:'unused',apiKeyEnv:'OLD_TEXT_SECRET'};
 validateBrowserIntegration({bindings:[],textHelper:config});validateJevConfig({thinking:config});
 expect(sanitizeJevChildEnv({OLD_TEXT_SECRET:'fixture',NORMAL:'ok'},{thinking:config})).toEqual({NORMAL:'ok'});
 expect(()=>validateBrowserIntegration({bindings:[],textHelper:{...config,apiKeyEnv:'ANTHROPIC_API_KEY'}})).toThrow();
});
