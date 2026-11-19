#!/usr/bin/env node
// Stand-in for `claude -p --agent <role>` in harness tests. Replays the scenario's next answer for the role
// and logs each call. Env: TRIBUTARY_HARNESS_STUB_DIR (holds scenario.json, calls.jsonl, counters.json).

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.TRIBUTARY_HARNESS_STUB_DIR;
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const role = option('--agent');
const prompt = readFileSync(0, 'utf8');

const countersFile = path.join(dir, 'counters.json');
const counters = existsSync(countersFile) ? JSON.parse(readFileSync(countersFile, 'utf8')) : {};
const index = counters[role] ?? 0;
counters[role] = index + 1;
writeFileSync(countersFile, JSON.stringify(counters));

const scenario = JSON.parse(readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const answer = scenario[role]?.[index];
const addDirs = args.filter((_, i) => args[i - 1] === '--add-dir');
appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ tool: 'claude', role, resume: option('--resume'), prompt, addDirs }) + '\n');

// "__memory": write a project-memory note, as an agent with `memory: project` would.
if (answer?.__memory) {
  const note = path.join('.claude', 'agent-memory', role, 'notes.md');
  mkdirSync(path.dirname(note), { recursive: true });
  writeFileSync(note, answer.__memory);
  delete answer.__memory;
}

const git = (...gitArgs) => spawnSync('git', gitArgs, { encoding: 'utf8' }).stdout.trim();

// "__record": commit a filled feature record on the answer's branch, as a coder would.
if (answer?.__record) {
  const task = /task (\S+)/.exec(prompt)[1];
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'feature.smd');
  const record = path.join('delivery', 'features', `${task}.smd`);
  git('switch', '-c', answer.branch);
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, readFileSync(fixture, 'utf8').replaceAll('__ID__', task));
  git('add', record);
  git('commit', '-m', `feat(${task}): demo`);
  delete answer.__record;
}
// "@head" stands for the commit the worktree is on.
if (answer?.head_sha === '@head') answer.head_sha = git('rev-parse', 'HEAD');

if (answer === undefined) {
  console.log(JSON.stringify({ type: 'result', is_error: true, result: `stub: no answer ${index} for ${role}` }));
  process.exit(1);
}
const result = answer === 'nojson' ? 'Handoff text without the block.' : `Handoff text.\n\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``;
console.log(JSON.stringify({ type: 'result', is_error: false, session_id: `${role}-session`, total_cost_usd: 0.01, result }));
