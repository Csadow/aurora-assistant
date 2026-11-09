import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {reminderOverviewUIChecks} from '../scripts/reminder-overview-ui-checks.mjs';

// Focused native coverage remains separate from the complete desktop suite.
export async function smoke({win,backend}){
 const evaluate=expression=>win.webContents.executeJavaScript(expression,true);
 const wait=async(fn,label)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
 const started=Date.now(),report={ok:false,phase:process.env.AURORA_TEST_PHASE,checks:[]};
 const check=text=>{report.checks.push(text);console.log('DESKTOP_PROGRESS '+JSON.stringify({phase:report.phase,checks:report.checks.length,elapsedMs:Date.now()-started,last:text}));};
 await wait(()=>evaluate('document.body.dataset.ready==="true"'),'native workspace ready');
 assert.equal(await evaluate('location.protocol'),'aster:');assert.equal(await evaluate('typeof require'),'undefined');assert.equal(await evaluate('typeof process'),'undefined');assert.equal(await evaluate('window.asterDesktop.isDesktop'),true);
 check('native reminder workspace loads through the sandboxed desktop protocol');
 await reminderOverviewUIChecks({app:backend,evaluate,wait,check,restart:report.phase==='restart'});
 await win.webContents.session.flushStorageData();report.ok=true;report.elapsedMs=Date.now()-started;await writeFile(process.env.AURORA_TEST_REPORT,JSON.stringify(report,null,2));await writeFile(process.env.AURORA_TEST_REPORT+'.png',(await win.webContents.capturePage()).toPNG());
}
