#!/usr/bin/env bash
# Offline checks for scripts/deploy-index-cloud.sh. gcloud, git and curl are
# stubbed; no credentials, no network, no live project. Proves the script
# refuses missing or unsafe inputs, masks every secret in planned output,
# runs migrations before a new revision serves, and smoke checks /v1/health.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/deploy-index-cloud.sh"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -x "$SCRIPT" ]] || { echo "missing executable ${SCRIPT}"; exit 1; }

DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-index-test.XXXXXX")"
trap 'rm -rf "$DIR"' EXIT
FAKE_BIN="${DIR}/bin"
mkdir -p "$FAKE_BIN"
FAKE_LOG="${DIR}/gcloud.log"
CURL_LOG="${DIR}/curl.log"

# Use a disposable repository containing ignored operator files. The stub
# checks the actual upload directory, not the printed command.
python3 - "$ROOT" "$DIR/repo" "$DIR/expected-context" <<'PYFIXTURE'
from pathlib import Path
import shutil
import sys
root, fixture, manifest = map(Path, sys.argv[1:])
for name in ("scripts", "service", "indexer"):
    shutil.copytree(root / name, fixture / name,
                    ignore=shutil.ignore_patterns("node_modules", "dist", ".git"))
fixed = {"service/Dockerfile", "service/docker-entrypoint.sh",
         "service/package.json", "service/package-lock.json", "service/tsconfig.json",
         "indexer/package.json", "indexer/package-lock.json", "indexer/idl/veto.json"}
for tree in ("service/src", "indexer/src"):
    for path in (fixture / tree).rglob("*"):
        if path.is_file() and path.suffix in (".ts", ".sql") and not path.name.endswith(".test.ts"):
            fixed.add(path.relative_to(fixture).as_posix())
manifest.write_text("\n".join(sorted(fixed)))
for name in ("app/credentials.json", "app/signing.p8", "app/signing.p12",
             "app/signing.key", "tools/.local/key.json", "watcher/data/key.json",
             "watcher/logs/run.log", "keys/wallet.json", ".env"):
    path = fixture / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("offline-secret-canary")
PYFIXTURE
SCRIPT="${DIR}/repo/scripts/deploy-index-cloud.sh"

# The gcloud stub records argv like a deploy log would. gcloud itself never
# echoes a --password value in its own output, so the stub records it masked:
# the recorded log is what an operator could paste, and it must carry no
# credential material.
cat > "${FAKE_BIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
set -u
args="$*"
mode="${FAKE_GCLOUD_MODE:-existing}"
printf '%s\n' "$args" | sed -E 's/--password=[^ ]*/--password=***/' >> "${FAKE_GCLOUD_LOG}"

if [[ "$1 $2" == 'builds submit' ]]; then
  python3 - "${@: -1}" "${HOME}/expected-context" <<'PYCHECK'
from pathlib import Path
import sys
context, manifest = map(Path, sys.argv[1:])
expected = set(manifest.read_text().splitlines())
actual = {p.relative_to(context).as_posix() for p in context.rglob("*") if p.is_file()}
assert actual == expected, f"unsafe upload context: extra={actual - expected}, missing={expected - actual}"
assert not any(p.is_symlink() for p in context.rglob("*")), "symlink in upload"
assert not any(b"offline-secret-canary" in p.read_bytes() for p in context.rglob("*") if p.is_file())
PYCHECK
  exit $?
fi

if [[ "$args" == *'auth list'* ]]; then
  printf 'owner@example.com\n'
  exit 0
fi
if [[ "$args" == *'services list'* ]]; then
  printf '%s\n' \
    run.googleapis.com \
    sqladmin.googleapis.com \
    secretmanager.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    cloudscheduler.googleapis.com \
    logging.googleapis.com
  exit 0
fi
if [[ "$args" == *'projects describe'* ]]; then
  printf '123456789\n'
  exit 0
fi
if [[ "$args" == *'iam service-accounts describe'* ]]; then
  if [[ "$mode" == fresh ]]; then printf 'NOT_FOUND\n' >&2; exit 1; fi
  exit 0
fi
if [[ "$args" == *'sql instances describe'* ]]; then
  if [[ "$mode" == fresh ]]; then printf 'NOT_FOUND\n' >&2; exit 1; fi
  exit 0
fi
if [[ "$args" == *'sql databases describe'* ]]; then
  if [[ "$mode" == fresh ]]; then printf 'NOT_FOUND\n' >&2; exit 1; fi
  exit 0
fi
if [[ "$args" == *'sql users list'* ]]; then
  case "$mode" in
    fresh) printf '\n' ;;
    *) printf 'veto_index_app\n' ;;
  esac
  exit 0
fi
if [[ "$args" == *'secrets describe'* ]]; then
  if [[ "$mode" == fresh ]]; then printf 'NOT_FOUND\n' >&2; exit 1; fi
  if [[ "$mode" == user-no-secret && "$args" == *'veto-index-database-url'* ]]; then
    printf 'NOT_FOUND\n' >&2; exit 1
  fi
  exit 0
fi
if [[ "$args" == *'artifacts repositories describe'* ]]; then
  if [[ "$mode" == fresh ]]; then printf 'NOT_FOUND\n' >&2; exit 1; fi
  exit 0
fi
if [[ "$args" == *'scheduler jobs describe'* ]]; then
  if [[ "$mode" == fresh ]]; then printf 'NOT_FOUND\n' >&2; exit 1; fi
  exit 0
fi
if [[ "$args" == *'run jobs execute'* ]]; then
  if [[ "$mode" == migrate-fail ]]; then
    printf 'Job execution failed\n' >&2
    exit 1
  fi
  exit 0
fi
if [[ "$args" == *'run services describe'* ]]; then
  printf 'https://veto-index-test.a.run.app\n'
  exit 0
fi
exit 0
EOF
chmod +x "${FAKE_BIN}/gcloud"

cat > "${FAKE_BIN}/git" <<'EOF'
#!/usr/bin/env bash
set -u
args="$*"
if [[ "$args" == *'status --porcelain'* ]]; then
  if [[ "${FAKE_GIT_MODE:-clean}" == dirty ]]; then
    printf ' M scripts/deploy-index-cloud.sh\n'
  fi
  exit 0
fi
if [[ "$args" == *'is-inside-work-tree'* ]]; then
  printf 'true\n'
  exit 0
fi
if [[ "$args" == *'rev-parse --short'* ]]; then
  printf 'deadbee\n'
  exit 0
fi
exit 0
EOF
chmod +x "${FAKE_BIN}/git"

cat > "${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "${FAKE_CURL_LOG}"
if [[ "${FAKE_CURL_MODE:-ok}" == fail ]]; then
  printf 'curl: (22) The requested URL returned error: 503\n' >&2
  exit 22
fi
printf '{"chain_tip_slot":"10","last_indexed_slot":"10","lag_slots":"0"}\n'
exit 0
EOF
chmod +x "${FAKE_BIN}/curl"

run_script() {
  local gcloud_mode="$1"
  shift
  env -i \
    PATH="${FAKE_BIN}:${PATH}" \
    HOME="${DIR}" \
    FAKE_GCLOUD_MODE="$gcloud_mode" \
    FAKE_GCLOUD_LOG="$FAKE_LOG" \
    FAKE_GIT_MODE="${FAKE_GIT_MODE:-clean}" \
    FAKE_CURL_MODE="${FAKE_CURL_MODE:-ok}" \
    FAKE_CURL_LOG="$CURL_LOG" \
    SMOKE_DELAY=0 \
    "$SCRIPT" "$@"
}

BASE_ENV=(
  PROJECT=test-project
  REGION=test-region
  INDEX_WEBHOOK_AUTH=test-auth-header-SECRETVALUE
  VETO_RPC=https://rpc.test/SECRETKEY123
)

run_full() {
  env -i \
    PATH="${FAKE_BIN}:${PATH}" \
    HOME="${DIR}" \
    FAKE_GCLOUD_MODE="$1" \
    FAKE_GCLOUD_LOG="$FAKE_LOG" \
    FAKE_GIT_MODE="${FAKE_GIT_MODE:-clean}" \
    FAKE_CURL_MODE="${FAKE_CURL_MODE:-ok}" \
    FAKE_CURL_LOG="$CURL_LOG" \
    SMOKE_DELAY=0 \
    "${BASE_ENV[@]}" \
    "$SCRIPT" "${@:2}"
}

if out="$(run_script existing --check 2>&1)"; then
  bad "missing PROJECT must refuse"
else
  if printf '%s' "$out" | grep "missing PROJECT" >/dev/null; then
    pass "missing PROJECT refuses; the project has no default"
  else
    bad "missing PROJECT message: ${out}"
  fi
fi

if out="$(env -i PATH="${FAKE_BIN}:${PATH}" HOME="${DIR}" PROJECT=test-project INDEX_WEBHOOK_AUTH=test-auth-header-SECRETVALUE VETO_RPC=https://rpc.test/SECRETKEY123 "$SCRIPT" --check 2>&1)"; then
  bad "missing REGION must refuse"
else
  if printf '%s' "$out" | grep "missing REGION" >/dev/null; then
    pass "missing REGION refuses; the region has no default"
  else
    bad "missing REGION message: ${out}"
  fi
fi

if out="$(FAKE_GIT_MODE=dirty run_full existing --check 2>&1)"; then
  bad "dirty working tree must refuse"
else
  if printf '%s' "$out" | grep -i "working tree" >/dev/null; then
    pass "dirty working tree refuses before any deploy"
  else
    bad "dirty working tree message: ${out}"
  fi
fi

if out="$(env -i PATH="${FAKE_BIN}:${PATH}" HOME="${DIR}" PROJECT=test-project REGION=test-region VETO_RPC=https://rpc.test/SECRETKEY123 "$SCRIPT" --check 2>&1)"; then
  bad "missing INDEX_WEBHOOK_AUTH must refuse"
else
  if printf '%s' "$out" | grep "missing INDEX_WEBHOOK_AUTH" >/dev/null; then
    pass "missing INDEX_WEBHOOK_AUTH refuses before any deploy"
  else
    bad "missing INDEX_WEBHOOK_AUTH message: ${out}"
  fi
fi

if out="$(env -i PATH="${FAKE_BIN}:${PATH}" HOME="${DIR}" PROJECT=test-project REGION=test-region INDEX_WEBHOOK_AUTH=test-auth-header-SECRETVALUE "$SCRIPT" --check 2>&1)"; then
  bad "missing VETO_RPC must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_RPC" >/dev/null; then
    pass "missing VETO_RPC refuses before any deploy"
  else
    bad "missing VETO_RPC message: ${out}"
  fi
fi

if out="$(run_full existing --check 2>&1)"; then
  if printf '%s' "$out" | grep "check ok" >/dev/null; then
    pass "check succeeds when every required input is present"
  else
    bad "check success message: ${out}"
  fi
else
  bad "check should succeed when every required input is present: ${out}"
fi

if out1="$(run_full existing --check 2>&1)" && out2="$(run_full existing --check 2>&1)"; then
  if printf '%s' "$out1" | grep "check ok" >/dev/null && printf '%s' "$out2" | grep "check ok" >/dev/null; then
    pass "check is safe to run twice"
  else
    bad "second check output: ${out2}"
  fi
else
  bad "running check twice must succeed"
fi

# shellcheck disable=SC2016
if grep -nE '(echo|printf)[^\n]*\$\{?(INDEX_WEBHOOK_AUTH|VETO_RPC|DATABASE_URL|DB_PASSWORD|database_url|db_password)\}?' "$SCRIPT" \
  | grep -v 'mask_arg\|MASK_VALUES\|need_var\|printf .%s\\n. "\$1"\|missing '; then
  bad "script must not print a secret variable"
else
  pass "script does not print a secret variable"
fi

: >"$FAKE_LOG"
if out="$(run_full fresh --dry-run 2>&1)"; then
  if printf '%s' "$out" | grep 'dry-run:' >/dev/null; then
    pass "dry-run prints planned commands"
  else
    bad "dry-run output missing dry-run prefix: ${out}"
  fi
else
  bad "dry-run on a fresh project should succeed: ${out}"
fi

dry="$(run_full fresh --dry-run 2>&1)"

if printf '%s' "$dry" | grep -F 'sql instances create' | grep 'POSTGRES_16' >/dev/null \
  && printf '%s' "$dry" | grep -F 'sql instances create' | grep 'db-f1-micro' >/dev/null; then
  pass "dry-run plans a Postgres 16 instance on the smallest tier"
else
  bad "dry-run missing Postgres 16 instance create: ${dry}"
fi

if printf '%s' "$dry" | grep -F 'sql users create' | grep -E -- '--password=\\\*\\\*\\\*' >/dev/null \
  && ! printf '%s' "$dry" | grep -E -- '--password=[0-9a-f]' | grep . >/dev/null; then
  pass "dry-run masks the generated database password"
else
  bad "dry-run leaks the database password: $(printf '%s' "$dry" | grep -F 'sql users create')"
fi

if printf '%s' "$dry" | grep 'SECRETVALUE' >/dev/null \
  || printf '%s' "$dry" | grep 'SECRETKEY123' >/dev/null \
  || printf '%s' "$dry" | grep 'postgresql://' >/dev/null; then
  bad "dry-run printed a secret value"
else
  pass "dry-run never prints the webhook auth, RPC URL, or database URL"
fi

migrate_line="$(printf '%s' "$dry" | grep -nF 'run jobs execute' | sed -n '1p' | cut -d: -f1)"
api_line="$(printf '%s' "$dry" | grep -nF 'run deploy veto-index ' | sed -n '1p' | cut -d: -f1)"
migrate_deploy_line="$(printf '%s' "$dry" | grep -nF 'run jobs deploy veto-index-migrate' | sed -n '1p' | cut -d: -f1)"
if [[ -n "$migrate_deploy_line" && -n "$migrate_line" && -n "$api_line" ]] \
  && [[ "$migrate_deploy_line" -lt "$migrate_line" && "$migrate_line" -lt "$api_line" ]]; then
  pass "migrations job is deployed and executed before the new revision serves"
else
  bad "migration ordering wrong: deploy=${migrate_deploy_line:-none} execute=${migrate_line:-none} api=${api_line:-none}"
fi

api_deploy="$(printf '%s' "$dry" | grep -F 'run deploy veto-index ' | sed -n '1p')"
if printf '%s' "$api_deploy" | grep 'min-instances=1' >/dev/null \
  && printf '%s' "$api_deploy" | grep 'add-cloudsql-instances' >/dev/null \
  && printf '%s' "$api_deploy" | grep 'DATABASE_URL=veto-index-database-url:latest' >/dev/null \
  && printf '%s' "$api_deploy" | grep 'VETO_RPC=veto-index-rpc-url:latest' >/dev/null \
  && printf '%s' "$api_deploy" | grep 'service-account=veto-index@test-project.iam.gserviceaccount.com' >/dev/null \
  && printf '%s' "$api_deploy" | grep 'allow-unauthenticated' >/dev/null; then
  pass "API service deploys with min instances 1, connector, secrets, and its own account"
else
  bad "API service deploy line wrong: ${api_deploy}"
fi

webhook_deploy="$(printf '%s' "$dry" | grep -F 'run deploy veto-index-webhook' | sed -n '1p')"
if printf '%s' "$webhook_deploy" | grep 'INDEX_WEBHOOK_AUTH=veto-index-webhook-auth:latest' >/dev/null \
  && printf '%s' "$webhook_deploy" | grep 'add-cloudsql-instances' >/dev/null; then
  pass "webhook service carries the webhook auth secret and the connector"
else
  bad "webhook service deploy line wrong: ${webhook_deploy}"
fi

if printf '%s' "$dry" | grep -F 'run jobs deploy veto-index-backfill' >/dev/null \
  && printf '%s' "$dry" | grep 'scheduler jobs create http' >/dev/null; then
  pass "backfill job and its schedule are planned"
else
  bad "backfill job or scheduler missing from dry-run: ${dry}"
fi

if printf '%s' "$dry" | grep '/v1/health' >/dev/null; then
  pass "dry-run plans the smoke check against /v1/health"
else
  bad "dry-run does not mention the smoke check: ${dry}"
fi

if printf '%s' "$dry" | grep 'service/Dockerfile' >/dev/null; then
  pass "image build uses service/Dockerfile"
else
  bad "dry-run build does not reference service/Dockerfile: ${dry}"
fi

if out1="$(run_full fresh --dry-run 2>&1)" && out2="$(run_full fresh --dry-run 2>&1)"; then
  if printf '%s\n' "$out1" "$out2" | grep -E 'instances delete|services delete|jobs delete|secrets delete|databases delete|repositories delete' >/dev/null; then
    bad "dry-run twice must not delete anything"
  else
    pass "dry-run twice is safe (no deletes)"
  fi
else
  bad "dry-run twice must succeed"
fi

: >"$FAKE_LOG"; : >"$CURL_LOG"
if out="$(run_full existing 2>&1)"; then
  if printf '%s' "$out" | grep 'smoke check ok' >/dev/null && printf '%s' "$out" | grep 'deployed' >/dev/null; then
    pass "deploy against existing resources succeeds and smoke checks"
  else
    bad "deploy output missing smoke or deployed: ${out}"
  fi
else
  bad "deploy against existing resources should succeed: ${out}"
fi

exec_line="$(grep -nF 'run jobs execute' "$FAKE_LOG" | sed -n '1p' | cut -d: -f1 || true)"
svc_line="$(grep -nF 'run deploy veto-index ' "$FAKE_LOG" | sed -n '1p' | cut -d: -f1 || true)"
if [[ -n "$exec_line" && -n "$svc_line" && "$exec_line" -lt "$svc_line" ]]; then
  pass "migrations execute before the new revision is deployed"
else
  bad "execution order wrong in recorded log: execute=${exec_line:-none} service=${svc_line:-none}"
fi

if grep -q 'SECRETVALUE' "$FAKE_LOG" || grep -q 'SECRETKEY123' "$FAKE_LOG" || grep -q 'postgresql://' "$FAKE_LOG"; then
  bad "recorded deploy log contains a secret value"
else
  pass "recorded deploy log carries no secret value"
fi

if grep -q '/v1/health' "$CURL_LOG"; then
  pass "smoke check fetched /v1/health"
else
  bad "smoke check did not run: $(cat "$CURL_LOG")"
fi

: >"$FAKE_LOG"
if out="$(run_full migrate-fail 2>&1)"; then
  bad "a failed migration job must stop the deploy"
else
  if grep -qF 'run deploy' "$FAKE_LOG"; then
    bad "services were deployed even though migrations failed"
  elif printf '%s' "$out" | grep -i 'migrat' >/dev/null; then
    pass "failed migrations stop the deploy before any service update"
  else
    bad "migration failure message: ${out}"
  fi
fi

if out="$(FAKE_CURL_MODE=fail run_full existing 2>&1)"; then
  bad "a failed smoke check must fail the deploy"
else
  if printf '%s' "$out" | grep 'smoke check failed' >/dev/null; then
    pass "smoke check failure fails the deploy"
  else
    bad "smoke failure message: ${out}"
  fi
fi

if out="$(run_full user-no-secret 2>&1)"; then
  bad "database user without a database-url secret must refuse"
else
  if printf '%s' "$out" | grep 'veto-index-database-url' >/dev/null; then
    pass "database user without the database-url secret refuses to guess"
  else
    bad "user-without-secret message: ${out}"
  fi
fi

# Unsafe files inside a required source tree must fail before upload.
for unsafe in keys/wallet.ts .env credentials.json account.json signing.p8 signing.p12 signing.key logs/run.ts; do
  target="${DIR}/repo/service/src/${unsafe}"
  mkdir -p "$(dirname "$target")"
  printf 'offline-secret-canary' > "$target"
  : > "$FAKE_LOG"
  if out="$(run_full existing 2>&1)"; then
    bad "unsafe source ${unsafe} must refuse"
  elif grep -q 'builds submit' "$FAKE_LOG"; then
    bad "unsafe source ${unsafe} reached upload"
  else
    pass "unsafe source ${unsafe} refuses before upload"
  fi
  rm "$target"
  case "$unsafe" in */*) rmdir "$(dirname "$target")" ;; esac
done
ln -s "${DIR}/repo/.env" "${DIR}/repo/service/src/leak.ts"
: > "$FAKE_LOG"
if out="$(run_full existing 2>&1)" || grep -q 'builds submit' "$FAKE_LOG"; then
  bad "source symlink must refuse before upload"
else
  pass "source symlink refuses before upload"
fi
rm "${DIR}/repo/service/src/leak.ts"

cp "${DIR}/repo/service/package.json" "${DIR}/package-backup.json"
printf '{"private_key":"offline-secret-canary"}' > "${DIR}/repo/service/package.json"
: > "$FAKE_LOG"
if out="$(run_full existing 2>&1)" || grep -q 'builds submit' "$FAKE_LOG"; then
  bad "credentials in an allowed JSON path must refuse before upload"
else
  pass "credentials in an allowed JSON path refuse before upload"
fi
mv "${DIR}/package-backup.json" "${DIR}/repo/service/package.json"

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'deploy-index-cloud checks: passed\n'
