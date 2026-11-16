#!/usr/bin/env bash
# Compares every published module with the latest v* release (japicmp).
#
# Any binary or source incompatibility fails the check unless a Conventional Commits breaking
# change is declared: '!' in the header or a 'BREAKING CHANGE:' footer. A declared break is
# reported only, and the release agent versions from it.
#
# A break counts as declared when it is declared in this change or anywhere since the baseline,
# because the release will then be a breaking bump anyway. Only text that lands on the base
# branch counts:
#   pull requests (PR_TITLE set): the PR title and body, and the commit messages from the
#     baseline to the PR base (BASE_SHA, else the first parent of the merge checkout). The PR's
#     own branch commits do not count: squash merge discards them.
#   pushes: the commit messages from the baseline to HEAD (squash commits keep the marker).
#
# The baseline is built from its tag, so the check does not depend on any artifact repository.
# API_COMPAT_BASELINE_REF names another baseline commit (used by the tests). Until a first
# release exists there is nothing to compare with, and the check is skipped.
set -euo pipefail

# Reads one change description on stdin: a header line, then an optional body with footers.
is_breaking_description() {
  local description
  description="$(tr -d '\r')"
  head -n 1 <<<"${description}" | grep -Eq '^[a-z]+(\([^)]*\))?!:' ||
    grep -Eq '^BREAKING[ -]CHANGE:' <<<"${description}"
}

# True when a commit after the baseline, up to and including $1, declares a break.
commits_declare_break() {
  local commit
  for commit in $(git rev-list "${baseline_ref}..$1"); do
    if git log -1 --format=%B "${commit}" | is_breaking_description; then
      return 0
    fi
  done
  return 1
}

declares_breaking_change() {
  if [[ -n "${PR_TITLE:-}" ]]; then
    printf '%s\n%s\n' "${PR_TITLE}" "${PR_BODY:-}" | is_breaking_description ||
      commits_declare_break "${BASE_SHA:-HEAD^1}"
  else
    commits_declare_break HEAD
  fi
}

baseline_ref="${API_COMPAT_BASELINE_REF:-$(git tag --list 'v*' --sort=-v:refname | head -n 1)}"
if [[ -z "${baseline_ref}" ]]; then
  echo "API compatibility: no v* release tag exists yet, so there is no baseline. Check skipped."
  exit 0
fi

baseline_dir="$(mktemp -d)"
trap 'git worktree remove --force "${baseline_dir}"' EXIT
git worktree add --detach "${baseline_dir}" "${baseline_ref}"

baseline_version="$(cd "${baseline_dir}" && ./mvnw -B -q help:evaluate -Dexpression=project.version -DforceStdout)"
echo "API compatibility: comparing with ${baseline_ref} (version ${baseline_version})."
(cd "${baseline_dir}" && ./mvnw -B -q install -DskipTests)

break_on_incompatibility=true
if declares_breaking_change; then
  echo "API compatibility: a breaking change is declared in this change or since the baseline, so incompatibilities are report only."
  break_on_incompatibility=false
fi

./mvnw -B verify -DskipTests "-Djapicmp.baseline=${baseline_version}" "-Dapi-compat.break=${break_on_incompatibility}"
