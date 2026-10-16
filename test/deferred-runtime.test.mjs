import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findPackageJSON} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {test} from 'node:test';

const sdkPath=process.env.PI_V1_SDK_PATH;
const presetPath=process.env.PI_PRESET_EXTENSION_PATH;
const childPath=process.env.PI_SUBAGENT_EXTENSION_PATH;
const pilot=['web_search','fetch_content','get_search_content'];

test('native deferred schemas, codemode execution and restricted discovery', {skip:!sdkPath}, async()=>{
  const sdk=await import(pathToFileURL(sdkPath).href);
  const ai=await import(new URL('./dist/index.js',pathToFileURL(findPackageJSON('@earendil-works/pi-ai',pathToFileURL(sdkPath)))).href);
  sdk.initTheme('dark',false);
  const root=mkdtempSync(join(tmpdir(),'web-deferred-runtime-'));
  const agentDir=join(root,'agent');mkdirSync(agentDir);
  const keys=['PI_CODING_AGENT_DIR','PI_SUBAGENT_ID','PI_SUBAGENT_TOOLS','PI_SUBAGENT_SOCKET','PI_SUBAGENT_TOKEN','PI_SUBAGENT_INITIAL_TOOLS','PI_SUBAGENT_NAME','PI_SUBAGENT_AGENT','PI_SUBAGENT_DEPTH','PI_SUBAGENT_AUTO_EXIT','PI_SUBAGENT_MODEL','PI_SUBAGENT_THINKING','PI_DENY_TOOLS','PI_OFFLINE'];
  const saved=new Map(keys.map(key=>[key,process.env[key]]));
  for(const key of keys) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_OFFLINE='1';
  // Only this disposable fixture may use loopback. No provider or external URL is called.
  writeFileSync(join(agentDir,'web-search.json'),JSON.stringify({workflow:'none',allowBrowserCookies:false,ssrf:{allowRanges:['127.0.0.1/32']}}));
  let requests=0;
  const server=createServer((req,res)=>{requests++;res.writeHead(200,{'content-type':'text/plain'});res.end('DEFERRED_FIXTURE '+req.url+'\n'+'Local test content. '.repeat(30));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const errors=[],metrics={};let session;
  try {
    const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:join(agentDir,'models.json'),refreshOnCreate:false});
    const faux=ai.fauxProvider();runtime.registerNativeProvider(faux.provider);
    const extensionPath=fileURLToPath(new URL('../index.ts',import.meta.url));
    const start=async({eager=false,restricted=false,full=false,child=false}={})=>{
      if(session) session.dispose();
      const allowed=restricted?['read','codemode']:child?['read','codemode','tool_search',...pilot,'subagent_done']:undefined;
      if(restricted||child){process.env.PI_SUBAGENT_ID='child-probe';process.env.PI_SUBAGENT_TOOLS=allowed.join(',');}
      else {delete process.env.PI_SUBAGENT_ID;delete process.env.PI_SUBAGENT_TOOLS;}
      writeFileSync(join(agentDir,'presets.json'),JSON.stringify({$default:'coding',coding:{tools:['read','codemode',...(eager?pilot:[])]},full:{tools:['*']}}));
      const settings=sdk.SettingsManager.inMemory({defaultTools:['read','codemode'],retry:{enabled:false}});
      const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir,settingsManager:settings,noExtensions:true,noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true,
        additionalExtensionPaths:[extensionPath,...(presetPath?[presetPath]:[]),...(child&&childPath?[childPath]:[])],extensionFactories:[sdk.createCodemodeExtension({models:false}),sdk.createToolSearchExtension()]});
      await loader.reload();
      ({session}=await sdk.createAgentSession({cwd:root,agentDir,modelRuntime:runtime,model:faux.getModel(),settingsManager:settings,resourceLoader:loader,sessionManager:sdk.SessionManager.inMemory(),tools:allowed}));
      await session.bindExtensions({onError:e=>errors.push(e)});
      if(!presetPath && eager) session.setActiveToolsByName(['read','codemode',...pilot]);
      if(presetPath && full) await session.prompt('/preset full');
    };
    const capture=async(label)=>{
      let declared;
      faux.setResponses([context=>{declared=ai.getCurrentTools(context.messages);return ai.fauxAssistantMessage('schema probe');}]);
      await session.prompt('Capture the current tool declarations.');
      assert.ok(declared,'Faux provider was not called');
      const selected=declared.filter(tool=>pilot.includes(tool.name));
      metrics[label]={schemas:selected.map(tool=>tool.name),schemaBytes:selected.reduce((n,tool)=>n+Buffer.byteLength(JSON.stringify(tool)),0)};
      return declared;
    };
    await start({eager:true});await capture('eagerBaseline');
    assert.deepEqual(new Set(metrics.eagerBaseline.schemas),new Set(pilot));
    await start();
    for(const name of pilot) assert.equal(session.getAllTools().find(tool=>tool.name===name)?.exposure,'deferred');
    const declared=await capture('deferredParent');
    assert.deepEqual(metrics.deferredParent.schemas,[]);
    assert.ok(!declared.find(tool=>tool.name==='codemode').description.includes('web_search('),'Deferred declarations must not be embedded in codemode');
    const code=`
      const found=await searchTools('fetch_content');
      if(!found.some(t=>t.name==='fetch_content')) throw new Error('Discovery failed');
      for(const name of ${JSON.stringify(pilot)}) if(!await describeTool(name)) throw new Error('Missing '+name);
      const fetched=await tools.fetch_content({urls:[${JSON.stringify(url+'/one')},${JSON.stringify(url+'/two')}]});
      const match=/responseId: "([^"]+)"/.exec(fetched);
      if(!match) throw new Error('No stored response ID: '+fetched);
      const stored=await tools.get_search_content({responseId:match[1],urlIndex:0});
      if(!stored.includes('DEFERRED_FIXTURE /one')) throw new Error('Stored content mismatch: '+stored);
      const validation=await tools.web_search({query:'',workflow:'none'});
      if(!validation.includes('No query provided')) throw new Error('Unexpected search validation');
      return 'DEFERRED_EXECUTION_OK';`;
    faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('codemode',{code}),{stopReason:'toolUse'}),ai.fauxAssistantMessage('execution checked')]);
    await session.prompt('Execute the local fixture through codemode.');
    const result=session.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='codemode');
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.ok(result.content.some(part=>part.type==='text'&&part.text.includes('DEFERRED_EXECUTION_OK')));
    assert.equal(requests,2,'Only the two local fixture fetches should occur');
    assert.ok(pilot.every(name=>!session.getActiveToolNames().includes(name)),'Codemode execution must not activate direct schemas');
    let expectedFetches=2;
    if(presetPath){await start({full:true});await capture('fullPreset');assert.deepEqual(metrics.fullPreset.schemas,[]);}
    if(childPath){
      await start({child:true});await capture('permittedChild');assert.deepEqual(metrics.permittedChild.schemas,[]);
      faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('codemode',{code}),{stopReason:'toolUse'}),ai.fauxAssistantMessage('child execution checked')]);
      await session.prompt('Run the same permitted fixture inside a child.');
      assert.equal(session.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='codemode').isError,false);
      expectedFetches=4;assert.equal(requests,expectedFetches);
    }
    await start({restricted:true});await capture('restrictedReviewer');
    for(const name of pilot) assert.ok(!session.getAllTools().some(tool=>tool.name===name),'Restricted registry leaked '+name);
    faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('codemode',{code:'if (await describeTool("fetch_content")) throw new Error("Forbidden tool discovered"); await tools.fetch_content({url:"http://127.0.0.1/forbidden"});'}),{stopReason:'toolUse'}),ai.fauxAssistantMessage('restriction checked')]);
    await session.prompt('Verify the forbidden web tool cannot be called.');
    assert.equal(session.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='codemode').isError,true);
    assert.equal(requests,expectedFetches,'Restricted calls must not reach even the local fixture');
    assert.deepEqual(errors,[]);
    console.log('First-request web schemas: '+JSON.stringify(metrics));
  } finally {
    session?.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    for(const [key,value] of saved){if(value===undefined) delete process.env[key];else process.env[key]=value;}
    rmSync(root,{recursive:true,force:true});
  }
});
