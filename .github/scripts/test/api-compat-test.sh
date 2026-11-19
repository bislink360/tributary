#!/usr/bin/env bash
# Proves that api-compat.sh fails on an undeclared incompatible change and only reports a
# declared one. Works on a throwaway copy of the working tree with its own git history; nothing
# is pushed. The baseline is a commit with a test-only version (0.0.0-test), passed through
# API_COMPAT_BASELINE_REF so the test needs no release tag.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
sandbox="$(mktemp -d)"

# The baseline install writes test-only artifacts to the local Maven repository; remove them on exit.
# Quiet mode prints Maven's errors on stdout, where the substitution would hide them; show them.
if ! local_repo="$(cd "${repo_root}" && ./mvnw -B -q help:evaluate -Dexpression=settings.localRepository -DforceStdout)"; then
  echo "Maven could not evaluate settings.localRepository:" >&2
  echo "${local_repo}" >&2
  exit 1
fi
if command -v cygpath >/dev/null; then local_repo="$(cygpath -u "${local_repo}")"; fi
test_artifacts=(
  "${local_repo}/com/bislink360/tributary/0.0.0-test"
  "${local_repo}/com/bislink360/tributary-spike/0.0.0-test"
  "${local_repo}/com/bislink360/api-compat-probe"
)
cleanup() {
  rm -rf "${sandbox}" "${test_artifacts[@]}"
}
trap cleanup EXIT

failures=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

# Writes the probe API with the given public methods, formatted as google-java-format expects.
write_api() {
  local file="${sandbox}/api-compat-probe/src/main/java/probe/Api.java"
  mkdir -p "$(dirname "${file}")"
  if (($# == 0)); then
    printf 'package probe;\n\npublic class Api {}\n' >"${file}"
    return
  fi
  local separator=""
  {
    printf 'package probe;\n\npublic class Api {\n'
    for name in "$@"; do
      printf '%s  public int %s() {\n    return 1;\n  }\n' "${separator}" "${name}"
      separator=$'\n'
    done
    printf '}\n'
  } >"${file}"
}

set_version() {
  sed -i "s|<version>$1</version>|<version>$2</version>|" \
    "${sandbox}/pom.xml" "${sandbox}/tributary-spike/pom.xml" "${sandbox}/api-compat-probe/pom.xml"
}

commit() {
  git -C "${sandbox}" add -A
  git -C "${sandbox}" commit -q -m "$1"
}

amend() {
  git -C "${sandbox}" add -A
  git -C "${sandbox}" commit -q --amend -m "$1"
}

switch_to() {
  git -C "${sandbox}" switch -q -c "$1" "$2"
}

head_sha() {
  git -C "${sandbox}" rev-parse HEAD
}

# Runs the check against the baseline commit as a push (no PR context) unless the caller passes
# PR_TITLE, PR_BODY or BASE_SHA assignments; prints the exit code.
run_check() {
  local log="$1"
  shift
  local status=0
  (cd "${sandbox}" && env -u PR_TITLE -u PR_BODY -u BASE_SHA API_COMPAT_BASELINE_REF="${baseline}" "$@" \
    bash .github/scripts/api-compat.sh) >"${log}" 2>&1 || status=$?
  echo "${status}"
}

# expect <passes|fails> <case name> [assignments...]: runs the check and records the result.
expect() {
  local expected="$1" name="$2"
  shift 2
  local log="${sandbox}/case.log"
  local status
  status="$(run_check "${log}" "$@")"
  if [[ "${expected}" == "passes" && "${status}" == "0" ]] || [[ "${expected}" == "fails" && "${status}" != "0" ]]; then
    pass "${name} (exit ${status})"
  else
    fail "${name}: expected the check ${expected} (exit ${status})"
    tail -n 30 "${log}"
  fi
}

expect_removed_method_reported() {
  if grep -rqs "METHOD_REMOVED" "${sandbox}/api-compat-probe/target/japicmp/"; then
    pass "$1: the report lists the removed method"
  else
    fail "$1: the report must list the removed method"
  fi
}

# Sandbox: the working tree plus a published probe module, released as 0.0.0-test.
(cd "${repo_root}" && git ls-files -co --exclude-standard -z | xargs -0 tar -cf - --) |
  tar -xf - -C "${sandbox}"
git -C "${sandbox}" init -q -b main
git -C "${sandbox}" config core.autocrlf false
git -C "${sandbox}" config user.name "api-compat test"
git -C "${sandbox}" config user.email "api-compat-test@invalid"
mkdir -p "${sandbox}/api-compat-probe"
sed -e 's|<artifactId>tributary-spike</artifactId>|<artifactId>api-compat-probe</artifactId>|' \
  -e 's|<api-compat.skip>true</api-compat.skip>|<api-compat.skip>false</api-compat.skip>|' \
  "${sandbox}/tributary-spike/pom.xml" >"${sandbox}/api-compat-probe/pom.xml"
sed -i 's|<module>tributary-spike</module>|<module>tributary-spike</module><module>api-compat-probe</module>|' \
  "${sandbox}/pom.xml"
write_api a
set_version "1.0-SNAPSHOT" "0.0.0-test"
commit "chore: release 0.0.0-test"
baseline="$(head_sha)"
set_version "0.0.0-test" "0.0.1-test-SNAPSHOT"
commit "chore: next development version"
development="$(head_sha)"

# 1. Undeclared break pushed: removing a public method fails the check.
switch_to undeclared "${development}"
write_api
commit "feat: remove a"
expect fails "1. undeclared break"
expect_removed_method_reported "1. undeclared break"

# 2. Break declared with '!' in the pushed commit header: reported, not failed.
amend "feat!: remove a"
expect passes "2. break declared with '!'"
expect_removed_method_reported "2. break declared with '!'"
grep -q "report only" "${sandbox}/case.log" && pass "2. says the break is report only" ||
  fail "2. must say the break is report only"

# 3. Break declared with a BREAKING CHANGE footer in the pull request body: reported, not failed.
amend "Merge pull request head into base"
expect passes "3. break declared in the pull request body" \
  PR_TITLE="feat: remove a" PR_BODY=$'Removes a.\n\nBREAKING CHANGE: a removed' BASE_SHA="${development}"
expect_removed_method_reported "3. break declared in the pull request body"

# 4. Compatible change: adding a method passes.
switch_to compatible "${development}"
write_api a b
commit "feat: add b"
expect passes "4. compatible change"

# 5. A declared break merged since the release, then a compatible change pushed: passes.
switch_to after-declared-break "${development}"
write_api
commit "feat!: remove a"
write_api b
commit "feat: add b"
expect passes "5. compatible push after a declared break merged"

# 6. Same history, a compatible pull request on top of it: passes.
base="$(head_sha)"
write_api b c
commit "Merge pull request head into base"
expect passes "6. compatible pull request after a declared break merged" \
  PR_TITLE="feat: add c" PR_BODY="Adds c." BASE_SHA="${base}"

# 7. A '!' only on a pull request branch commit does not count: squash merge discards it.
switch_to branch-commit-only "${development}"
write_api
commit "feat!: remove a"
expect fails "7. break declared only in a branch commit" \
  PR_TITLE="feat: remove a" PR_BODY="Removes a." BASE_SHA="${development}"

if ((failures > 0)); then
  echo "${failures} API compatibility check(s) failed."
  exit 1
fi
echo "All API compatibility cases passed."
