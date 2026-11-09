import {mkdir, open, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {atomic} from '../src/vault.mjs';
import {repairReviewCases} from './repair-review-corpus.mjs';
import {reviewOracle} from './repair-review-oracle.mjs';
import {copyRoot, snapshotCopySources, buildCopyPlan, savedCheck} from './repair-copy-plan.mjs';
import {evaluateFixedCopy, evaluatePristineCopy} from './repair-copy-runner.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || args.some(a => !['--preflight', '--run'].includes(a))) throw Error('Use --preflight (default) or --run. Only built-in fixtures are accepted.');
const snapshot = await snapshotCopySources(), cases = await repairReviewCases();
if (!args.includes('--run')) {
  const plans = [];
  for (const c of cases) {
    const plan = await buildCopyPlan(c.name, c.input, snapshot);
    plans.push({name: c.name, inputRevision: plan.inputRevision, variants: Object.keys(plan.variants), scope: plan.scope, evidenceGap: plan.evidenceGap});
  }
  console.log(JSON.stringify({mode: 'preflight', executed: false, savedCheck, source: snapshot.revisions, cases: plans,
    notice: 'No candidate executed. --run explicitly runs saved tests against fixed repository fixtures only.'}, null, 2));
} else {
  const artifacts = join(copyRoot, 'artifacts'); await mkdir(artifacts, {recursive: true});
  const lock = join(artifacts, 'repair-copy.lock'), handle = await open(lock, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({pid: process.pid, script: 'repair-copy-eval'})); await handle.close();
    const started = new Date().toISOString(), path = join(artifacts, 'repair-copy-' + started.replaceAll(/[:.]/g, '-') + '.json');
    const report = {started, mode: 'fixed-copies', runtime: {node: process.version, platform: process.platform},
      source: snapshot, planned: cases.map(c => c.name), results: [],
      notice: 'Development evidence only. No model calls, task actions, project edits or approvals. Saved tests, independent finite cases, and mechanical scope are separate observations.'};
    await writeFile(path, '{}', {flag: 'wx', mode: 0o600});
    const save = () => atomic(path, JSON.stringify(report, null, 2));
    const controller = new AbortController(), interrupt = signal => { report.interrupted = signal; controller.abort(); };
    const term = () => interrupt('SIGTERM'), int = () => interrupt('SIGINT');
    process.once('SIGTERM', term); process.once('SIGINT', int);
    try {
      await save();
      report.pristine = await evaluatePristineCopy(cases[0].name, cases[0].input, {signal: controller.signal}); await save();
      if (!report.pristine.passed) throw Error('Pristine saved tests did not pass; candidate evaluation stopped.');
      for (const c of cases) {
        if (controller.signal.aborted) break;
        // Write each completed run so interruption retains concrete evidence.
        const pending = {name: c.name, runs: {}}; report.results.push(pending); await save();
        const result = await evaluateFixedCopy(c.name, c.input, {signal: controller.signal, onRun: async (variant, run) => { pending.runs[variant] = run; await save(); }});
        Object.assign(pending, result);
        if (!result.interrupted && !result.stopped) pending.supplemental = await reviewOracle(c.name, c.input);
        await save();
        console.log(JSON.stringify({case: c.name, savedTests: result.runs.candidate?.passed, expressionBoundary: result.scope.within,
          independentCases: pending.supplemental?.passed ?? 'unresolved', evidenceGap: result.evidenceGap?.kind || null}));
        if (result.stopped) throw Error('Copy harness stopped: ' + result.stopped);
      }
    } catch (e) { report.error = e.message; }
    finally {
      process.removeListener('SIGTERM', term); process.removeListener('SIGINT', int);
      try {
        const after = await snapshotCopySources(); report.changedSources = Object.keys(snapshot.revisions).filter(p => snapshot.revisions[p] !== after.revisions[p]);
      } catch (e) { report.changedSources = ['Source snapshot unavailable']; report.sourceError = e.message; }
      report.notAttempted = cases.filter(c => !report.results.some(r => r.name === c.name)).map(c => c.name);
      report.incomplete = report.results.filter(r => Object.keys(r.runs).length !== 4 || r.interrupted).map(r => r.name);
      const runs = [report.pristine, ...report.results.flatMap(r => Object.values(r.runs))].filter(Boolean);
      report.harnessFailures = runs.filter(r => r.failure || !r.cleanedUp || r.changedDuringRun?.length).map(r => ({cwd: r.cwd, failure: r.failure, changedDuringRun: r.changedDuringRun}));
      report.ok = !report.error && !report.interrupted && !report.changedSources.length && !report.notAttempted.length && !report.incomplete.length && !report.harnessFailures.length;
      report.finished = new Date().toISOString(); await save();
      console.log(JSON.stringify({ok: report.ok, report: path, completed: report.results.length, copyRuns: runs.length, error: report.error,
        notice: 'ok means the evaluation completed without harness failures, not that candidates are correct.'}));
      if (!report.ok) process.exitCode = 1;
    }
  } finally { await handle.close().catch(() => {}); await rm(lock); }
}
