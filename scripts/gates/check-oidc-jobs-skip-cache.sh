#!/usr/bin/env bash
# check-oidc-jobs-skip-cache.sh — jobs that can publish never touch the Actions cache.
#
# Any job on main can write a cache entry that a tag run restores, and
# `pnpm install --frozen-lockfile` trusts a restored node_modules. A job whose
# token can mint an OIDC token (id-token: write, or write-all) publishes, so it
# must not restore one.
#
# Fail conditions, per job that holds id-token: write (its own permissions:, or
# the workflow's when the job has none):
#   - the job does not set `cache-mode: none`
#   - a step uses ./.github/actions/setup without `cache: 'false'`
#   - a step uses actions/cache, actions/cache/restore or actions/cache/save
# A top-level `cache-mode: none` covers a job that sets no cache-mode of its own.
# And per workflow: one that relaxes the release-age rule does not set a
# top-level `cache-mode: none`. The rule matches minimumReleaseAge, the
# PNPM_CONFIG_MINIMUM_RELEASE_AGE variable (any case) and --config.minimum-release-age.
#
# Line-based, for this repository's layout: block-map permissions, two-space job
# keys, four-space job keys, six-space `- ` steps. It fails closed: a file with
# an id-token: write (or write-all) the scanner did not read as an OIDC job
# fails, so a layout it cannot parse never passes silently.
# It does not resolve YAML anchors, aliases or tags either, so it fails on one in a
# permissions, id-token or cache-mode value, and on any alias or merge key in a
# workflow that grants id-token: write. It also fails on a `?` explicit key and on a
# permissions, id-token or cache-mode value that is not key: value on one line.
# A flow collection that spans lines, and a double-quoted escape on those keys, fail
# too. Block scalars and quoted text are skipped; a quote opens only where a value starts.
#
# Env overrides (for tests):
#   CI_WORKFLOWS_DIR — directory of workflow yaml files
#                      (default: <repo>/.github/workflows)
#
# Usage:
#   bash scripts/gates/check-oidc-jobs-skip-cache.sh
# Self-test: bash scripts/gates/check-oidc-jobs-skip-cache.test.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_WORKFLOWS_DIR="${CI_WORKFLOWS_DIR:-${ROOT_DIR}/.github/workflows}"
for arg in "$@"; do
  echo "FAIL: unknown argument: ${arg}" >&2
  echo "Usage: $0" >&2
  exit 1
done

echo "=== OIDC jobs skip the Actions cache ==="

if [ ! -d "${CI_WORKFLOWS_DIR}" ]; then
  echo "FAIL: Workflows directory not found: ${CI_WORKFLOWS_DIR}" >&2
  exit 1
fi

# Prints "CHECKED <file> <job>" for each OIDC job and "FAIL: ..." per violation.
check_workflow() {
  awk -v file="$(basename "$1")" -v sq="'" '
    function end_step() {
      if (in_step && step_setup && !step_nocache) setup_bad[n] = 1
      in_step = 0; step_setup = 0; step_nocache = 0
    }
    function is_flow(q,    m) {
      m = q
      sub(/^[[:space:]]*(-[[:space:]]+)*/, "", m)
      return m ~ /^[[{]/ || m ~ /^[^[:space:]][^:]*:[[:space:]]+[[{]/
    }
    # Empties each quoted span, opening a quote only where a value starts, so an
    # apostrophe in plain text pairs with nothing. A quote that never closes stays.
    function mask(s, flow,    out, i, j, n, c, d, ns) {
      n = length(s); ns = 1; out = ""
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[[:space:]]/)) return out substr(s, i)
        if (ns && (c == sq || c == "\"")) {
          for (j = i + 1; j <= n; j++) {
            d = substr(s, j, 1)
            if (c == "\"" && d == "\\") { j++; continue }
            if (d != c) continue
            if (c == sq && substr(s, j + 1, 1) == sq) { j++; continue }
            break
          }
          if (j > n) return out substr(s, i)
          out = out c c; i = j; ns = 0
          continue
        }
        out = out c
        if (c ~ /[[:space:]]/) continue
        d = substr(s, i + 1, 1)
        if (c == ":" || (c == "-" && ns)) ns = (d == "" || d ~ /[[:space:]]/)
        else if (c == "," || c == "[" || c == "{") ns = flow
        else ns = 0
      }
      return out
    }
    # A node starts after "key: ", after "- ", at the start of a line, or inside a
    # flow collection; there a leading & * or ! is an anchor, alias or tag.
    function scan_node(q, bare, raw,    m, flow, t, o, c, opening, key) {
      m = q
      sub(/^[[:space:]]*(-[[:space:]]+)*/, "", m)
      flow = is_flow(q)
      key = "(^|[^-[:alnum:]_])(permissions|id-token|cache-mode)\"?[[:space:]]*:"
      if (fdepth > 0 || flow) {
        t = q; o = gsub(/[[{]/, "", t); c = gsub(/[]}]/, "", t)
        opening = (fdepth == 0)
        fdepth += o - c
        if (fdepth <= 0) { fdepth = 0; fg_done = 0 }
        else {
          if (opening && !flow_nr) flow_nr = NR
          if (!fg_done && (in_guard || bare ~ key)) {
            fg_done = 1
            print "FAIL: " file " line " NR " has a flow collection that spans lines; the gate cannot read it, so write it on one line"
          }
        }
      }
      if (raw ~ (key "[[:space:]]*\"[^\"]*\\\\") || (in_guard && raw ~ /:[[:space:]]*"[^"]*\\/)) {
        print "FAIL: " file " line " NR " has an escaped value the gate cannot read on permissions, id-token or cache-mode; write the value without escapes"
      }
      if (m ~ /^(\*|<<[[:space:]]*:)/ || m ~ /:[[:space:]]+\*/ || (flow && m ~ /[[{,:][[:space:]]*\*/)) {
        if (!alias_nr) alias_nr = NR
      }
      if ((m ~ /^[!&*]/ || m ~ /:[[:space:]]+[!&*]/ || (flow && m ~ /[[{,:][[:space:]]*[!&*]/)) && (in_guard || bare ~ /(^|[^-[:alnum:]_])(permissions|id-token|cache-mode)[[:space:]]*:[[:space:]]*[!&*]/)) {
        print "FAIL: " file " line " NR " puts a YAML anchor, alias or tag on permissions, id-token or cache-mode; write the value out"
      }
      if (m ~ /^\?([[:space:]]|$)/) print "FAIL: " file " line " NR " uses a YAML explicit key; the gate does not read explicit keys, so write the key on one line"
      if (guard_first) {
        guard_first = 0
        if (q !~ /^[[:space:]]*[^[:space:]:?&*!|>{[#-][^:]*:([[:space:]]|$)/) print "FAIL: " file " line " NR " cannot read the value of permissions, id-token or cache-mode; write it as key: value on one line"
      }
      if (m ~ /(^|:[[:space:]]+)([!&][^[:space:]]*[[:space:]]+)*[|>][-+0-9]*[[:space:]]*$/) {
        in_bs = 1; bs_ind = length(q) - length(m)
        if (bare ~ /(^|[^-[:alnum:]_])(permissions|id-token|cache-mode)[[:space:]]*:[[:space:]]*([!&][^[:space:]]*[[:space:]]+)*[|>][-+0-9]*[[:space:]]*$/) print "FAIL: " file " line " NR " cannot read the value of permissions, id-token or cache-mode; write it as key: value on one line"
      }
      if (bare ~ /^[[:space:]]*(-[[:space:]]+)*(permissions|id-token|cache-mode)[[:space:]]*:[[:space:]]*$/) {
        in_guard = 1; guard_ind = length(q) - length(m)
        if (bare ~ /(id-token|cache-mode)[[:space:]]*:[[:space:]]*$/) print "FAIL: " file " line " NR " cannot read the value of permissions, id-token or cache-mode; write it as key: value on one line"
        else guard_first = 1
      }
    }
    {
      line = $0
      sub(/(^|[[:space:]]+)#.*$/, "", line)
      gsub(sq, "", line)
      gsub(/"/, "", line)
      q = mask($0, is_flow($0))
      sub(/(^|[[:space:]]+)#.*$/, "", q)
      if (q !~ /^[[:space:]]*$/) {
        match(q, /^ */)
        if (in_bs && RLENGTH <= bs_ind) in_bs = 0
        if (in_guard && RLENGTH <= guard_ind) { in_guard = 0; guard_first = 0 }
        if (!in_bs) scan_node(q, line, $0)
      }
    }
    line ~ /^[^[:space:]]/ {
      end_step()
      in_jobs = 0; in_wf_perm = 0; in_job_perm = 0
    }
    line ~ /minimumReleaseAge/ || tolower(line) ~ /pnpm_config_minimum_release_age|--config\.minimum-release-age/ { lifts_age = 1 }
    line ~ /id-token[[:space:]]*:[[:space:]]*write([^-[:alnum:]]|$)/ || line ~ /permissions[[:space:]]*:[[:space:]]*write-all/ { raw++ }
    line ~ /^cache-mode[[:space:]]*:[[:space:]]*none$/ { wf_none = 1 }
    line ~ /^permissions[[:space:]]*:[[:space:]]*write-all$/ { wf_oidc = 1; read_oidc++ }
    line ~ /^permissions[[:space:]]*:[[:space:]]*$/ { in_wf_perm = 1; next }
    in_wf_perm && line ~ /^  id-token[[:space:]]*:[[:space:]]*write$/ { wf_oidc = 1; read_oidc++ }
    line ~ /^jobs[[:space:]]*:[[:space:]]*$/ { in_jobs = 1; next }
    !in_jobs { next }
    line ~ /^  [^[:space:]]/ { jobs_seen++ }
    line ~ /^  [A-Za-z0-9_-]+[[:space:]]*:$/ {
      end_step()
      in_job_perm = 0
      n++
      job[n] = line
      sub(/^  /, "", job[n])
      sub(/[[:space:]]*:$/, "", job[n])
      next
    }
    line ~ /^    [^[:space:]-]/ { end_step(); in_job_perm = 0 }
    line ~ /^    permissions[[:space:]]*:/ { has_perm[n] = 1 }
    line ~ /^    permissions[[:space:]]*:[[:space:]]*write-all$/ { oidc[n] = 1; read_oidc++ }
    line ~ /^    permissions[[:space:]]*:[[:space:]]*$/ { in_job_perm = 1; next }
    in_job_perm && line ~ /^      id-token[[:space:]]*:[[:space:]]*write$/ { oidc[n] = 1; read_oidc++ }
    line ~ /^    cache-mode[[:space:]]*:/ { has_cm[n] = 1 }
    line ~ /^    cache-mode[[:space:]]*:[[:space:]]*none$/ { none[n] = 1 }
    line ~ /^      - / { end_step(); in_step = 1 }
    in_step && line ~ /uses:[[:space:]]*\.\/\.github\/actions\/setup\/?$/ { step_setup = 1 }
    in_step && line ~ /^[[:space:]]+cache:[[:space:]]*false$/ { step_nocache = 1 }
    line ~ /uses:[[:space:]]*actions\/cache(\/restore|\/save)?@/ { direct[n] = 1 }
    END {
      end_step()
      if (lifts_age && !wf_none) print "FAIL: " file " mentions minimumReleaseAge but does not set top-level cache-mode: none"
      for (i = 1; i <= n; i++) {
        if (!(has_perm[i] ? oidc[i] : wf_oidc)) continue
        print "CHECKED " file " " job[i]
        if (!(none[i] || (!has_cm[i] && wf_none))) print "FAIL: " file " job " job[i] " has id-token: write but does not set cache-mode: none"
        if (setup_bad[i]) print "FAIL: " file " job " job[i] " uses ./.github/actions/setup without cache: " sq "false" sq
        if (direct[i]) print "FAIL: " file " job " job[i] " uses actions/cache directly"
      }
      if (raw > 0 && flow_nr) print "FAIL: " file " can publish and has a flow collection that spans lines at line " flow_nr "; the gate cannot read it, so write it on one line"
      if (raw > 0 && alias_nr) print "FAIL: " file " can publish and uses a YAML alias or merge key at line " alias_nr "; the gate cannot see what it brings into a job, so write it out"
      if (raw > read_oidc || (raw > 0 && (n == 0 || jobs_seen != n))) print "FAIL: " file " has id-token: write but the gate could not find the job that holds it; write permissions as a block map with 2-space job indentation"
    }
  ' "$1"
}

report=""
for wf in "${CI_WORKFLOWS_DIR}"/*.yml "${CI_WORKFLOWS_DIR}"/*.yaml; do
  [ -f "${wf}" ] || continue
  report+="$(check_workflow "${wf}")"$'\n'
done

checked="$(sed -n 's/^CHECKED /  - /p' <<< "${report}")"
failures="$(sed -n '/^FAIL: /p' <<< "${report}")"

echo "Jobs with id-token: write:"
echo "${checked:-  (none)}"

if [ -n "${failures}" ]; then
  echo "" >&2
  echo "${failures}" >&2
  echo "" >&2
  echo "A job that can publish installs fresh, and a workflow that changes the release-age rule never writes the cache. See .github/workflows/REQUIRED.md." >&2
  exit 1
fi

echo "No job with id-token: write touches the Actions cache."
exit 0
