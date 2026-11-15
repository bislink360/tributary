#!/usr/bin/env bash
# Compares every published module with the latest v* release (japicmp).
# The baseline is built from its tag, so the check does not depend on any artifact repository.
# Until a first release exists there is nothing to compare with, and the check is skipped.
set -euo pipefail

baseline_tag="$(git tag --list 'v*' --sort=-v:refname | head -n 1)"
if [[ -z "${baseline_tag}" ]]; then
  echo "API compatibility: no v* release tag exists yet, so there is no baseline. Check skipped."
  exit 0
fi

baseline_dir="$(mktemp -d)"
trap 'git worktree remove --force "${baseline_dir}"' EXIT
git worktree add --detach "${baseline_dir}" "${baseline_tag}"

baseline_version="$(cd "${baseline_dir}" && ./mvnw -B -q help:evaluate -Dexpression=project.version -DforceStdout)"
echo "API compatibility: comparing with ${baseline_tag} (version ${baseline_version})."
(cd "${baseline_dir}" && ./mvnw -B -q install -DskipTests)

./mvnw -B verify -DskipTests "-Djapicmp.baseline=${baseline_version}"
