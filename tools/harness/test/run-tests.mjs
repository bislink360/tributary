#!/usr/bin/env node
// Routing tests for the delivery harness. Agents and GitHub are stubbed; git worktrees are real but live in
// a temporary folder. Usage: node tools/harness/test/run-tests.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const harness = path.join(here, '..', 'deliver.mjs');

const coder = (sha, extra = {}) => ({ status: 'handoff', pr_number: 7, branch: 'feat/T-X-1-demo', head_sha: sha, needs_user_approval: [], blocked_reason: null, summary: 'ok', ...extra });
const tester = (verdict, sha, report = 'report') => ({ verdict, pr_number: 7, head_sha: sha, findings: verdict === 'FAIL' ? ['F1 broken'] : [], report, evidence_file: null, error: null });
const success = [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const failure = [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }];
const pr = (sha, checks = success, extra = {}) => ({ state: 'OPEN', isDraft: false, headRefOid: sha, headRefName: 'feat/T-X-1-demo', mergeable: 'MERGEABLE', statusCheckRollup: checks, url: 'https://github.com/bislink360/tributary/pull/7', ...extra });

const cases = [
  {
    name: 'FAIL then PASS: coder fixes with the QA report, both sessions resume, merge pins the tested head',
    scenario: { coder: [coder('a1'), coder('b2')], tester: [tester('FAIL', 'a1', 'QA-REPORT-ROUND-1'), tester('PASS', 'b2')], gh: { pr_view: [pr('b2')] } },
    exit: 0,
    check: (calls) => {
      const agents = calls.filter((c) => c.tool === 'claude');
      expect(agents.map((c) => c.role).join(), 'coder,tester,coder,tester');
      expect(agents[2].resume, 'coder-session');
      expect(agents[2].prompt.includes('QA-REPORT-ROUND-1'), true);
      expect(agents[3].resume, 'tester-session');
      const mergeCall = calls.find((c) => c.tool === 'gh' && c.args[1] === 'merge');
      expect(mergeCall.args.join(' '), 'pr merge 7 --squash --match-head-commit b2');
      expect(calls.some((c) => c.tool === 'gh' && c.args.join(' ').includes('DELETE repos/bislink360/tributary/git/refs/heads/feat/T-X-1-demo')), true);
    },
  },
  {
    name: 'coder blocked: stops for a person without running QA',
    scenario: { coder: [coder(null, { status: 'blocked', pr_number: null, blocked_reason: 'needs Q1' })], tester: [], gh: {} },
    exit: 3,
    check: (calls) => expect(calls.filter((c) => c.role === 'tester').length, 0),
  },
  {
    name: 'QA does not converge: stops after --max-rounds',
    args: ['--max-rounds', '2'],
    scenario: { coder: [coder('a1'), coder('b2'), coder('c3')], tester: [tester('FAIL', 'a1'), tester('FAIL', 'b2'), tester('FAIL', 'c3')], gh: {} },
    exit: 4,
    check: (calls) => expect(calls.filter((c) => c.role === 'tester').length, 2),
  },
  {
    name: 'head moved after QA: re-tests instead of merging untested code',
    scenario: { coder: [coder('a1')], tester: [tester('PASS', 'a1'), tester('PASS', 'b2')], gh: { pr_view: [pr('b2'), pr('b2')] } },
    exit: 0,
    check: (calls) => {
      expect(calls.filter((c) => c.role === 'tester').length, 2);
      expect(calls.filter((c) => c.role === 'coder').length, 1);
      expect(calls.find((c) => c.tool === 'gh' && c.args[1] === 'merge').args.includes('b2'), true);
    },
  },
  {
    name: 'CI failed after PASS: back to the coder, then QA again',
    scenario: { coder: [coder('a1'), coder('b2')], tester: [tester('PASS', 'a1'), tester('PASS', 'b2')], gh: { pr_view: [pr('a1', failure), pr('b2')] } },
    exit: 0,
    check: (calls) => {
      const coders = calls.filter((c) => c.role === 'coder');
      expect(coders.length, 2);
      expect(coders[1].prompt.includes('CI checks failed'), true);
    },
  },
  {
    name: 'missing JSON block: asks once more, then continues (--no-merge stops at PASS)',
    args: ['--no-merge'],
    scenario: { coder: ['nojson', coder('a1')], tester: [tester('PASS', 'a1')], gh: { pr_view: [pr('a1')] } },
    exit: 0,
    check: (calls) => {
      const coders = calls.filter((c) => c.role === 'coder');
      expect(coders.length, 2);
      expect(coders[1].prompt.includes('Reply with only that block'), true);
      expect(calls.some((c) => c.tool === 'gh' && c.args[1] === 'merge'), false);
    },
  },
  {
    name: 'no CI checks: stops for a person instead of merging',
    scenario: { coder: [coder('a1')], tester: [tester('PASS', 'a1')], gh: { pr_view: [pr('a1', [])] } },
    exit: 3,
    check: (calls) => expect(calls.some((c) => c.tool === 'gh' && c.args[1] === 'merge'), false),
  },
  {
    name: 'tester ERROR: stops for a person',
    scenario: { coder: [coder('a1')], tester: [{ ...tester('ERROR', 'a1'), error: 'Docker is not running' }], gh: {} },
    exit: 3,
    check: () => {},
  },
];

function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function expect(actual, expected) {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let failed = 0;
for (const [index, testCase] of cases.entries()) {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), 'harness-stub-'));
  const worktrees = mkdtempSync(path.join(os.tmpdir(), 'harness-wt-'));
  writeFileSync(path.join(stubDir, 'scenario.json'), JSON.stringify(testCase.scenario));
  const result = spawnSync(process.execPath, [harness, `T-HARNESS-TEST-${index}`, '--base', 'HEAD', ...(testCase.args ?? [])], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TRIBUTARY_HARNESS_CLAUDE: path.join(here, 'stub-claude.mjs'),
      TRIBUTARY_HARNESS_GH: path.join(here, 'stub-gh.mjs'),
      TRIBUTARY_HARNESS_STUB_DIR: stubDir,
      TRIBUTARY_HARNESS_WORKTREES: worktrees,
    },
  });
  const calls = existsSync(path.join(stubDir, 'calls.jsonl'))
    ? readFileSync(path.join(stubDir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  try {
    expect(result.status, testCase.exit);
    testCase.check(calls);
    if (!existsSync(path.join(repoRoot, 'docs', 'roadmap.smd'))) throw new Error('docs/roadmap.smd disappeared');
    console.log(`PASS  ${testCase.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${testCase.name}\n      ${error.message}\n${result.stdout}${result.stderr}`);
  }
  for (const entry of readdirSync(worktrees)) {
    if (entry === '.runs') continue;
    const docsLink = path.join(worktrees, entry, 'docs');
    if (isLink(docsLink)) unlinkSync(docsLink);
    spawnSync('git', ['worktree', 'remove', '--force', path.join(worktrees, entry)], { cwd: repoRoot });
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot });
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(worktrees, { recursive: true, force: true });
}
console.log(failed === 0 ? `all ${cases.length} passed` : `${failed} of ${cases.length} failed`);
process.exit(failed === 0 ? 0 : 1);
