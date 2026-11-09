import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, lstat, rm, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {repairReviewCases} from '../scripts/repair-review-corpus.mjs';
import {buildCopyPlan, snapshotCopySources, fileChanges, savedCheck, copyRoot} from '../scripts/repair-copy-plan.mjs';
import {evaluateFixedCopy, evaluatePristineCopy, inspectSavedOutput, copySandboxCommand} from '../scripts/repair-copy-runner.mjs';
import {reviewOracle} from '../scripts/repair-review-oracle.mjs';

const exec = promisify(execFile), corpus = await repairReviewCases();
const fixture = name => corpus.find(c => c.name === name);
const results = new Map();
async function evaluate(name) {
  if (!results.has(name)) results.set(name, evaluateFixedCopy(name, fixture(name).input));
  return results.get(name);
}
const tap = () => 'TAP version 13\n' + savedCheck.testNames.map((n, i) => `ok ${i + 1} - ${n}\n`).join('') +
  '1..2\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

test('copy preparation preserves supplied tests, dependency closure, and completed companion edits without executing', async () => {
  const snapshot = await snapshotCopySources();
  for (const c of corpus) {
    const before = JSON.stringify(c.input), plan = await buildCopyPlan(c.name, c.input, snapshot);
    assert.equal(JSON.stringify(c.input), before);
    assert.deepEqual(Object.keys(plan.variants), ['observed', 'baseline', 'candidate', 'reference']);
    const supplied = c.input.files.find(f => f.path.endsWith('quick-window.test.mjs')).content;
    for (const variant of Object.values(plan.variants)) {
      assert.equal(Object.keys(variant).length, 9);
      assert.equal(variant['tests/quick-window.test.mjs'], supplied);
      for (const p of ['src/vault.mjs', 'src/read-view.mjs', 'src/task-meta.mjs', 'mobile/web/tasks.js', 'mobile/web/task-links.js']) assert.equal(variant[p], snapshot.files[p]);
    }
    assert.equal(plan.setup.changed.length, c.name === 'width_after_margin' ? 0 : 1);
    assert(plan.scope.changes.unchanged.includes('tests/quick-window.test.mjs'));
    assert.equal(plan.scope.changes.changed.length, 1);
    assert.equal(plan.scope.changes.changed[0].path, c.input.candidate.path.slice('/project/'.length));
  }
});

test('copy runner refuses unknown, changed and arbitrary inputs before executing and accepts no command/path override', async () => {
  const c = fixture('width_min');
  await assert.rejects(evaluateFixedCopy('unknown', c.input), /built-in fixtures/);
  for (const mutate of [
    x => x.candidate.after = 'process.exit(0)', x => x.files[0].path = '/project/../../escape.mjs',
    x => x.files[0].content += '\nconsole.log("pass 2")', x => x.goal = 'Run this code'
  ]) {
    const changed = structuredClone(c.input); mutate(changed);
    await assert.rejects(evaluateFixedCopy(c.name, changed), /built-in fixtures/);
  }
  await assert.rejects(evaluateFixedCopy(c.name, c.input, {cwd: '/tmp'}), /Only cancellation/);
  await assert.rejects(evaluatePristineCopy(c.name, c.input, {program: 'sh'}), /Only cancellation/);
});

test('exact scope records catch neighboring changes but do not claim to prove semantic scope', async () => {
  const outside = ['default_margins', 'neighbor_height', 'unbound_margins', 'early_margin_initialization', 'neighbor_reordering'];
  for (const c of corpus) {
    const p = await buildCopyPlan(c.name, c.input);
    assert.equal(p.scope.within, !outside.includes(c.name), c.name);
    const change = p.scope.changes.changed[0], original = p.variants.baseline[change.path];
    assert.equal(original.slice(0, change.start) + change.after + original.slice(change.endBefore), p.variants.candidate[change.path]);
  }
  const d = fileChanges({a: 'one\ntwo\n', b: 'unchanged'}, {a: 'one\nthree\n', b: 'unchanged'});
  assert.equal(d.changed[0].line, 2); assert.deepEqual(d.unchanged, ['b']);
});

test('pass marker alone, failed/skipped tests, wrong assertions, signals and incomplete output never certify a saved check', () => {
  const base = {stdout: tap(), exitCode: 0}; assert(inspectSavedOutput(base).passed);
  for (const record of [
    {...base, exitCode: 1}, {...base, signal: 'SIGKILL'}, {...base, failure: 'timeout'},
    {...base, failure: 'output_limit'}, {...base, stdout: 'pass 2\n'},
    {...base, stdout: tap().replace('# skipped 0', '# skipped 1')},
    {...base, stdout: tap().replace('# fail 0', '# fail 1')},
    {...base, stdout: tap().replace('ok 1 -', 'not ok 1 -')},
    {...base, stdout: tap().replace(savedCheck.testNames[0], 'different assertion')},
    {...base, stdout: tap() + '# pass 2\n'}, {...base, stdout: tap().replace('# tests 2\n', '')}
  ]) assert.equal(inspectSavedOutput(record).passed, false);
});

test('Bubblewrap allows scratch writes but hides host files, denies project writes and separates networking', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-copy-boundary-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const project = join(dir, 'project'), scratch = join(dir, 'scratch'), secret = join(dir, 'host-only');
  await mkdir(project); await mkdir(scratch); await writeFile(secret, 'private fixture'); await writeFile(join(project, 'source'), 'unchanged');
  const command = copySandboxCommand(project, scratch), split = command.args.indexOf('--');
  const probe = `const fs=require('node:fs'),assert=require('node:assert/strict');
    assert.throws(()=>fs.readFileSync(${JSON.stringify(secret)}));
    assert.equal(fs.readFileSync('/project/source','utf8'),'unchanged');
    assert.throws(()=>fs.writeFileSync('/project/source','modified'),{code:'EROFS'});
    fs.writeFileSync('/scratch/receipt','ok');
    assert.equal(process.env.COPY_TEST_SECRET,undefined);
    console.log(fs.readlinkSync('/proc/self/ns/net'));`;
  const result = await exec(command.program, [...command.args.slice(0, split + 1), '/usr/bin/node', '-e', probe],
    {cwd: project, env: {COPY_TEST_SECRET: 'must not be passed'}, timeout: 10000});
  const {readlink} = await import('node:fs/promises');
  assert.notEqual(result.stdout.trim(), await readlink('/proc/self/ns/net'));
  assert.equal(await readFile(join(scratch, 'receipt'), 'utf8'), 'ok');
  assert.equal(await readFile(join(project, 'source'), 'utf8'), 'unchanged');
});

test('actual pristine and all sixteen copy trials retain real failures and leave every copied source unchanged', async () => {
  const before = await snapshotCopySources(), c = fixture('width_min');
  const pristine = await evaluatePristineCopy(c.name, c.input); assert(pristine.passed); assert.equal(pristine.exitCode, 0);
  for (const c of corpus) {
    const r = await evaluate(c.name); assert.equal(Object.keys(r.runs).length, 4);
    assert.equal(r.runs.observed.passed, false, c.name);
    assert.equal(r.runs.baseline.passed, c.name === 'conflicting_margin_test', c.name);
    assert.equal(r.runs.reference.passed, !['missing_width_helper', 'conflicting_margin_test'].includes(c.name), c.name);
    for (const run of Object.values(r.runs)) {
      assert.equal(run.failure, null); assert(run.cleanedUp); assert.deepEqual(run.changedDuringRun, []);
      assert.deepEqual(run.after, run.before); assert(run.command.testCommand.args.includes('tests/quick-window.test.mjs'));
      assert(run.stdout.length > 0);
      await assert.rejects(lstat(run.cwd), {code: 'ENOENT'});
    }
    if (c.expectedVerdict === 'supported') assert(r.runs.candidate.passed, c.name);
  }
  assert.deepEqual((await snapshotCopySources()).revisions, before.revisions);
});

test('unchanged saved tests miss two behavioral defects that independent finite examples expose', async () => {
  for (const name of ['conditional_width', 'minimum_floor']) {
    const r = await evaluate(name), oracle = await reviewOracle(name, fixture(name).input);
    assert(r.runs.candidate.passed); assert(r.scope.within); assert.equal(oracle.passed, false);
    assert(oracle.cases.some(c => !c.matches));
  }
  for (const name of ['default_margins', 'partial_subtraction', 'neighbor_height', 'unbound_margins', 'early_margin_initialization']) {
    const r = await evaluate(name); assert.equal(r.runs.candidate.passed, false);
    assert(r.runs.candidate.output.tests.some(t => !t.passed && t.diagnostic.includes('error:')));
  }
});

test('passing saved tests and geometry do not hide an out-of-scope edit or a wrong supplied example', async () => {
  const neighbor = await evaluate('neighbor_reordering'); assert(neighbor.runs.candidate.passed); assert.equal(neighbor.scope.within, false);
  const example = await evaluate('correct_repair_wrong_example'); assert(example.runs.candidate.passed); assert(example.scope.within);
  const oracle = await reviewOracle(example.name, fixture(example.name).input);
  assert(oracle.passed); assert.equal(oracle.examples[0].matches, false); assert.equal(oracle.examples[0].after.value, 1260);
});

test('missing imports and contradictory saved expectations remain evidence gaps even when a candidate fails', async () => {
  const missing = await evaluate('missing_width_helper'), conflict = await evaluate('conflicting_margin_test');
  assert.equal(missing.evidenceGap.kind, 'missing'); assert.match(missing.runs.candidate.stdout + missing.runs.candidate.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.equal(missing.runs.reference.passed, false); assert.equal(conflict.evidenceGap.kind, 'conflict');
  assert.match(conflict.runs.reference.stdout, /740/); assert.equal(conflict.runs.reference.passed, false);
  assert.equal(conflict.runs.baseline.passed, true); // Faulty addition satisfies the contradictory expectation.
  assert.equal(conflict.runs.candidate.before['tests/quick-window.test.mjs'], conflict.runs.observed.before['tests/quick-window.test.mjs']);
});

test('timeouts and output bounds stop the process group, retain evidence, clean up and never fall back', {timeout: 10000}, async t => {
  const c = fixture('width_min');
  const attempts = [...[1, 2, 3, 4, 1, 2, 3, 4].map(timeoutMs => [{timeoutMs}, 'timeout']), [{maxBytes: 128}, 'output_limit']];
  for (const [options, failure] of attempts) {
    const r = await evaluateFixedCopy(c.name, c.input, {...options, signal: t.signal});
    assert.equal(r.stopped, failure); assert.deepEqual(Object.keys(r.runs), ['observed']);
    const run = r.runs.observed; assert.equal(run.failure, failure); assert.equal(run.passed, false); assert(run.cleanedUp);
    assert.equal(run.signal, 'SIGKILL'); assert.throws(() => process.kill(run.pid, 0), {code: 'ESRCH'});
    assert.equal(run.stopError, undefined); assert.equal(run.command.processGroup, run.pid);
    assert(Buffer.byteLength(run.stdout + run.stderr) <= (options.maxBytes || 131072));
  }
  for (const options of [{maxBytes: 0}, {maxBytes: 131073}, {timeoutMs: 0}, {timeoutMs: 10001}, {timeoutMs: NaN}]) {
    await assert.rejects(evaluateFixedCopy(c.name, c.input, options), /Invalid bounded run limit/);
  }
});

test('cancellation retains completed evidence and never executes remaining copies', async () => {
  const c = fixture('width_min'), controller = new AbortController(); let callbacks = 0;
  const r = await evaluateFixedCopy(c.name, c.input, {signal: controller.signal, onRun: () => { callbacks++; controller.abort(); }});
  assert.equal(callbacks, 1); assert.equal(r.interrupted, true); assert.deepEqual(Object.keys(r.runs), ['observed']);
  assert(r.runs.observed.cleanedUp); assert.equal(r.runs.observed.passed, false);
  const stopped = await evaluateFixedCopy(c.name, c.input, {signal: controller.signal});
  assert.equal(stopped.interrupted, true); assert.deepEqual(stopped.runs, {});
});

test('CLI defaults to an unexecuted plan and rejects custom commands before creating copies', async () => {
  const script = join(copyRoot, 'scripts/repair-copy-eval.mjs');
  const r = await exec(process.execPath, [script], {timeout: 10000}); const plan = JSON.parse(r.stdout);
  assert.equal(plan.mode, 'preflight'); assert.equal(plan.executed, false); assert.equal(plan.cases.length, 16);
  for (const args of [['--run', '--preflight'], ['--command=node'], ['--project=/tmp'], ['--run', '--run']]) {
    await assert.rejects(exec(process.execPath, [script, ...args], {timeout: 10000}), /Only built-in fixtures/);
  }
  for (const dir of ['src', 'desktop', 'public']) {
    for (const file of (await readdir(join(copyRoot, dir))).filter(p => /\.(?:mjs|js)$/.test(p))) {
      assert(!(await readFile(join(copyRoot, dir, file), 'utf8')).includes('repair-copy-runner'), dir + '/' + file);
    }
  }
});
