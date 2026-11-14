# Tributary

Embeddable Java 21 library that federates MCP servers of mixed protocol versions behind one MCP 2026-07-28 endpoint. Maven multi-module; parent `pom.xml`, Phase 0 work in `tributary-spike`.

- Design: `docs/Tributary - Scope & Architecture.md` (source of truth, ADR-001 at the end).
- Plan: `docs/roadmap.smd`. Read `.smd` files with the semantic-markdown-reader skill, never whole. Its "Rules for following this roadmap" section binds every agent.
- `docs/` is git-ignored (roadmap Q10): ADRs and evidence stay local until the user decides otherwise.

## Delivery team

| Agent | Role |
| --- | --- |
| `coder` | Implements one task per branch, keeps CI and GitHub security green, hands finished PRs to QA |
| `tester` | Verifies PRs independently against requirements and the zero-issue SonarQube bar; returns PASS or FAIL |
| `architect` | Decides architecture-level questions with the minimal sound solution; consulted by the coder |
| `release` | Cuts `release/X.Y` branches, picks the SemVer bump, verifies gates, prepares tags and release notes |

The main session orchestrates with the `deliver-feature` skill (`/deliver-feature <task id>`): coder → tester → (fix loop) → squash-merge to `main` → roadmap check-off with evidence → release on request. Shared skills: `java-standards`, `quality-gates`, `mcp-protocol`.

Guardrails: `.claude/hooks/guard.mjs` runs before every Bash, Edit and Write call (project `settings.json` for everyone, plus role rules in the coder and tester frontmatter). It blocks commits and pushes to `main`, force pushes, `--no-verify`, `NOSONAR` and Sonar exclusions; the coder cannot merge, tag or commit to `release/*`; the tester cannot change history or write outside `target/` and `docs/validation/`. The GitHub ruleset is the real enforcement; the hook catches mistakes locally.

## Rules for every session

- Branches: `feat|fix|ci|chore|docs|test/<task-id>-<slug>` from `main`; `release/X.Y` for releases. No direct commits to `main` or `release/*`.
- Conventional Commits; incompatible changes use `!` and a `BREAKING CHANGE:` footer.
- A PR merges only with a tester PASS on its current head and every gate at zero (see the quality-gates skill).
- Repository settings, tags, GitHub releases and anything published need the user's explicit go.
- Never weaken a gate to pass it (suppressions, exclusions, disabled tests, profile changes).
- Comments on `.smd` documents are tagged with the authoring agent: `--by @coder`, `@tester`, `@architect`, `@release`, or `@claude` for the main session.

## Commands

```bash
./mvnw -B clean verify                       # build and test (mvn until the wrapper exists)
node .claude/skills/quality-gates/scripts/check-sonar.mjs tributary   # after a Sonar scan; needs SONAR_TOKEN
```
