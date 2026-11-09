import test from 'node:test';
import assert from 'node:assert/strict';
import {literalImports,copyDependencies} from '../src/copy-dependencies.mjs';

test('literal import discovery handles ESM, reexports and literal require/import without treating strings or comments as imports',()=>{
  const scan=literalImports(`// import './ignored.mjs';
/* require('./comment.cjs') */
const text="import './string.mjs'";
import {x} from './one.mjs'; export {y} from './two.mjs';
const z=require('./three.cjs'); await import('./four.mjs');`);
  assert.deepEqual(scan.imports,['./one.mjs','./two.mjs','./three.cjs','./four.mjs']);assert.deepEqual(scan.limitations,[]);
});
test('uncertain syntax is explicitly limited and never executed',()=>{
  const scan=literalImports("import name from './a.mjs';\nconst r=/import 'bad'/;\nimport('./'+x);\nrequire(`./${x}`);\nrequire('./esc\\u0061ped.mjs');");
  assert.deepEqual(scan.imports,['./a.mjs']);assert(scan.limitations.length>=3);
});
test('dependencies are discovered across observed helpers and candidate imports, with no outside probing',async()=>{
  const probed=[],files=[{path:'/project/test.mjs',content:"import './helper.mjs'; import 'node:test'; import 'other-package';"},{path:'/project/helper.mjs',content:"export * from './missing.mjs'; import '../../outside.mjs';"}];
  const d=await copyDependencies(files,'/project',{path:'/project/helper.mjs',content:"import './new.mjs';"},async p=>{probed.push(p);return p.endsWith('new.mjs');});
  assert.deepEqual(d.neededReads,['/project/new.mjs']);assert.deepEqual(d.missing,['/project/missing.mjs']);assert.deepEqual(probed,['/project/missing.mjs','/project/new.mjs']);assert.equal(d.limitations.length,2);
});
test('bounded preview reports transitive local imports without including unread source in the copy',async()=>{
 const files=[{path:'/project/test.mjs',content:"import './one.mjs';"}],contents={
  '/project/one.mjs':"import './two.mjs'; export const secret='never returned';",
  '/project/two.mjs':"import './missing.mjs';"
 },discovered=[];
 const d=await copyDependencies(files,'/project',null,async path=>Object.hasOwn(contents,path),{discover:async path=>{discovered.push(path);return contents[path];}});
 assert.deepEqual(d.neededReads,['/project/one.mjs','/project/two.mjs']);assert.deepEqual(d.missing,['/project/missing.mjs']);
 assert.deepEqual(discovered,['/project/one.mjs','/project/two.mjs']);assert(!JSON.stringify(d).includes('never returned'));
 assert.match(d.notice,/model-facing read/);
});
test('transitive preview stops at bounded files and never probes an oversized specifier',async()=>{
 const source={};for(let i=1;i<=40;i++)source[`/project/m${i}.mjs`]=`import './m${i+1}.mjs';`;
 let previews=0,probes=0;
 const d=await copyDependencies([{path:'/project/test.mjs',content:`import './m1.mjs'; import './${'x'.repeat(600)}.mjs';`}],'/project',null,async path=>{probes++;return Object.hasOwn(source,path);},{discover:async path=>{previews++;return source[path];}});
 assert(previews<=31);assert(probes<=32);assert(d.limitations.some(x=>x.includes('32 files')));assert(d.limitations.some(x=>x.includes('Oversized')));
});
