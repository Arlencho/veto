#!/usr/bin/env bash
# Assert every claim in docs/GCP_SETUP.md against the live project.
#
# That document was written after the setup rather than before it, so it is a
# description of what someone believes was done. This is the part that can be
# checked. It reads and asserts; it creates nothing, changes nothing and
# deletes nothing, so it is safe to run at any time by anyone with read access.
#
#   scripts/gcp-verify.sh
#
# Every check is run and every failure is printed, so one broken claim does not
# hide the next. The exit code is non-zero if any check failed.
#
# THE RULE THIS SCRIPT EXISTS TO ENFORCE ON ITSELF: a check may not pass
# because it could not look. The first version of this file counted resources
# with `gcloud ... 2>/dev/null | wc -l` and compared the count to zero, so a
# gcloud that failed for any reason at all, no permission, wrong project, no
# network, produced an empty list, a count of zero, and a green tick. It would
# have reported a clean project while being unable to see it. Every call now
# goes through `capture`, which fails the check when the command fails and
# never lets silence read as evidence.
set -euo pipefail

PROJECT="veto-watcher-260921"
NUMBER="472736420070"
BILLING="01778E-30EA11-E3BA6D"
BUDGET="914d5c6c-9361-437b-8ea6-dd7b50ab333d"
DISPLAY_NAME="Veto Watcher"
CREATED="2026-09-21T11:36:55Z"
# Live resource was renamed off "veto-watcher cap"; this is the name asserted below.
BUDGET_NAME="veto-watcher spend alert (does not stop spend)"
# The billing account currency decides what a budget amount means, and the
# document states it, so it is asserted rather than assumed.
BILLING_CURRENCY="SEK"
DEFAULT_SA="$NUMBER-compute@developer.gserviceaccount.com"
# Cloud Run runs in europe-north1. Cloud Scheduler does not exist there at all,
# so the schedule lives in the nearest region that serves it. The cadence is in
# Europe/Stockholm either way, which is what actually matters for the prices.
RUN_REGION="europe-north1"
SCHEDULER_REGION="europe-west1"

# The budget API resolves its quota against the active project, which is not
# necessarily this one.
export CLOUDSDK_CORE_PROJECT="$PROJECT"

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); return 0; }
bad()  { printf '  FAIL %s\n' "$1"; shift; for l in "$@"; do printf '         %s\n' "$l"; done; fail=$((fail+1)); return 0; }

# capture <var> <claim> <command...>
# Runs the command. On failure, fails the claim and returns 1, so the caller
# skips its assertion rather than asserting on an empty string.
capture() {
    local __var="$1" __claim="$2"; shift 2
    local __out __err __rc=0 __ef
    __ef=$(mktemp)
    # Under set -e a failing command substitution aborts the shell before the
    # next line runs, so the exit status has to be taken in the same statement.
    __out=$("$@" 2>"$__ef") || __rc=$?
    __err=$(head -1 "$__ef" 2>/dev/null || true); rm -f "$__ef"
    if [ $__rc -ne 0 ]; then
        bad "$__claim" "could not look: $* exited $__rc" "$__err"
        return 1
    fi
    printf -v "$__var" '%s' "$__out"
    return 0
}

equal()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected: [$2]" "actual:   [$3]"; fi; }
# Exact membership in a newline or semicolon separated list, not a substring:
# a substring test passes environment=development-staging for environment=development.
member() { # member <claim> <needle> <haystack>
    local IFS=$'\n;'
    for item in $3; do
        if [ "$item" = "$2" ]; then ok "$1"; return 0; fi
    done
    bad "$1" "no exact match for: [$2]" "in: [$3]"
    return 0
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
    perms="$(gcloud iam roles describe "$role" --format="value(includedPermissions)")" || rc=$?
    if [ $rc -ne 0 ]; then
        return 2
    fi
    if printf '%s\n' "$perms" | tr ';,' '\n' | grep -x 'secretmanager.versions.access' >/dev/null; then
        return 0
    fi
    return 1
}

# Append "member<TAB>role<TAB>where" lines to $3. Returns 1 if the policy could not be read as JSON.
scan_iam_json_into() {
    local json="$1"
    local where="$2"
    local findings="$3"
    local rows rc=0
    rows="$(printf '%s' "$json" | iam_policy_secret_access_rows)" || rc=$?
    if [ $rc -ne 0 ]; then
        return 1
    fi
    local kind role member grant_rc
    while IFS=$'\t' read -r kind role member; do
        [ -n "${kind:-}" ] || continue
        if [ "$kind" = ACCESS ]; then
            printf '%s\t%s\t%s\n' "$member" "$role" "$where" >> "$findings"
            continue
        fi
        grant_rc=0
        role_grants_versions_access_via_describe "$role" || grant_rc=$?
        if [ $grant_rc -eq 2 ]; then
            bad "could not describe $role on $where" "silence is not absence: this principal was not classified" "$member"
        elif [ $grant_rc -eq 0 ]; then
            printf '%s\t%s\t%s\n' "$member" "$role" "$where" >> "$findings"
        fi
    done <<< "$rows"
    return 0
}

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }
acct=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null)
[ -n "$acct" ] || { echo "not authenticated: run gcloud auth login" >&2; exit 2; }

echo "Verifying docs/GCP_SETUP.md against the live project"
echo "  as: $acct"
echo

echo "Project"
if capture d "project exists with the documented id, number, name, state and creation time" \
        gcloud projects describe "$PROJECT" --format=value'(projectId,projectNumber,name,lifecycleState,createTime)'; then
    IFS=$'\t' read -r pid pnum pname pstate pcreated <<<"$d"
    equal "project id and number" "$PROJECT $NUMBER" "$pid $pnum"
    equal "project display name" "$DISPLAY_NAME" "$pname"
    equal "project is active" "ACTIVE" "$pstate"
    # createTime carries sub-second precision; compare to the second.
    equal "project creation time" "${CREATED%Z}" "$(printf '%s' "$pcreated" | cut -c1-19)"
fi

if capture labels "project labels" gcloud projects describe "$PROJECT" --format=value'(labels)'; then
    for l in "environment=development" "owner=arlen" "purpose=veto-watcher"; do
        member "label $l" "$l" "$labels"
    done
fi

echo
echo "Billing"
if capture b "billing is enabled and points at the documented account" \
        gcloud billing projects describe "$PROJECT" --format=value'(billingEnabled,billingAccountName)'; then
    equal "billing enabled and account" "True	billingAccounts/$BILLING" "$b"
fi

if capture cur "billing account currency can be read" \
        gcloud billing accounts describe "$BILLING" --format=value'(currencyCode)'; then
    equal "billing account currency" "$BILLING_CURRENCY" "$cur"
fi

echo
echo "Budget"
if capture bj "budget $BUDGET can be read" \
        gcloud billing budgets describe "$BUDGET" --billing-account="$BILLING" --format=json; then
    parse() { printf '%s' "$bj" | python3 -c "$1" 2>/dev/null; }
    equal "budget display name" "$BUDGET_NAME" \
          "$(parse 'import json,sys; print(json.load(sys.stdin).get("displayName",""))')"
    # nanos are a real part of the amount: 200 units plus 500000000 nanos is
    # 200.5, and checking units alone calls that 200.
    equal "budget amount is exactly 200 SEK, nanos included" "200 0 SEK" \
          "$(parse 'import json,sys; a=json.load(sys.stdin)["amount"]["specifiedAmount"]; print(a.get("units","0"), a.get("nanos",0), a.get("currencyCode",""))')"
    # A budget with no project filter covers the whole billing account: it
    # fires on unrelated spend and protects this project from nothing.
    equal "budget is scoped to this project alone" "['projects/$NUMBER']" \
          "$(parse 'import json,sys; print(json.load(sys.stdin).get("budgetFilter",{}).get("projects"))')"
    equal "budget thresholds are 50, 90 and 100 percent" "[0.5, 0.9, 1.0]" \
          "$(parse 'import json,sys; print(sorted(r["thresholdPercent"] for r in json.load(sys.stdin).get("thresholdRules",[])))')"
    # Thresholds with nowhere to go are decoration. Either the billing admins
    # get the mail, or a channel is named.
    equal "budget notifications actually reach someone" "reaches-someone" \
          "$(parse 'import json,sys
d=json.load(sys.stdin).get("notificationsRule",{}) or {}
muted=d.get("disableDefaultIamRecipients", False)
chans=d.get("monitoringNotificationChannels") or []
print("reaches-someone" if (not muted) or chans else "nobody-is-notified")')"
fi

echo
echo "APIs"
if capture enabled "enabled services can be listed" \
        gcloud services list --enabled --project="$PROJECT" --format=value'(config.name)'; then
    for api in run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
               artifactregistry.googleapis.com cloudbuild.googleapis.com storage-api.googleapis.com \
               monitoring.googleapis.com billingbudgets.googleapis.com \
               storage.googleapis.com; do
        member "$api enabled" "$api" "$enabled"
    done
fi

echo
echo "Audit"
# The document claims every read of the agent key leaves a trail. A paste of a
# live command proves that was true once; this proves it is true now. Without
# it, audit logging could be turned off and nothing here would notice.
if capture pol "the project IAM policy can be read for audit configuration" \
        gcloud projects get-iam-policy "$PROJECT" --format=json; then
    audit=$(printf '%s' "$pol" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for a in d.get("auditConfigs",[]):
    if a.get("service")=="secretmanager.googleapis.com":
        print(",".join(sorted(c["logType"] for c in a.get("auditLogConfigs",[]))))
        break
' 2>/dev/null || true)
    equal "Secret Manager logs DATA_READ and DATA_WRITE" "DATA_READ,DATA_WRITE" "$audit"
fi

echo
echo "Identity: who can act, and who could read the key once it exists"
if capture sas "service accounts can be listed" \
        gcloud iam service-accounts list --project="$PROJECT" --format=value'(email)'; then
    extra=$(printf '%s\n' "$sas" | grep -v '^[[:space:]]*$' | grep -vx "$DEFAULT_SA" || true)
    equal "no service account beyond the one GCP created by itself" "" "$extra"
fi

# The default compute account is what a Cloud Run job picks up when nobody
# tells it otherwise. If it ever gains a role, that is what the job runs as.
if capture roles "the default compute account's project roles can be listed" \
        gcloud projects get-iam-policy "$PROJECT" --flatten=bindings'[].members' \
          --filter="bindings.members:$DEFAULT_SA" --format=value'(bindings.role)'; then
    equal "the default compute account holds no project LEVEL role binding" "" "$(printf '%s' "$roles" | tr -d '[:space:]')"
fi

echo
echo "Principals that can read a secret version"
findings="$(mktemp)"
policy_readable=0
if capture pj "project IAM policy can be read as JSON" \
        gcloud projects get-iam-policy "$PROJECT" --format=json; then
    if scan_iam_json_into "$pj" "project policy" "$findings"; then
        policy_readable=1
        ok "project IAM policy was parsed for secretmanager.versions.access"
    else
        bad "project IAM policy was parsed for secretmanager.versions.access" "policy was not JSON, silence is not an empty list"
    fi
fi

if capture secret_names "secrets can be listed for IAM" \
        gcloud secrets list --project="$PROJECT" --format=value'(name)'; then
    while IFS= read -r sname; do
        [ -n "${sname:-}" ] || continue
        if capture sj "secret $sname IAM policy can be read as JSON" \
                gcloud secrets get-iam-policy "$sname" --project="$PROJECT" --format=json; then
            if scan_iam_json_into "$sj" "secret ${sname} policy" "$findings"; then
                ok "secret $sname IAM policy was parsed for secretmanager.versions.access"
            else
                bad "secret $sname IAM policy was parsed for secretmanager.versions.access" "policy was not JSON, silence is not an empty list"
            fi
        fi
    done <<< "$secret_names"
fi

above_inspected=0
above_missed=0
if capture anc "the project's ancestry can be read" \
        gcloud projects get-ancestors "$PROJECT" --format=value'(id,type)'; then
    while IFS=$'\t' read -r anc_id anc_type; do
        [ -n "${anc_id:-}" ] || continue
        case "$anc_type" in
            project) continue ;;
            folder)
                if capture fj "folder $anc_id IAM policy can be read as JSON" \
                        gcloud resource-manager folders get-iam-policy "$anc_id" --format=json; then
                    if scan_iam_json_into "$fj" "folder ${anc_id} policy" "$findings"; then
                        above_inspected=1
                        ok "folder $anc_id IAM policy was parsed for secretmanager.versions.access"
                    else
                        above_missed=1
                        bad "folder $anc_id IAM policy was parsed for secretmanager.versions.access" "policy was not JSON"
                    fi
                else
                    above_missed=1
                fi
                ;;
            organization)
                if capture oj "organization $anc_id IAM policy can be read as JSON" \
                        gcloud organizations get-iam-policy "$anc_id" --format=json; then
                    if scan_iam_json_into "$oj" "organization ${anc_id} policy" "$findings"; then
                        above_inspected=1
                        ok "organization $anc_id IAM policy was parsed for secretmanager.versions.access"
                    else
                        above_missed=1
                        bad "organization $anc_id IAM policy was parsed for secretmanager.versions.access" "policy was not JSON"
                    fi
                else
                    above_missed=1
                fi
                ;;
        esac
    done <<< "$anc"
fi

printed=0
default_hit=0
if [ -s "$findings" ]; then
    while IFS=$'\t' read -r princ role where; do
        [ -n "${princ:-}" ] || continue
        printf '  principal %s  role %s  from %s\n' "$princ" "$role" "$where"
        printed=1
        if [ "$princ" = "serviceAccount:$DEFAULT_SA" ] || [ "$princ" = "$DEFAULT_SA" ]; then
            default_hit=1
            bad "the default compute account can read a secret version" "found: $role on $where"
        fi
    done < "$findings"
fi
rm -f "$findings"
if [ "$printed" -eq 0 ] && [ "$policy_readable" -eq 1 ]; then
    printf '  none on the project or secret policies that were readable\n'
fi
if [ "$policy_readable" -eq 1 ] && [ "$default_hit" -eq 0 ]; then
    ok "the default compute account is absent from readable policies that grant secretmanager.versions.access"
fi

printf '  note this listing cannot see IAM bindings above the project.\n'
printf '       It reads the project policy and each secret policy. Organization and folder\n'
printf '       bindings do not appear in a project policy. A short list is not a complete\n'
printf '       list of who can read a secret version.\n'
if [ "$above_missed" -ne 0 ]; then
    printf '       Organization or folder get-iam-policy did not succeed; those bindings were not inspected.\n'
elif [ "$above_inspected" -eq 0 ]; then
    printf '       Ancestry had no readable folder or organization policy; those bindings were not inspected.\n'
fi

echo
echo "Claims the document makes about what is NOT here yet"
# Asserted so that a resource appearing without the document being updated is a
# failure rather than silent drift.
absent() { # absent <claim> <command...>
    local claim="$1"; shift
    local out
    if capture out "$claim" "$@"; then
        equal "$claim" "" "$(printf '%s' "$out" | grep -v '^[[:space:]]*$' || true)"
    fi
}
absent "no bucket yet"                gcloud storage buckets list --project="$PROJECT" --format=value'(name)'
absent "no secret yet"                gcloud secrets list --project="$PROJECT" --format=value'(name)'
absent "no Cloud Run job yet"         gcloud run jobs list --project="$PROJECT" --format=value'(metadata.name)'
absent "no Cloud Run service yet"     gcloud run services list --project="$PROJECT" --format=value'(metadata.name)'
absent "no Cloud Scheduler job yet"   gcloud scheduler jobs list --project="$PROJECT" --location="$SCHEDULER_REGION" --format=value'(name)'
absent "no Artifact Registry repo yet" gcloud artifacts repositories list --project="$PROJECT" --format=value'(name)'

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
