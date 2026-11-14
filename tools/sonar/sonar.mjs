#!/usr/bin/env node
// Local SonarQube for Tributary's quality gate: starts the server, provisions it, scans, and checks.
//
// Usage: node tools/sonar/sonar.mjs <command>
//   gate     up + scan + check (what agents run)
//   up       start the server and provision the admin password, project and token
//   scan     run the Maven build with the Sonar analysis
//   check    evaluate the last analysis (zero issues, duplications and hotspots)
//   status   whether the server is running and the stored token works
//   down     stop the server, keeping its data
//   reset    stop the server and delete its data and stored credentials
//
// Exit codes: 0 pass, 1 gate failed, 2 could not evaluate.
// Credentials are generated here and kept in tools/sonar/.state/ (git-ignored); they are never printed.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'http://127.0.0.1:9001';
const PROJECT_KEY = 'tributary';
const SCANNER = 'org.sonarsource.scanner.maven:sonar-maven-plugin:5.8.0.7211:sonar';
// The server's default Java profile ("Sonar way core") misses basics such as empty catch blocks,
// System.out, unused fields and commented-out code; "comprehensive" is the built-in profile that has them.
const QUALITY_PROFILES = { java: 'Sonar way comprehensive' };
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const composeFile = path.join(here, 'compose.yaml');
const stateDir = path.join(here, '.state');
const stateFile = path.join(stateDir, 'credentials.json');
const checkScript = path.join(repoRoot, '.claude', 'skills', 'quality-gates', 'scripts', 'check-sonar.mjs');
const isWindows = process.platform === 'win32';

class CannotEvaluate extends Error {}

function run(command, args, { shell = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell, env });
  if (result.error) throw new CannotEvaluate(`${command} could not start: ${result.error.message}`);
  return result.status ?? 2;
}

function compose(...args) {
  return run('docker', ['compose', '-f', composeFile, ...args]);
}

function readState() {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
}

function writeState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function api(method, apiPath, auth, form) {
  const headers = { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') };
  const body = form ? new URLSearchParams(form) : undefined;
  const response = await fetch(`${HOST}/api/${apiPath}`, { method, headers, body });
  if (!response.ok) {
    throw new CannotEvaluate(`${method} /api/${apiPath} returned ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function isValid(auth) {
  const response = await fetch(`${HOST}/api/authentication/validate`, {
    headers: { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') },
  });
  return response.ok && (await response.json()).valid === true;
}

async function serverStatus() {
  try {
    const response = await fetch(`${HOST}/api/system/status`);
    return response.ok ? (await response.json()).status : 'STARTING';
  } catch {
    return 'DOWN';
  }
}

async function waitUntilUp() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let status = await serverStatus();
  while (status !== 'UP') {
    if (Date.now() > deadline) throw new CannotEvaluate(`SonarQube did not come up within 5 minutes (status ${status}).`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    status = await serverStatus();
  }
}

// SonarQube requires 12+ characters with upper and lower case, a digit and a special character.
function generatePassword() {
  const pick = (alphabet) => alphabet[randomInt(alphabet.length)];
  return randomBytes(24).toString('base64url') + pick('ABCDEFGHJKLMNPQRSTUVWXYZ') + pick('abcdefghijkmnpqrstuvwxyz') + pick('23456789') + pick('!@#%^*-_=+');
}

async function ensureAdminPassword(state) {
  if (state.adminPassword && (await isValid(`admin:${state.adminPassword}`))) return state.adminPassword;
  if (!(await isValid('admin:admin'))) {
    throw new CannotEvaluate(
      'Cannot authenticate as admin: the server holds credentials this script does not have. ' +
        'Run `node tools/sonar/sonar.mjs reset` to start from an empty server.',
    );
  }
  // Stored before the change: if the change fails, the next run still finds admin/admin and retries.
  const adminPassword = generatePassword();
  writeState({ ...state, adminPassword, token: undefined });
  await api('POST', 'users/change_password', 'admin:admin', {
    login: 'admin',
    previousPassword: 'admin',
    password: adminPassword,
  });
  return adminPassword;
}

async function ensureToken() {
  const state = readState();
  if (state.token && (await isValid(`${state.token}:`))) return state.token;

  const admin = `admin:${await ensureAdminPassword(state)}`;
  const { token } = await api('POST', 'user_tokens/generate', admin, {
    name: `tributary-agents-${Date.now()}`,
    type: 'USER_TOKEN',
  });
  writeState({ ...readState(), token });
  return token;
}

// Runs on every `up`, so a changed profile setting or a recreated project is always applied.
async function ensureProject(token) {
  const auth = `${token}:`;
  const { components } = await api('GET', `projects/search?projects=${PROJECT_KEY}`, auth);
  if (components.length === 0) {
    await api('POST', 'projects/create', auth, { project: PROJECT_KEY, name: PROJECT_KEY });
  }
  for (const [language, qualityProfile] of Object.entries(QUALITY_PROFILES)) {
    await api('POST', 'qualityprofiles/add_project', auth, { language, project: PROJECT_KEY, qualityProfile });
  }
}

async function up() {
  if ((await serverStatus()) !== 'UP') {
    if (compose('up', '-d') !== 0) throw new CannotEvaluate('docker compose up failed. Is Docker running?');
    await waitUntilUp();
  }
  await ensureProject(await ensureToken());
  const profiles = Object.entries(QUALITY_PROFILES).map(([language, name]) => `${language}: ${name}`).join(', ');
  console.log(`SonarQube ready at ${HOST} (project ${PROJECT_KEY}; ${profiles}).`);
}

function tokenEnv() {
  const { token } = readState();
  if (!token) throw new CannotEvaluate('No token yet. Run `node tools/sonar/sonar.mjs up` first.');
  return { ...process.env, SONAR_TOKEN: token, SONAR_HOST_URL: HOST };
}

function scan() {
  const wrapper = isWindows ? 'mvnw.cmd' : './mvnw';
  const maven = existsSync(path.join(repoRoot, isWindows ? 'mvnw.cmd' : 'mvnw')) ? wrapper : 'mvn';
  const status = run(maven, ['-B', 'clean', 'verify', SCANNER, `-Dsonar.host.url=${HOST}`, `-Dsonar.projectKey=${PROJECT_KEY}`], {
    shell: isWindows,
    env: tokenEnv(),
  });
  if (status !== 0) throw new CannotEvaluate(`The build or analysis failed (exit ${status}); fix the build first.`);
}

function check() {
  return run('node', [checkScript, PROJECT_KEY], { env: tokenEnv() });
}

async function status() {
  const server = await serverStatus();
  const { token } = readState();
  const tokenState = !token ? 'none' : server === 'UP' ? ((await isValid(`${token}:`)) ? 'valid' : 'invalid') : 'unknown';
  console.log(`server: ${server} at ${HOST}   token: ${tokenState}`);
}

const commands = {
  up,
  scan,
  check: () => process.exit(check()),
  gate: async () => {
    await up();
    scan();
    process.exit(check());
  },
  status,
  down: () => process.exit(compose('down')),
  reset: () => {
    const code = compose('down', '-v');
    rmSync(stateDir, { recursive: true, force: true });
    process.exit(code);
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.error('Usage: node tools/sonar/sonar.mjs <gate|up|scan|check|status|down|reset>');
  process.exit(2);
}
try {
  await command();
} catch (error) {
  console.error(error instanceof CannotEvaluate ? error.message : error.stack);
  process.exit(2);
}
