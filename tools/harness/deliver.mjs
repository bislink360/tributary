#!/usr/bin/env node
// Tributary delivery harness: runs the coder and tester agents headless, routing work between them
// until one roadmap task is merged, blocked on a person, or out of QA rounds.
//
// Usage:
//   node tools/harness/deliver.mjs <task-id> [options]
//   node tools/harness/deliver.mjs smoke [--base <ref>]    check the setup with one cheap real agent run
//
// Options:
//   --base <ref>            commit a new worktree starts from (default origin/main)
//   --max-rounds <n>        QA rounds before giving up (default 3)
//   --budget-usd <n>        spending cap for each agent run
//   --permission-mode <m>   permission mode for agent runs (default auto)
//   --no-merge              stop after a QA PASS instead of merging
//   --allow-no-checks       accept a PR that has no CI checks (only until CI exists)
//   --keep-worktree         keep the worktree after the merge
//
// Exit codes: 0 merged (or passed with --no-merge), 2 error, 3 needs a person, 4 QA did not converge.
//
// Agents work in a separate git worktree (<repo>-worktrees/<task>), so the main checkout is never touched.
// docs/ (git-ignored, the only copy of the roadmap) is linked into it, never copied, and the link is
// removed before the worktree is. The feature record (delivery/features/<task>.smd, committed) is marked
// delivered by a harness commit on the PR branch right after the QA pass, so it reads "Delivered" exactly
// when the PR merges.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT = { done: 0, error: 2, needsPerson: 3, notConverging: 4 };
const approvals = new Set();
const CHECK_WAIT_MS = 60 * 60 * 1000;
const REMOTE = process.env.TRIBUTARY_HARNESS_REMOTE ?? 'origin';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// TRIBUTARY_HARNESS_DOCS points the docs link elsewhere (the tests use a throwaway roadmap).
const docsRoot = path.resolve(process.env.TRIBUTARY_HARNESS_DOCS ?? path.join(repoRoot, 'docs'));
const roadmapFile = path.join(docsRoot, 'roadmap.smd');
const worktreesRoot =
  process.env.TRIBUTARY_HARNESS_WORKTREES ?? path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`);

class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- options ----------

function parseArgs(argv) {
  const options = { base: 'origin/main', maxRounds: 3, permissionMode: 'auto', merge: true, allowNoChecks: false, keepWorktree: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === '--base') options.base = value();
    else if (arg === '--max-rounds') options.maxRounds = Number(value());
    else if (arg === '--budget-usd') options.budgetUsd = Number(value());
    else if (arg === '--permission-mode') options.permissionMode = value();
    else if (arg === '--no-merge') options.merge = false;
    else if (arg === '--allow-no-checks') options.allowNoChecks = true;
    else if (arg === '--keep-worktree') options.keepWorktree = true;
    else if (arg.startsWith('--')) throw new Stop(EXIT.error, `Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Stop(EXIT.error, 'Usage: node tools/harness/deliver.mjs <task-id|smoke> [options]');
  return { target: positional[0], options };
}

// ---------- processes ----------

// TRIBUTARY_HARNESS_CLAUDE / TRIBUTARY_HARNESS_GH replace the real CLIs (tests use stubs ending in .mjs).
function tool(name) {
  const override = process.env[`TRIBUTARY_HARNESS_${name.toUpperCase()}`];
  if (!override) return [name, []];
  return override.endsWith('.mjs') ? [process.execPath, [override]] : [override, []];
}

function exec(name, args, { cwd = repoRoot, input, allowFailure = false, timeout } = {}) {
  const [command, prefix] = tool(name);
  const result = spawnSync(command, [...prefix, ...args], { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout });
  if (result.error) throw new Stop(EXIT.error, `${name} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Stop(EXIT.error, `${name} ${args.slice(0, 3).join(' ')} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const git = (args, options) => exec('git', args, options);
const gh = (args, options) => exec('gh', args, options);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (message) => console.log(`[harness] ${message}`);

// ---------- run state ----------

function runDir(task) {
  const dir = path.join(worktreesRoot, '.runs', task);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadState(task) {
  const file = path.join(runDir(task), 'state.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { task, round: 0, step: 0, cost: 0 };
}

function saveState(state) {
  writeFileSync(path.join(runDir(state.task), 'state.json'), JSON.stringify(state, null, 2));
}

// ---------- worktree ----------

function findOpenPr(task) {
  const prs = JSON.parse(gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName,title']).stdout || '[]');
  const inTitle = new RegExp(`(^|[^A-Za-z0-9-])${task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`);
  return prs.find((pr) => pr.headRefName.includes(`/${task}-`) || inTitle.test(pr.title));
}

function linkDocs(worktree) {
  const link = path.join(worktree, 'docs');
  if (!existsSync(roadmapFile)) throw new Stop(EXIT.error, `${docsRoot} has no roadmap.smd`);
  if (!existsSync(link)) symlinkSync(docsRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function ensureWorktree(task, branch, base) {
  const worktree = path.join(worktreesRoot, task);
  if (existsSync(worktree)) {
    git(['rev-parse', '--is-inside-work-tree'], { cwd: worktree });
    log(`reusing worktree ${worktree}`);
  } else {
    git(['fetch', 'origin', '--prune']);
    if (branch) {
      const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status === 0;
      git(local ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, `origin/${branch}`]);
    } else {
      git(['worktree', 'add', '--detach', worktree, base]);
    }
    log(`created worktree ${worktree}`);
  }
  linkDocs(worktree);
  return worktree;
}

// The docs link is removed first, and only if it is a link: deleting through it would destroy the roadmap.
function removeWorktree(worktree) {
  const link = path.join(worktree, 'docs');
  if (existsSync(link) || isLink(link)) {
    if (!isLink(link)) throw new Stop(EXIT.error, `${link} is not a link; leaving the worktree in place`);
    unlinkSync(link);
  }
  if (!existsSync(roadmapFile)) throw new Stop(EXIT.error, 'docs/roadmap.smd is missing after unlinking');
  const removed = git(['worktree', 'remove', worktree], { allowFailure: true });
  log(removed.status === 0 ? `removed worktree ${worktree}` : `kept worktree ${worktree}: ${removed.stderr}`);
}

function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------- agents ----------

const CONTRACT_COMMON = `You are running unattended inside the Tributary delivery harness (tools/harness/deliver.mjs).
No person can answer questions during this run: when you would need a decision or approval, stop and report it
in the JSON below instead of asking. You are in a git worktree of the repository; docs/ is linked to the main
checkout. End your final message with exactly one fenced \`\`\`json block matching the schema below, after your
normal handoff text. Use real values, never placeholders.`;

const CONTRACTS = {
  coder: `${CONTRACT_COMMON}
If the worktree is a detached HEAD, create your branch from it with \`git switch -c <type>/<task-id>-<slug>\`;
do not switch to main, which another worktree may hold.
{
  "status": "handoff" | "blocked",
  "pr_number": number | null,
  "branch": string | null,
  "head_sha": "full SHA of the pushed PR head" | null,
  "needs_user_approval": ["exact command or decision", ...],
  "blocked_reason": string | null,
  "summary": "two sentences"
}`,
  tester: `${CONTRACT_COMMON}
Use "ERROR" when a gate could not be evaluated, with the reason in "error".
{
  "verdict": "PASS" | "FAIL" | "ERROR",
  "pr_number": number,
  "head_sha": "full SHA you verified",
  "findings": ["F1 title", ...],
  "report": "the full QA report as posted on the PR",
  "evidence_file": "docs/validation/<task-id>.md" | null,
  "error": string | null
}`,
};

function lastJsonBlock(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  try {
    return JSON.parse(blocks.at(-1)[1]);
  } catch {
    return null;
  }
}

function runAgent(state, role, prompt, worktree, options) {
  const sessionKey = `${role}Session`;
  const contractFile = path.join(runDir(state.task), `contract-${role}.md`);
  writeFileSync(contractFile, CONTRACTS[role]);

  const invoke = (text, sessionId) => {
    const args = ['-p', '--agent', role, '--output-format', 'json', '--permission-mode', options.permissionMode, '--append-system-prompt-file', contractFile];
    if (sessionId) args.push('--resume', sessionId);
    if (options.budgetUsd) args.push('--max-budget-usd', String(options.budgetUsd));
    state.step += 1;
    log(`step ${state.step}: ${role}${sessionId ? ' (resumed)' : ''} running…`);
    const { stdout } = exec('claude', args, { cwd: worktree, input: text, allowFailure: true });
    writeFileSync(path.join(runDir(state.task), `${String(state.step).padStart(2, '0')}-${role}.json`), stdout);
    let output;
    try {
      output = JSON.parse(stdout);
    } catch {
      throw new Stop(EXIT.error, `${role} returned no JSON result; see ${runDir(state.task)}`);
    }
    state.cost += output.total_cost_usd ?? 0;
    state[sessionKey] = output.session_id ?? sessionId;
    saveState(state);
    if (output.is_error) throw new Stop(EXIT.error, `${role} run ended with an error: ${String(output.result).slice(0, 500)}`);
    return output;
  };

  let output = invoke(prompt, state[sessionKey]);
  let handoff = lastJsonBlock(output.result);
  if (!handoff) {
    output = invoke('Your final message must end with the fenced json block the harness contract describes. Reply with only that block.', state[sessionKey]);
    handoff = lastJsonBlock(output.result);
  }
  if (!handoff) throw new Stop(EXIT.error, `${role} did not return the harness JSON block; see ${runDir(state.task)}`);
  log(`${role}: ${handoff.status ?? handoff.verdict}${handoff.summary ? ` — ${handoff.summary}` : ''}`);
  return handoff;
}

// ---------- merge gate ----------

function prStatus(pr) {
  return JSON.parse(gh(['pr', 'view', String(pr), '--json', 'state,isDraft,headRefOid,headRefName,mergeable,statusCheckRollup,url']).stdout);
}

function checksState(rollup) {
  if (!rollup || rollup.length === 0) return 'none';
  const states = rollup.map((check) =>
    check.__typename === 'StatusContext' ? check.state : check.status === 'COMPLETED' ? check.conclusion : 'PENDING',
  );
  if (states.some((state) => !state || ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(state))) return 'pending';
  return states.every((state) => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(state)) ? 'passed' : 'failed';
}

// Returns { ok } or { retest | fix | person: reason }.
function mergeGate(pr, testedSha, options) {
  let status = prStatus(pr);
  if (status.state !== 'OPEN') return { person: `PR #${pr} is ${status.state}` };
  if (status.isDraft) return { fix: `PR #${pr} is still a draft; mark it ready once finished` };
  if (status.headRefOid !== testedSha) return { retest: `the PR head moved to ${status.headRefOid} after QA verified ${testedSha}` };

  if (checksState(status.statusCheckRollup) === 'pending') {
    log('waiting for CI checks…');
    gh(['pr', 'checks', String(pr), '--watch', '--interval', '30'], { allowFailure: true, timeout: CHECK_WAIT_MS });
    status = prStatus(pr);
  }
  const checks = checksState(status.statusCheckRollup);
  if (checks === 'none' && !options.allowNoChecks) return { person: `PR #${pr} has no CI checks; set up CI first or pass --allow-no-checks` };
  if (checks === 'failed') return { fix: `CI checks failed on PR #${pr}; read them with gh pr checks ${pr}` };
  if (checks === 'pending') return { person: `CI checks on PR #${pr} did not finish within an hour` };

  for (let attempt = 0; status.mergeable === 'UNKNOWN' && attempt < 6; attempt++) {
    sleep(5000);
    status = prStatus(pr);
  }
  if (status.mergeable === 'CONFLICTING') return { fix: `PR #${pr} conflicts with main; merge origin/main into the branch and resolve the conflicts` };
  if (status.mergeable !== 'MERGEABLE') return { person: `GitHub reports PR #${pr} as ${status.mergeable}` };
  return { ok: true, status };
}

function merge(pr, status, repo) {
  gh(['pr', 'merge', String(pr), '--squash', '--match-head-commit', status.headRefOid]);
  gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${status.headRefName}`], { allowFailure: true });
  log(`merged PR #${pr} (${status.url})`);
}

// ---------- roadmap ----------

function checkOffRoadmap(task, evidenceFile, prUrl, sha) {
  const relative = (evidenceFile ?? `docs/validation/${task}.md`).replace(/^docs[\\/]/, '');
  const evidence = path.join(docsRoot, relative);
  if (!existsSync(evidence)) return log(`roadmap: ${task} left open, no evidence file at ${evidence}`);
  const roadmap = roadmapFile;
  const text = readFileSync(roadmap, 'utf8');
  const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const updated = text.replace(new RegExp(`^(\\s*- )\\[ \\](.*\\{#${escaped}\\})`, 'm'), '$1[x]$2');
  if (updated === text) return log(`roadmap: no open task {#${task}} found`);
  writeFileSync(roadmap, updated);
  const smd = path.join(repoRoot, '.claude', 'skills', 'semantic-markdown-reader', 'scripts', 'smd.cjs');
  const comment = `Merged in ${prUrl} (${sha}). Evidence: docs/${relative.replaceAll('\\', '/')}`;
  spawnSync(process.execPath, [smd, 'review', 'comment', roadmap, task, '--by', '@claude', '--title', 'Done', '--text', comment], { stdio: 'inherit' });
  spawnSync(process.execPath, [smd, 'validate', roadmap], { stdio: 'inherit' });
  log(`roadmap: checked off ${task}`);
}

// ---------- feature record ----------

const docsScript = path.join(repoRoot, '.claude', 'skills', 'delivery-docs', 'scripts', 'docs.mjs');

function docs(worktree, args) {
  return spawnSync(process.execPath, [docsScript, ...args, '--root', path.join(worktree, 'delivery'), '--roadmap', roadmapFile], { encoding: 'utf8' });
}

const recordFile = (worktree, task) => path.join(worktree, 'delivery', 'features', `${task}.smd`);

function logProgress(task, worktree) {
  if (!existsSync(recordFile(worktree, task))) return log(`feature record: none yet at delivery/features/${task}.smd`);
  const result = docs(worktree, ['progress', task]);
  log(`feature record: ${(result.stdout || result.stderr).trim()}`);
}

// After a QA pass on testedSha: mark the record delivered in one commit on top of it and push it.
// Returns the commit the merge gate should accept: the new commit, or testedSha when nothing changed.
function markDelivered(task, worktree, branch, testedSha, prUrl) {
  const file = recordFile(worktree, task);
  if (!existsSync(file)) {
    log(`feature record: none at delivery/features/${task}.smd; nothing to mark delivered`);
    return testedSha;
  }
  if (/^status:s*approveds*$/m.test(readFileSync(file, 'utf8'))) return testedSha;
  if (git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout !== testedSha) {
    log('feature record: worktree is not at the tested commit; leaving the record for the next round');
    return testedSha;
  }
  const result = docs(worktree, ['finalize', task, '--pr', prUrl]);
  if (result.status !== 0) throw new Stop(EXIT.error, `could not finalize the feature record: ${result.stderr.trim()}`);
  git(['add', '--', 'delivery'], { cwd: worktree });
  git(['commit', '-m', `docs(${task}): mark the feature delivered`], { cwd: worktree });
  git(['push', REMOTE, `HEAD:refs/heads/${branch}`], { cwd: worktree });
  const sha = git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout;
  log(`feature record: marked delivered in ${sha.slice(0, 7)}; CI runs once more on that commit`);
  return sha;
}

// ---------- delivery loop ----------

function stopSonar() {
  const script = path.join(repoRoot, 'tools', 'sonar', 'sonar.mjs');
  if (existsSync(script)) spawnSync(process.execPath, [script, 'down'], { cwd: repoRoot, stdio: 'ignore' });
}

function deliver(task, options) {
  gh(['auth', 'status']);
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).stdout;
  const state = loadState(task);
  const existing = state.pr ? { number: state.pr, headRefName: state.branch } : findOpenPr(task);
  const worktree = ensureWorktree(task, existing?.headRefName, options.base);
  let roundsThisRun = 0;

  let coderPrompt = existing
    ? `Continue roadmap task ${task} on branch ${existing.headRefName}, PR #${existing.number}. Bring it to your definition of finished, then hand over.`
    : `Deliver roadmap task ${task} following your agent definition, up to an open PR that meets your definition of finished.`;

  while (true) {
    if (coderPrompt) {
      const handoff = runAgent(state, 'coder', coderPrompt, worktree, options);
      (handoff.needs_user_approval ?? []).forEach((item) => approvals.add(item));
      if (handoff.status !== 'handoff') throw new Stop(EXIT.needsPerson, `coder is blocked: ${handoff.blocked_reason ?? handoff.summary}`);
      if (!handoff.pr_number) throw new Stop(EXIT.error, 'coder handed over without a PR number');
      Object.assign(state, { pr: handoff.pr_number, branch: handoff.branch });
      saveState(state);
      logProgress(task, worktree);
    }

    if (roundsThisRun >= options.maxRounds) {
      throw new Stop(EXIT.notConverging, `${options.maxRounds} QA rounds without a mergeable PASS on PR #${state.pr}`);
    }
    roundsThisRun += 1;
    state.round += 1;
    const testerPrompt =
      state.round === 1 || !state.testerSession
        ? `Verify PR #${state.pr} for roadmap task ${task} following your agent definition. This is QA round ${state.round}.`
        : `The coder has updated PR #${state.pr}. Run QA round ${state.round} from scratch on the new head, confirming each earlier finding id as fixed or still open.`;
    const qa = runAgent(state, 'tester', testerPrompt, worktree, options);

    if (qa.verdict === 'ERROR') throw new Stop(EXIT.needsPerson, `tester could not evaluate the gates: ${qa.error}`);
    if (qa.verdict === 'FAIL') {
      coderPrompt = `The tester returned FAIL for PR #${state.pr} (QA round ${state.round}). Fix every finding on the same branch, re-check your definition of finished, reply on the PR per finding id, then hand over.\n\nQA report:\n\n${qa.report}`;
      continue;
    }

    const accepted = options.merge ? markDelivered(task, worktree, state.branch, qa.head_sha, `https://github.com/${repo}/pull/${state.pr}`) : qa.head_sha;
    const gate = mergeGate(state.pr, accepted, options);
    if (gate.retest) {
      log(`re-testing: ${gate.retest}`);
      coderPrompt = null;
      continue;
    }
    if (gate.fix) {
      log(`back to coder: ${gate.fix}`);
      coderPrompt = `PR #${state.pr} passed QA but cannot merge: ${gate.fix}. Fix it on the same branch, re-check your definition of finished, then hand over.`;
      continue;
    }
    if (gate.person) throw new Stop(EXIT.needsPerson, gate.person);

    if (!options.merge) return finish(state, `QA PASS on PR #${state.pr}; not merged (--no-merge)`);
    merge(state.pr, gate.status, repo);
    checkOffRoadmap(task, qa.evidence_file, gate.status.url, gate.status.headRefOid);
    if (!options.keepWorktree) {
      removeWorktree(worktree);
      git(['branch', '-D', gate.status.headRefName], { allowFailure: true });
    }
    state.merged = true;
    saveState(state);
    return finish(state, `merged PR #${state.pr} for ${task}`);
  }
}

function finish(state, message) {
  log(`done: ${message} after ${state.round} QA round(s), $${state.cost.toFixed(2)} spent`);
  return EXIT.done;
}

function reportApprovals() {
  if (approvals.size > 0) log(`needs your approval:\n  - ${[...approvals].join('\n  - ')}`);
}

// ---------- smoke test ----------

function smoke(options) {
  const task = `SMOKE-${Date.now()}`;
  const worktree = ensureWorktree(task, null, options.base);
  const state = loadState(task);
  try {
    const head = git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout;
    const qa = runAgent(
      state,
      'tester',
      `Harness smoke test. Do not verify any PR and change nothing except as below.
1. Run \`node .claude/skills/semantic-markdown-reader/scripts/smd.cjs tasks docs/roadmap.smd --order deps\` and note the first open task id.
2. Run \`git commit --allow-empty -m smoke\` and note whether the project guard blocked it.
Then answer with verdict "ERROR", pr_number 0, head_sha from \`git rev-parse HEAD\`, findings [the task id, "guard-blocked" or "guard-allowed"], report "smoke", evidence_file null, error "smoke test".`,
      worktree,
      options,
    );
    const problems = [];
    if (qa.head_sha !== head) problems.push(`head_sha ${qa.head_sha} != worktree HEAD ${head}`);
    if (!/^[A-Z][A-Z0-9-]+$/.test(qa.findings?.[0] ?? '')) problems.push(`no roadmap task id read through the docs link (${qa.findings?.[0]})`);
    if (qa.findings?.[1] !== 'guard-blocked') problems.push(`the tester guard did not block a commit (${qa.findings?.[1]})`);
    if (git(['rev-parse', 'HEAD'], { cwd: worktree }).stdout !== head) problems.push('a commit landed in the worktree');
    log(problems.length === 0 ? `smoke: PASS ($${state.cost.toFixed(2)})` : `smoke: FAIL\n  - ${problems.join('\n  - ')}`);
    return problems.length === 0 ? EXIT.done : EXIT.error;
  } finally {
    removeWorktree(worktree);
  }
}

// ---------- main ----------

let code;
try {
  const { target, options } = parseArgs(process.argv.slice(2));
  code = target === 'smoke' ? smoke(options) : deliver(target, options);
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(`[harness] stopped: ${error.message}`);
  code = error.code;
} finally {
  reportApprovals();
  stopSonar();
}
process.exit(code);
