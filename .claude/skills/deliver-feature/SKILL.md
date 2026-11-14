---
name: deliver-feature
description: Orchestrates the Tributary delivery flow across the coder, tester, architect and release agents — branch, implement, QA loop, merge to main, and release. Use when the user asks to implement, deliver or ship a roadmap task or feature (for example "/deliver-feature T01-3"), or to run a release.
argument-hint: <roadmap task id | feature description | release>
---

# Deliver a feature

You are the orchestrator in the main session. The agents do the work; you route their handoffs, keep the user informed, and own the decisions that are the user's. Each agent's definition in `.claude/agents/` holds its full procedure — don't repeat it in prompts, pass the context it needs.

Task: $ARGUMENTS

## 1. Frame the task

- Resolve the task id in `docs/roadmap.smd` (semantic-markdown-reader). If the request matches no task, ask the user for one or for permission to add it; the roadmap forbids unlisted work.
- Check its dependencies and the open questions that gate it. If a gating question is open, tell the user and stop.
- If `.github/workflows/ci.yml` is missing, the CI bootstrap goes first; tell the user before starting the requested task.

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

## 5. Release (only when asked)

When the user asks to release, or several merged tasks complete a roadmap release, spawn `release`. Relay its `READY FOR APPROVAL` summary to the user verbatim, and only when the user approves that version in this conversation, resume the release agent to push the tag and create the draft GitHub release. Publishing the draft and any Maven Central deployment stay with the user.

## Reporting

After each handoff, tell the user in one or two lines where things stand: which agent ran, the verdict, the PR link, and what happens next.
