// Frozen continuation controls: the initial repair is deliberately supplied by
// this harness, never claimed to be an independent model diagnosis. Real copy
// actions run before local-model continuation; reference repairs stay private.
import {projectScopeCases} from './project-scope-cases.mjs';
const page=projectScopeCases.find(c=>c.id==='catalog'),source=page.files['src/catalog.mjs'];
const cap='export function allowed(count, limit) { return Math.max(count, limit); }\nexport const quotaVersion = 1;\n';
export const projectRecoveryCases=[
 {...page,id:'pagerepair',seedRepair:{file:'src/catalog.mjs',line:81,before:'return items.slice(start, start + size);',after:'return [...items].slice(start, start + size);',reason:'Prior hypothesis: cloning the array before slicing will fix pagination.'},copyCandidates:{'src/catalog.mjs':[source.replace('return items.slice(start, start + size);','return [...items].slice(start, start + size);')]}},
 {id:'caprepair',expected:'repaired',outputs:['src/quota.mjs'],test:'tests/quota.test.mjs',marker:'pass 3',
  files:{'package.json':'{"type":"module"}\n','src/quota.mjs':cap,'tests/quota.test.mjs':"import test from 'node:test';import assert from 'node:assert/strict';import {allowed,quotaVersion} from '../src/quota.mjs';\ntest('below cap',()=>assert.equal(allowed(2,5),2));\ntest('above and equal cap',()=>{assert.equal(allowed(8,5),5);assert.equal(allowed(5,5),5);});\ntest('zero and version',()=>{assert.equal(allowed(0,5),0);assert.equal(quotaVersion,1);});\n"},
  references:{'src/quota.mjs':[cap.replace('Math.max(count, limit)','Math.min(count, limit)'),cap.replace('Math.max(count, limit)','Math.min(limit, count)')]},
  seedRepair:{file:'src/quota.mjs',line:1,before:'Math.max(count, limit)',after:'Math.min(count, limit) + 1',reason:'Prior hypothesis: clamp to the limit and add one unit.'},copyCandidates:{'src/quota.mjs':[cap.replace('Math.max(count, limit)','Math.min(count, limit) + 1')]},
  goal:'Repair allowed(count, limit) in src/quota.mjs: return the smaller of count and limit, including zero and equality. Preserve the version export and tests. Read actual source/tests. Test every candidate in copies before separate edit review, then run the original saved check, verify its marker and read the final source.'},
 {...page,id:'equivalent',references:{'src/catalog.mjs':[source.replace('(page + 1) * size','(page * size)')]},seedRepair:{file:'src/catalog.mjs',line:80,before:'(page + 1) * size',after:'(page * size)',reason:'Prior hypothesis: zero-based pages multiply the page by size; parentheses preserve the expression.'}}
];
