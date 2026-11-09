import {localDay,minutes} from '../mobile/web/planner-core.js';

const merge=intervals=>{
 const result=[];
 for(const [start,end] of intervals.filter(([s,e])=>s<e).sort((a,b)=>a[0]-b[0])){
  const last=result.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else result.push([start,end]);
 }
 return result;
};
const subtract=(windows,busy)=>windows.flatMap(([start,end])=>{
 const result=[];let cursor=start;
 for(const [s,e] of busy){if(s>=end)break;if(e<=cursor)continue;if(s>cursor)result.push([cursor,Math.min(s,end)]);cursor=Math.max(cursor,e);}
 if(cursor<end)result.push([cursor,end]);return result;
});
const total=intervals=>intervals.reduce((n,[s,e])=>n+e-s,0);
// This is time capacity, not a promise that every task can fit into the fragments.
// Use the same start floor and buffers as suggestDay; do not double-count overlaps.
export function planningCapacity({date,start,end,windows=null,gap,now,busy,placed=[],includeSlots=false}){
 const begin=minutes(start),finish=minutes(end),floor=date===localDay(now)?Math.max(begin,Math.ceil((now.getHours()*60+now.getMinutes()+1)/5)*5):begin;
 const available=merge((windows===null?[[begin,finish]]:windows.map(([s,e])=>[minutes(s),minutes(e)])).map(([s,e])=>[Math.max(s,begin,floor),Math.min(e,finish)]).filter(([s,e])=>s<e));
 const occupied=merge(busy.map(([s,e])=>[s,e])),buffered=merge(busy.map(([s,e])=>[s-gap,e+gap]));
 const rawFree=subtract(available,occupied),free=subtract(available,buffered),remaining=subtract(available,merge([...busy,...placed].map(([s,e])=>[s-gap,e+gap])));
 return {...(includeSlots?{freeSlots:free}:{}),windowMinutes:total(available),busyMinutes:total(available)-total(rawFree),bufferMinutes:total(rawFree)-total(free),availableMinutes:total(free),largestSlotMinutes:Math.max(0,...free.map(([s,e])=>e-s)),remainingMinutes:total(remaining)};
}
