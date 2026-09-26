#!/usr/bin/env bash
# Prove the Cloud Run deploy script refuses missing inputs instead of
# creating a half deployment, and that it is safe to invoke twice.
# Does not talk to Google Cloud.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/deploy-watcher-cloud.sh"

fail=0
pass() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; fail=1; }

[[ -x "$SCRIPT" ]] || { echo "missing executable ${SCRIPT}"; exit 1; }

IDENTITIES=(
  VETO_RPC=http://rpc.test
  VETO_PROGRAM_ID=Prog
  VETO_MINT=Mint
  VETO_OWNER=Owner
  VETO_OWNER_TOKEN=OwnerToken
  VETO_MERCHANT=Merchant
  VETO_MERCHANT_TOKEN=MerchantToken
  VETO_AGENT=Agent
)

fake_key() {
  local path="$1"
  python3 -c 'import json,sys; json.dump([0]*64, open(sys.argv[1],"w"))' "$path"
}

run_check() {
  env -i \
    PATH="$PATH" \
    HOME="${HOME:-/tmp}" \
    AGENT_KEY_PATH="${AGENT_KEY_PATH:-}" \
    BUCKET="${BUCKET:-}" \
    "${IDENTITIES[@]}" \
    "$SCRIPT" --check "$@"
}

DIR="$(mktemp -d)"
KEY="${DIR}/agent.json"
fake_key "$KEY"

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$SCRIPT" --check 2>&1)"; then
  bad "missing AGENT_KEY_PATH must refuse"
else
  if printf '%s' "$out" | grep "missing AGENT_KEY_PATH" >/dev/null; then
    pass "missing AGENT_KEY_PATH refuses before any deploy"
  else
    bad "missing AGENT_KEY_PATH message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="${DIR}/no-such.json" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  bad "missing agent key file must refuse"
else
  if printf '%s' "$out" | grep "agent key file not found" >/dev/null; then
    pass "missing agent key file refuses before any deploy"
  else
    bad "missing agent key file message: ${out}"
  fi
fi

printf '%s\n' '{"not":"a keypair"}' > "${DIR}/bad.json"
if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="${DIR}/bad.json" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  bad "invalid agent key file must refuse"
else
  if printf '%s' "$out" | grep "not a JSON keypair array" >/dev/null \
    && ! printf '%s' "$out" | grep 'not":"a keypair' >/dev/null; then
    pass "invalid agent key file refuses without printing the file"
  else
    bad "invalid agent key file message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" VETO_PROGRAM_ID=Prog VETO_MINT=Mint VETO_OWNER=Owner VETO_OWNER_TOKEN=OwnerToken VETO_MERCHANT=Merchant VETO_MERCHANT_TOKEN=MerchantToken VETO_AGENT=Agent "$SCRIPT" --check 2>&1)"; then
  bad "missing VETO_RPC must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_RPC" >/dev/null; then
    pass "missing VETO_RPC refuses before any deploy"
  else
    bad "missing VETO_RPC message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" BUCKET="" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  bad "missing BUCKET must refuse"
else
  if printf '%s' "$out" | grep "missing BUCKET" >/dev/null; then
    pass "missing BUCKET refuses before any deploy"
  else
    bad "missing BUCKET message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  if printf '%s' "$out" | grep "check ok" >/dev/null; then
    pass "check succeeds when every required input is present"
  else
    bad "check success message: ${out}"
  fi
else
  bad "check should succeed when every required input is present: ${out}"
fi

if out1="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)" \
  && out2="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" "${IDENTITIES[@]}" "$SCRIPT" --check 2>&1)"; then
  if printf '%s' "$out1" | grep "check ok" >/dev/null && printf '%s' "$out2" | grep "check ok" >/dev/null; then
    pass "check is safe to run twice"
  else
    bad "second check output: ${out2}"
  fi
else
  bad "running check twice must succeed"
fi

if grep -nE 'cat[[:space:]]+"?\$\{?AGENT_KEY_PATH' "$SCRIPT"; then
  bad "script must not cat AGENT_KEY_PATH"
else
  pass "script does not cat AGENT_KEY_PATH"
fi

if grep -nE 'echo[[:space:]]+"?\$\{?(SECRET|AGENT_KEY|KEYPAIR)' "$SCRIPT"; then
  bad "script must not echo a secret variable"
else
  pass "script does not echo a secret variable"
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" VETO_RPC=http://rpc.test VETO_MINT=Mint VETO_OWNER=Owner VETO_OWNER_TOKEN=OwnerToken VETO_MERCHANT=Merchant VETO_MERCHANT_TOKEN=MerchantToken VETO_AGENT=Agent "$SCRIPT" --check 2>&1)"; then
  bad "missing VETO_PROGRAM_ID must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_PROGRAM_ID" >/dev/null; then
    pass "missing VETO_PROGRAM_ID refuses before any deploy"
  else
    bad "missing VETO_PROGRAM_ID message: ${out}"
  fi
fi

if out="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" AGENT_KEY_PATH="$KEY" VETO_RPC=http://rpc.test VETO_PROGRAM_ID=Prog VETO_OWNER=Owner VETO_OWNER_TOKEN=OwnerToken VETO_MERCHANT=Merchant VETO_MERCHANT_TOKEN=MerchantToken VETO_AGENT=Agent "$SCRIPT" --check 2>&1)"; then
  bad "missing VETO_MINT must refuse"
else
  if printf '%s' "$out" | grep "missing VETO_MINT" >/dev/null; then
    pass "missing VETO_MINT refuses before any deploy"
  else
    bad "missing VETO_MINT message: ${out}"
  fi
fi

FAKE_BIN="${DIR}/bin"
mkdir -p "$FAKE_BIN"
FAKE_LOG="${DIR}/gcloud.log"
cat > "${FAKE_BIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_GCLOUD_LOG}"
case " $* " in
  *" auth list "*) printf 'owner@example.com\n' ;;
  *" projects describe "*) printf '123456789\n' ;;
  *" projects get-iam-policy "*) printf '{"bindings":[]}\n' ;;
  *" secrets get-iam-policy "*) printf '{"bindings":[]}\n' ;;
  *" secrets describe "*) printf 'NOT_FOUND: Secret [veto-agent-keypair] not found.\n' >&2; exit 1 ;;
  *" get-ancestors "*) printf '123456789\tproject\n' ;;
  *" organizations get-iam-policy "*) printf 'PERMISSION_DENIED\n' >&2; exit 1 ;;
  *" folders get-iam-policy "*) printf 'PERMISSION_DENIED\n' >&2; exit 1 ;;
  *" monitoring policies list "*) printf 'projects/veto-watcher-260921/alertPolicies/1\n' ;;
  *" monitoring channels list "*) printf '\n' ;;
esac
exit 0
EOF
chmod +x "${FAKE_BIN}/gcloud"

DRY_ENV=(
  env -i
  PATH="${FAKE_BIN}:${PATH}"
  HOME="${DIR}"
  FAKE_GCLOUD_LOG="$FAKE_LOG"
  AGENT_KEY_PATH="$KEY"
  "${IDENTITIES[@]}"
)
if out1="$("${DRY_ENV[@]}" "$SCRIPT" --dry-run 2>&1)" \
  && out2="$("${DRY_ENV[@]}" "$SCRIPT" --dry-run 2>&1)"; then
  if printf '%s\n' "$out1" "$out2" | grep -E 'storage rm|buckets delete|secrets delete|jobs delete' >/dev/null ; then
    bad "dry-run twice must not delete the journal, secret, or jobs"
  elif printf '%s' "$out1" | grep 'dry-run:' >/dev/null && printf '%s' "$out2" | grep 'dry-run:' >/dev/null; then
    if printf '%s' "$out1$out2" | grep '\[0, 0, 0' >/dev/null; then
      bad "dry-run printed key bytes"
    else
      pass "dry-run twice is safe (no delete, no key bytes)"
    fi
  else
    bad "dry-run twice output missing dry-run prefix: ${out2}"
  fi
else
  if printf '%s' "${out1-}${out2-}" | grep 'env_file: unbound variable' >/dev/null; then
    bad "EXIT trap references local env_file after deploy returns; script exits 1 after printing deployed"
  else
    bad "dry-run twice must succeed: ${out1-}${out2-}"
  fi
fi

if printf '%s' "$out1" | grep "storage cp" >/dev/null && printf '%s' "$out1" | grep "decisions.jsonl" >/dev/null; then
  bad "dry-run with an existing journal object must not upload a replacement"
else
  pass "dry-run does not wipe an existing journal object"
fi

write_mode_gcloud() {
  cat > "${FAKE_BIN}/gcloud" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "${FAKE_GCLOUD_LOG}"
args="$*"
mode="${FAKE_GCLOUD_MODE:-clean}"

enabled_apis() {
  printf '%s\n' \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    secretmanager.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    storage.googleapis.com \
    monitoring.googleapis.com \
    logging.googleapis.com
}

if [[ "$args" == *'auth list'* ]]; then
  printf 'owner@example.com\n'
  exit 0
fi
if [[ "$args" == *'run services list'* ]]; then
  exit 0
fi
if [[ "$args" == *'services list'* ]]; then
  enabled_apis
  exit 0
fi
if [[ "$args" == *'projects describe'* ]]; then
  printf '123456789\n'
  exit 0
fi
if [[ "$args" == *'iam service-accounts describe'* ]]; then
  exit 0
fi
if [[ "$args" == *'organizations get-iam-policy'* || "$args" == *'folders get-iam-policy'* ]]; then
  printf 'PERMISSION_DENIED\n' >&2
  exit 1
fi
if [[ "$args" == *'get-ancestors'* ]]; then
  printf '123456789\tproject\n'
  exit 0
fi
if [[ "$args" == *'projects get-iam-policy'* ]]; then
  if [[ "$mode" == default-can-read ]]; then
    printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:123456789-compute@developer.gserviceaccount.com"]}]}\n'
    exit 0
  fi
  printf '{"bindings":[]}\n'
  exit 0
fi
if [[ "$args" == *'secrets get-iam-policy'* ]]; then
  if [[ "$mode" == default-can-read-secret ]]; then
    printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:123456789-compute@developer.gserviceaccount.com"]}]}\n'
    exit 0
  fi
  printf '{"bindings":[]}\n'
  exit 0
fi
if [[ "$args" == *'secrets describe'* ]]; then
  if [[ "$mode" == default-can-read-secret ]]; then
    printf 'veto-agent-keypair\n'
    exit 0
  fi
  printf 'NOT_FOUND: Secret [veto-agent-keypair] not found.\n' >&2
  exit 1
fi
if [[ "$args" == *'storage buckets describe'* ]]; then
  if [[ "$mode" == bucket-missing || "$mode" == pap-create-fail ]]; then
    printf 'NOT_FOUND\n' >&2
    exit 1
  fi
  if [[ "$args" == *'format=json'* ]]; then
    if [[ "$mode" == pap-not-enforced ]]; then
      printf '{"iam_config":{"public_access_prevention":"inherited","uniform_bucket_level_access":{"enabled":true}}}\n'
      exit 0
    fi
    printf '{"iam_config":{"public_access_prevention":"enforced","uniform_bucket_level_access":{"enabled":true}}}\n'
    exit 0
  fi
  exit 0
fi
if [[ "$args" == *'storage buckets create'* ]]; then
  if [[ "$mode" == pap-create-fail ]]; then
    printf 'could not set public access prevention\n' >&2
    exit 1
  fi
  exit 0
fi
if [[ "$args" == *'storage buckets update'* && "$args" == *'public-access-prevention'* ]]; then
  if [[ "$mode" == pap-update-fail ]]; then
    printf 'could not set public access prevention\n' >&2
    exit 1
  fi
  exit 0
fi
if [[ "$args" == *'storage objects describe'* ]]; then
  if [[ "$mode" == bucket-missing ]]; then
    exit 1
  fi
  exit 0
fi
exit 0
EOF
  chmod +x "${FAKE_BIN}/gcloud"
}

run_deploy() {
  local mode="$1"
  shift
  : >"$FAKE_LOG"
  FAKE_GCLOUD_MODE="$mode" FAKE_GCLOUD_LOG="$FAKE_LOG" \
    env -i \
    PATH="${FAKE_BIN}:${PATH}" \
    HOME="${DIR}" \
    FAKE_GCLOUD_MODE="$mode" \
    FAKE_GCLOUD_LOG="$FAKE_LOG" \
    AGENT_KEY_PATH="$KEY" \
    "${IDENTITIES[@]}" \
    "$SCRIPT" "$@"
}

write_mode_gcloud

if out="$(run_deploy default-can-read --dry-run 2>&1)"; then
  bad "default compute account with secretAccessor must stop deploy"
else
  if printf '%s' "$out" | grep 'default compute account 123456789-compute@developer.gserviceaccount.com can read a secret version' >/dev/null \
    && printf '%s' "$out" | grep 'found: roles/secretmanager.secretAccessor on project policy' >/dev/null; then
    if grep -E 'secrets create|secrets versions add' "$FAKE_LOG"; then
      bad "default compute secretAccessor must stop before secrets create/add; gcloud log still has a secret write"
    else
      pass "default compute account with secretAccessor stops deploy before the secret is created"
    fi
  else
    bad "default compute secretAccessor message: ${out}"
  fi
fi

if out="$(run_deploy default-can-read-secret --dry-run 2>&1)"; then
  bad "default compute account with secret-level secretAccessor must stop deploy"
else
  if printf '%s' "$out" | grep 'default compute account 123456789-compute@developer.gserviceaccount.com can read a secret version' >/dev/null \
    && printf '%s' "$out" | grep 'found: roles/secretmanager.secretAccessor on secret veto-agent-keypair policy' >/dev/null; then
    if grep -E 'secrets create|secrets versions add' "$FAKE_LOG"; then
      bad "secret-level secretAccessor must stop before secrets create/add; gcloud log still has a secret write"
    else
      pass "default compute account with secret-level secretAccessor stops before a new version is stored"
    fi
  else
    bad "secret-level secretAccessor message: ${out}"
  fi
fi

if out="$(run_deploy pap-update-fail 2>&1)"; then
  bad "existing bucket that cannot take public access prevention must fail"
else
  if printf '%s' "$out" | grep 'could not set public access prevention to enforced' >/dev/null; then
    if grep -E 'secrets create|secrets versions add' "$FAKE_LOG"; then
      bad "PAP failure must happen before the secret is created"
    else
      pass "existing bucket that cannot take public access prevention fails before the secret is created"
    fi
  else
    bad "PAP update failure message: ${out}"
  fi
fi

if out="$(run_deploy pap-not-enforced 2>&1)"; then
  bad "bucket whose public access prevention stays inherited must fail"
else
  if printf '%s' "$out" | grep "public access prevention on gs://veto-watcher-260921-journal is 'inherited', wanted enforced" >/dev/null; then
    pass "bucket that does not report PAP enforced fails"
  else
    bad "PAP not-enforced message: ${out}"
  fi
fi

if out="$(run_deploy pap-create-fail 2>&1)"; then
  bad "create that cannot set public access prevention must fail"
else
  if printf '%s' "$out" | grep 'could not create gs://veto-watcher-260921-journal with public access prevention enforced' >/dev/null \
    || printf '%s' "$out" | grep 'could not set public access prevention to enforced' >/dev/null; then
    pass "create that cannot set public access prevention fails"
  else
    bad "PAP create failure message: ${out}"
  fi
fi

if out="$(run_deploy bucket-missing --dry-run 2>&1)"; then
  if printf '%s' "$out" | grep 'storage buckets create' >/dev/null \
    && printf '%s' "$out" | grep 'public-access-prevention' >/dev/null; then
    pass "bucket create includes public access prevention"
  else
    bad "dry-run create missing --public-access-prevention: ${out}"
  fi
else
  bad "dry-run with a missing bucket should print create: ${out}"
fi

# VETO_QUOTE_CURRENCY is written into the env file both jobs deploy with,
# and only when the operator set it. deploy() calls write_env_file once and
# passes that file to veto-watcher and veto-watcher-stale.
quote_env_body() {
  local currency="${1:-}"
  (
    # The sourced deploy script parses "$@". Drop the function argument so a
    # currency value is not treated as an unknown flag.
    set --
    export VETO_RPC=http://rpc.test
    export VETO_PROGRAM_ID=Prog
    export VETO_MINT=Mint
    export VETO_OWNER=Owner
    export VETO_OWNER_TOKEN=OwnerToken
    export VETO_MERCHANT=Merchant
    export VETO_MERCHANT_TOKEN=MerchantToken
    export VETO_AGENT=Agent
    export BUCKET=test-bucket
    export PROJECT=veto-watcher-260921
    if [[ -n "$currency" ]]; then
      export VETO_QUOTE_CURRENCY="$currency"
    else
      unset VETO_QUOTE_CURRENCY
    fi
    # shellcheck disable=SC1090
    source "$SCRIPT"
    local dest
    dest="$(mktemp)"
    write_env_file "$dest"
    cat "$dest"
    rm -f "$dest"
  )
}

unset_body="$(quote_env_body)"
if printf '%s\n' "$unset_body" | grep 'VETO_QUOTE_CURRENCY' >/dev/null; then
  bad "unset VETO_QUOTE_CURRENCY must not be written into the job env file"
else
  pass "unset VETO_QUOTE_CURRENCY is omitted from the job env file"
fi

usd_body="$(quote_env_body USD)"
if printf '%s\n' "$usd_body" | grep -x 'VETO_QUOTE_CURRENCY: "USD"' >/dev/null; then
  pass "VETO_QUOTE_CURRENCY=USD is written into the job env file"
else
  bad "USD env file missing the quote currency line: ${usd_body}"
fi

job_deploys="$(grep -c -F 'run jobs deploy' "$SCRIPT" || true)"
env_files="$(grep -c -F -- '--env-vars-file="$env_file"' "$SCRIPT" || true)"
if [[ "$job_deploys" == "2" && "$env_files" == "2" ]]; then
  pass "both Cloud Run jobs deploy with the same env file"
else
  bad "expected 2 job deploys and 2 env-vars-file uses, got deploys=${job_deploys} files=${env_files}"
fi

if out="$(run_deploy quote-forward --dry-run 2>&1)"; then
  watcher_line="$(printf '%s\n' "$out" | grep -F 'run jobs deploy veto-watcher ' | grep -F 'env-vars-file=' || true)"
  stale_line="$(printf '%s\n' "$out" | grep -F 'run jobs deploy veto-watcher-stale ' | grep -F 'env-vars-file=' || true)"
  watcher_path="$(printf '%s\n' "$watcher_line" | sed -n 's/.*env-vars-file=\([^ ]*\).*/\1/p')"
  stale_path="$(printf '%s\n' "$stale_line" | sed -n 's/.*env-vars-file=\([^ ]*\).*/\1/p')"
  if [[ -n "$watcher_path" && "$watcher_path" == "$stale_path" ]]; then
    pass "dry-run passes one env file to both jobs"
  else
    bad "dry-run env file paths differ: watcher=${watcher_path:-<missing>} stale=${stale_path:-<missing>}"
  fi
else
  bad "dry-run for quote currency forwarding should succeed: ${out}"
fi

rm -rf "$DIR"

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf 'deploy-watcher-cloud checks: passed\n'
