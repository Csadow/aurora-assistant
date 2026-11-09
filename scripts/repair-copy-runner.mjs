// Executes only copies built from the fixed repository corpus. No project/task API.
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sha} from '../src/vault.mjs';
import {buildCopyPlan, manifest, savedCheck, projectPaths} from './repair-copy-plan.mjs';

export function copySandboxCommand(cwd, scratch) {
  const testArgs = ['--test', '--test-reporter=tap', savedCheck.args[1]];
  return {program: '/usr/bin/bwrap', args: [
    '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', cwd, '/project', '--bind', scratch, '/scratch', '--chdir', '/project', '--clearenv',
    '--setenv', 'TMPDIR', '/scratch', '--setenv', 'TZ', 'UTC', '--setenv', 'LANG', 'C', '--setenv', 'LC_ALL', 'C',
    '--', '/usr/bin/node', ...testArgs], cwd, sandboxCwd: '/project', env: {}, savedCheck,
    testCommand: {program: '/usr/bin/node', args: testArgs, cwd: '/project'}, shell: false,
    notice: 'Fixed Linux fixture harness. Home is not mounted, network/PID namespaces are separate, project and runtime are read-only, scratch is writable. Bubblewrap failure stops execution; no less-isolated fallback. Not a general untrusted-code service.'};
}

export function inspectSavedOutput({stdout = '', stderr = '', exitCode, signal = null, failure = null}) {
  const lines = stdout.split(/\r?\n/), count = key => {
    const values = lines.filter(l => new RegExp('^# ' + key + ' \\d+$').test(l));
    return values.length === 1 ? Number(values[0].split(' ').at(-1)) : null;
  };
  const tests = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(ok|not ok) (\d+) - (.+)$/.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && !/^(?:# Subtest:|(?:not )?ok |1\.\.|# tests )/.test(lines[end])) end++;
    tests.push({name: m[3], passed: m[1] === 'ok', diagnostic: lines.slice(i + 1, end).join('\n')});
  }
  const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(k => [k, count(k)]));
  const assertionsPresent = tests.length === savedCheck.testNames.length && savedCheck.testNames.every(n => tests.filter(t => t.name === n).length === 1);
  const marker = lines.includes('# pass 2');
  const passed = exitCode === 0 && !signal && !failure && marker && assertionsPresent && tests.every(t => t.passed) &&
    totals.tests === 2 && totals.pass === 2 && ['fail', 'cancelled', 'skipped', 'todo'].every(k => totals[k] === 0);
  return {passed, marker, assertionsPresent, totals, tests, stderrPresent: !!stderr};
}

async function readManifest(directory, prefix = '') {
  const result = {};
  for (const item of await readdir(join(directory, prefix), {withFileTypes: true})) {
    const path = prefix ? prefix + '/' + item.name : item.name;
    if (item.isDirectory()) Object.assign(result, await readManifest(directory, path));
    else if (item.isFile()) result[path] = sha(await readFile(join(directory, path)));
    else result[path] = 'unexpected non-regular entry';
  }
  return result;
}

// Not exported: callers cannot supply a directory, program, arguments or source.
async function executeCopy(files, {signal, timeoutMs = 10000, maxBytes = 131072} = {}) {
  signal?.throwIfAborted();
  const allowed = new Set([...projectPaths, 'package.json']);
  if (Object.keys(files).length !== allowed.size || Object.keys(files).some(p => !allowed.has(p) || typeof files[p] !== 'string')) throw Error('Unexpected copy manifest.');
  const owned = await mkdtemp(join(tmpdir(), 'aurora-repair-copy-')), cwd = join(owned, 'project'), scratch = join(owned, 'scratch');
  const result = {cwd, scratch, before: manifest(files), command: null, stdout: '', stderr: '', exitCode: null, signal: null, failure: null};
  const start = Date.now();
  try {
    await mkdir(cwd, {mode: 0o700}); await mkdir(scratch, {mode: 0o700});
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), {recursive: true, mode: 0o700});
      await writeFile(join(cwd, path), content, {flag: 'wx', mode: 0o600});
    }
    const actual = await readManifest(cwd);
    if (Object.keys(actual).length !== Object.keys(result.before).length || Object.keys(result.before).some(p => actual[p] !== result.before[p])) throw Error('Copy readback mismatch.');
    // Keep saved test source and Node's normal subprocess isolation unchanged.
    // The explicit TAP reporter and OS isolation are recorded additions.
    result.command = {...copySandboxCommand(cwd, scratch), timeoutMs, maxBytes};
    const {program, args, env} = result.command;
    // A startup-time kill can leave a Bubblewrap helper behind if only its
    // leader is signalled. Own a separate process group and stop that group.
    const child = spawn(program, args, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    result.pid = child.pid;
    result.command.processGroup = child.pid;
    let bytes = 0;
    const stop = why => {
      result.failure ||= why;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (e) { if (e.code !== 'ESRCH') { result.stopError = e.message; child.kill('SIGKILL'); } }
      }
    };
    const abort = () => stop('interrupted');
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const key of ['stdout', 'stderr']) {
      child[key].setEncoding('utf8');
      child[key].on('data', chunk => {
        const remaining = Math.max(0, maxBytes - bytes), data = Buffer.from(chunk);
        result[key] += data.subarray(0, remaining).toString('utf8'); bytes += data.length;
        if (bytes > maxBytes) stop('output_limit');
      });
    }
    try {
      await new Promise(resolve => {
        child.once('error', e => { result.failure = 'spawn_error'; result.error = e.message; });
        child.once('close', (code, signalled) => { result.exitCode = code; result.signal = signalled; resolve(); });
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    result.after = await readManifest(cwd);
    result.changedDuringRun = [...new Set([...Object.keys(result.before), ...Object.keys(result.after)])].filter(p => result.before[p] !== result.after[p]).sort();
    result.output = inspectSavedOutput(result);
    result.passed = result.output.passed && result.changedDuringRun.length === 0;
  } catch (e) { result.failure ||= 'harness_error'; result.error = e.message; result.passed = false; }
  finally {
    result.milliseconds = Date.now() - start;
    await rm(owned, {recursive: true, force: true});
    result.cleanedUp = await lstat(owned).then(() => false, e => { if (e.code === 'ENOENT') return true; throw e; });
  }
  return result;
}

function validateOptions(options, callback = false) {
  if (Object.keys(options).some(k => !['signal', 'timeoutMs', 'maxBytes', ...(callback ? ['onRun'] : [])].includes(k))) throw Error('Only cancellation, bounded run limits and result callbacks are supported.');
  for (const [name, min, max] of [['timeoutMs', 1, 10000], ['maxBytes', 128, 131072]]) {
    if (options[name] !== undefined && (!Number.isInteger(options[name]) || options[name] < min || options[name] > max)) throw Error('Invalid bounded run limit: ' + name);
  }
}

export async function evaluateFixedCopy(name, input, options = {}) {
  validateOptions(options, true);
  const plan = await buildCopyPlan(name, input);
  const report = {name, inputRevision: plan.inputRevision, evidenceGap: plan.evidenceGap, setup: plan.setup,
    scope: plan.scope, referenceChange: plan.referenceChange, input: plan.input, notice: plan.notice, runs: {}};
  for (const [variant, files] of Object.entries(plan.variants)) {
    if (options.signal?.aborted) { report.interrupted = true; break; }
    const result = await executeCopy(files, options); report.runs[variant] = result;
    await options.onRun?.(variant, result);
    if (result.failure === 'interrupted') { report.interrupted = true; break; }
    if (result.failure) { report.stopped = result.failure; break; }
  }
  return report;
}

export async function evaluatePristineCopy(name, input, options = {}) {
  validateOptions(options);
  const plan = await buildCopyPlan(name, input);
  return executeCopy(plan.pristine, options);
}
