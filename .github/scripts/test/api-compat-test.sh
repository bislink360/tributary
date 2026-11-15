#!/usr/bin/env bash
# Proves that api-compat.sh fails on an undeclared incompatible change and only reports a
# declared one. Works on a throwaway copy of the working tree with its own git history; nothing
# is pushed. The baseline is a commit with a test-only version (0.0.0-test), passed through
# API_COMPAT_BASELINE_REF so the test needs no release tag.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
sandbox="$(mktemp -d)"
trap 'rm -rf "${sandbox}"' EXIT

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

# Runs the check against the baseline commit, without PR context unless the caller passes
# PR_TITLE/PR_BODY assignments; prints the exit code.
run_check() {
  local log="$1"
  shift
  local status=0
  (cd "${sandbox}" && env -u PR_TITLE -u PR_BODY API_COMPAT_BASELINE_REF="${baseline}" "$@" \
    bash .github/scripts/api-compat.sh) >"${log}" 2>&1 || status=$?
  echo "${status}"
}

reports_removed_method() {
  grep -rqs "METHOD_REMOVED" "${sandbox}/api-compat-probe/target/japicmp/"
}

# Sandbox: the working tree plus a published probe module, released as 0.0.0-test.
(cd "${repo_root}" && git ls-files -co --exclude-standard -z | xargs -0 tar -cf - --) |
  tar -xf - -C "${sandbox}"
git -C "${sandbox}" init -q
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
baseline="$(git -C "${sandbox}" rev-parse HEAD)"
set_version "0.0.0-test" "0.0.1-test-SNAPSHOT"
commit "chore: next development version"

# 1. Undeclared break: removing a public method must fail the check.
write_api
commit "feat: remove a"
status="$(run_check "${sandbox}/undeclared.log")"
if [[ "${status}" != "0" ]] && reports_removed_method; then
  pass "undeclared break fails the check (exit ${status})"
else
  fail "undeclared break must fail the check (exit ${status})"
  tail -n 30 "${sandbox}/undeclared.log"
fi

# 2. Break declared with '!' in the commit header: reported, not failed.
amend "feat!: remove a"
status="$(run_check "${sandbox}/declared-header.log")"
if [[ "${status}" == "0" ]] && reports_removed_method && grep -q "report only" "${sandbox}/declared-header.log"; then
  pass "break declared with '!' is reported, not failed"
else
  fail "break declared with '!' must pass and report (exit ${status})"
  tail -n 30 "${sandbox}/declared-header.log"
fi

# 3. Break declared with a BREAKING CHANGE footer in the pull request body: reported, not failed.
amend "Merge pull request head into base"
status="$(run_check "${sandbox}/declared-pr.log" PR_TITLE="feat: remove a" PR_BODY=$'Removes a.\n\nBREAKING CHANGE: a removed')"
if [[ "${status}" == "0" ]] && reports_removed_method; then
  pass "break declared in the pull request body is reported, not failed"
else
  fail "break declared in the pull request body must pass (exit ${status})"
  tail -n 30 "${sandbox}/declared-pr.log"
fi

# 4. Compatible change: adding a method passes.
write_api a b
amend "feat: add b"
status="$(run_check "${sandbox}/compatible.log")"
if [[ "${status}" == "0" ]]; then
  pass "compatible change passes"
else
  fail "compatible change must pass (exit ${status})"
  tail -n 30 "${sandbox}/compatible.log"
fi

if ((failures > 0)); then
  echo "${failures} API compatibility case(s) failed."
  exit 1
fi
echo "All API compatibility cases passed."
