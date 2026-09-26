#!/usr/bin/env bash
# Create or update the Cloud Run watcher job. Idempotent. Refuses before
# creating anything if a required input is missing. Never prints a secret.
#
# The owner runs this. It does not run from CI and it does not execute the
# job. See watcher/CLOUD.md.
#
#   ./scripts/deploy-watcher-cloud.sh --check
#   ./scripts/deploy-watcher-cloud.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT="${PROJECT:-veto-watcher-260921}"
REGION="${REGION:-europe-north1}"
# Cloud Scheduler is not offered in europe-north1 (Finland). Belgium is the
# nearest Scheduler region; the job it invokes still runs in europe-north1.
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-europe-west1}"
JOB_NAME="${JOB_NAME:-veto-watcher}"
STALE_JOB_NAME="${STALE_JOB_NAME:-veto-watcher-stale}"
SCHEDULER_JOB="${SCHEDULER_JOB:-veto-watcher-cadence}"
STALE_SCHEDULER_JOB="${STALE_SCHEDULER_JOB:-veto-watcher-stale-hourly}"
SA_NAME="${SA_NAME:-veto-watcher}"
AR_REPO="${AR_REPO:-veto-watcher}"
IMAGE_NAME="${IMAGE_NAME:-watcher}"
SECRET_NAME="${SECRET_NAME:-veto-agent-keypair}"
if [[ -z "${BUCKET+x}" ]]; then
  BUCKET="${PROJECT}-journal"
fi
JOURNAL_OBJECT="${JOURNAL_OBJECT:-decisions.jsonl}"
ALERT_POLICY_FILE="${ALERT_POLICY_FILE:-${ROOT}/infra/watcher-silent-alert.yaml}"
STALE_ALERT_POLICY_FILE="${STALE_ALERT_POLICY_FILE:-${ROOT}/infra/watcher-stale-alert.yaml}"
DOCKERFILE="${DOCKERFILE:-${ROOT}/watcher/Dockerfile}"

IDENTITY_VARS=(
  VETO_RPC
  VETO_PROGRAM_ID
  VETO_MINT
  VETO_OWNER
  VETO_OWNER_TOKEN
  VETO_MERCHANT
  VETO_MERCHANT_TOKEN
  VETO_AGENT
)

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Must not be `local` inside deploy: the EXIT trap runs after deploy returns,
# and a function-local is already gone. With set -u that exits 1 after
# printing deployed.
env_file=""
cleanup_env_file() {
  if [[ -n "${env_file:-}" ]]; then
    rm -f "$env_file"
    env_file=""
  fi
}
trap cleanup_env_file EXIT

usage() {
  cat <<'EOF'
usage: ./scripts/deploy-watcher-cloud.sh [--check] [--dry-run]

Creates the journal bucket (public access prevention enforced), the agent
key in Secret Manager, the image, the Cloud Run jobs, the Cloud Scheduler
entries, and the two silent-journal alert policies (record too old, check
stopped reporting).

Before the secret is created, the script reads the project IAM policy and
the secret IAM policy (if the secret already exists) and stops if the
default compute account can read a secret version, naming the role and the
policy it was found on. Organization and folder policies are read when
possible; when they cannot be, the script says so.

Required environment:
  AGENT_KEY_PATH     path to the agent keypair JSON (never printed)
  VETO_RPC           Solana RPC URL
  VETO_PROGRAM_ID    program id
  VETO_MINT          mint
  VETO_OWNER         owner pubkey
  VETO_OWNER_TOKEN   owner token account
  VETO_MERCHANT      merchant pubkey
  VETO_MERCHANT_TOKEN merchant token account
  VETO_AGENT         agent pubkey

Optional environment:
  PROJECT            default veto-watcher-260921
  REGION             default europe-north1
  SCHEDULER_LOCATION default europe-west1 (Scheduler is not in europe-north1)
  BUCKET             default ${PROJECT}-journal
  ALERT_EMAIL        owner email for the silent-journal alert
  AGENT_KEY_PATH     required, no default
EOF
}

MODE="deploy"
SKIP_BUILD="${SKIP_BUILD:-0}"
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --dry-run) MODE="dry-run" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: ${arg} (try --help)" ;;
  esac
done

run() {
  if [[ "$MODE" == "dry-run" ]]; then
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    die "missing ${name}; set it in the environment (see watcher/CLOUD.md)"
  fi
}

need_no_quote() {
  local name="$1"
  local value="${!name}"
  case "$value" in
    *\"*) die "${name} contains a double quote; refuse rather than break the env file" ;;
  esac
}

require_agent_key_file() {
  local path="${AGENT_KEY_PATH:-}"
  [[ -n "$path" ]] || die "missing AGENT_KEY_PATH; set it to the agent keypair JSON on this machine"
  [[ -f "$path" ]] || die "agent key file not found at AGENT_KEY_PATH"
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      process.stderr.write("agent key file is not a JSON keypair array\n");
      process.exit(1);
    }
    if (!Array.isArray(data) || data.length < 64) {
      process.stderr.write("agent key file is not a JSON keypair array\n");
      process.exit(1);
    }
  ' "$path" || die "agent key file is not a JSON keypair array"
}

require_local_inputs() {
  need_cmd node
  [[ -f "$DOCKERFILE" ]] || die "missing ${DOCKERFILE}"
  [[ -f "${ROOT}/watcher/package-lock.json" ]] || die "missing watcher/package-lock.json"
  [[ -f "$ALERT_POLICY_FILE" ]] || die "missing ${ALERT_POLICY_FILE}"
  [[ -f "$STALE_ALERT_POLICY_FILE" ]] || die "missing ${STALE_ALERT_POLICY_FILE}"
  [[ -n "$PROJECT" ]] || die "missing PROJECT"
  [[ -n "$REGION" ]] || die "missing REGION"
  [[ -n "$BUCKET" ]] || die "missing BUCKET; set BUCKET to the journal bucket name"
  [[ -n "$SECRET_NAME" ]] || die "missing SECRET_NAME"
  require_agent_key_file
  local name
  for name in "${IDENTITY_VARS[@]}"; do
    need_var "$name"
    need_no_quote "$name"
  done
  need_no_quote PROJECT
  need_no_quote REGION
  need_no_quote BUCKET
  if [[ -n "${VETO_PURPOSE:-}" ]]; then
    need_no_quote VETO_PURPOSE
  fi
}

require_gcloud() {
  need_cmd gcloud
  local account
  account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | sed -n '1p' || true)"
  [[ -n "$account" ]] || die "gcloud is not logged in"
}

require_services() {
  local svc
  for svc in \
    run.googleapis.com \
    cloudscheduler.googleapis.com \
    secretmanager.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    storage.googleapis.com \
    monitoring.googleapis.com \
    logging.googleapis.com
  do
    if ! gcloud services list --enabled --project="$PROJECT" --filter="config.name:${svc}" --format='value(config.name)' | grep -x "$svc" >/dev/null; then
      die "required API ${svc} is not enabled on ${PROJECT}"
    fi
  done
}

write_env_file() {
  local dest="$1"
  local purpose="${VETO_PURPOSE:-SE3 home charging}"
  # gcloud --env-vars-file wants YAML, a mapping of key to value. Writing
  # KEY="value" is dotenv, which YAML reads as a single scalar and gcloud
  # rejects with "expected map-like data".
  cat > "$dest" <<EOF
VETO_RPC: "${VETO_RPC}"
VETO_PROGRAM_ID: "${VETO_PROGRAM_ID}"
VETO_MINT: "${VETO_MINT}"
VETO_OWNER: "${VETO_OWNER}"
VETO_OWNER_TOKEN: "${VETO_OWNER_TOKEN}"
VETO_MERCHANT: "${VETO_MERCHANT}"
VETO_MERCHANT_TOKEN: "${VETO_MERCHANT_TOKEN}"
VETO_AGENT: "${VETO_AGENT}"
VETO_KEYS_DIR: "/keys"
VETO_JOURNAL: "/tmp/veto/decisions.jsonl"
VETO_JOURNAL_GCS: "gs://${BUCKET}/${JOURNAL_OBJECT}"
VETO_MANDATE_ID: "${VETO_MANDATE_ID:-1}"
VETO_KWH_MILLI: "${VETO_KWH_MILLI:-50000}"
VETO_MINT_DECIMALS: "${VETO_MINT_DECIMALS:-6}"
VETO_PURPOSE: "${purpose}"
EOF
  # Both jobs read this file. Forward the variable only when the operator set it.
  if [[ -n "${VETO_QUOTE_CURRENCY:-}" ]]; then
    need_no_quote VETO_QUOTE_CURRENCY
    printf 'VETO_QUOTE_CURRENCY: "%s"\n' "${VETO_QUOTE_CURRENCY}" >> "$dest"
  fi
}

ensure_sa() {
  local email="$1"
  if gcloud iam service-accounts describe "$email" --project="$PROJECT" >/dev/null 2>&1; then
    log "service account exists: ${email}"
    return 0
  fi
  run gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Veto watcher" \
    --project="$PROJECT"
}

# IAM roles that include secretmanager.versions.access.
# Editor and Viewer do not. See Secret Manager access-control docs.
iam_policy_secret_access_rows() {
  python3 -c '
import json, sys
ACCESS = {
    "roles/owner",
    "roles/secretmanager.admin",
    "roles/secretmanager.secretAccessor",
}
KNOWN_NO = {
    "roles/editor",
    "roles/viewer",
    "roles/secretmanager.viewer",
    "roles/secretmanager.editor",
    "roles/secretmanager.secretVersionManager",
    "roles/secretmanager.secretVersionAdder",
}
raw = sys.stdin.read()
if not raw.strip():
    sys.stderr.write("empty IAM policy\n")
    sys.exit(2)
try:
    policy = json.loads(raw)
except json.JSONDecodeError as exc:
    sys.stderr.write("IAM policy is not JSON: %s\n" % exc)
    sys.exit(2)
if not isinstance(policy, dict):
    sys.stderr.write("IAM policy JSON is not an object\n")
    sys.exit(2)
for binding in policy.get("bindings") or []:
    if not isinstance(binding, dict):
        continue
    role = binding.get("role") or ""
    members = binding.get("members") or []
    if role in ACCESS:
        kind = "ACCESS"
    elif role in KNOWN_NO or not role:
        continue
    else:
        kind = "CHECK"
    for member in members:
        if not member or str(member).startswith("deleted:"):
            continue
        sys.stdout.write("%s\t%s\t%s\n" % (kind, role, member))
'
}

role_grants_versions_access_via_describe() {
  local role="$1"
  local perms rc=0
  perms="$(gcloud iam roles describe "$role" --format='value(includedPermissions)')" || rc=$?
  if [[ $rc -ne 0 ]]; then
    return 2
  fi
  if printf '%s\n' "$perms" | tr ';,' '\n' | grep -x 'secretmanager.versions.access' >/dev/null; then
    return 0
  fi
  return 1
}

scan_iam_json_into() {
  local json="$1"
  local where="$2"
  local findings="$3"
  local rows rc=0
  rows="$(printf '%s' "$json" | iam_policy_secret_access_rows)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    return 1
  fi
  local kind role member grant_rc
  while IFS=$'\t' read -r kind role member; do
    [[ -n "${kind:-}" ]] || continue
    if [[ "$kind" == ACCESS ]]; then
      printf '%s\t%s\t%s\n' "$member" "$role" "$where" >> "$findings"
      continue
    fi
    grant_rc=0
    role_grants_versions_access_via_describe "$role" || grant_rc=$?
    if [[ $grant_rc -eq 2 ]]; then
      printf 'could-not-describe\t%s\t%s\t%s\n' "$member" "$role" "$where" >> "$findings"
    elif [[ $grant_rc -eq 0 ]]; then
      printf '%s\t%s\t%s\n' "$member" "$role" "$where" >> "$findings"
    fi
  done <<< "$rows"
  return 0
}

# The default compute account is what a Cloud Run job uses when nobody passes
# --service-account. If that account can read a secret version, stop before
# the agent key is stored.
refuse_if_default_compute_can_read_secrets() {
  command -v python3 >/dev/null 2>&1 || die "missing required command: python3"
  local number rc=0
  number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')" || rc=$?
  if [[ $rc -ne 0 || -z "$number" ]]; then
    die "could not read project number for ${PROJECT}; refusing to create the secret"
  fi
  local email="${number}-compute@developer.gserviceaccount.com"
  local member="serviceAccount:${email}"
  local findings
  findings="$(mktemp)"

  local proj_json proj_err
  proj_err="$(mktemp)"
  rc=0
  proj_json="$(gcloud projects get-iam-policy "$PROJECT" --format=json 2>"$proj_err")" || rc=$?
  if [[ $rc -ne 0 ]]; then
    local err
    err="$(head -1 "$proj_err")"
    rm -f "$proj_err" "$findings"
    die "could not read project IAM policy for ${PROJECT}: ${err}; refusing to create the secret"
  fi
  rm -f "$proj_err"
  if ! scan_iam_json_into "$proj_json" "project policy" "$findings"; then
    rm -f "$findings"
    die "could not parse project IAM policy for ${PROJECT}; refusing to create the secret"
  fi

  local desc_err
  desc_err="$(mktemp)"
  rc=0
  gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" --format='value(name)' >/dev/null 2>"$desc_err" || rc=$?
  if [[ $rc -eq 0 ]]; then
    local sec_json sec_err sec_rc=0
    sec_err="$(mktemp)"
    sec_json="$(gcloud secrets get-iam-policy "$SECRET_NAME" --project="$PROJECT" --format=json 2>"$sec_err")" || sec_rc=$?
    if [[ $sec_rc -ne 0 ]]; then
      local err
      err="$(head -1 "$sec_err")"
      rm -f "$desc_err" "$sec_err" "$findings"
      die "could not read IAM policy on secret ${SECRET_NAME}: ${err}; refusing to store the agent key"
    fi
    rm -f "$sec_err"
    if ! scan_iam_json_into "$sec_json" "secret ${SECRET_NAME} policy" "$findings"; then
      rm -f "$desc_err" "$findings"
      die "could not parse IAM policy on secret ${SECRET_NAME}; refusing to store the agent key"
    fi
  else
    if ! grep -qi 'NOT_FOUND' "$desc_err"; then
      local err
      err="$(head -1 "$desc_err")"
      rm -f "$desc_err" "$findings"
      die "could not look up secret ${SECRET_NAME}: ${err}; refusing to create it"
    fi
  fi
  rm -f "$desc_err"

  local anc anc_err anc_rc=0
  anc_err="$(mktemp)"
  anc="$(gcloud projects get-ancestors "$PROJECT" --format=value'(id,type)' 2>"$anc_err")" || anc_rc=$?
  if [[ $anc_rc -ne 0 ]]; then
    log "cannot see IAM bindings above the project (get-ancestors failed: $(head -1 "$anc_err")). Those bindings were not inspected."
  else
    local id type looked=0 missed=0
    while IFS=$'\t' read -r id type; do
      [[ -n "${id:-}" ]] || continue
      case "$type" in
        project) continue ;;
        folder)
          looked=1
          local folder_json folder_err folder_rc=0
          folder_err="$(mktemp)"
          folder_json="$(gcloud resource-manager folders get-iam-policy "$id" --format=json 2>"$folder_err")" || folder_rc=$?
          if [[ $folder_rc -ne 0 ]]; then
            log "cannot see IAM bindings on folder ${id}: $(head -1 "$folder_err"). Bindings above the project were not fully inspected."
            missed=1
          elif ! scan_iam_json_into "$folder_json" "folder ${id} policy" "$findings"; then
            log "could not parse IAM policy on folder ${id}. Bindings above the project were not fully inspected."
            missed=1
          fi
          rm -f "$folder_err"
          ;;
        organization)
          looked=1
          local org_json org_err org_rc=0
          org_err="$(mktemp)"
          org_json="$(gcloud organizations get-iam-policy "$id" --format=json 2>"$org_err")" || org_rc=$?
          if [[ $org_rc -ne 0 ]]; then
            log "cannot see IAM bindings on organization ${id}: $(head -1 "$org_err"). Bindings above the project were not fully inspected."
            missed=1
          elif ! scan_iam_json_into "$org_json" "organization ${id} policy" "$findings"; then
            log "could not parse IAM policy on organization ${id}. Bindings above the project were not fully inspected."
            missed=1
          fi
          rm -f "$org_err"
          ;;
      esac
    done <<< "$anc"
    if [[ $looked -eq 0 ]]; then
      log "cannot see IAM bindings above the project (ancestry has no folder or organization). Those bindings were not inspected."
    elif [[ $missed -ne 0 ]]; then
      log "cannot see all IAM bindings above the project. A readable project policy is not proof of absence at the org or folder."
    fi
  fi
  rm -f "$anc_err"

  local hits undetermined
  hits="$(awk -F '\t' -v m="$member" -v e="$email" '$1 == m || $1 == e {print}' "$findings" || true)"
  undetermined="$(awk -F '\t' -v m="$member" -v e="$email" '$1 == "could-not-describe" && ($2 == m || $2 == e) {print}' "$findings" || true)"
  if [[ -n "$undetermined" ]]; then
    printf 'error: could not establish that default compute account %s cannot read a secret version\n' "$email" >&2
    while IFS=$'\t' read -r _ princ role where; do
      [[ -n "${princ:-}" ]] || continue
      printf '       could not describe %s bound on %s\n' "$role" "$where" >&2
    done <<< "$undetermined"
    rm -f "$findings"
    exit 1
  fi
  if [[ -n "$hits" ]]; then
    printf 'error: default compute account %s can read a secret version\n' "$email" >&2
    while IFS=$'\t' read -r princ role where; do
      [[ -n "${princ:-}" ]] || continue
      printf '       found: %s on %s\n' "$role" "$where" >&2
    done <<< "$hits"
    rm -f "$findings"
    exit 1
  fi
  rm -f "$findings"
}

pap_from_bucket_json() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    sys.stderr.write("empty bucket describe\n")
    sys.exit(2)
try:
    data = json.loads(raw)
except json.JSONDecodeError as exc:
    sys.stderr.write("bucket describe is not JSON: %s\n" % exc)
    sys.exit(2)
# gcloud has moved this field between releases: some versions nest it under
# iam_config, others return it at the top level of the describe. Reading only
# the nested shape made this check report empty on a bucket that was correctly
# enforced, which refuses every deploy on a false negative.
iam = data.get("iam_config") or data.get("iamConfig") or {}
value = (
    iam.get("public_access_prevention")
    or iam.get("publicAccessPrevention")
    or data.get("public_access_prevention")
    or data.get("publicAccessPrevention")
    or ""
)
sys.stdout.write(str(value))
'
}

enforce_public_access_prevention() {
  if [[ "$MODE" == "dry-run" ]]; then
    run gcloud storage buckets update "gs://${BUCKET}" \
      --public-access-prevention \
      --project="$PROJECT"
    return 0
  fi
  command -v python3 >/dev/null 2>&1 || die "missing required command: python3"
  gcloud storage buckets update "gs://${BUCKET}" \
    --public-access-prevention \
    --project="$PROJECT" \
    || die "could not set public access prevention to enforced on gs://${BUCKET}"
  local json pap rc=0
  json="$(gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT" --format=json)" || rc=$?
  if [[ $rc -ne 0 || -z "$json" ]]; then
    die "could not read public access prevention on gs://${BUCKET}"
  fi
  pap="$(printf '%s' "$json" | pap_from_bucket_json)" || die "could not parse public access prevention on gs://${BUCKET}"
  [[ "$pap" == "enforced" ]] || die "public access prevention on gs://${BUCKET} is '${pap:-<empty>}', wanted enforced"
}

ensure_bucket() {
  if gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT" >/dev/null 2>&1; then
    log "bucket exists: gs://${BUCKET}"
  else
    if [[ "$MODE" == "dry-run" ]]; then
      run gcloud storage buckets create "gs://${BUCKET}" \
        --location="$REGION" \
        --uniform-bucket-level-access \
        --public-access-prevention \
        --project="$PROJECT"
    else
      gcloud storage buckets create "gs://${BUCKET}" \
        --location="$REGION" \
        --uniform-bucket-level-access \
        --public-access-prevention \
        --project="$PROJECT" \
        || die "could not create gs://${BUCKET} with public access prevention enforced"
    fi
  fi
  enforce_public_access_prevention
  if gcloud storage objects describe "gs://${BUCKET}/${JOURNAL_OBJECT}" --project="$PROJECT" >/dev/null 2>&1; then
    log "journal object exists: gs://${BUCKET}/${JOURNAL_OBJECT}"
  else
    local empty
    empty="$(mktemp)"
    : > "$empty"
    run gcloud storage cp "$empty" "gs://${BUCKET}/${JOURNAL_OBJECT}" --project="$PROJECT"
    rm -f "$empty"
  fi
}

ensure_secret() {
  if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" >/dev/null 2>&1; then
    log "secret exists: ${SECRET_NAME} (adding a new version from AGENT_KEY_PATH)"
    run gcloud secrets versions add "$SECRET_NAME" \
      --data-file="${AGENT_KEY_PATH}" \
      --project="$PROJECT"
  else
    run gcloud secrets create "$SECRET_NAME" \
      --data-file="${AGENT_KEY_PATH}" \
      --replication-policy=automatic \
      --project="$PROJECT"
  fi
}

ensure_ar_repo() {
  if gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
    log "artifact registry repo exists: ${AR_REPO}"
    return 0
  fi
  run gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Veto watcher images" \
    --project="$PROJECT"
}

ensure_scheduler() {
  local name="$1"
  local schedule="$2"
  local uri="$3"
  local sa_email="$4"
  if gcloud scheduler jobs describe "$name" --location="$SCHEDULER_LOCATION" --project="$PROJECT" >/dev/null 2>&1; then
    run gcloud scheduler jobs update http "$name" \
      --location="$SCHEDULER_LOCATION" \
      --schedule="$schedule" \
      --time-zone="Europe/Stockholm" \
      --uri="$uri" \
      --http-method=POST \
      --oauth-service-account-email="$sa_email" \
      --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
      --project="$PROJECT"
  else
    run gcloud scheduler jobs create http "$name" \
      --location="$SCHEDULER_LOCATION" \
      --schedule="$schedule" \
      --time-zone="Europe/Stockholm" \
      --uri="$uri" \
      --http-method=POST \
      --oauth-service-account-email="$sa_email" \
      --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
      --project="$PROJECT"
  fi
}

policy_name_by_display() {
  gcloud monitoring policies list \
    --project="$PROJECT" \
    --filter="displayName=\"${1}\"" \
    --format='value(name)' | sed -n '1p' || true
}

# Merge a comma-separated channel list with an optional extra channel.
merge_channels() {
  local combined="${1:-}"
  local extra="${2:-}"
  if [[ -z "$extra" ]]; then
    printf '%s' "$combined"
    return 0
  fi
  case ",${combined}," in
    *",${extra},"*) printf '%s' "$combined" ;;
    *)
      if [[ -n "$combined" ]]; then
        printf '%s,%s' "$combined" "$extra"
      else
        printf '%s' "$extra"
      fi
      ;;
  esac
}

ensure_one_alert() {
  local display_name="$1"
  local policy_file="$2"
  local ch="${3:-}"
  local existing preserved="" combined
  existing="$(policy_name_by_display "$display_name")"
  if [[ -n "$existing" ]]; then
    log "alert policy exists: ${existing}"
    # Replacing a policy from file drops notification channels. Read them
    # first, then put them back on the same update.
    if [[ "$MODE" != "dry-run" ]]; then
      preserved="$(gcloud monitoring policies describe "$existing" \
        --project="$PROJECT" \
        --format='value[separator=","](notificationChannels)' 2>/dev/null || true)"
    fi
    combined="$(merge_channels "$preserved" "$ch")"
    if [[ -n "$combined" ]]; then
      run gcloud monitoring policies update "$existing" \
        --policy-from-file="$policy_file" \
        --set-notification-channels="$combined" \
        --project="$PROJECT"
    else
      run gcloud monitoring policies update "$existing" \
        --policy-from-file="$policy_file" \
        --project="$PROJECT"
    fi
    return 0
  fi
  if [[ -n "$ch" ]]; then
    run gcloud monitoring policies create \
      --policy-from-file="$policy_file" \
      --notification-channels="$ch" \
      --project="$PROJECT"
  else
    run gcloud monitoring policies create \
      --policy-from-file="$policy_file" \
      --project="$PROJECT"
  fi
}

ensure_alert() {
  local ch=""
  if [[ -n "${ALERT_EMAIL:-}" ]]; then
    ch="$(gcloud beta monitoring channels list --project="$PROJECT" --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" --format='value(name)' | sed -n '1p' || true)"
    if [[ -z "$ch" ]]; then
      run gcloud beta monitoring channels create \
        --display-name="Veto watcher owner" \
        --type=email \
        --channel-labels="email_address=${ALERT_EMAIL}" \
        --project="$PROJECT"
      if [[ "$MODE" != "dry-run" ]]; then
        ch="$(gcloud beta monitoring channels list --project="$PROJECT" --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" --format='value(name)' | sed -n '1p' || true)"
      fi
    fi
  else
    log "ALERT_EMAIL is unset; the policies are created without a channel. See watcher/CLOUD.md to point them at an address."
  fi
  ensure_one_alert "Veto watcher silent" "$ALERT_POLICY_FILE" "$ch"
  ensure_one_alert "Veto watcher record too old" "$STALE_ALERT_POLICY_FILE" "$ch"
}

deploy() {
  require_local_inputs
  if [[ "$MODE" == "check" ]]; then
    log "check ok: local inputs present for project ${PROJECT} region ${REGION} bucket ${BUCKET}"
    return 0
  fi
  require_gcloud
  if [[ "$MODE" != "dry-run" ]]; then
    require_services
  fi

  local sa_email="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  local image="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${IMAGE_NAME}:latest"
  local once_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_NAME}:run"
  local stale_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${STALE_JOB_NAME}:run"
  env_file="$(mktemp)"
  write_env_file "$env_file"

  ensure_sa "$sa_email"
  ensure_bucket
  refuse_if_default_compute_can_read_secrets
  ensure_secret
  ensure_ar_repo

  local project_number
  if [[ "$MODE" == "dry-run" ]]; then
    project_number="PROJECT_NUMBER"
  else
    project_number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
    [[ -n "$project_number" ]] || die "could not read project number for ${PROJECT}"
  fi

  run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
    --location="$REGION" \
    --member="serviceAccount:${project_number}@cloudbuild.gserviceaccount.com" \
    --role="roles/artifactregistry.writer" \
    --project="$PROJECT"

  run gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/storage.objectAdmin" \
    --project="$PROJECT"

  run gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT"

  run gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/logging.logWriter" \
    --quiet

  run gcloud iam service-accounts add-iam-policy-binding "$sa_email" \
    --member="serviceAccount:service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser" \
    --project="$PROJECT"

  if [[ "$SKIP_BUILD" == "1" ]]; then
    log "skipping build, expecting $image to exist already"
    if [[ "$MODE" != "dry-run" ]]; then
      gcloud artifacts docker images describe "$image" --project="$PROJECT" >/dev/null 2>&1 \
        || die "--skip-build was given but $image does not exist"
    fi
  else
    run gcloud builds submit "${ROOT}/watcher" \
      --tag="$image" \
      --project="$PROJECT"
  fi

  run gcloud run jobs deploy "$JOB_NAME" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=1 \
    --task-timeout=15m \
    --cpu=1 \
    --memory=1Gi \
    --set-secrets="/keys/agent.json=${SECRET_NAME}:latest" \
    --env-vars-file="$env_file" \
    --command=node \
    --args=dist/index.js,once

  run gcloud run jobs deploy "$STALE_JOB_NAME" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=0 \
    --task-timeout=5m \
    --cpu=1 \
    --memory=512Mi \
    --set-secrets="/keys/agent.json=${SECRET_NAME}:latest" \
    --env-vars-file="$env_file" \
    --command=node \
    --args=dist/index.js,stale

  cleanup_env_file

  run gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
    --region="$REGION" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/run.invoker" \
    --project="$PROJECT"

  run gcloud run jobs add-iam-policy-binding "$STALE_JOB_NAME" \
    --region="$REGION" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/run.invoker" \
    --project="$PROJECT"

  ensure_scheduler "$SCHEDULER_JOB" "0 0,6,12,18 * * *" "$once_uri" "$sa_email"
  ensure_scheduler "$STALE_SCHEDULER_JOB" "0 * * * *" "$stale_uri" "$sa_email"
  ensure_alert

  log "deployed ${JOB_NAME} in ${REGION} on ${PROJECT}"
  log "scheduler ${SCHEDULER_JOB} in ${SCHEDULER_LOCATION} (Europe/Stockholm 00,06,12,18)"
  log "stale job ${STALE_JOB_NAME} hourly; alert policies 'Veto watcher silent' and 'Veto watcher record too old'"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  deploy
fi
