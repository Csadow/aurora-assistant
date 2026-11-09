// Development fixtures only. A copy is not a security sandbox or edit approval.
import {readFile, realpath, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {sha} from '../src/vault.mjs';
import {repairReviewCases, applyCandidate} from './repair-review-corpus.mjs';

export const copyRoot = fileURLToPath(new URL('../', import.meta.url));
export const projectPaths = [
  'desktop/quick-window.mjs', 'desktop/placement.mjs', 'tests/quick-window.test.mjs',
  'src/vault.mjs', 'src/read-view.mjs', 'src/task-meta.mjs', 'mobile/web/tasks.js', 'mobile/web/task-links.js'
];
export const harnessPaths = [
  'scripts/repair-copy-plan.mjs', 'scripts/repair-copy-runner.mjs', 'scripts/repair-copy-eval.mjs',
  'scripts/repair-review-corpus.mjs', 'scripts/repair-diagnosis-cases.mjs',
  'scripts/repair-review-oracle.mjs', 'src/repair-expression.mjs'
];
export const savedCheck = {
  name: 'Window tests', program: 'node', args: ['--test', 'tests/quick-window.test.mjs'],
  outputIncludes: 'pass 2', testNames: [
    'Quick ask restores independent geometry and clamps it after a monitor disappears',
    'placement uses scaled, rotated monitor work areas and fits small screens'
  ]
};
const repairs = {
  'desktop/quick-window.mjs': ['Math.max(value.width,area.width)', 'Math.min(value.width,area.width)'],
  'desktop/placement.mjs': ['width+left+right', 'width-left-right']
};
export const manifest = files => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p, s]) => [p, sha(s)]));

export async function snapshotCopySources() {
  const files = {};
  for (const p of [...projectPaths, ...harnessPaths]) {
    const path = join(copyRoot, p);
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw Error('Fixture source must be a regular file without symlink parents: ' + p);
    files[p] = await readFile(path, 'utf8');
  }
  return {files, revisions: manifest(files)};
}

// Minimal exact text-span changes (UTF-16 offsets), plus full changed lines.
export function fileChanges(before, after) {
  const changed = [], unchanged = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[path], b = after[path];
    if (a === b) { unchanged.push(path); continue; }
    let start = 0, endA = a?.length || 0, endB = b?.length || 0;
    if (a !== undefined && b !== undefined) {
      while (start < endA && start < endB && a[start] === b[start]) start++;
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    }
    const lineStart = (a || '').lastIndexOf('\n', start - 1) + 1;
    const lineEnd = (s, n) => { const i = (s || '').indexOf('\n', n); return i < 0 ? (s || '').length : i; };
    changed.push({path, beforeRevision: a === undefined ? null : sha(a), afterRevision: b === undefined ? null : sha(b),
      start, endBefore: endA, endAfter: endB, line: (a || '').slice(0, start).split('\n').length,
      column: start - lineStart + 1, before: (a || '').slice(start, endA), after: (b || '').slice(start, endB),
      beforeLines: (a || '').slice(lineStart, lineEnd(a, endA)), afterLines: (b || '').slice(lineStart, lineEnd(b, endB))});
  }
  return {changed, unchanged};
}

export function expressionBoundary(before, after, path) {
  const wrong = repairs[path]?.[0], start = wrong ? before[path]?.indexOf(wrong) : -1;
  if (start === undefined || start < 0 || start !== before[path].lastIndexOf(wrong)) throw Error('Expected one known faulty expression.');
  const end = start + wrong.length, changes = fileChanges(before, after);
  const within = changes.changed.length === 1 && changes.changed[0].path === path &&
    after[path].startsWith(before[path].slice(0, start)) && after[path].endsWith(before[path].slice(end));
  return {within, path, permitted: {start, end, text: wrong}, changes,
    notice: 'Mechanical expression boundary only. Staying inside it does not prove behavior or semantic scope.'};
}

function repairControl(files, path) {
  const [wrong, right] = repairs[path], content = files[path];
  if (!content.includes(wrong)) {
    if (!content.includes(right)) throw Error('Unknown fixture repair state: ' + path);
    return {...files};
  }
  if (content.indexOf(wrong) !== content.lastIndexOf(wrong)) throw Error('Ambiguous fixture repair: ' + path);
  return {...files, [path]: content.replace(wrong, right)};
}

export async function buildCopyPlan(name, proposedInput, snapshot) {
  snapshot ??= await snapshotCopySources();
  const fixed = (await repairReviewCases()).find(c => c.name === name);
  if (!fixed || sha(JSON.stringify(fixed.input)) !== sha(JSON.stringify(proposedInput))) {
    throw Error('Copy evaluation accepts only unchanged built-in fixtures; no arbitrary or model-generated code.');
  }
  const pristine = Object.fromEntries(projectPaths.map(p => [p, snapshot.files[p]]));
  // .js dependencies are ESM; this synthetic manifest has no scripts or packages.
  pristine['package.json'] = '{"private":true,"type":"module"}\n';
  const observed = {...pristine};
  for (const f of fixed.input.files) {
    const path = f.path.replace(/^\/project\//, '');
    if (!projectPaths.includes(path) || f.revision !== sha(f.content)) throw Error('Unexpected fixture source.');
    observed[path] = f.content;
  }
  const path = fixed.input.candidate.path.slice('/project/'.length);
  const other = Object.keys(repairs).find(p => p !== path);
  const baseline = repairControl(observed, other), preview = applyCandidate(fixed.input);
  const candidate = {...baseline, [path]: preview.content}, reference = repairControl(baseline, path);
  return {name, input: fixed.input, inputRevision: sha(JSON.stringify(fixed.input)),
    evidenceGap: fixed.oracle === 'execute' ? null : {kind: fixed.oracle, reason: fixed.rubric},
    variants: {observed, baseline, candidate, reference},
    setup: fileChanges(observed, baseline), scope: expressionBoundary(baseline, candidate, path),
    referenceChange: fileChanges(baseline, reference), pristine,
    notice: 'Baseline completes only the other known fixture repair. Reference makes the minimal known target repair, retaining supplied tests and missing evidence. Neither is an assistant-generated edit.'};
}
