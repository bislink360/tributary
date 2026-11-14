#!/usr/bin/env node
// Usage: node check-sonar.mjs [projectKey]
// Env: SONAR_TOKEN (required), SONAR_HOST_URL (default http://127.0.0.1:9000)
// Exit codes: 0 all gates zero, 1 gate failed, 2 could not evaluate.

import { existsSync, readFileSync } from 'node:fs';

const projectKey = process.argv[2] ?? 'tributary';
const host = (process.env.SONAR_HOST_URL ?? 'http://127.0.0.1:9000').replace(/\/$/, '');
const token = process.env.SONAR_TOKEN;
const reportTask = 'target/sonar/report-task.txt';

if (!token) {
  console.error('SONAR_TOKEN is not set. Set it in the environment; never pass it on the command line.');
  process.exit(2);
}

const authHeader = { Authorization: 'Basic ' + Buffer.from(`${token}:`).toString('base64') };

async function api(path) {
  const response = await fetch(`${host}/api/${path}`, { headers: authHeader });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for /api/${path}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForAnalysis() {
  if (!existsSync(reportTask)) {
    console.warn(`${reportTask} not found; evaluating the last analysis on the server.`);
    return;
  }
  const taskId = /^ceTaskId=(.+)$/m.exec(readFileSync(reportTask, 'utf8'))?.[1]?.trim();
  for (let attempt = 0; attempt < 120; attempt++) {
    const { task } = await api(`ce/task?id=${taskId}`);
    if (task.status === 'SUCCESS') return;
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new Error(`Analysis task ${taskId} ended ${task.status}: ${task.errorMessage ?? ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Analysis task ${taskId} did not finish within 4 minutes.`);
}

function location(component, line) {
  const file = component.slice(component.indexOf(':') + 1);
  return line ? `${file}:${line}` : file;
}

async function main() {
  await waitForAnalysis();

  const issues = await api(`issues/search?components=${projectKey}&resolved=false&ps=500`);
  // One query per status: multi-value status filters have silently returned no results on Community Edition.
  const marked = await Promise.all(
    ['FALSE_POSITIVE', 'ACCEPTED'].map((status) =>
      api(`issues/search?components=${projectKey}&issueStatuses=${status}&ps=500`),
    ),
  );
  const accepted = { issues: marked.flatMap((result) => result.issues) };
  const hotspots = await api(`hotspots/search?projectKey=${projectKey}&status=TO_REVIEW&ps=500`);
  const { component } = await api(
    `measures/component?component=${projectKey}&metricKeys=duplicated_lines,duplicated_blocks,coverage`,
  );
  const measure = (key) => component.measures.find((m) => m.metric === key)?.value ?? '0';

  const duplicatedLines = Number(measure('duplicated_lines'));
  const counts = {
    'open issues': issues.total,
    'duplicated lines': duplicatedLines,
    'hotspots to review': hotspots.paging.total,
  };

  console.log(`SonarQube ${host} project ${projectKey}`);
  for (const [name, value] of Object.entries(counts)) console.log(`  ${name}: ${value}`);
  console.log(`  duplicated blocks: ${measure('duplicated_blocks')}   coverage: ${measure('coverage')}%`);

  for (const issue of issues.issues) {
    const qualities = (issue.impacts ?? []).map((i) => `${i.softwareQuality}/${i.severity}`).join(',');
    console.log(`ISSUE   ${location(issue.component, issue.line)}  ${issue.rule}  ${qualities || issue.type}  ${issue.message}`);
  }
  for (const hotspot of hotspots.hotspots) {
    console.log(`HOTSPOT ${location(hotspot.component, hotspot.line)}  ${hotspot.securityCategory}  ${hotspot.message}`);
  }
  for (const issue of accepted.issues) {
    console.log(`MARKED  ${location(issue.component, issue.line)}  ${issue.issueStatus}  ${issue.rule}  ${issue.message}  (needs a justification in the PR)`);
  }

  const failed = Object.values(counts).some((value) => value > 0);
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`Could not evaluate the SonarQube gate: ${error.message}`);
  process.exit(2);
});
