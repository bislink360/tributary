#!/usr/bin/env bash
# Compares every published module with the latest v* release (japicmp).
#
# Any binary or source incompatibility fails the check, unless the change declares it as a
# Conventional Commits breaking change: '!' in the header or a 'BREAKING CHANGE:' footer. A
# declared break is reported only, and the release agent versions from it.
#
# The declaration is read from PR_TITLE and PR_BODY when they are set (pull requests), and from
# the last commit message otherwise (pushes after a squash merge).
#
# The baseline is built from its tag, so the check does not depend on any artifact repository.
# API_COMPAT_BASELINE_REF names another baseline commit (used by the tests). Until a first
# release exists there is nothing to compare with, and the check is skipped.
set -euo pipefail

change_description() {
  if [[ -n "${PR_TITLE:-}" ]]; then
    printf '%s\n%s\n' "${PR_TITLE}" "${PR_BODY:-}"
  else
    git log -1 --format=%B
  fi
}

declares_breaking_change() {
  local description
  description="$(change_description | tr -d '\r')"
  head -n 1 <<<"${description}" | grep -Eq '^[a-z]+(\([^)]*\))?!:' ||
    grep -Eq '^BREAKING[ -]CHANGE:' <<<"${description}"
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
  echo "API compatibility: the change declares a breaking change, so incompatibilities are report only."
  break_on_incompatibility=false
fi

./mvnw -B verify -DskipTests "-Djapicmp.baseline=${baseline_version}" "-Dapi-compat.break=${break_on_incompatibility}"
