# Tributary

Embeddable Java 21 library that federates MCP servers of mixed protocol versions behind one MCP 2026-07-28 endpoint. Maven multi-module; parent `pom.xml`, Phase 0 work in `tributary-spike`.

- Design: `docs/Tributary - Scope & Architecture.md` (source of truth, ADR-001 at the end).
- Plan: `docs/roadmap.smd`. Read `.smd` files with the semantic-markdown-reader skill, never whole. Its "Rules for following this roadmap" section binds every agent.
- `docs/` is git-ignored (roadmap Q10): ADRs and evidence stay local until the user decides otherwise.
- `delivery/` is committed and business-facing: one feature record per roadmap task and one release record per version (`.smd` source, generated `.md` beside it, index in `delivery/README.md`). The Delivery pages workflow publishes them to GitHub Pages from `main`. See the `delivery-docs` skill.

## Delivery team

| Agent | Role |
| --- | --- |
| `coder` | Implements one task per branch, keeps CI and GitHub security green, hands finished PRs to QA |
| `tester` | Verifies PRs independently against requirements and the zero-issue SonarQube bar; returns PASS or FAIL |
| `architect` | Decides architecture-level questions with the minimal sound solution; consulted by the coder |
| `release` | Cuts `release/X.Y` branches, picks the SemVer bump, verifies gates, prepares tags and release notes |

The main session orchestrates with the `deliver-feature` skill (`/deliver-feature <task id>`, or no argument to work through the roadmap): coder → tester → (fix loop) → squash-merge to `main` → roadmap check-off with evidence → release on request. The implement–verify–merge loop runs in the delivery harness (`tools/harness/deliver.mjs`), which drives the agents headless in their own git worktree and merges only on a QA PASS for the exact PR head with green CI, after marking the feature record delivered. Shared skills: `java-standards`, `quality-gates`, `mcp-protocol`, `delivery-docs`.

Guardrails: `.claude/hooks/guard.mjs` runs before every Bash, Edit and Write call (project `settings.json` for everyone, plus role rules in the coder and tester frontmatter). It blocks commits and pushes to `main`, force pushes, `--no-verify`, `NOSONAR` and Sonar exclusions; the coder cannot merge, tag or commit to `release/*`; the tester cannot change history or write outside `target/`, `docs/validation/` and its memory in `.claude/agent-memory/`. The GitHub ruleset is the real enforcement; the hook catches mistakes locally.

## Rules for every session

- Branches: `feat|fix|ci|chore|docs|test/<task-id>-<slug>` from `main`; `release/X.Y` for releases. No direct commits to `main` or `release/*`.
- Conventional Commits; incompatible changes use `!` and a `BREAKING CHANGE:` footer.
- A PR merges only with a tester PASS on its current head and every gate at zero (see the quality-gates skill). The one commit allowed on top of the tested head is the one that marks the feature record delivered, touching only `delivery/`.
- Repository settings, tags, GitHub releases and anything published need the user's explicit go.
- Never weaken a gate to pass it (suppressions, exclusions, disabled tests, profile changes).
- Comments on `.smd` documents are tagged with the authoring agent: `--by @coder`, `@tester`, `@architect`, `@release`, or `@claude` for the main session.

## Commands

```bash
./mvnw -B clean verify                       # build and test (mvn until the wrapper exists)
node tools/sonar/sonar.mjs gate              # start local SonarQube (Docker) if needed, build, analyze, check zero issues
node tools/sonar/sonar.mjs down              # stop it when done (data kept)
node tools/harness/deliver.mjs <task-id>     # coder → tester → merge for one roadmap task, unattended
node tools/harness/deliver.mjs smoke         # check the harness setup with one cheap real agent run
node tools/harness/test/run-tests.mjs        # harness routing tests (stubbed agents and GitHub)
node .claude/skills/delivery-docs/scripts/docs.mjs list   # every feature's state and progress
```
