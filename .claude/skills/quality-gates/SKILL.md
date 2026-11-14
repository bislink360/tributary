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

Server: `http://127.0.0.1:9000`, project key `tributary`. The token comes from the `SONAR_TOKEN` environment variable; never write a token into a file, command line or comment. If `SONAR_TOKEN` is unset, stop and ask for it to be set — do not skip the gate.

The server is Community Edition, which keeps one branch per project: each analysis replaces the previous one. That is intended — the gate judges the commit you just analyzed, on its overall code, not only new code.

```bash
./mvnw -B clean verify org.sonarsource.scanner.maven:sonar-maven-plugin:sonar \
  -Dsonar.host.url=http://127.0.0.1:9000 -Dsonar.projectKey=tributary
node .claude/skills/quality-gates/scripts/check-sonar.mjs tributary
```

The script waits for the server to finish processing the analysis, then prints the counts and every open issue and hotspot with file and line, and exits non-zero if any count is above zero. It also lists issues marked false positive or accepted: each needs a justification cited in the PR, or it is a finding.

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
gh api "repos/bislink360/tributary/code-scanning/alerts?state=open&ref=refs/pull/<pr>/merge" --jq length
gh api "repos/bislink360/tributary/dependabot/alerts?state=open" --jq length
gh api "repos/bislink360/tributary/secret-scanning/alerts?state=open" --jq length
```

Each must print `0`. Dependency review is one of the PR checks. To see details, drop `--jq length` and read `rule.description`, `most_recent_instance.location` and `html_url`.

Responses that are not zero but not alerts either:

- `no analysis found` — CodeQL has not run on that ref yet; wait for the CodeQL check, then retry. If CodeQL is not configured, the gate fails: the CI bootstrap is missing.
- `Secret scanning is disabled` — the gate cannot be evaluated; report it as needing the user to enable secret scanning. Do not treat it as a pass.
- A permission error — report the missing `gh` scope; do not treat it as a pass.
