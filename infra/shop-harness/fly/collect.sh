#!/usr/bin/env bash
# Copy one scenario's report back from a running (or held-open) harness
# machine to this repository, verified byte for byte (#166).
#
#   bash infra/shop-harness/fly/collect.sh -a <app> -m <machine-id> \
#     -s <scenario> -o <out.json>
#
# Runs only `wc -c`, `split`, `base64` and `sha256sum` through
# `fly machine exec`. Nothing else. Never uses `fly ssh` or prints a secret.
set -uo pipefail

APP=""
MACHINE=""
SCENARIO=""
OUT=""

usage() {
  cat <<'EOF' >&2
usage: collect.sh -a|--app <name> -m|--machine <id> -s|--scenario <name> -o|--out <path>
keep the machine running until this prints 'collected'. Never chain
`fly machine stop` after it in one command: a failed collect then loses the report.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -a|--app)
      [ $# -ge 2 ] || { usage; exit 2; }
      APP="$2"
      shift 2
      ;;
    -m|--machine)
      [ $# -ge 2 ] || { usage; exit 2; }
      MACHINE="$2"
      shift 2
      ;;
    -s|--scenario)
      [ $# -ge 2 ] || { usage; exit 2; }
      SCENARIO="$2"
      shift 2
      ;;
    -o|--out)
      [ $# -ge 2 ] || { usage; exit 2; }
      OUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ -z "${APP}" ] || [ -z "${MACHINE}" ] || [ -z "${SCENARIO}" ] || [ -z "${OUT}" ]; then
  usage
  exit 2
fi

# Refused before fly is ever called: a slash or a space in the scenario name
# could change what path gets read or written on the machine.
if ! [[ "${SCENARIO}" =~ ^[a-z-]+$ ]]; then
  echo "FAIL: scenario name must match ^[a-z-]+\$: ${SCENARIO}" >&2
  exit 2
fi

REPORT_PATH="/reports/${SCENARIO}.json"
# One exec answer has a size limit: a 6.7 MB cat failed where 1.8 MB passed (#173).
PART_BYTES=1000000
PART_PREFIX="/tmp/kyu-collect-${SCENARIO}.part."

# An empty stdout is left out of `--json` output, so it reads as "".
extract_stdout() {
  node -e '
let s = ""
process.stdin.on("data", (d) => { s += d })
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(s)
    const row = Array.isArray(parsed) ? parsed[0] : parsed
    if (row === null || typeof row !== "object" || (row.exit_code ?? 0) !== 0) {
      process.exit(1)
    }
    process.stdout.write(typeof row.stdout === "string" ? row.stdout : "")
  } catch {
    process.exit(1)
  }
})
'
}

machine_stdout() {
  fly machine exec "${MACHINE}" "$1" --json -a "${APP}" | extract_stdout
}

if ! SIZE_LINE="$(machine_stdout "wc -c ${REPORT_PATH}")"; then
  echo "FAIL: could not read the size of ${REPORT_PATH} from machine ${MACHINE}" >&2
  exit 1
fi
BYTES="$(printf '%s' "${SIZE_LINE}" | awk '{print $1}')"
if ! [[ "${BYTES}" =~ ^[0-9]+$ ]]; then
  echo "FAIL: unexpected size line for ${REPORT_PATH}: ${SIZE_LINE}" >&2
  exit 1
fi

if ! machine_stdout "split -b ${PART_BYTES} -d -a 3 ${REPORT_PATH} ${PART_PREFIX}" >/dev/null; then
  echo "FAIL: could not split ${REPORT_PATH} on machine ${MACHINE}" >&2
  exit 1
fi

PARTS=$(( (BYTES + PART_BYTES - 1) / PART_BYTES ))
RECEIVED="$(mktemp)"
trap 'rm -f "${RECEIVED}"' EXIT
for (( i = 0; i < PARTS; i++ )); do
  part="${PART_PREFIX}$(printf '%03d' "${i}")"
  if ! machine_stdout "base64 -w0 ${part}" \
    | node -e 'process.stdout.write(Buffer.from(require("node:fs").readFileSync(0, "utf8"), "base64"))' \
    >> "${RECEIVED}"; then
    echo "FAIL: could not read ${part} from machine ${MACHINE}" >&2
    exit 1
  fi
done

if ! SHA_LINE="$(machine_stdout "sha256sum ${REPORT_PATH}")"; then
  echo "FAIL: could not sha256sum ${REPORT_PATH} from machine ${MACHINE}" >&2
  exit 1
fi

REMOTE_SHA="$(printf '%s' "${SHA_LINE}" | awk '{print $1}')"
LOCAL_SHA="$(shasum -a 256 < "${RECEIVED}" | awk '{print $1}')"

if [ -z "${REMOTE_SHA}" ] || [ "${REMOTE_SHA}" != "${LOCAL_SHA}" ]; then
  echo "FAIL: sha256 mismatch for ${REPORT_PATH}: remote=${REMOTE_SHA:-<none>} local=${LOCAL_SHA}" >&2
  exit 1
fi

if ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "${RECEIVED}" >/dev/null 2>&1; then
  echo "FAIL: ${REPORT_PATH} content did not parse as JSON" >&2
  exit 1
fi

cat "${RECEIVED}" > "${OUT}"
echo "collected scenario=${SCENARIO} bytes=${BYTES} parts=${PARTS} sha256=${LOCAL_SHA} -> ${OUT}"
