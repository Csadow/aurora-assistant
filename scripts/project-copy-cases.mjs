// Fixed evaluation inputs. Reference edits are kept out of model requests.
const label="import {cleanText} from './text.mjs';\nexport function label(text) { return cleanText(text).replace(/\\s+/g, '-'); }\n";
const labels={
  'package.json':'{"type":"module"}\n',
  'README.md':'# Labels\nThe label export in src/label.mjs converts display text into lowercase, hyphen-separated labels. Local text cleanup is in src/text.mjs. Tests are in tests/label.test.mjs.\n',
  'src/label.mjs':label,
  'src/text.mjs':"export function cleanText(text) { return text.trim(); }\n",
  'tests/label.test.mjs':"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {label} from '../src/label.mjs';\ntest('lowercase label',()=>assert.equal(label('  Hello World  '),'hello-world'));\ntest('whitespace',()=>assert.equal(label('a   b'),'a-b'));\ntest('empty input',()=>assert.equal(label('  '),''));\n"
};
const layout={
  'package.json':'{"type":"module"}\n',
  'README.md':'# Layout\nThe available area calculation is in src/area.mjs; width clamping is in src/fit.mjs. The public integration is src/layout.mjs. Tests are in tests/layout.test.mjs.\n',
  'src/area.mjs':'export function available(width, left, right) { return width + left + right; }\n',
  'src/fit.mjs':'export function fit(width, area) { return Math.max(width, area); }\n',
  'src/layout.mjs':"import {available} from './area.mjs';\nimport {fit} from './fit.mjs';\nexport function layout(width, screen, left, right) { return fit(width, available(screen, left, right)); }\n",
  'tests/layout.test.mjs':"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {available} from '../src/area.mjs';\nimport {fit} from '../src/fit.mjs';\nimport {layout} from '../src/layout.mjs';\ntest('reserved margins',()=>assert.equal(available(720,10,10),700));\ntest('small width',()=>assert.equal(fit(700,1280),700));\ntest('large width',()=>assert.equal(fit(460,320),320));\ntest('integration',()=>assert.equal(layout(800,720,10,10),700));\n"
};
const missing={...labels};delete missing['src/text.mjs'];
const copyRequest=' Discover and read the relevant tests, local imports and package manifests. Record the necessary repairs. Test each proposed repair in a temporary copy before requesting its original edit. Review the actual results, apply only the necessary corrections, run the saved original check, verify its pass marker and read the final output files. Preserve tests and unrelated code.';
export const projectCopyCases=[
  {id:'labels',files:labels,outputs:['src/label.mjs'],references:{'src/label.mjs':[
    label.replace('cleanText(text).replace','cleanText(text).toLowerCase().replace'),
    label.replace(".replace(/\\s+/g, '-')",".replace(/\\s+/g, '-').toLowerCase()")
  ]},test:'tests/label.test.mjs',marker:'pass 3',expected:'repaired',
  goal:'Repair label generation so leading/trailing whitespace is removed, whitespace runs become one hyphen, letters become lowercase, and empty input stays empty. Only src/label.mjs may change.'+copyRequest},
  {id:'layout',files:layout,outputs:['src/area.mjs','src/fit.mjs'],references:{
    'src/area.mjs':[layout['src/area.mjs'].replace('width + left + right','width - left - right')],
    'src/fit.mjs':[layout['src/fit.mjs'].replace('Math.max','Math.min')]
  },test:'tests/layout.test.mjs',marker:'pass 4',expected:'repaired',restart:true,
  goal:'Repair layout calculation. Available width subtracts both reserved margins: 720 minus 10 on each side is 700. Clamped width is the smaller of requested and available: 700 in 1280 stays 700, and 460 in 320 becomes 320. Combined layout(800,720,10,10) must be 700. Only src/area.mjs and src/fit.mjs may change.'+copyRequest},
  {id:'missing',files:missing,outputs:['src/label.mjs'],references:{'src/label.mjs':[label.replace('cleanText(text).replace','cleanText(text).toLowerCase().replace')]},test:'tests/label.test.mjs',marker:'pass 3',expected:'blocked',missing:'src/text.mjs',
  goal:'Investigate the failing label tests and lowercase behavior in src/label.mjs. Discover and inspect its tests and local dependencies. Do not invent missing implementations or change tests. If a required implementation is unavailable, stop and explain what is missing; do not apply an unverified edit or claim success. If the necessary evidence is present, test a proposed repair in a temporary copy before requesting any original edit.'}
];
