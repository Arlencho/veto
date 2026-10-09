# Internal working notes

## What these are

These notes are kept for the record. They are not product documentation. They hold the
decisions, the design brief, and a review of commits, including the alternatives that were set
aside.

## The notes

| Note | What it is |
|---|---|
| [DECISIONS.md](DECISIONS.md) | Append-only architecture decisions, each with the reason and what would reverse it |
| [SELF_REVIEW.md](SELF_REVIEW.md) | Review, dated 2026-09-20, of seven commits merged to main without a separate critic |
| [DESIGN_BRIEF.md](DESIGN_BRIEF.md) | The brief for the front-end proposals |
| [DESIGN_DECISION.md](DESIGN_DECISION.md) | Which proposal the app follows, and which pieces were taken from the others |
| [WORDS.md](WORDS.md) | Words the pitch, deck, and video do not use |
| [RECORDING.md](RECORDING.md) | Shoot-day notes |
| [BUILD_NOTES.md](BUILD_NOTES.md) | Cut lines and the old self-score, moved out of the plan |
| [DEVICE_CHECK.md](DEVICE_CHECK.md) | The on-device checklist walked on a wiped Seeker for each release APK |
| [TESTER_POST.md](TESTER_POST.md) | Tester recruitment drafts for the founder to send personally |

`docs/DECISIONS.md` is a pointer to the decision log.
[SECURITY_REVIEW.md](../SECURITY_REVIEW.md) points here. A comment in `watcher/src/feed.ts` still names `docs/DECISIONS.md`, which resolves through that pointer.

Product documentation is everything under `docs/` outside this directory, plus the READMEs in `app/`, `sdk/`, `watcher/`, `indexer/`, and `terminal/`, and the [README](../../README.md) at the repo root.
