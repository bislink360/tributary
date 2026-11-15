#!/usr/bin/env node
// Stand-in for the GitHub CLI in harness tests: answers the calls the harness makes from scenario.json
// and logs each one. Env: TRIBUTARY_HARNESS_STUB_DIR.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.TRIBUTARY_HARNESS_STUB_DIR;
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(path.join(dir, 'scenario.json'), 'utf8')).gh ?? {};
appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ tool: 'gh', args }) + '\n');

function next(key) {
  const countersFile = path.join(dir, 'counters.json');
  const counters = existsSync(countersFile) ? JSON.parse(readFileSync(countersFile, 'utf8')) : {};
  const index = counters[key] ?? 0;
  counters[key] = index + 1;
  writeFileSync(countersFile, JSON.stringify(counters));
  const answers = scenario[key];
  return answers[Math.min(index, answers.length - 1)];
}

const [command, sub] = args;
if (command === 'auth') process.exit(0);
if (command === 'repo') console.log('bislink360/tributary');
else if (command === 'pr' && sub === 'list') console.log(JSON.stringify(scenario.pr_list ?? []));
else if (command === 'pr' && sub === 'view') console.log(JSON.stringify(next('pr_view')));
else if (command === 'pr' && (sub === 'checks' || sub === 'merge')) process.exit(0);
else if (command === 'api') process.exit(0);
else {
  console.error(`stub-gh: unexpected call ${args.join(' ')}`);
  process.exit(1);
}
