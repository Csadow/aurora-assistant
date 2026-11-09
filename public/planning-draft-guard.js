const guards=new WeakMap();
const listening=new WeakSet();
const values=body=>JSON.stringify([...body.querySelectorAll('input,textarea,select')].map(e=>[e.value,e.checked]));
// Only the live editor owns the guard. Replaced views cannot recreate old drafts.
export function guardPlanningDraft(body,owner,persist){
 guards.set(body,{owner,persist,values:values(body),dirty:false});
 if(!listening.has(body)){listening.add(body);for(const event of ['input','change'])body.addEventListener(event,()=>{const g=guards.get(body);if(g&&body.contains(g.owner))g.dirty=true;});}
}
export function flushPlanningDraft(body){const g=guards.get(body);if(g&&body.contains(g.owner)&&(g.dirty||g.values!==values(body))){g.persist();g.dirty=false;g.values=values(body);}}
