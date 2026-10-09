# Watcher on Cloud Run

The laptop `run` loop dies when the lid closes. The decision rows can be rebuilt
from the on-chain ring and transaction history. The price columns for missed
windows cannot. This is the Cloud Run job that runs `once` on the price
window cadence, with the journal stored in Cloud Storage.

The journal is read from the object at the start of a run and written back as a
whole file after each decision. A torn append would be worse than a rewrite.
The object is never treated as the truth: if that write fails after the chain
already confirmed, the process exits 1 with a line naming the decision it
could not record. The next start hydrates the object, then repairs any missing
paid or refused row from the on-chain ledger ring before any window is
processed, so `processWindow` can skip a nonce the chain already settled.

The owner runs these commands by hand. They are not part of CI or any automated flow.

**Project:** `veto-watcher-260921`
**Job region:** `europe-north1` (Finland)
**Scheduler region:** `europe-west1` (Belgium). Cloud Scheduler is not available
in `europe-north1`; Belgium is the nearest Scheduler region. The job it invokes
still runs in Finland. The cron timezone is `Europe/Stockholm`.

Nothing in the image is a key, an RPC endpoint, a mint, or an account. The
program id travels with the bundled IDL (`idl/veto.json`, copied in the
Dockerfile). Everything environment-specific arrives as environment and a
Secret Manager mount. The image is compiled JavaScript. TypeScript and the
rest of the build toolchain stay in the build stage.

## 1. What you need on the machine

- `gcloud` logged in to an account that owns `veto-watcher-260921`
- Node 22 or newer (the script checks the agent keypair is a JSON array without
  printing it)
- The agent keypair file, from gitignored `keys/agent.json`
- The public identities (RPC, program, mint, owner, merchant, agent)

```bash
gcloud config set project veto-watcher-260921
gcloud auth application-default login   # only if this account is not already the active one
```

Copy identities from `keys/devnet-addresses.env` or from [docs/DEVNET.md](../docs/DEVNET.md).
Do not paste a secret into the shell history. Point `AGENT_KEY_PATH` at the file.

## 2. Check, then deploy

From the repo root. The script refuses before creating anything if a required
value is missing. It is safe to run twice.

```bash
export AGENT_KEY_PATH=/absolute/path/to/keys/agent.json
export VETO_RPC='https://api.devnet.solana.com'
export VETO_PROGRAM_ID='PROGRAM_ID'
export VETO_MINT='MINT'
export VETO_OWNER='OWNER'
export VETO_OWNER_TOKEN='OWNER_TOKEN'
export VETO_MERCHANT='MERCHANT'
export VETO_MERCHANT_TOKEN='MERCHANT_TOKEN'
export VETO_AGENT='AGENT'
# optional:
# export ALERT_EMAIL='you@example.com'
# optional, forwarded to both jobs when set. Unset keeps 1 token as 1 SEK.
# export VETO_QUOTE_CURRENCY='USD'

./scripts/deploy-watcher-cloud.sh --check
./scripts/deploy-watcher-cloud.sh
```

The script refuses to update `veto-watcher` or `veto-watcher-stale` when either job already exists, because it replaces the whole job environment. Pass `--replace-env` only when that is what you want; for an ordinary rule or image change, follow "Switching the rule in place" below.

`--check` validates local inputs only. The deploy path then, in order:

1. Creates the service account `veto-watcher@veto-watcher-260921.iam.gserviceaccount.com` if missing.
2. Creates the bucket `gs://veto-watcher-260921-journal` in `europe-north1` if missing, and
   uploads an empty `decisions.jsonl` only when that object does not already exist
   (a second run does not wipe the journal).
3. Creates Secret Manager secret `veto-agent-keypair` from `AGENT_KEY_PATH`, or
   adds a new version if the secret already exists. The file contents are never
   printed.
4. Creates Artifact Registry repo `veto-watcher` in `europe-north1` if missing.
5. Grants the job service account `storage.objectAdmin` on the bucket,
   `secretmanager.secretAccessor` on the secret, and `logging.logWriter` on the
   project. Grants Cloud Build `artifactregistry.writer`. Grants Cloud Scheduler
   `iam.serviceAccountUser` on the job account, and `run.invoker` on both jobs.
6. Builds and pushes `europe-north1-docker.pkg.dev/veto-watcher-260921/veto-watcher/watcher:latest`
   with Cloud Build from `watcher/`.
7. Creates or updates Cloud Run job `veto-watcher` (`node dist/index.js once`)
   with the secret mounted at `/keys/agent.json` and the identities as
   environment. Journal: `VETO_JOURNAL=/tmp/veto/decisions.jsonl` and
   `VETO_JOURNAL_GCS=gs://veto-watcher-260921-journal/decisions.jsonl`.
8. Creates or updates Cloud Run job `veto-watcher-stale` (`node dist/index.js stale`).
9. Creates or updates Cloud Scheduler `veto-watcher-cadence` at
   `0 0,6,12,18 * * *` `Europe/Stockholm` in `europe-west1`, POSTing the Cloud
   Run jobs API `:run` URI.
10. Creates or updates Cloud Scheduler `veto-watcher-stale-hourly` at
    `0 * * * *` `Europe/Stockholm`.
11. Creates or updates two alerting policies. `Veto watcher record too old`
    from `infra/watcher-stale-alert.yaml` (failed stale execution). `Veto
    watcher silent` from `infra/watcher-silent-alert.yaml` (PromQL `absent()`
    of that check). If `ALERT_EMAIL` is set, creates or reuses an email
    notification channel and attaches it to both.

The script does not execute the job (`--execute-now` is not passed).

## Switching the rule in place

A rule change is applied with `gcloud run jobs update` on `veto-watcher` and `veto-watcher-stale`, not by running `scripts/deploy-watcher-cloud.sh`. The deploy script replaces the whole job environment from the identities the operator exports, and the setup still points that export at `keys/devnet-addresses.env`, which describes an older rule. The script also defaults the journal object to `decisions.jsonl` and adds a new version of the agent secret. Running it would put both jobs back on that older rule. For a switch, build and push the watcher image with Cloud Build the same way the script does (`gcloud builds submit` of `watcher/` tagged `latest`), add a tag for the short commit hash, create the new journal object only when it is absent, and update both jobs with `--image` and `--update-env-vars` for the values that changed. That leaves `VETO_RPC`, `VETO_PROGRAM_ID`, the secret mount, and every other setting as they are. Record the previous environment in `docs/GCP_SETUP.md` before the update, and do not rewrite an existing journal object.

## 3. Point both alerts at an email address

The failure that costs the demo is a job that stops quietly. Google requires a
PromQL condition to be the only condition in its policy, so the two paths are
two policies.

- Cadence is six hours (00:00, 06:00, 12:00, 18:00 Stockholm).
- A window and a half is **9 hours** (`STALE_AFTER_MS` in `watcher/src/cadence.ts`).
- Job `veto-watcher-stale` hydrates the journal object and exits 1 when
  `isJournalStale` is true. Age comes from the latest row `ts`, or, when the
  journal is empty, from the object's own server-side `updated` time. The
  checker does not use the local file it just wrote, so an empty object from
  deploy still ages.
- Policy `Veto watcher record too old` (`infra/watcher-stale-alert.yaml`):
  `run.googleapis.com/job/completed_execution_count` with
  `resource.labels.job_name="veto-watcher-stale"` and
  `metric.labels.result="failed"` greater than 0 for 60s.
- Policy `Veto watcher silent` (`infra/watcher-silent-alert.yaml`): PromQL
  `absent()` on that same metric for 32400s (9 hours), with
  `disableMetricValidation: true`. True when the series has never written a
  point.

What fires in each case:

1. Nothing has ever run. `Veto watcher silent` fires. `absent()` is true for a
   series that has never existed. A Cloud Monitoring metric-absence condition
   would not fire in that case.
2. The watcher stopped while the checker kept going. After 9 hours the empty
   object still carries the `updated` time from deploy (or the last row `ts`
   is older than 9 hours), the stale job exits 1, and `Veto watcher record too
   old` fires on the failed-execution threshold.
3. The checker itself stopped. `Veto watcher silent` fires once
   `completed_execution_count` for `veto-watcher-stale` has been absent for
   32400s.

If `ALERT_EMAIL` was set on deploy, the channel is already attached to both
policies. Otherwise:

```bash
gcloud beta monitoring channels create \
  --project=veto-watcher-260921 \
  --display-name='Veto watcher owner' \
  --type=email \
  --channel-labels=email_address=you@example.com

CHANNEL=$(gcloud beta monitoring channels list \
  --project=veto-watcher-260921 \
  --filter='labels.email_address="you@example.com" AND type=email' \
  --format='value(name)')

POLICY_SILENT=$(gcloud monitoring policies list \
  --project=veto-watcher-260921 \
  --filter='displayName="Veto watcher silent"' \
  --format='value(name)')

POLICY_STALE=$(gcloud monitoring policies list \
  --project=veto-watcher-260921 \
  --filter='displayName="Veto watcher record too old"' \
  --format='value(name)')

gcloud monitoring policies update "$POLICY_SILENT" \
  --project=veto-watcher-260921 \
  --add-notification-channels="$CHANNEL"

gcloud monitoring policies update "$POLICY_STALE" \
  --project=veto-watcher-260921 \
  --add-notification-channels="$CHANNEL"
```

Google sends a verification email to that address. The channel stays unverified
until you confirm it.

## 4. What each piece costs

Figures are list prices as of 2026-09-21, `europe-north1` where the resource
lives. A demo at four `once` runs a day plus an hourly stale check stays inside
the free tiers below.

| Piece | What we run | List price | This demo |
|---|---|---|---|
| Cloud Run jobs | 1 vCPU, 1 GiB (`once`) and 512 MiB (`stale`), billed for the whole run with a 1 minute minimum | $0.000018 / vCPU-second, $0.000002 / GiB-second. Free: 240,000 vCPU-seconds and 450,000 GiB-seconds per month | About 28 billed minutes per day (four `once` runs and 24 stale checks), roughly 840 per month. About 50,400 vCPU-seconds. Inside the free tier. |
| Cloud Scheduler | 2 jobs (`cadence`, `stale-hourly`) in `europe-west1` | 3 jobs free per billing account, then $0.10 per job per month | Free |
| Cloud Storage | One bucket, one JSONL object of a few hundred rows | About $0.02 / GB-month plus Class A/B ops | Cents or less; the object is kilobytes |
| Secret Manager | One secret, read on each job start | $0.06 per secret per month plus $0.03 per 10,000 accesses | One secret, about 30 days * 28 reads |
| Artifact Registry | One image in `europe-north1` | $0.10 / GB-month after 0.5 GB free | One Node image, often inside the free 0.5 GB |
| Cloud Build | One image build per deploy | 2,500 free build-minutes per month (promotional tier for e2-standard-2, subject to change) | One watcher build is a few minutes |
| Cloud Monitoring | Two policies, email channel | Email notifications are free | Free |
| Cloud Logging | stdout from the jobs | 50 GiB free per month | Well under |

Pricing pages: [Cloud Run](https://cloud.google.com/run/pricing),
[Scheduler](https://cloud.google.com/scheduler/pricing),
[Storage](https://cloud.google.com/storage/pricing),
[Secret Manager](https://cloud.google.com/secret-manager/pricing),
[Artifact Registry](https://cloud.google.com/artifact-registry/pricing),
[Cloud Build](https://cloud.google.com/build/pricing).

## 5. Confirm it is alive

After the next cadence tick (or after you run the job by hand):

```bash
gcloud run jobs executions list --job=veto-watcher --region=europe-north1 --project=veto-watcher-260921
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="veto-watcher"' --project=veto-watcher-260921 --limit=20
gcloud storage cat gs://veto-watcher-260921-journal/decisions.jsonl | tail
```

To run one pass without waiting for the cron (this submits a real charge if a
slot is due):

```bash
gcloud run jobs execute veto-watcher --region=europe-north1 --project=veto-watcher-260921
```

The `stale` command locally, against a file journal:

```bash
cd watcher && node dist/index.js stale
```

Exit 1 means the last recorded decision is older than nine hours. For an empty
journal the age comes from the object's server-side `updated` time in cloud
runs, or from the local file's modification time. A missing journal file is
always stale.

## 6. Tear it down

From the repo root, after you are sure you want the cloud copy of the journal
gone. Order: stop invocation, then jobs, then data, then identity.

```bash
PROJECT=veto-watcher-260921
REGION=europe-north1
SCHEDULER_LOCATION=europe-west1

gcloud scheduler jobs delete veto-watcher-cadence --location=$SCHEDULER_LOCATION --project=$PROJECT --quiet
gcloud scheduler jobs delete veto-watcher-stale-hourly --location=$SCHEDULER_LOCATION --project=$PROJECT --quiet

gcloud run jobs delete veto-watcher --region=$REGION --project=$PROJECT --quiet
gcloud run jobs delete veto-watcher-stale --region=$REGION --project=$PROJECT --quiet

gcloud artifacts docker images delete \
  europe-north1-docker.pkg.dev/$PROJECT/veto-watcher/watcher:latest \
  --delete-tags --project=$PROJECT --quiet
gcloud artifacts repositories delete veto-watcher --location=$REGION --project=$PROJECT --quiet

gcloud storage rm gs://$PROJECT-journal/decisions.jsonl
gcloud storage buckets delete gs://$PROJECT-journal --project=$PROJECT --quiet

gcloud secrets delete veto-agent-keypair --project=$PROJECT --quiet

POLICY_SILENT=$(gcloud monitoring policies list --project=$PROJECT --filter='displayName="Veto watcher silent"' --format='value(name)')
[ -n "$POLICY_SILENT" ] && gcloud monitoring policies delete "$POLICY_SILENT" --project=$PROJECT --quiet
POLICY_STALE=$(gcloud monitoring policies list --project=$PROJECT --filter='displayName="Veto watcher record too old"' --format='value(name)')
[ -n "$POLICY_STALE" ] && gcloud monitoring policies delete "$POLICY_STALE" --project=$PROJECT --quiet

gcloud iam service-accounts delete veto-watcher@$PROJECT.iam.gserviceaccount.com --project=$PROJECT --quiet
```

The project itself stays. The teardown leaves it in place. Deleting the project
is a separate step (`gcloud projects delete`) and is not required to stop spend.

## Local journal behaviour

`VETO_JOURNAL` still defaults to `watcher/data/decisions.jsonl`. Cloud Storage
is used only when `VETO_JOURNAL_GCS` is set to a `gs://bucket/object` URI.
With or without that URI, `once` and `run` rebuild paid and refused rows from
the chain ledger before they submit, so a lost local file does not send a
window the chain already refused.
