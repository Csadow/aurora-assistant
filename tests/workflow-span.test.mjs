import test from 'node:test';
import assert from 'node:assert/strict';
import {spanEdit} from '../src/workflow-span.mjs';
import {filePatch} from '../src/file-patch.mjs';
import {sha} from '../src/vault.mjs';
import {fileObservations,recentProjectRead} from '../src/workflow-tools.mjs';

const observed=content=>({id:'read',name:'read_system_file',status:'completed',arguments:{path:'/tmp/source.mjs'},result:{path:'/tmp/source.mjs',content,revision:sha(content),truncated:false}});
const args={evidence:'E1',line:2,before:'a+b',after:'a-b',reason:'Subtract the reserved amount'};
const source='// café 🐱\r\n\treturn {width:a+b,height:c-d};\r\n\treturn {width:a+b,height:c-d};';

test('fragment edits retain adjacent expressions, Unicode, repeated lines, indentation and exact newline bytes',()=>{
  for(const text of [source,source.replaceAll('\r\n','\n')+'\n',source.replaceAll('\r\n','\r')]){
    const w={operations:[observed(text)]},before=JSON.stringify(w),edit=spanEdit(w,args);
    assert.equal(filePatch(text,edit.edits).content,text.replace('width:a+b','width:a-b'));
    assert.equal(edit.path,'/tmp/source.mjs');assert.equal(edit.revision,sha(text));assert.equal(JSON.stringify(w),before);
  }
});

test('fragment edits reject ambiguity, malformed or missing text, line overrides and identical replacements',()=>{
  const w={operations:[observed(source)]};
  for(const override of [{before:''},{before:'width:nope'},{before:'d'},{after:'a+b'},{after:'x\ny'},{before:'a\rb'},{after:'\0'},{after:'\ud800'},{before:'x'.repeat(2001)},{after:'x'.repeat(2001)},{line:0},{line:4},{line:1.5},{before:'\treturn'},{path:'/tmp/other'},{content:'new'},{reason:''},{evidence:'E9'}])assert.throws(()=>spanEdit(w,{...args,...override}),JSON.stringify(override));
  const deleted=spanEdit(w,{...args,before:'width:a+b,',after:''});assert.equal(filePatch(source,deleted.edits).content,source.replace('width:a+b,',''));
});

test('fragment edits reject incomplete, redacted, failed or historical observations',()=>{
  const read=observed(source);
  for(const update of [{status:'failed'},{name:'read_note'},{arguments:{offset:1}},{result:{...read.result,truncated:true}},{result:{...read.result,revision:sha('redacted')}}])assert.throws(()=>spanEdit({operations:[{...read,...update}]},args),/complete, unredacted/);
  const w={version:6,projectCheckpoint:{operationCount:1},operations:[read]};
  assert.throws(()=>spanEdit(w,args),/continuation checkpoint/);
});

test('fragment edits require fresh inspection after commands, matching writes and computer input',()=>{
  for(const action of [{name:'propose_command'},{name:'propose_file_edit',arguments:{path:'/tmp/source.mjs'}},{name:'computer_action',arguments:{operation:'type_text'}}]){
    const w={operations:[observed(source),{id:'effect',action:'reviewed',status:'completed',...action}]};
    assert.throws(()=>spanEdit(w,args),/Read the current file/);
    w.operations.push({...observed(source),id:'fresh'});assert.doesNotThrow(()=>spanEdit(w,{...args,evidence:'E3'}));
  }
  assert.doesNotThrow(()=>spanEdit({operations:[observed(source),{name:'propose_file_edit',action:'reviewed',status:'completed',arguments:{path:'/tmp/other'}}]},args));
});

test('numbered project source context is bounded, respects partial reads and removes stale code',()=>{
  const read=observed(source),w={operations:[read]};
  const view=fileObservations(w,8000,{numbered:true,maxExcerpt:4500});assert.equal(view[0].numbered,true);assert.match(view[0].excerpt,/2: \treturn/);assert.equal(view[0].truncated,false);
  read.result.content='// long source\n'.repeat(600);read.result.revision=sha(read.result.content);
  const limited=fileObservations(w,500,{numbered:true,maxExcerpt:4500});assert(limited[0].truncated);assert(JSON.stringify(limited).length<=500);assert.equal(read.result.content.length,9000);
  read.arguments.offset=24000;read.result.nextOffset=48000;read.result.truncated=true;
  const partial=fileObservations(w,8000,{numbered:true,maxExcerpt:4500});assert.equal(partial[0].numbered,false);assert.equal(partial[0].offset,24000);assert.equal(partial[0].nextOffset,48000);assert(partial[0].excerpt.startsWith('// long source'));
  w.version=6;w.projectCheckpoint={operationCount:1};assert.equal(fileObservations(w,8000,{numbered:true})[0].excerpt,undefined);
});

test('only the latest usable read stays in tool history and its source is omitted from the file view',()=>{
  const read=observed(source),w={operations:[read]},before=JSON.stringify(w);
  assert.equal(recentProjectRead(w),read);const view=fileObservations(w,8000,{numbered:true,omitRead:read.id});assert.equal(view[0].excerpt,undefined);assert.equal(view[0].inRecentToolResult,true);assert.equal(view[0].truncated,false);assert.equal(JSON.stringify(w),before);
  w.operations.push({id:'failed',name:'read_system_file',arguments:{path:read.result.path},status:'failed',result:{error:'Unreadable'}});assert.equal(recentProjectRead(w),null);
  w.operations.push({...read,id:'new'});assert.equal(recentProjectRead(w).id,'new');w.operations.push({action:'reviewed',name:'propose_command',status:'completed'});assert.equal(recentProjectRead(w),null);
  w.operations.push({...read,id:'current'});w.version=6;w.projectCheckpoint={operationCount:w.operations.length};assert.equal(recentProjectRead(w),null);
});
