import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionNumberAlerts,decisionWording,decisionPremises} from '../src/workflow-decision-alert.mjs';

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

test('exact decision wording is selected from authored inference claims, not source statements or model critique',()=>{
 const alerts=decisionNumberAlerts([compare(quote,limit,'>'),compare(catalog,limit,'<')]);
 const claims=[
  {kind:'source_statement',text:'Vendor recommends Cedar.',limits:'Vendor wording only.'},
  {kind:'inference',text:'No source establishes which Cedar price is current.',limits:'Unresolved.'},
  {kind:'inference',text:'Decision: Cedar at 65 credits meets the budget.',limits:'If the catalog price is current; the quote is 85.'},
  {kind:'inference',text:'Migration duration remains unknown.',limits:'No source gives duration.'}
 ];
 assert.deepEqual(decisionWording({claims},alerts),[{number:3,text:claims[2].text,limits:claims[2].limits}]);
 assert.deepEqual(decisionWording({claims},[]),[]);
});

test('independent deferred and unrelated-option decisions keep their exact wording without an automatic verdict',()=>{
 const alerts=[{limit:{value:'70'},below:[{value:'50'}],above:[{value:'85'}]}];
 const deferred={kind:'inference',text:'Do not choose Cedar until its current price is verified.',limits:'The 65 and 85 credit sources disagree.'};
 const unrelated={kind:'inference',text:'Choose Birch at 50 credits.',limits:'Ash at 85 is a different option.'};
 assert.deepEqual(decisionWording({claims:[deferred]},alerts),[{number:1,text:deferred.text,limits:deferred.limits}]);
 assert.deepEqual(decisionWording({claims:[unrelated]},alerts),[{number:1,text:unrelated.text,limits:unrelated.limits}]);
});

test('the cue and wording also cover a non-price route limit without deciding whether routes match',()=>{
 const walking={id:'W',value:'10',source:'/work/requirements.md',excerpt:'Walking limit is 10 km.'};
 const estimate={id:'E',value:'12',source:'/work/estimate.md',excerpt:'North route is 12 km.'};
 const map={id:'M',value:'8',source:'/work/map.md',excerpt:'North route is 8 km.'};
 const alerts=decisionNumberAlerts([compare(estimate,walking,'>'),compare(map,walking,'<')]);
 assert.equal(alerts.length,1);assert.equal(alerts[0].limit.value,'10');
 const choice={kind:'inference',text:'Choose North at the 8 km map distance.',limits:'The 12 km estimate is disputed.'};
 assert.deepEqual(decisionWording({claims:[choice]},alerts),[{number:1,text:choice.text,limits:choice.limits}]);
});

test('premise evidence records only literal IDs and units from exact source observations',()=>{
 const limit={id:'L2',value:'70',source:'/work/limit.md',sourceRevision:'rev-l',line:1,excerpt:'Budget limit 70 credits per month.'};
 const above={id:'A2',value:'85',source:'/work/quote.md',sourceRevision:'rev-a',line:3,excerpt:'Offer CB-17 costs 85 credits per month.'};
 const below={id:'B2',value:'65',source:'/work/catalog.md',sourceRevision:'rev-b',line:2,excerpt:'Offer CB-17 costs 65 credits per month.'};
 const comparisons=[compare(above,limit,'>'),compare(below,limit,'<')];
 const [premise]=decisionPremises(decisionNumberAlerts(comparisons),comparisons);
 assert.equal(premise.status,'shared_identifier');
 assert.deepEqual([premise.below.identifier,premise.above.identifier],['CB-17','CB-17']);
 assert.equal(premise.below.unit.kind,'credit/month');
 assert.equal(premise.below.sourceRevision,'rev-b');
 assert.equal(premise.above.line,3);
 assert.equal(decisionPremises(decisionNumberAlerts([compare({...above,excerpt:'SKU CP-2 costs 85 credits per month.'},limit,'>'),compare(below,limit,'<')]),[compare({...above,excerpt:'SKU CP-2 costs 85 credits per month.'},limit,'>'),compare(below,limit,'<')])[0].status,'different_identifiers');
});

test('incompatible units and missing identifiers stay review clues rather than equivalence verdicts',()=>{
 const walking={id:'WL',value:'10',source:'/work/limit.md',excerpt:'Walking limit 10 km.'};
 const miles={id:'MI',value:'12',source:'/work/route-a.md',excerpt:'Option R-2 is 12 miles.'};
 const km={id:'KM',value:'8',source:'/work/route-b.md',excerpt:'Option R-2 is 8 km.'};
 const route=[compare(miles,walking,'>'),compare(km,walking,'<')];
 assert.equal(decisionPremises(decisionNumberAlerts(route),route)[0].status,'incompatible_units_or_periods');
 const cedar=[compare(quote,limit,'>'),compare(catalog,limit,'<')];
 assert.equal(decisionPremises(decisionNumberAlerts(cedar),cedar)[0].status,'unresolved');
 const ambiguous=[compare({...quote,excerpt:'SKU CB-1 or SKU CB-2 costs 85 credits per month.'},limit,'>'),compare(catalog,limit,'<')];
 assert.equal(decisionPremises(decisionNumberAlerts(ambiguous),ambiguous)[0].status,'unresolved');
});

test('ambiguous numeric provenance cannot become a resolved premise',()=>{
 const comparisons=[compare(quote,limit,'>'),compare(catalog,limit,'<'),compare({...catalog,id:'C2'},limit,'<')];
 const [premise]=decisionPremises(decisionNumberAlerts(comparisons),comparisons);
 assert.equal(premise.status,'unresolved');assert.equal(premise.below,null);
 assert.deepEqual(decisionPremises([],[]),[]);
 const [missing]=decisionPremises(decisionNumberAlerts([compare(quote,limit,'>'),compare(catalog,limit,'<')]),[]);
 assert.equal(missing.status,'unresolved');assert.equal(missing.above,null);
});

test('an identifier in a neighboring sentence does not attach to the observed price',()=>{
 const l={...limit,id:'L3',excerpt:'Budget limit 70 credits per month.'};
 const a={...quote,id:'A3',excerpt:'Offer CB-17 is retired. New rate is 85 credits per month.'};
 const b={...catalog,id:'B3',excerpt:'Offer CB-17 costs 65 credits per month.'};
 const comparisons=[compare(a,l,'>'),compare(b,l,'<')];
 const [premise]=decisionPremises(decisionNumberAlerts(comparisons),comparisons);
 assert.equal(premise.above.identifier,null);
 assert.equal(premise.below.identifier,'CB-17');
 assert.equal(premise.status,'unresolved');
});
