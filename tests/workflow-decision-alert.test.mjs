import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionNumberAlerts} from '../src/workflow-decision-alert.mjs';

const limit={id:'L',value:'70',source:'/work/requirements.md',excerpt:'The monthly budget ceiling is 70 credits.'};
const quote={id:'Q',value:'85',source:'/work/cedar-quote.md',excerpt:'Cedar costs 85 credits per month.'};
const catalog={id:'C',value:'65',source:'/work/cedar-catalog.md',excerpt:'Cedar costs 65 credits per month.'};
const compare=(left,right,relation)=>({left,right,relation,expression:`${left.value} ${relation} ${right.value}`});

test('recorded values on both sides of a named limit produce a neutral exact-review cue',()=>{
 const alerts=decisionNumberAlerts([compare(quote,limit,'>'),compare(limit,catalog,'>')]);
 assert.equal(alerts.length,1);assert.deepEqual(alerts[0].limit,{value:'70',source:'/work/requirements.md'});
 assert.deepEqual(alerts[0].above,[{value:'85',source:'/work/cedar-quote.md',expression:'85 > 70'}]);
 assert.deepEqual(alerts[0].below,[{value:'65',source:'/work/cedar-catalog.md',expression:'70 > 65'}]);
 assert.match(alerts[0].notice,/which option each value describes/);
});

test('an unlabelled number or one-sided comparison does not imply a decision conflict',()=>{
 assert.deepEqual(decisionNumberAlerts([compare(quote,limit,'>')]),[]);
 assert.deepEqual(decisionNumberAlerts([compare(quote,{...limit,excerpt:'The number is 70.'},'>'),compare(catalog,{...limit,excerpt:'The number is 70.'},'<')]),[]);
 assert.deepEqual(decisionNumberAlerts([compare(quote,limit,'>'),compare({...catalog,excerpt:'Budget limit 65 credits.'},limit,'<')]),[]);
 assert.deepEqual(decisionNumberAlerts([]),[]);
});
