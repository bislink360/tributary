---
name: quality-gates
description: Exact commands and pass criteria for Tributary's quality gates — local Maven build, local SonarQube analysis (zero issues, duplications and hotspots), GitHub CI checks, and GitHub security alerts (code scanning, Dependabot, secret scanning, dependency review). Use whenever you need to prove a branch, PR or release commit meets the bar.
---

# Quality gates

Every gate is pass or fail on evidence from the current commit. Use `./mvnw` once the Maven Wrapper exists, `mvn` before that. Run commands from the repository root in Git Bash.

| Gate | Pass means |
| --- | --- |
| Build | `./mvnw -B clean verify` exits 0 with no test skipped or disabled by the change |
| SonarQube | 0 open issues (bugs, vulnerabilities, code smells), 0 duplicated lines, 0 hotspots to review |
| CI | every check on the PR or commit concluded `success` (or `skipped` by design) |
| Security | 0 open code-scanning alerts on the ref, dependency review passed, 0 open Dependabot alerts, 0 open secret-scanning alerts |

## SonarQube (local)

The project runs its own SonarQube in Docker (`tools/sonar/compose.yaml`, `http://127.0.0.1:9001`, project key `tributary`). One command starts it when needed, provisions it, builds, analyzes and checks:

```bash
node tools/sonar/sonar.mjs gate      # exit 0 pass, 1 gate failed, 2 could not evaluate
```

Other commands: `up` (start and provision only), `scan`, `check` (re-evaluate the last analysis), `status`, `down` (stop, keep data), `reset` (delete data and credentials, then the next `up` provisions from scratch).

- The first `up` takes about a minute. The script generates the admin password and an analysis token itself and keeps them in `tools/sonar/.state/` (git-ignored). Never read, print or copy that file; the script passes the token to Maven and the check through the environment.
- Java is analyzed with the built-in **Sonar way comprehensive** profile, assigned on every `up`. The server's default profile misses basics (empty catch blocks, `System.out`, unused fields, commented-out code), so it would let code smells through.
- Exit 2 means the gate could not run (Docker not running, the build failed, the server did not start). Report it; never treat it as a pass. If the script says the server holds credentials it does not have, run `reset`.
- The server is Community Edition, which keeps one branch per project: each analysis replaces the previous one. That is intended — the gate judges the commit you just analyzed, on its overall code, not only new code.
- Leave the server running between agents in one delivery run; the orchestrator stops it with `down` when the run ends.

The check prints the counts and every open issue and hotspot with file and line. It also lists issues marked false positive or accepted: each needs a justification cited in the PR, or it is a finding.

Fix the code; never pass the gate by suppression, exclusion, resolving issues in the UI, or changing the quality profile or gate.

## CI

```bash
gh pr checks <pr>                       # state of every check on the PR
gh pr checks <pr> --watch --fail-fast   # block until checks finish; run in the background
gh run list --branch <branch> --limit 5
gh run view <run-id> --log-failed       # read the failure before changing anything
```

For a commit without a PR (a release branch): `gh run list --commit <sha>`.

## GitHub security

Repository `bislink360/tributary`. For a PR, the code-scanning ref is `refs/pull/<pr>/merge`; for a branch, `refs/heads/<branch>`.

```bash
gh api repos/bislink360/tributary/code-scanning/alerts -X GET -f state=open -f ref=refs/pull/<pr>/merge --jq length
gh api repos/bislink360/tributary/dependabot/alerts -X GET -f state=open --jq length
gh api repos/bislink360/tributary/secret-scanning/alerts -X GET -f state=open --jq length
```

Keep this exact form (`-X GET -f`, no quotes): it matches the project's permission allowlist, so it runs without a prompt.

Each must print `0`. Dependency review is one of the PR checks. To see details, drop `--jq length` and read `rule.description`, `most_recent_instance.location` and `html_url`.

Responses that are not zero but not alerts either:

- `no analysis found` — CodeQL has not run on that ref yet; wait for the CodeQL check, then retry. If CodeQL is not configured, the gate fails: the CI bootstrap is missing.
- `Secret scanning is disabled` — the gate cannot be evaluated; report it as needing the user to enable secret scanning. Do not treat it as a pass.
- A permission error — report the missing `gh` scope; do not treat it as a pass.
