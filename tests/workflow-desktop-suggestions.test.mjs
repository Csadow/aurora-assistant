import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestRequirements} from '../src/workflow-suggestions.mjs';

const base=()=>({files:[],commands:[]});
const input={goal:'Leave the final Aurora Browser page at https://example.com/report?q=1#end with exact title "Project report". Leave the document window with exact title “notes.md — Editor” open.',scope:'The exact window app identifier is `org.example.Editor`.',requirements:base()};
const draft=()=>({files:[],browser:{url:'https://example.com/report?q=1#end',title:'Project report',reason:'The goal asks for this final page.'},window:{title:'notes.md — Editor',app:'org.example.Editor',reason:'The document must remain open.'},limitations:'These labels do not verify contents.'});
function fixture(reply){
 const app={assistant:{busy:new Set(),ollama:{model:'fixture',chat:async(_messages,tools,_signal,_chunk,options)=>{assert.equal(tools,undefined);assert.equal(options.think,false);assert.equal(options.num_predict,2400);return {content:JSON.stringify(typeof reply==='function'?reply():reply)};}}},actions:{system:{path:async p=>p}}};
 return {app,run:i=>suggestRequirements(app,i??structuredClone(input))};
}

test('desktop drafts copy exact values with independently validated goal/context excerpts',async()=>{
 const f=fixture(draft),before=structuredClone(input),r=await f.run(input);
 assert.deepEqual(input,before);assert.equal(f.app.assistant.busy.size,0);
 assert.deepEqual(r.requirements.browser,{url:'https://example.com/report?q=1#end',title:'Project report'});
 assert.deepEqual(r.requirements.window,{title:'notes.md — Editor',app:'org.example.Editor'});
 assert.deepEqual(r.reasons[0].basis.map(x=>[x.field,x.value,x.source]),[['url',r.requirements.browser.url,'goal'],['title','Project report','goal']]);
 assert.equal(r.reasons[1].basis[1].quote,input.scope);assert.equal(r.model,'fixture');
});
test('omitted optional fields stay omitted and literal URLs normalize only after grounding',async()=>{
 const d={files:[],browser:{url:'https://example.com',reason:'Final page requested.'},window:{title:'Notes',reason:'Final window requested.'},limitations:''};
 const r=await fixture(d).run({goal:'Leave https://example.com open.',scope:"Leave the exact window 'Notes' open.",requirements:base()});
 assert.deepEqual(r.requirements.browser,{url:'https://example.com/'});assert.deepEqual(r.requirements.window,{title:'Notes'});
 assert.equal(r.reasons[0].basis[0].value,'https://example.com');
});
test('an ambiguous request can abstain while preserving deliberately selected desktop conditions',async()=>{
 const d={files:[],browser:null,window:null,limitations:'Choose the current window to supply a full title.'},i={goal:'Help with the project.',scope:'',requirements:{...base(),browser:{url:'https://example.com/selected'},window:{title:'Selected document',app:'Editor'}}};
 const r=await fixture(d).run(i);assert.deepEqual(r.requirements,i.requirements);assert.deepEqual(r.reasons,[]);
 assert.deepEqual((await fixture({files:[],limitations:''}).run(i)).requirements,i.requirements);
});
test('generation cannot replace, extend or weaken an existing desktop rule',async()=>{
 for(const kind of ['browser','window']){
  const i=structuredClone(input);i.requirements[kind]=kind==='browser'?{url:'https://example.com/selected'}:{title:'Selected'};
  const before=structuredClone(i),f=fixture(draft);await assert.rejects(f.run(i),/replace an existing/);assert.deepEqual(i,before);assert.equal(f.app.assistant.busy.size,0);
 }
});
test('invented values and model-supplied provenance are rejected atomically',async()=>{
 const mutations=[d=>d.browser.url='https://invented.example/',d=>d.browser.basis={quote:'Fabricated'},d=>d.window.app='invented.Editor',d=>d.window.reason='',d=>d.window.reason='x'.repeat(601),d=>d.browser.title='Invented title'];
 for(const mutate of mutations){const d=draft();mutate(d);const f=fixture(d),before=structuredClone(input);await assert.rejects(f.run(input));assert.deepEqual(input,before);assert.equal(f.app.assistant.busy.size,0);}
});
test('URL prefixes cannot silently drop a path, query, fragment or host suffix',async()=>{
 for(const [url,full] of [['https://example.com','https://example.com/other'],['https://example.com','https://example.com.evil'],['https://example.com/report','https://example.com/report?q=1'],['https://example.com/report?q=1','https://example.com/report?q=1#end']]){
  const goal='Leave '+full+' open.',d={files:[],browser:{url,reason:'Final page'},limitations:''};
  await assert.rejects(fixture(d).run({goal,scope:'',requirements:base()}),/must occur/);
 }
});
test('unquoted or partial titles and inferred app identities cannot become checks',async()=>{
 for(const [field,value] of [['title','notes.md'],['title','Editor'],['app','Editor']]){
  const d=draft();d.window[field]=value;await assert.rejects(fixture(d).run(),/must occur/);
 }
 const i={goal:'Leave exact window Notes open.',scope:'',requirements:base()},d={files:[],window:{title:'Notes',reason:'Final window'},limitations:''};
 await assert.rejects(fixture(d).run(i),/must occur/);
});
test('explicit but unsupported desktop values fail ordinary requirement validation',async()=>{
 for(const [kind,field,value] of [['browser','url','file:///tmp/test'],['browser','url','https://name:password@example.com/'],['window','title','a\nwindow'],['window','title','x'.repeat(501)],['window','app','x'.repeat(201)]]){
  const d=draft(),i=structuredClone(input);d[kind][field]=value;i.scope+='\n'+JSON.stringify(value);
  // Use literal control characters to exercise the normal requirements guard.
  if(value.includes('\n')){i.scope=input.scope+'\n"'+value+'"';}
  await assert.rejects(fixture(d).run(i));
 }
});
test('extra actions, duplicate target arrays, unsupported fields and missing titles are rejected',async()=>{
 for(const mutate of [d=>d.commands=[],d=>d.browser=[d.browser],d=>d.browser.selector='h1',d=>d.window.pid=123,d=>d.browser.basis={quote:input.goal},d=>delete d.window.title]){
  const d=draft();mutate(d);await assert.rejects(fixture(d).run());
 }
});
test('HTML-like quoted labels and excerpts remain literal draft data',async()=>{
 const title='<b>Notes</b>',goal='Leave the exact window "'+title+'" open.',d={files:[],window:{title,reason:'Literal <b>label</b>'},limitations:'Not a content check.'};
 const r=await fixture(d).run({goal,scope:'',requirements:base()});assert.equal(r.requirements.window.title,title);assert.equal(r.reasons[0].basis[0].quote,goal);
});

test('a sourced note can suggest claim review only with named local citation links',async()=>{
 const path='/tmp/aurora-suggestion-decision.md',goal=`Write a sourced note in ${path}. Cite requirements.md and vendor.md, and review key claims against those sources.`,file={path,finalNewline:'any',lineEndings:'any',requiredText:['](requirements.md)','](vendor.md)'],sourceReview:true,reason:'The note needs cited local sources.'};
 const d={files:[file],limitations:'Literal links and source review do not establish factual accuracy.'},i={goal,scope:'',requirements:base()},before=structuredClone(i),r=await fixture(d).run(i);
 assert.deepEqual(i,before);assert.equal(r.requirements.files[0].sourceReview,true);assert.equal(r.reasons[0].sourceReview,true);
 await assert.rejects(fixture(d).run({...i,goal:`Write a note in ${path}. Read requirements.md and vendor.md.`}),/source review/i);
 for(const requiredText of [['](invented.md)'],[]])await assert.rejects(fixture({...d,files:[{...file,requiredText}]}).run(i),/source review/i);
});

test('explicit null optional values are absent, but a quoted string null still needs provenance',async()=>{
 const d=draft();d.browser.title=null;d.window.app=null;
 const r=await fixture(d).run();assert.deepEqual(r.requirements.browser,{url:d.browser.url});assert.deepEqual(r.requirements.window,{title:d.window.title});
 d.browser.title='null';await assert.rejects(fixture(d).run(),/must occur/);
});

test('excerpts are bounded exact source slices and retain the whole matched value',async()=>{
 const title='Exact title',scope='x'.repeat(800)+' Keep "'+title+'" open. '+'y'.repeat(800),goal='Help with my document.',d={files:[],window:{title,reason:'Final window requested.'},limitations:''};
 const r=await fixture(d).run({goal,scope,requirements:base()}),b=r.reasons[0].basis[0];assert.equal(b.source,'scope');assert(scope.includes(b.quote));assert(b.quote.includes('"'+title+'"'));assert(b.quote.length<=title.length+282);
});
