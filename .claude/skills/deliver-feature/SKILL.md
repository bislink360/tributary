---
name: deliver-feature
description: Orchestrates the Tributary delivery flow across the coder, tester, architect and release agents — pick the next roadmap task, branch, implement, QA loop, merge to main, and release. Use when the user asks to implement, deliver or ship a roadmap task or feature (for example "/deliver-feature T01-3"), to "work through the roadmap" or "pick up the next task" (no argument), or to run a release.
argument-hint: "[roadmap task id | release]  (empty: work through the next unblocked tasks)"
---

# Deliver a feature

You are the orchestrator in the main session. The agents do the work; you route their handoffs, keep the user informed, and own the decisions that are the user's. Each agent's definition in `.claude/agents/` holds its full procedure — don't repeat it in prompts, pass the context it needs.

Arguments: $ARGUMENTS

- A task id: deliver that one task, then stop.
- `release`: go to step 5.
- Empty: run in **continuous mode** — pick the next task (step 0), deliver it, and repeat until a stop condition.

## 0. Pick the next task (continuous mode)

```bash
node .claude/skills/semantic-markdown-reader/scripts/smd.cjs tasks docs/roadmap.smd --order deps --json
```

From that list, the next task is the first one that passes every check, in this order:

1. **Not blocked.** Its `blocked` list is empty. An open question in `depends` (Q1…Q11) blocks it until the user answers.
2. **Current phase.** The roadmap's sections are its phase order, and the tool does not encode it. Take tasks only from the earliest section that still has open tasks, skipping the "Milestones" and "Definition of done" sections, whose items are outcomes rather than work. A later phase starts only once the previous phase's gate has evidence in `docs/validation/` and the user has confirmed it. All 0.1 work also waits for Q1 = GO.
3. **Not already in flight.** No open PR or remote branch carries its id: `gh pr list --state open --search "<id>"` and `git ls-remote --heads origin "*<id>*"`. If one exists, resume that work (go to step 3 if the PR is ready for QA, otherwise step 2 with the existing branch) instead of starting fresh.
4. **Agent-deliverable.** Classify the task by what it produces:
   - **Code or tests** → steps 1–4.
   - **Research or a written record** with no code (such as "re-read the release notes and record…") → spawn `architect` to research and write the record under `docs/validation/<id>.md`, show it to the user, and check the task off only after the user accepts it.
   - **A decision, an ADR freeze, or publishing** ("Decide…", "Record the … choice as a decision", "Freeze…", "Publish…") → spawn `architect` for a recommendation, present it, and stop: the user decides.

Before the first task of a run, check the local working tree. If it holds uncommitted work that touches the task's area (for example, files the task would create), stop and ask the user how to handle it rather than building a second version beside it.

### Stop conditions

Stop the loop and report to the user when any of these holds:

- the next task needs a user decision, answer or approval (including the "Needs user approval" items of a handoff);
- the current phase has no open agent-deliverable task left, so its gate is ready for the user's review;
- every remaining task is blocked;
- a gate cannot be evaluated (for example `node tools/sonar/sonar.mjs gate` exits 2 because Docker is not running, or a GitHub security feature is disabled);
- three FAIL rounds on one PR;
- the user asked for a fixed number of tasks and that many are done.

When you stop, run `node tools/sonar/sonar.mjs down` to free the local SonarQube, then say what was delivered in this run (task ids with PR links), why you stopped, and exactly what the user needs to do to unblock the next task.

## 1. Frame the task

- Resolve the task id in `docs/roadmap.smd` (semantic-markdown-reader). If the request matches no task, ask the user for one or for permission to add it; the roadmap forbids unlisted work.
- Check its dependencies and the open questions that gate it. If a gating question is open, tell the user and stop.
- If `.github/workflows/ci.yml` is missing, the CI bootstrap goes first; tell the user before starting the requested task.

## Steps 2–4 through the harness (default)

For a code task, run the implement → verify → merge loop with the delivery harness instead of spawning the agents yourself. It runs the coder and tester headless in their own git worktree (your checkout is never touched), routes FAIL reports back to the coder with sessions resumed, re-tests when the PR head moves, and merges only when QA passed on the exact head and every CI check is green. It also does the roadmap check-off from step 4.

```bash
node tools/harness/deliver.mjs <task-id>        # run in the background; it can take a long time
```

Options: `--max-rounds <n>` (default 3), `--budget-usd <n>` per agent run, `--no-merge` (stop at PASS), `--allow-no-checks` (only for the PR that sets up CI), `--base <ref>`. Its log names each step, and `<repo>-worktrees/.runs/<task-id>/` keeps every agent's raw output.

Act on its exit code:

| Exit | Meaning | What you do |
| --- | --- | --- |
| 0 | Merged (or passed with `--no-merge`) | Report the PR; in continuous mode, pick the next task |
| 3 | Needs a person (coder blocked, tester could not evaluate, no CI, PR closed) | Show the reason and any "needs your approval" lines; stop |
| 4 | QA did not converge | Show the last QA report from the PR; stop |
| 2 | Error | Show the error and the run folder; stop |

Re-running the same command resumes: it finds the open PR and the stored agent sessions. Use the manual steps 2–4 below only when the user wants to watch each handoff in this conversation, or when the harness cannot run.

## 2. Implement

Spawn `coder` with the task id, the user's request in their words, and anything already decided in this conversation. The coder may consult `architect` on its own.

- `HANDOFF → tester`: continue to step 3. Show the user any "Needs user approval" items now, with the exact commands, and run them only if the user says yes.
- `BLOCKED` on a user decision: present the decision and the architect's recommendation to the user, wait, then resume the same coder with `SendMessage` (keep its context; don't start a new one).

## 3. Verify

Spawn `tester` with the PR number and task id only — not the coder's reasoning — so the verification stays independent.

- `FAIL`: resume the same coder with `SendMessage`, passing the full QA report. When it hands back, resume the same tester with `SendMessage` for the next round.
- After three FAIL rounds on the same PR, stop and show the user the open findings; the loop is not converging.
- `PASS`: continue.

## 4. Merge

With a QA PASS on the PR's current head and all checks green:

```bash
gh pr merge <pr> --squash --delete-branch
```

Use a squash commit whose subject is the PR's Conventional Commit title, keeping `!` and the `BREAKING CHANGE:` footer when present. Then tell the user what merged.

Then record progress in the roadmap (local file, `docs/` is git-ignored):

1. Check that `docs/validation/<task-id>.md` exists and lists reproduction commands. If it doesn't, leave the task open and say why.
2. Change the task's `- [ ]` to `- [x]` in `docs/roadmap.smd`, touching nothing else on the line.
3. `node .claude/skills/semantic-markdown-reader/scripts/smd.cjs review comment docs/roadmap.smd <task-id> --by @claude --title "Done" --text "Merged in <PR url> (<sha>). Evidence: docs/validation/<task-id>.md"`
4. `node .claude/skills/semantic-markdown-reader/scripts/smd.cjs validate docs/roadmap.smd`

Never set a requirement to implemented or verified and never answer a question: the user does both.

## 5. Release (only when asked)

When the user asks to release, or several merged tasks complete a roadmap release, spawn `release`. Relay its `READY FOR APPROVAL` summary to the user verbatim, and only when the user approves that version in this conversation, resume the release agent to push the tag and create the draft GitHub release. Publishing the draft and any Maven Central deployment stay with the user.

## Reporting

After each handoff, tell the user in one or two lines where things stand: which agent ran, the verdict, the PR link, and what happens next.
