import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {Ollama} from '../src/ollama.mjs';
import {missingOutcomes} from '../src/workflow-evidence.mjs';

// Real 9B + real desktop/browser. All state, files and approvals use a disposable
// profile. The native adapter is restricted to the explicitly permitted fixture.
export async function smoke({win,backend,desktopComputer}){
  const strict=process.env.AURORA_OUTPUT_REQUIREMENTS==='1',formatted=process.env.AURORA_OUTPUT_REQUIREMENTS==='format';let skill;
  const reports=[],model=new Ollama('http://127.0.0.1:11434','qwen3.5:9b'),original=backend.assistant.ollama;
  original.status=model.status.bind(model);original.check=model.check.bind(model);
  original.chat=(...args)=>{model.generationOptions=original.generationOptions;return model.chat(...args);};
  await backend.models.save({model:model.model,thinking:true});backend.memory.model='';
  const dir=join(backend.config.data,'..','fixture');await mkdir(dir,{recursive:true});
  const allowed=backend.system.allowed.bind(backend.system);backend.system.allowed=path=>{assert(path===dir||path.startsWith(dir+'/'),'Access outside the disposable fixture');return allowed(path);};
  const handle=desktopComputer.handle.bind(desktopComputer);let target;
  desktopComputer.handle=async(method,input,signal)=>{
    const permitted=input.operation==='open_url'?['https://example.com','https://example.com/'].includes(input.url):input.operation==='open_path'?input.path===target:['browser_read','windows'].includes(input.operation);
    assert(permitted,'Unexpected native action: '+input.operation);return handle(method,input,signal);
  };
  const wait=async fn=>{const end=Date.now()+15000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for fixture cleanup');};
  const save=()=>writeFile(process.env.AURORA_TEST_REPORT,JSON.stringify({ok:reports.length===2&&reports.every(r=>r.ok),model:model.model,kind:'real local model and native browser/files/editor',requirements:strict,formatted,rounds:reports},null,2));
  for(let round=1;round<=2;round++){
    target=join(dir,`aurora-native-${process.pid}-${round}.txt`);let id,record;const start=Date.now();let approvals=0,planReviews=0;const corrections=[];
    try{
      const goal=`Open https://example.com/ in Aurora Browser and observe the page title. Verify the actual title with verify_outcome. Save exactly the observed title plus one newline to ${target}. Read it back, then open this file in its default application and list windows to verify that the filename appears in a window title. Use the fresh windows evidence with verify_outcome kind=window_title before finishing. Only edit this file. No shell commands, keyboard input, cloud requests or messages. Combine related work into a compact plan.`;
      const w=await backend.workflows.start({goal,scope:`Only write ${target}. Use the supplied URL, browser_read, open_path and windows. Do not inspect other files.`,...(strict||formatted?{requirements:{files:[{path:target,...(strict?{exactText:'Example Domain\n'}:{}),finalNewline:'required',lineEndings:'lf'}],commands:[]}}:{}),...(skill?{skills:['research-note'],skillRevision:skill.revision,skillInputs:{source:'https://example.com/',target_files:target,content_requirements:'Write exactly Example Domain followed by one LF. Read back, open in the default application and verify the visible window.'}}:{})});id=w.id;
      win.webContents.send('aster:command',{type:'workspace',view:'workflows',workflow:id});let previous='';
      while(Date.now()-start<600000){
        record=await backend.workflows.read(id);const progress=JSON.stringify([record.status,record.current,record.calls,record.health.headline]);if(progress!==previous){console.log(`Native round ${round}: ${progress}`);previous=progress;}
        if(['completed','paused','needs_verification','needs_help','waiting_input','cancelled'].includes(record.status)&&!backend.workflows.running.has(id))break;
        if(record.status==='plan_review'&&!backend.workflows.running.has(id)){assert(strict||formatted);assert.equal(record.operations.length,0);assert.equal(planReviews,0);await backend.workflows.control(id,'approve_plan','',record.revision);planReviews++;}
        for(const a of await backend.store.list('actions'))if(a.workflow?.id===id&&a.status==='pending'){
          if(a.kind==='computer')continue; // Routine policy owns desktop actions.
          assert.equal(a.kind,'write');assert.equal(a.payload.path,target);
          if(!strict&&a.payload.content==='Example Domain'&&!corrections.length){
            // Explicit simulated user correction, not approval or a silent edit.
            // Report assisted completion separately from an unaided pass.
            corrections.push({kind:'simulated user task update',action:a.id,proposed:a.payload.content,reason:'Missing the requested final newline'});
            console.log(`Native round ${round}: requesting correction of the missing final newline before approval`);
            await backend.workflows.steer(id,'Your pending file edit omitted the requested final newline. Retire that proposal and propose the title followed by exactly one LF character (JSON content "Example Domain\\n"). Keep the completed browser observation/check. Then read the file back, open it and verify its window. Do not repeat browser navigation.',record.revision||1);
            assert.equal((await backend.store.get('actions',a.id)).status,'dismissed');
            break;
          }
          assert.equal(a.payload.content,'Example Domain\n');if(strict)assert(a.payload.requirementsCheck.checks.includes('Exact text matches'));
          await backend.actions.decide(a.id,'approve',a.digest);approvals++;
        }
        await new Promise(r=>setTimeout(r,400));
      }
      assert.equal(record.status,'completed',record.error||record.question||'Native workflow timed out');assert.equal(approvals,1);assert.equal(await readFile(target,'utf8'),'Example Domain\n');assert.deepEqual(missingOutcomes(record),[]);
      assert.equal(record.operations.filter(o=>o.name==='computer_action'&&o.arguments.operation==='open_url'&&o.status==='completed').length,1,'Completed browser navigation must not be repeated');
      assert(record.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.result.kind==='window_title'));
      assert(record.operations.some(o=>o.name==='verify_outcome'&&o.status==='completed'&&o.result.kind==='browser_title'));
      const windows=record.operations.findLast(o=>o.name==='computer_action'&&o.arguments.operation==='windows'&&o.status==='completed').result.windows;assert(windows.some(w=>w.title.includes(basename(target))));
      if(strict){assert(record.requirementChecks.every(x=>x.passed));if(round===1){const draft=await backend.workflows.skillDraft(id);skill=await backend.workflows.skillDraft(id,{skillId:'research-note',content:draft.content,revision:null});}}
      await writeFile(process.env.AURORA_TEST_REPORT+`.round-${round}.png`,(await win.webContents.capturePage()).toPNG());
      reports.push({round,mode:strict&&round===2?'reusable-skill':formatted?'saved-formatting':'ordinary',planReviews,requirementRejections:record.operations.filter(o=>o.result?.requirementFailures).length,ok:true,unaided:corrections.length===0,corrections,seconds:Math.round((Date.now()-start)/1000),approvals,record});await save();console.log(`PASS native round ${round} (${corrections.length?'with a simulated user correction':'unaided'})`);
    }catch(e){reports.push({round,ok:false,corrections,seconds:Math.round((Date.now()-start)/1000),error:e.message,record});await save();throw e;}
    finally{
      if(id){const w=await backend.store.get('workflows',id);if(!['completed','cancelled'].includes(w.status))await backend.workflows.control(id,'cancel');}
      // Cleanup uses the original adapter, with exact title/ID validation.
      const windows=(await handle('execute',{operation:'windows'},new AbortController().signal)).windows;
      for(const w of windows.filter(w=>w.title.includes(basename(target)))){
        const payload=await handle('prepare',{operation:'close_window',windowId:w.id},new AbortController().signal);assert(payload.target.title.includes(basename(target)));
        await handle('execute',payload,new AbortController().signal);await wait(async()=>!(await handle('execute',{operation:'windows'},new AbortController().signal)).windows.some(x=>x.id===w.id));
      }
    }
  }
  await save();
}
