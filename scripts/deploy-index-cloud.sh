#!/usr/bin/env bash
# Create or update the index service on Google Cloud: a Cloud SQL Postgres 16
# instance, the read API and webhook Cloud Run services, the migration runner
# as a one-off Cloud Run job, and the backfill job with its schedule.
# Idempotent. Refuses before creating anything if a required input is missing
# or the working tree is not clean. Never prints a secret.
#
# The owner runs this. It does not run from CI. See docs/GCP_SETUP.md.
#
#   PROJECT=my-project REGION=europe-north1 ./scripts/deploy-index-cloud.sh --check
#   PROJECT=my-project REGION=europe-north1 ./scripts/deploy-index-cloud.sh --dry-run
#   PROJECT=my-project REGION=europe-north1 ./scripts/deploy-index-cloud.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# PROJECT and REGION have no defaults: the target must be named explicitly.
PROJECT="${PROJECT:-}"
REGION="${REGION:-}"
INSTANCE="${INSTANCE:-veto-index-pg}"
DB_NAME="${DB_NAME:-veto_index}"
DB_USER="${DB_USER:-veto_index_app}"
SA_NAME="${SA_NAME:-veto-index}"
AR_REPO="${AR_REPO:-veto-index}"
IMAGE_NAME="${IMAGE_NAME:-index}"
API_SERVICE="${API_SERVICE:-veto-index}"
WEBHOOK_SERVICE="${WEBHOOK_SERVICE:-veto-index-webhook}"
MIGRATE_JOB="${MIGRATE_JOB:-veto-index-migrate}"
BACKFILL_JOB="${BACKFILL_JOB:-veto-index-backfill}"
SCHEDULER_JOB="${SCHEDULER_JOB:-veto-index-backfill-hourly}"
# Cloud Scheduler is not offered in europe-north1 (Finland). Belgium is the
# nearest Scheduler region; the job it invokes still runs in REGION.
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-europe-west1}"
SECRET_WEBHOOK="${SECRET_WEBHOOK:-veto-index-webhook-auth}"
SECRET_DB="${SECRET_DB:-veto-index-database-url}"
SECRET_RPC="${SECRET_RPC:-veto-index-rpc-url}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-4}"
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-5}"
SMOKE_DELAY="${SMOKE_DELAY:-5}"
DOCKERFILE="${DOCKERFILE:-${ROOT}/service/Dockerfile}"

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Secret values registered here are replaced with *** in dry-run output.
MASK_VALUES=()

# Staged secret files and the generated build config live in one private
# directory, removed on exit. Must not be `local`: the EXIT trap runs after
# deploy returns, and a function-local is already gone.
tmpdir=""
cleanup_tmpdir() {
  if [[ -n "${tmpdir:-}" ]]; then
    rm -rf "$tmpdir"
    tmpdir=""
  fi
}
trap cleanup_tmpdir EXIT

ensure_tmpdir() {
  if [[ -z "$tmpdir" ]]; then
    tmpdir="$(mktemp -d)"
    chmod 700 "$tmpdir"
  fi
}

# Write a secret value to a private temp file and print the path. The value
# never appears on a command line.
stage_value() {
  local name="$1"
  local value="$2"
  ensure_tmpdir
  local f="${tmpdir}/${name}"
  printf '%s' "$value" > "$f"
  chmod 600 "$f"
  printf '%s' "$f"
}

usage() {
  cat <<'EOF'
usage: ./scripts/deploy-index-cloud.sh [--check] [--dry-run] [--skip-build]

Creates the Cloud SQL Postgres 16 instance, the veto_index database and its
application user, the three secrets (webhook auth header, database URL, RPC
URL), the Artifact Registry repo, the image, the migration Cloud Run job,
the read API and webhook Cloud Run services, the backfill Cloud Run job, and
the hourly backfill schedule. Migrations run to completion before the new
revision is deployed, and a smoke check against GET /v1/health must pass
before the script reports success.

The database URL secret and the Cloud SQL user are created together, once.
The URL carries the generated password, so a later run changes neither. If
exactly one of the pair exists, the script refuses rather than guess.

Required environment (no defaults; pass them explicitly):
  PROJECT            target Google Cloud project
  REGION             target region for Cloud Run and Cloud SQL
  INDEX_WEBHOOK_AUTH exact Authorization header value Helius sends (never printed)
  VETO_RPC           Solana RPC URL (never printed)

Optional environment:
  INSTANCE           default veto-index-pg
  DB_NAME            default veto_index
  DB_USER            default veto_index_app
  SCHEDULER_LOCATION default europe-west1 (Scheduler is not in europe-north1)
  MIN_INSTANCES      default 1
  MAX_INSTANCES      default 4
  SMOKE_ATTEMPTS     default 5
  SMOKE_DELAY        default 5 (seconds between smoke attempts)
  TAG                image tag, default the short commit of HEAD
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

mask_arg() {
  local s="$1"
  local v
  for v in ${MASK_VALUES[@]+"${MASK_VALUES[@]}"}; do
    if [[ -n "$v" ]]; then
      s="${s//"$v"/***}"
    fi
  done
  printf '%s' "$s"
}

run() {
  if [[ "$MODE" == "dry-run" ]]; then
    local masked=()
    local arg
    for arg in "$@"; do
      masked+=("$(mask_arg "$arg")")
    done
    printf 'dry-run:'
    printf ' %q' "${masked[@]}"
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
    die "missing ${name}; set it in the environment (see docs/GCP_SETUP.md)"
  fi
}

require_clean_tree() {
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "${ROOT} is not inside a git work tree"
  local dirty
  dirty="$(git -C "$ROOT" status --porcelain)"
  [[ -z "$dirty" ]] \
    || die "working tree is not clean; commit or stash so the image tag matches a commit"
}

require_local_inputs() {
  need_cmd git
  need_cmd python3
  [[ -f "$DOCKERFILE" ]] || die "missing ${DOCKERFILE}"
  [[ -f "${ROOT}/service/docker-entrypoint.sh" ]] || die "missing service/docker-entrypoint.sh"
  [[ -f "${ROOT}/service/package-lock.json" ]] || die "missing service/package-lock.json"
  [[ -f "${ROOT}/indexer/package-lock.json" ]] || die "missing indexer/package-lock.json"
  [[ -n "$PROJECT" ]] || die "missing PROJECT; pass the target project explicitly (export PROJECT=...)"
  [[ -n "$REGION" ]] || die "missing REGION; pass the target region explicitly (export REGION=...)"
  need_var INDEX_WEBHOOK_AUTH
  need_var VETO_RPC
  require_clean_tree
  MASK_VALUES+=("$INDEX_WEBHOOK_AUTH" "$VETO_RPC")
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
    sqladmin.googleapis.com \
    secretmanager.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    cloudscheduler.googleapis.com \
    logging.googleapis.com
  do
    if ! gcloud services list --enabled --project="$PROJECT" --filter="config.name:${svc}" --format='value(config.name)' | grep -x "$svc" >/dev/null; then
      die "required API ${svc} is not enabled on ${PROJECT}"
    fi
  done
}

ensure_sa() {
  local email="$1"
  if gcloud iam service-accounts describe "$email" --project="$PROJECT" >/dev/null 2>&1; then
    log "service account exists: ${email}"
    return 0
  fi
  run gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Veto index service" \
    --project="$PROJECT"
}

ensure_sql_instance() {
  if gcloud sql instances describe "$INSTANCE" --project="$PROJECT" >/dev/null 2>&1; then
    log "sql instance exists: ${INSTANCE}"
    return 0
  fi
  # No authorized networks: only the Cloud SQL connector can reach the
  # instance, from the service account named on each Cloud Run resource.
  run gcloud sql instances create "$INSTANCE" \
    --project="$PROJECT" \
    --region="$REGION" \
    --database-version=POSTGRES_16 \
    --tier=db-f1-micro \
    --storage-type=HDD \
    --storage-size=10GB \
    --availability-type=zonal \
    --no-deletion-protection
}

ensure_database() {
  if gcloud sql databases describe "$DB_NAME" --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1; then
    log "database exists: ${DB_NAME}"
    return 0
  fi
  run gcloud sql databases create "$DB_NAME" \
    --instance="$INSTANCE" \
    --project="$PROJECT"
}

sql_users() {
  local rc=0
  local users
  users="$(gcloud sql users list --instance="$INSTANCE" --project="$PROJECT" --format='value(name)')" || rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ "$MODE" == "dry-run" ]]; then
      printf ''
      return 0
    fi
    die "could not list users on instance ${INSTANCE}"
  fi
  printf '%s' "$users"
}

secret_exists() {
  gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1
}

# The database URL embeds the generated password, so the user and the secret
# are created together and never updated by later runs. If exactly one of the
# pair exists, the password is unrecoverable: refuse rather than guess.
ensure_db_user_and_url_secret() {
  local users
  users="$(sql_users)"
  local user_exists=1
  if printf '%s\n' "$users" | grep -x "$DB_USER" >/dev/null; then
    user_exists=0
  fi
  local secret_exists_rc=0
  if secret_exists "$SECRET_DB"; then
    secret_exists_rc=1
  fi
  if [[ $user_exists -eq 0 && $secret_exists_rc -eq 1 ]]; then
    log "database user ${DB_USER} and secret ${SECRET_DB} exist"
    return 0
  fi
  if [[ $user_exists -eq 0 ]]; then
    die "database user ${DB_USER} exists on ${INSTANCE} but secret ${SECRET_DB} is missing; the password is not recoverable. Delete the user or create the secret to match, then rerun."
  fi
  if [[ $secret_exists_rc -eq 1 ]]; then
    die "secret ${SECRET_DB} exists but database user ${DB_USER} is missing on ${INSTANCE}. Delete the secret or create the user to match, then rerun."
  fi
  local db_password
  db_password="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  local database_url="postgresql://${DB_USER}:${db_password}@localhost:5432/${DB_NAME}?host=/cloudsql/${PROJECT}:${REGION}:${INSTANCE}"
  MASK_VALUES+=("$db_password" "$database_url")
  run gcloud sql users create "$DB_USER" \
    --instance="$INSTANCE" \
    --project="$PROJECT" \
    --password="$db_password"
  local url_file
  url_file="$(stage_value database-url "$database_url")"
  run gcloud secrets create "$SECRET_DB" \
    --data-file="$url_file" \
    --replication-policy=automatic \
    --project="$PROJECT"
}

ensure_secret() {
  local name="$1"
  local value="$2"
  local file
  file="$(stage_value "$name" "$value")"
  if secret_exists "$name"; then
    log "secret exists: ${name} (adding a new version from the environment)"
    run gcloud secrets versions add "$name" \
      --data-file="$file" \
      --project="$PROJECT"
  else
    run gcloud secrets create "$name" \
      --data-file="$file" \
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
    --description="Veto index service images" \
    --project="$PROJECT"
}

# Stage only Dockerfile inputs. Nested ignore files cannot protect a repo-root
# upload. Keep the context separate from the temporary secret files and config.
build_image() {
  local image="$1"
  ensure_tmpdir
  local context="${tmpdir}/context"
  python3 "${ROOT}/scripts/stage-index-context.py" "$ROOT" "$context"
  local cb="${tmpdir}/cloudbuild.yaml"
  cat > "$cb" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${image}', '-f', 'service/Dockerfile', '.']
images: ['${image}']
EOF
  log "image build: docker build -t ${image} -f service/Dockerfile . (context: minimal staged inputs)"
  run gcloud builds submit \
    --config="$cb" \
    --project="$PROJECT" \
    "$context"
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

smoke_check() {
  if [[ "$MODE" == "dry-run" ]]; then
    log "dry-run: smoke check would GET https://<${API_SERVICE} url>/v1/health and require a healthy body"
    return 0
  fi
  need_cmd curl
  local url
  url="$(gcloud run services describe "$API_SERVICE" \
    --region="$REGION" \
    --project="$PROJECT" \
    --format='value(status.url)')"
  [[ -n "$url" ]] || die "could not read the service URL for ${API_SERVICE}"
  local attempt body
  for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++)); do
    if body="$(curl -fsS --max-time 20 "${url}/v1/health" 2>/dev/null)"; then
      if printf '%s' "$body" | grep '"chain_tip_slot"' >/dev/null; then
        log "smoke check ok: GET ${url}/v1/health"
        return 0
      fi
    fi
    if [[ "$attempt" -lt "$SMOKE_ATTEMPTS" ]]; then
      sleep "$SMOKE_DELAY"
    fi
  done
  die "smoke check failed: GET ${url}/v1/health did not return a healthy body after ${SMOKE_ATTEMPTS} attempts"
}

deploy() {
  require_local_inputs
  if [[ "$MODE" == "check" ]]; then
    log "check ok: local inputs present for project ${PROJECT} region ${REGION}"
    return 0
  fi
  require_gcloud
  if [[ "$MODE" != "dry-run" ]]; then
    require_services
  fi

  local tag="${TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}"
  local sa_email="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  local image="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${IMAGE_NAME}:${tag}"
  local conn="${PROJECT}:${REGION}:${INSTANCE}"
  local backfill_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${BACKFILL_JOB}:run"

  ensure_sa "$sa_email"
  ensure_sql_instance
  ensure_database
  ensure_db_user_and_url_secret
  ensure_secret "$SECRET_WEBHOOK" "$INDEX_WEBHOOK_AUTH"
  ensure_secret "$SECRET_RPC" "$VETO_RPC"
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

  local secret_name
  for secret_name in "$SECRET_WEBHOOK" "$SECRET_DB" "$SECRET_RPC"; do
    run gcloud secrets add-iam-policy-binding "$secret_name" \
      --member="serviceAccount:${sa_email}" \
      --role="roles/secretmanager.secretAccessor" \
      --project="$PROJECT"
  done

  # The Cloud SQL connector authenticates as the service account.
  run gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/cloudsql.client" \
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
    build_image "$image"
  fi

  # Migrations run as a one-off job on the new image and must finish
  # successfully before any new revision serves.
  # --args replaces only the CMD; the image ENTRYPOINT stays, because it
  # translates DATABASE_URL into the PG* variables node-postgres reads.
  run gcloud run jobs deploy "$MIGRATE_JOB" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --add-cloudsql-instances="$conn" \
    --set-secrets="DATABASE_URL=${SECRET_DB}:latest" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=0 \
    --task-timeout=10m \
    --cpu=1 \
    --memory=512Mi \
    --args=node,dist/service/src/db/cli.js

  run gcloud run jobs execute "$MIGRATE_JOB" \
    --region="$REGION" \
    --project="$PROJECT" \
    --wait \
    || die "migrations job ${MIGRATE_JOB} failed; refusing to deploy a new revision"

  run gcloud run deploy "$API_SERVICE" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --add-cloudsql-instances="$conn" \
    --set-secrets="DATABASE_URL=${SECRET_DB}:latest,VETO_RPC=${SECRET_RPC}:latest" \
    --set-env-vars="HOST=0.0.0.0" \
    --port=8080 \
    --min-instances="$MIN_INSTANCES" \
    --max-instances="$MAX_INSTANCES" \
    --cpu=1 \
    --memory=512Mi \
    --args=node,dist/service/src/api/cli.js \
    --allow-unauthenticated

  run gcloud run deploy "$WEBHOOK_SERVICE" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --add-cloudsql-instances="$conn" \
    --set-secrets="DATABASE_URL=${SECRET_DB}:latest,VETO_RPC=${SECRET_RPC}:latest,INDEX_WEBHOOK_AUTH=${SECRET_WEBHOOK}:latest" \
    --port=8080 \
    --min-instances="$MIN_INSTANCES" \
    --max-instances="$MAX_INSTANCES" \
    --cpu=1 \
    --memory=512Mi \
    --args=node,dist/service/src/sources/webhook.js \
    --allow-unauthenticated

  run gcloud run jobs deploy "$BACKFILL_JOB" \
    --image="$image" \
    --region="$REGION" \
    --project="$PROJECT" \
    --service-account="$sa_email" \
    --add-cloudsql-instances="$conn" \
    --set-secrets="DATABASE_URL=${SECRET_DB}:latest,VETO_RPC=${SECRET_RPC}:latest" \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=1 \
    --task-timeout=30m \
    --cpu=1 \
    --memory=512Mi \
    --args=node,dist/service/src/sources/backfill.js

  run gcloud run jobs add-iam-policy-binding "$BACKFILL_JOB" \
    --region="$REGION" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/run.invoker" \
    --project="$PROJECT"

  ensure_scheduler "$SCHEDULER_JOB" "13 * * * *" "$backfill_uri" "$sa_email"

  smoke_check

  log "deployed ${API_SERVICE} and ${WEBHOOK_SERVICE} in ${REGION} on ${PROJECT} at ${image}"
  log "database ${DB_NAME} on ${INSTANCE} (Postgres 16, connector only)"
  log "migrations job ${MIGRATE_JOB} ran before this revision; backfill ${BACKFILL_JOB} hourly via ${SCHEDULER_JOB} in ${SCHEDULER_LOCATION}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  deploy
fi
