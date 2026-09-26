#!/usr/bin/env bash
# Critic round 3 fixtures for scripts/deploy-watcher-cloud.sh.
#
# Fake gcloud only. No credentials, no network, no live project. Proves the
# default-compute secret-access guard, public access prevention read-back,
# and that a permission error is a stop rather than an all-clear.
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

DIR="$(mktemp -d "${TMPDIR:-/tmp}/deploy-critic-r3.XXXXXX")"
trap 'rm -rf "$DIR"' EXIT
KEY="${DIR}/agent.json"
python3 -c 'import json,sys; json.dump([0]*64, open(sys.argv[1],"w"))' "$KEY"
FAKE_BIN="${DIR}/bin"
mkdir -p "$FAKE_BIN"
FAKE_LOG="${DIR}/gcloud.log"

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
if [[ "$args" == *'iam roles describe'* ]]; then
  if [[ "$mode" == role-describe-denied ]]; then
    printf 'PERMISSION_DENIED: iam.roles.get\n' >&2
    exit 1
  fi
  if [[ "$args" == *'customSecretReader'* ]]; then
    printf 'secretmanager.versions.access;secretmanager.secrets.get\n'
    exit 0
  fi
  printf 'storage.objects.get\n'
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
  if [[ "$mode" == iam-denied ]]; then
    printf 'PERMISSION_DENIED: resourcemanager.projects.getIamPolicy\n' >&2
    exit 1
  fi
  if [[ "$mode" == project-accessor || "$mode" == pap-new-enforced-accessor || "$mode" == pap-existing-enforced-accessor ]]; then
    printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:123456789-compute@developer.gserviceaccount.com"]}]}\n'
    exit 0
  fi
  if [[ "$mode" == indirect-accessor ]]; then
    printf '{"bindings":[{"role":"projects/veto-watcher-260921/roles/customSecretReader","members":["serviceAccount:123456789-compute@developer.gserviceaccount.com"]}]}\n'
    exit 0
  fi
  if [[ "$mode" == role-describe-denied ]]; then
    printf '{"bindings":[{"role":"projects/veto-watcher-260921/roles/customSecretReader","members":["serviceAccount:123456789-compute@developer.gserviceaccount.com"]}]}\n'
    exit 0
  fi
  printf '{"bindings":[]}\n'
  exit 0
fi
if [[ "$args" == *'secrets get-iam-policy'* ]]; then
  if [[ "$mode" == secret-iam-denied ]]; then
    printf 'PERMISSION_DENIED: secretmanager.secrets.getIamPolicy\n' >&2
    exit 1
  fi
  if [[ "$mode" == secret-accessor ]]; then
    printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:123456789-compute@developer.gserviceaccount.com"]}]}\n'
    exit 0
  fi
  printf '{"bindings":[]}\n'
  exit 0
fi
if [[ "$args" == *'secrets describe'* ]]; then
  if [[ "$mode" == secret-accessor || "$mode" == secret-iam-denied ]]; then
    printf 'veto-agent-keypair\n'
    exit 0
  fi
  printf 'NOT_FOUND: Secret [veto-agent-keypair] not found.\n' >&2
  exit 1
fi
if [[ "$args" == *'storage buckets describe'* ]]; then
  if [[ "$mode" == pap-new-inherited || "$mode" == pap-new-enforced-accessor || "$mode" == pap-create-fail ]]; then
    if [[ "$args" == *'format=json'* ]]; then
      if [[ "$mode" == pap-new-inherited ]]; then
        printf '{"iam_config":{"public_access_prevention":"inherited","uniform_bucket_level_access":{"enabled":true}}}\n'
        exit 0
      fi
      printf '{"iam_config":{"public_access_prevention":"enforced","uniform_bucket_level_access":{"enabled":true}}}\n'
      exit 0
    fi
    printf 'NOT_FOUND\n' >&2
    exit 1
  fi
  if [[ "$mode" == pap-update-fail ]]; then
    if [[ "$args" == *'format=json'* ]]; then
      printf '{"iam_config":{"public_access_prevention":"inherited","uniform_bucket_level_access":{"enabled":true}}}\n'
      exit 0
    fi
    exit 0
  fi
  if [[ "$args" == *'format=json'* ]]; then
    if [[ "$mode" == pap-existing-inherited ]]; then
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
  exit 0
fi
exit 0
EOF
chmod +x "${FAKE_BIN}/gcloud"

run_deploy() {
  local mode="$1"
  shift
  : >"$FAKE_LOG"
  FAKE_GCLOUD_MODE="$mode" FAKE_GCLOUD_LOG="$FAKE_LOG" \
    env -i \
    PATH="${FAKE_BIN}:${PATH}" \
    HOME="$DIR" \
    FAKE_GCLOUD_MODE="$mode" \
    FAKE_GCLOUD_LOG="$FAKE_LOG" \
    AGENT_KEY_PATH="$KEY" \
    "${IDENTITIES[@]}" \
    "$SCRIPT" "$@"
}

secret_write_in_log() {
  grep -E 'secrets create|secrets versions add' "$FAKE_LOG" >/dev/null
}

# Project binding.
if out="$(run_deploy project-accessor --dry-run 2>&1)"; then
  bad "project-level secretAccessor on the default compute account must stop deploy"
else
  if printf '%s' "$out" | grep 'default compute account 123456789-compute@developer.gserviceaccount.com can read a secret version' >/dev/null \
    && printf '%s' "$out" | grep 'found: roles/secretmanager.secretAccessor on project policy' >/dev/null; then
    if secret_write_in_log; then
      bad "project-level secretAccessor must stop before secrets create/add"
    else
      pass "project binding: deploy stops before the secret is created and names the role and policy"
    fi
  else
    bad "project-level secretAccessor message: ${out}"
  fi
fi

# Secret binding.
if out="$(run_deploy secret-accessor --dry-run 2>&1)"; then
  bad "secret-level secretAccessor on the default compute account must stop deploy"
else
  if printf '%s' "$out" | grep 'default compute account 123456789-compute@developer.gserviceaccount.com can read a secret version' >/dev/null \
    && printf '%s' "$out" | grep 'found: roles/secretmanager.secretAccessor on secret veto-agent-keypair policy' >/dev/null; then
    if secret_write_in_log; then
      bad "secret-level secretAccessor must stop before secrets create/add"
    else
      pass "secret binding: deploy stops before a new version is stored and names the secret policy"
    fi
  else
    bad "secret-level secretAccessor message: ${out}"
  fi
fi

# Indirect role: not in the hardcoded ACCESS set; includedPermissions has versions.access.
if out="$(run_deploy indirect-accessor --dry-run 2>&1)"; then
  bad "custom role that grants secretmanager.versions.access must stop deploy"
else
  if printf '%s' "$out" | grep 'default compute account 123456789-compute@developer.gserviceaccount.com can read a secret version' >/dev/null \
    && printf '%s' "$out" | grep 'found: projects/veto-watcher-260921/roles/customSecretReader on project policy' >/dev/null; then
    if secret_write_in_log; then
      bad "indirect role must stop before secrets create/add"
    else
      pass "indirect role: deploy stops before the secret is created and names the custom role"
    fi
  else
    bad "indirect role message: ${out}"
  fi
fi

# The check itself fails: permission denied on the project policy.
if out="$(run_deploy iam-denied --dry-run 2>&1)"; then
  bad "permission denied on project IAM policy must stop deploy"
else
  if printf '%s' "$out" | grep 'could not read project IAM policy' >/dev/null \
    && printf '%s' "$out" | grep 'PERMISSION_DENIED' >/dev/null \
    && printf '%s' "$out" | grep 'refusing to create the secret' >/dev/null; then
    if secret_write_in_log; then
      bad "project IAM permission denied must stop before secrets create/add"
    else
      pass "project IAM permission denied stops deploy rather than treating the error as an all-clear"
    fi
  else
    bad "project IAM permission denied message: ${out}"
  fi
fi

# Permission denied on the secret policy when the secret already exists.
if out="$(run_deploy secret-iam-denied --dry-run 2>&1)"; then
  bad "permission denied on secret IAM policy must stop deploy"
else
  if printf '%s' "$out" | grep 'could not read IAM policy on secret' >/dev/null \
    && printf '%s' "$out" | grep 'PERMISSION_DENIED' >/dev/null \
    && printf '%s' "$out" | grep 'refusing to store the agent key' >/dev/null; then
    if secret_write_in_log; then
      bad "secret IAM permission denied must stop before secrets create/add"
    else
      pass "secret IAM permission denied stops deploy rather than treating the error as an all-clear"
    fi
  else
    bad "secret IAM permission denied message: ${out}"
  fi
fi

# Permission denied describing a CHECK role bound to the default compute account.
if out="$(run_deploy role-describe-denied --dry-run 2>&1)"; then
  bad "permission denied describing a bound role must stop deploy"
else
  if printf '%s' "$out" | grep 'could not establish that default compute account' >/dev/null \
    && printf '%s' "$out" | grep 'could not describe projects/veto-watcher-260921/roles/customSecretReader' >/dev/null; then
    if secret_write_in_log; then
      bad "role describe permission denied must stop before secrets create/add"
    else
      pass "role describe permission denied stops deploy rather than treating the error as an all-clear"
    fi
  else
    bad "role describe permission denied message: ${out}"
  fi
fi

# New bucket: create is accepted, read-back stays inherited.
if out="$(run_deploy pap-new-inherited 2>&1)"; then
  bad "new bucket whose PAP read-back is inherited must fail"
else
  if printf '%s' "$out" | grep "public access prevention on gs://veto-watcher-260921-journal is 'inherited', wanted enforced" >/dev/null; then
    if secret_write_in_log; then
      bad "inherited PAP on a new bucket must fail before the secret is created"
    elif grep -q 'storage buckets create' "$FAKE_LOG" \
      && grep -q 'public-access-prevention' "$FAKE_LOG" \
      && grep -q 'format=json' "$FAKE_LOG"; then
      pass "new bucket: PAP is read back as enforced, inherited fails the deploy"
    else
      bad "new bucket inherited PAP failed without a create+describe json round trip"
    fi
  else
    bad "new bucket inherited PAP message: ${out}"
  fi
fi

# New bucket: read-back is enforced, then the IAM guard still runs.
if out="$(run_deploy pap-new-enforced-accessor 2>&1)"; then
  bad "new bucket with PAP enforced must still apply the default-compute guard"
else
  if printf '%s' "$out" | grep 'can read a secret version' >/dev/null \
    && grep -q 'storage buckets create' "$FAKE_LOG" \
    && grep -q -- '--public-access-prevention' "$FAKE_LOG" \
    && grep -q 'format=json' "$FAKE_LOG"; then
    if secret_write_in_log; then
      bad "new bucket PAP enforced path must still stop before the secret is created"
    else
      pass "new bucket: PAP read-back is enforced, then the default-compute guard still stops the secret"
    fi
  else
    bad "new bucket PAP enforced message: ${out}"
  fi
fi

# Existing bucket: update requested, read-back stays inherited.
if out="$(run_deploy pap-existing-inherited 2>&1)"; then
  bad "existing bucket whose PAP read-back is inherited must fail"
else
  if printf '%s' "$out" | grep "public access prevention on gs://veto-watcher-260921-journal is 'inherited', wanted enforced" >/dev/null; then
    if secret_write_in_log; then
      bad "inherited PAP on an existing bucket must fail before the secret is created"
    else
      pass "existing bucket: PAP is read back, inherited fails the deploy"
    fi
  else
    bad "existing bucket inherited PAP message: ${out}"
  fi
fi

# Existing bucket: the update itself is refused.
if out="$(run_deploy pap-update-fail 2>&1)"; then
  bad "existing bucket that cannot take PAP must fail"
else
  if printf '%s' "$out" | grep 'could not set public access prevention to enforced' >/dev/null; then
    if secret_write_in_log; then
      bad "PAP update failure must happen before the secret is created"
    else
      pass "existing bucket that cannot take PAP fails the deploy before the secret is created"
    fi
  else
    bad "PAP update failure message: ${out}"
  fi
fi

# New bucket: create itself is refused.
if out="$(run_deploy pap-create-fail 2>&1)"; then
  bad "create that cannot set PAP must fail"
else
  if printf '%s' "$out" | grep 'could not create gs://veto-watcher-260921-journal with public access prevention enforced' >/dev/null; then
    if secret_write_in_log; then
      bad "PAP create failure must happen before the secret is created"
    else
      pass "new bucket that cannot take PAP fails the deploy before the secret is created"
    fi
  else
    bad "PAP create failure message: ${out}"
  fi
fi

# Existing bucket: read-back enforced, then the IAM guard still runs.
if out="$(run_deploy pap-existing-enforced-accessor 2>&1)"; then
  bad "existing bucket with PAP enforced must still apply the default-compute guard"
else
  if printf '%s' "$out" | grep 'can read a secret version' >/dev/null \
    && grep -q 'storage buckets update' "$FAKE_LOG" \
    && grep -q -- '--public-access-prevention' "$FAKE_LOG" \
    && grep -q 'format=json' "$FAKE_LOG"; then
    if secret_write_in_log; then
      bad "existing bucket PAP enforced path must still stop before the secret is created"
    else
      pass "existing bucket: PAP read-back is enforced, then the default-compute guard still stops the secret"
    fi
  else
    bad "existing bucket PAP enforced message: ${out}"
  fi
fi

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "deploy-watcher-cloud critic round 3 fixtures: FAILED"
  exit 1
fi
printf 'deploy-watcher-cloud critic round 3 fixtures: passed\n'
