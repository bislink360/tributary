#!/usr/bin/env node
// PreToolUse guard for Bash, Edit and Write. Usage: node guard.mjs <global|coder|tester>
// Reads the hook event from stdin. Exit 2 blocks the tool call and shows stderr to the agent.
// Best effort: GitHub rulesets are the real enforcement; this stops mistakes before they leave the machine.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const role = process.argv[2] ?? 'global';
const CODE_FILE = /\.(java|kt|js|mjs|cjs|ts|py|xml|properties|ya?ml|gradle|kts)$/i;
const SONAR_CONFIG_FILE = /(^|[\\/])(pom\.xml|sonar-project\.properties|[^\\/]+\.ya?ml)$/i;
const GATE_WEAKENING_PROPERTY = /sonar\.(exclusions|cpd\.exclusions|issue\.ignore|test\.exclusions)/;

function readEvent() {
  try {
    const input = readFileSync(0, 'utf8');
    return input ? JSON.parse(input) : null;
  } catch {
    return null;
  }
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function segments(command) {
  return command.split(/&&|\|\||;|\||\r?\n/).map((part) => part.trim().split(/\s+/).filter(Boolean));
}

// Returns { tool, sub, args } for `git ...` and `gh ...` segments, skipping global options such as `git -C dir`.
function parse(tokens) {
  const start = tokens.findIndex((token) => token === 'git' || token === 'gh' || /[\\/](git|gh)(\.exe)?$/.test(token));
  if (start < 0) return null;
  const tool = path.basename(tokens[start]).replace(/\.exe$/, '');
  let index = start + 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    index += ['-C', '-c', '--git-dir', '--work-tree', '-R', '--repo'].includes(tokens[index]) ? 2 : 1;
  }
  return { tool, sub: tokens[index] ?? '', args: tokens.slice(index + 1) };
}

const isMain = (branch) => branch === 'main';
const isRelease = (branch) => branch.startsWith('release/');

function bashViolations(command, cwd) {
  const branch = currentBranch(cwd);
  const problems = [];
  for (const tokens of segments(command)) {
    const call = parse(tokens);
    if (!call) continue;
    const { tool, sub, args } = call;
    const git = (name) => tool === 'git' && sub === name;
    const gh = (name, action) => tool === 'gh' && sub === name && args[0] === action;

    if (role === 'global') {
      if ((git('commit') || git('cherry-pick')) && isMain(branch)) {
        problems.push('No direct commits to main. Work on a feat|fix|ci|chore|docs|test/<task-id>-<slug> branch.');
      }
      if (git('push') && (args.includes('--force') || args.includes('-f') || args.some((a) => a.startsWith('+')))) {
        problems.push('Force push is not allowed. Use --force-with-lease on your own feature branch if you must rewrite it.');
      }
      if (git('push') && (isMain(branch) || args.some((a) => /(^|:)(refs\/heads\/)?main$/.test(a)))) {
        problems.push('No direct pushes to main. Open a pull request.');
      }
      if ((git('commit') || git('push')) && args.includes('--no-verify')) {
        problems.push('--no-verify skips the checks; fix what they report instead.');
      }
    }

    if (role === 'coder') {
      if ((git('commit') || git('cherry-pick')) && isRelease(branch)) {
        problems.push('Release branches belong to the release agent. Land the fix on main through a PR.');
      }
      if (gh('pr', 'merge')) problems.push('The coder does not merge; the orchestrator merges after a QA PASS.');
      if (git('tag') || gh('release', 'create') || (git('push') && args.some((a) => a === '--tags' || a.startsWith('refs/tags/')))) {
        problems.push('Tags and releases belong to the release agent.');
      }
    }

    if (role === 'tester') {
      if (['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'tag', 'reset', 'stash'].some(git)) {
        problems.push(`The tester never changes history (git ${sub}). Report findings to the coder instead.`);
      }
      if (gh('pr', 'merge') || gh('pr', 'close') || gh('pr', 'edit') || (gh('pr', 'review') && args.includes('--approve'))) {
        problems.push('The tester reports with `gh pr comment`; it does not merge, close, edit or approve PRs.');
      }
    }
  }
  return problems;
}

function editViolations(toolInput, cwd) {
  const file = toolInput.file_path ?? '';
  const text = toolInput.new_string ?? toolInput.content ?? '';
  const problems = [];

  if (role === 'global') {
    if (CODE_FILE.test(file) && /NOSONAR/.test(text)) {
      problems.push('NOSONAR hides an issue instead of fixing it. Fix the code, or ask the architect.');
    }
    if (SONAR_CONFIG_FILE.test(file) && GATE_WEAKENING_PROPERTY.test(text)) {
      problems.push('Sonar exclusions and ignore rules weaken the zero-issue gate. Fix the code, or ask the architect.');
    }
  }

  if (role === 'tester') {
    const root = currentRepoRoot(cwd);
    const relative = root ? path.relative(root, path.resolve(cwd, file)) : '';
    const insideRepo = root && !relative.startsWith('..') && !path.isAbsolute(relative);
    const allowed =
      /(^|[\\/])target[\\/]/.test(relative) || /^docs[\\/]validation[\\/]/.test(relative) || /^\.claude[\\/]agent-memory[\\/]/.test(relative);
    if (insideRepo && !allowed) {
      problems.push(`The tester writes only under target/, docs/validation/ and its memory in .claude/agent-memory/, not ${relative}.`);
    }
  }
  return problems;
}

function currentRepoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const event = readEvent();
if (!event) process.exit(0);
const cwd = event.cwd ?? process.cwd();
const input = event.tool_input ?? {};
const problems =
  event.tool_name === 'Bash' ? bashViolations(input.command ?? '', cwd)
  : ['Edit', 'Write', 'MultiEdit'].includes(event.tool_name) ? editViolations(input, cwd)
  : [];

if (problems.length > 0) {
  console.error(`Blocked by project guard (${role}):\n- ${problems.join('\n- ')}`);
  process.exit(2);
}
