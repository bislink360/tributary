#!/usr/bin/env node
// Stand-in for `claude -p --agent <role>` in harness tests. Replays the scenario's next answer for the role
// and logs each call. Env: TRIBUTARY_HARNESS_STUB_DIR (holds scenario.json, calls.jsonl, counters.json).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ tool: 'claude', role, resume: option('--resume'), prompt }) + '\n');

if (answer === undefined) {
  console.log(JSON.stringify({ type: 'result', is_error: true, result: `stub: no answer ${index} for ${role}` }));
  process.exit(1);
}
const result = answer === 'nojson' ? 'Handoff text without the block.' : `Handoff text.\n\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``;
console.log(JSON.stringify({ type: 'result', is_error: false, session_id: `${role}-session`, total_cost_usd: 0.01, result }));
