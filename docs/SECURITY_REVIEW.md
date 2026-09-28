# Security review of the Veto program

Adversarial pass for [#18](https://github.com/Arlencho/veto/issues/18). Scope: `programs/veto/src/lib.rs`
and `programs/veto/src/state.rs` at commit `4b50a63`, plus the README threat model those files are
supposed to back. Line numbers in the tables below are at that commit. On current main those lines
have moved. The program was not changed in this review. Every verdict below was produced by running an attack
against the compiled program, not by reading it; the attacks live in `programs/veto/tests/red_team.rs`
and run under `make test`.

Hold (`programs/veto/src/hold.rs`) landed after this review. The verdicts below do not cover it. Hold is merged and tested in `programs/veto/tests/hold.rs`, and live on devnet. The app screens exist. A completed device check of Hold with a real vault is not recorded in this repository yet.

Toolchain used: anchor-cli 1.2.0, solana-cli 4.1.2, rustc 1.89.0, LiteSVM 0.10.0, SBPF v0 build.

```
$ make build && cargo test --manifest-path programs/veto/Cargo.toml
tests/red_team.rs            20 passed; 0 failed
tests/refusal_is_recorded.rs  4 passed; 0 failed   # at commit 4b50a63; the file has 6 tests on current main
```

Severity scale: CRITICAL exploitable now with funds at risk, HIGH exploitable with effort, MEDIUM
needs specific conditions or has limited impact, LOW theoretical or defence in depth, INFO a wording
or best-practice note. Findings of MEDIUM or worse have a GitHub issue; the rest are listed here only.

Headline: **no CRITICAL or HIGH.** No path was found by which anyone other than the named agent can
move funds, by which the agent can widen any limit, or by which arithmetic can wrap. Three MEDIUM
findings, all about what the product claims rather than what an attacker can take: a delegation that
outlives an expired mandate, an override that can be granted for a nonce that will never pay, and a
class of decline that leaves no record.

## Claims, one row each

| # | Claim under attack | Verdict | Evidence | File | Severity |
|---|---|---|---|---|---|
| C1 | Every instruction that widens authority requires the owner signature and cannot be reached by the agent | Holds | `grant_override`, `revoke_mandate` and `close_mandate` take `OwnerAction`/`CloseMandate` with `owner: Signer` and `has_one = owner`. Signing them with the agent key fails `NotTheOwner` and leaves the mandate untouched. `open_mandate` refuses `agent == owner` and refuses a `source` the signer does not own. `charge` only narrows: it raises `spent`, `last_nonce`, the counters, and can flip status away from ACTIVE. Test: `claim_the_agent_cannot_grant_an_override_revoke_or_close`, `claim_open_mandate_refuses_to_name_the_owner_as_agent_or_borrow_another_source` | `lib.rs:504-525`, `lib.rs:528-546`, `lib.rs:57-61`, `lib.rs:459` | none |
| C2 | `charge` cannot be called by anyone other than the named agent | Holds | `Charge.agent: Signer` plus `has_one = agent` on the mandate. A stranger and the owner both fail `NotTheAgent`; the ledger `total` does not move, so a rejected caller writes nothing. Test: `claim_neither_a_stranger_nor_the_owner_can_charge` | `lib.rs:473-481` | none |
| C3 | No arithmetic can overflow or wrap, including the override path and the spent accumulator | Holds | `spent + amount` is `checked_add` twice, once in `evaluate` (reported as `OVER_CAP`) and once on the paid path (`MathOverflow`, unreachable because `evaluate` ran first). Counters are `saturating_add`, `remaining` is `saturating_sub`, `effective_per_tx_max` is a `max`, ring index is modulo. Workspace release profile has `overflow-checks = true`, so any operator missed would panic rather than wrap. With `cap = per_tx_max = u64::MAX` and 50 already spent, charging `u64::MAX` and `u64::MAX - 50 + 1` are refused `OVER_CAP`; `u64::MAX - 50` passes the cap arithmetic and is refused on funds. An override of exactly `remaining` is accepted and `remaining + 1` is `OverrideAboveCap`. Test: `claim_a_charge_that_would_overflow_spent_is_refused_as_over_cap_not_wrapped` | `lib.rs:184-188`, `lib.rs:380-383`, `state.rs:83-93`, `state.rs:136-141`, `Cargo.toml` (`[profile.release] overflow-checks = true`) | none |
| C4 | The mandate PDA cannot be substituted by an attacker-controlled account, and the re-derivation check closes that | Holds, with a precision note | Three independent walls, tested separately. (a) `Account<Mandate>` requires the account to be owned by this program with the Mandate discriminator, so an attacker cannot present data the program did not write; the only writer is `open_mandate`, which pins `owner = signer` and `source.owner == signer`. (b) A forged program-owned Mandate was injected into the test VM at a non-PDA address with the victim's owner, id and bump and the attacker's agent: `charge` fails `InvalidMandatePda` before any policy runs. (c) The same forgery placed at the PDA its own fields derive to passes re-derivation and is then refused `DELEGATE_MISSING`, because the victim's token account is delegated to the victim's PDA and not to this address; and even that refusal is redundant, since the CPI would fail on the delegate check inside the token program. The README credits the re-derivation; the runtime owner check is the primary wall and the SPL delegate is the last. Tests: `claim_an_attackers_own_mandate_cannot_reach_the_victims_source_or_ledger`, `claim_a_program_owned_forgery_at_the_wrong_address_fails_rederivation`, `claim_a_forgery_at_its_own_pda_is_still_not_the_delegate_of_the_victims_source` | `lib.rs:136-150`, `lib.rs:386`, `lib.rs:459`, `lib.rs:475-481` | INFO (wording) |
| C5 | The ledger PDA is bound to its mandate by seeds and cannot be swapped for another | Holds | `seeds = [b"ledger", mandate.key()]` with runtime `bump` on every instruction that touches it. Passing mandate 1 with mandate 2's ledger fails `ConstraintSeeds`; passing the ledger as the mandate fails `AccountDiscriminatorMismatch`. `ledger.mandate` is stored but never read on chain, and `VetoError::LedgerMismatch` is declared and never raised; the seeds constraint does the whole job. Test: `claim_a_ledger_of_another_mandate_and_a_ledger_posing_as_a_mandate_are_rejected` | `lib.rs:483-488`, `lib.rs:514-519`, `lib.rs:539-545`, `lib.rs:587` | INFO (dead error variant) |
| C6 | The zero-copy `Ledger` and `Entry` layouts have no padding holes and no way to read uninitialised memory as a decision | Holds, with a reader contract | `#[zero_copy]` and `#[account(zero_copy)]` expand to `repr(C)` plus derived `bytemuck::Pod`, and `Pod` cannot be derived for a type with padding, so the build itself is the proof. Confirmed by hand: `Entry` is 8+8+32+8+8+1+1+6 = 72 bytes at align 8, `Ledger` is 32+4+2+1+1 + 32*72 = 2344 bytes at align 8, both equal to the sum of their fields. Memory is never uninitialised: `init` allocates zeroed data and `load_init` requires a zero discriminator. The one thing to know is that an all-zero slot decodes as a well-formed `Entry` with `kind = KIND_OPENED (0)`, `reason = REASON_OK (0)`, `ts = 0`. That is a reader contract, not a hole: readers must bound by `min(total, 32)`, and both shipped readers do. On current main that bound is `indexer/src/ring.ts` (`Math.min(total, LEDGER_CAPACITY)`) and `indexedEntries` in `tools/lib.ts`. Test: `claim_zero_copy_layouts_have_no_padding_and_a_zero_slot_is_a_known_shape` | `state.rs:101-133`, `lib.rs:84-88`, `lib.rs:448-455` | INFO (document the reader contract) |
| C7 | A revoked or expired mandate cannot be revived | Holds | No instruction writes `STATUS_ACTIVE` except `open_mandate` on a fresh `init`. After revoke: charge is refused `NOT_ACTIVE`, `grant_override` and a second revoke fail `MandateNotActive`, and re-approving the delegation by hand outside the program does not bring it back. Past expiry the refusal fires on the clock even while the stored status still says ACTIVE, and the status then flips to EXPIRED. Close plus re-open at the same `mandate_id` produces a new mandate with `spent = 0` and an empty ring at the same address; that needs the owner's signature and a fresh `approve_checked`, so it is a new mandate, not a revival. Tests: `claim_a_revoked_mandate_cannot_be_charged_overridden_or_revived`, `claim_an_expired_mandate_is_refused_even_while_its_status_is_still_active` | `lib.rs:300-335`, `lib.rs:360-364`, `lib.rs:224-226` | none |
| C8 | An override cannot be replayed, cannot exceed the remaining cap, and cannot be granted by the agent | Holds | Agent: see C1. Cap: `amount <= remaining()` at grant and `spent + amount <= cap` at charge, so a cap that shrinks between grant and use still wins. Replay: paying with the override nonce clears `override_nonce` and sets `last_nonce`, after which the same nonce is `STALE_NONCE` and a fresh nonce for the same amount is `OVER_PER_TX_MAX` (existing test). Two `charge` instructions with the same nonce inside one transaction pay once. Tests: `claim_an_override_cannot_exceed_remaining_cap_and_cannot_be_used_twice`, `claim_the_same_nonce_twice_in_one_transaction_pays_once`, and `an_override_clears_the_exact_charge_it_was_granted_for` in the original suite | `lib.rs:269-282`, `lib.rs:189-193`, `lib.rs:371`, `lib.rs:377-383` | none |
| C9 | The nonce rule cannot be used to strand a mandate or to replay a settled charge | Replay holds; strand breaks, at LOW | Replay: `last_nonce` is written only on the paid path and only from a nonce that was strictly greater, so it is monotonic and a settled nonce is never paid twice. Strand: the agent picks the nonce, so one paid charge at `u64::MAX` makes every later charge `STALE_NONCE` forever, with 499 of the 500 cap unspendable and no owner instruction to reset it. Only the agent can do this and it costs the owner nothing except a revoke and a re-open. The override half of this line is worse and is finding F2. Test: `finding_3_a_paid_charge_at_nonce_u64_max_strands_the_mandate` | `lib.rs:371`, `lib.rs:189` | LOW (F3) |

## Findings

### F1: MEDIUM, revoke is unreachable once status is EXPIRED or EXHAUSTED, so the SPL delegation outlives the mandate

> **Status: fixed in #37.** The text below describes the defect as it stood at the time of the
> review and is kept as the record of what was found. `revoke_mandate` now accepts any status
> except REVOKED. See docs/internal/DECISIONS.md.

Issue: [#33](https://github.com/Arlencho/veto/issues/33). Category: Auth.
File: `programs/veto/src/lib.rs:302` (precondition), `lib.rs:224` and `lib.rs:194` (the flips), `lib.rs:338-345` (close has no revoke CPI).

Exploit: pay 100 of 500, wait past expiry, submit one charge. Status becomes EXPIRED. `revoke_mandate`
now fails `MandateNotActive`. `close_mandate` succeeds and reclaims rent, and the owner's token account
still carries `delegate = <mandate PDA>`, `delegated_amount = 400`, pointing at an address that no
longer has an account. A compromised agent key can force this state on purpose with one transaction
after expiry, which removes the owner's in-app revoke path. Nothing can move today, because the PDA
signs only inside `charge` and `charge` refuses on any non-ACTIVE status; the party that could act on
the lingering delegation is the program's upgrade authority, which is the deployer key per
`docs/DEVNET.md`. The revoke CPI's own comment (`lib.rs:323`) says its purpose is to survive exactly
that case.

Fix: allow `revoke_mandate` on any status that still has a delegation, or add the `token::revoke` CPI
to `close_mandate` (with `has_one = source`). Either way a finished mandate ends with `delegate = None`.
Test: `finding_1_expired_status_still_allows_revoke_and_drops_the_delegation`.

### F2: MEDIUM, `grant_override` accepts a nonce that can never pay, and the shipped watcher never retries a refused nonce

> **Status: fixed in #37.** The text below is the defect as found. `grant_override` now rejects a
> nonce at or below `last_nonce`. The orphaned-override half is an accepted known limit, bounded by
> assertions in `red_team.rs`. See docs/internal/DECISIONS.md.

Issue: [#34](https://github.com/Arlencho/veto/issues/34). Category: API.
File: `programs/veto/src/lib.rs:267-282` (no `nonce > last_nonce` check), `lib.rs:190-193` (override
cleared only on a matching pay), `watcher/src/nonce.ts` and `watcher/src/journal.ts:21,44`.

Exploit: grant an override for nonce 7, then pay nonce 8. The retry of nonce 7 is refused
`STALE_NONCE` and `override_nonce` stays 7, a pending override nothing can consume. Separately, the
owner can grant an override for nonce 3 when `last_nonce` is 8; it is accepted, written to the ledger
as KIND_OVERRIDE, and can never pay. In the demo the override can never be consumed at all: the
watcher's nonces are window-start seconds and strictly increase, and it treats `refused` as terminal,
so it never resubmits the nonce the owner overrode, and the next window's payment orphans it. The
README and PLAN say "a refused one can still be retried after an override". With this program and
this watcher the retry does not happen. No funds at risk; the owner signs something that will never
be used.

Fix: `require!(nonce > mandate.last_nonce)` in `grant_override`; watcher resubmits a refused nonce once
after seeing an OVERRIDE for it. Test: `finding_2_grant_override_rejects_a_nonce_that_can_never_pay`.

### F3: LOW, the agent can strand a mandate by paying with nonce `u64::MAX`

Category: API. File: `programs/veto/src/lib.rs:371`, `lib.rs:189`. Covered under C9. Self-inflicted
by the only key that can sign `charge`; the owner's exit is revoke and re-open. A bound on the nonce
(for example, `nonce <= now + slack`, or a per-mandate monotonic counter the program assigns) would
close it, but that is a design change to a frozen program and the impact is nil for the owner.
Test: `finding_3_a_paid_charge_at_nonce_u64_max_strands_the_mandate`.

### F4: MEDIUM, a decline raised inside the token CPI is an error, not a recorded refusal

> **Status: fixed in #37.** The text below is the defect as found. `evaluate` now checks the state
> of both token accounts before the CPI and records reason 10, so a frozen account is a recorded
> refusal like any other decline. See docs/internal/DECISIONS.md.

Issue: [#35](https://github.com/Arlencho/veto/issues/35). Category: Data.
File: `programs/veto/src/lib.rs:351-393` (`evaluate` does not read `state`), `lib.rs:168-181` (CPI).

Exploit: the mint's freeze authority freezes the merchant's token account (USDC has one). `evaluate`
returns `REASON_OK`, `transfer_checked` fails `AccountFrozen`, the instruction errors, and the ledger
write and `Refused` event roll back with it: `ledger.total` unchanged, `refusal_count` still 0. Same
class for a Token-2022 mint with a transfer hook or non-transferable extension. A transfer-fee mint is
the mirror: `spent` records `amount`, the merchant receives less. This contradicts the README line
"The ledger records every decision the agent submits". It does not contradict "no attempt is judged by
the agent instead of by the chain", which still holds.

Fix, one of: add a `REASON_ACCOUNT_FROZEN` check on `source.state` and `destination.state` before the
CPI (reopens the frozen-program decision, which names a security finding as its reversal condition), or
narrow the README to decisions this program makes and say that a token-program decline is a failed
transaction with no entry. Test: `finding_4_a_frozen_account_is_a_recorded_refusal`.

### F5: LOW, `purpose` is limited in characters but the account is sized in bytes

Category: Input. File: `programs/veto/src/lib.rs:48-51`, `state.rs:70-71`.
A 64-character purpose of two-byte characters is 128 bytes, passes `chars().count() <= 64`, and fails
at account exit with `AccountDidNotSerialize` instead of `PurposeTooLong`. Owner-only, no state
change. Fix: check `purpose.len() <= PURPOSE_MAX_LEN` (bytes) or document the limit in bytes.
Test: `finding_5_purpose_limit_counts_chars_but_the_account_is_sized_in_bytes`.

### F6: LOW, a second mandate on the same token account silently disables the first

> **Status: the app opens each new rule on its own token account (merged in #192).** The program still approves whatever source it is given, so two mandates on one token account still replace the single delegate. The README says that, and says a rule opened in the app does not share that account. On devnet the demo owner token account's delegate is mandate id 3, and mandate id 1 on that same account is reason 5 on a new charge over the per-payment limit and reason 7 on a new charge inside the limits once the delegation is withdrawn.

Category: API. File: `programs/veto/src/lib.rs:102-114`.
SPL allows one delegate per token account. `open_mandate` calls `approve_checked` unconditionally, so
opening mandate 2 on the same `source` re-points the delegation; mandate 1 still reads ACTIVE with its
full remaining cap and learns otherwise only at its next charge (`DELEGATE_MISSING`). The owner signs
both, so this is a footgun, not an attack. The README should say one mandate per token account at a
time. The program could also refuse to open when `source.delegate` is already set to another mandate.
Test: `finding_6_a_second_mandate_on_the_same_source_disables_the_first_silently`.

### F7: LOW, the agent can evict every PAID row from the on-chain ring with 32 refusals

> **Status: the README ring paragraph says the window is agent-evictable, and that longer history rests on transaction retention or the indexer.**

Category: Data. File: `programs/veto/src/state.rs:136-141`.
Refusals are written on the agent's signature at will. After one payment and 32 refused charges the
ring holds only REFUSED rows; `total` still counts and the transactions and events remain, which is
what the indexer reads. This is by design and the README already calls the ring a window. What the
README does not say is that the window is agent-evictable and that "durable" ultimately rests on RPC
transaction retention or a running indexer. Worth one sentence.
Test: `finding_7_refusal_spam_evicts_paid_entries_from_the_ring`.

### F8: LOW, the threat model does not name the upgrade authority

> **Status: decided in #110.** Devnet keeps the single deployer key as upgrade authority and the
> README threat model now names it as the assumption behind every bound and every verified
> record. Mainnet: the upgrade authority is burned before the first mandate is opened, after the
> external audit; a fix to a frozen program is a new program id. Multisig was considered and not
> chosen, because a verified record has to outlive the signers' goodwill.

Category: Infra. File: `README.md` "Threat model", `docs/DEVNET.md` "Deployer (fee payer, upgrade
authority, mint authority)". The program is deployed with the upgradeable loader and a single-key
upgrade authority. Every bound the README lists is a bound on the program as deployed; whoever holds
that key can replace the logic and move anything still delegated to a mandate PDA (see F1 for a case
where that is more than zero after the owner thinks they are done). Nothing to fix in code for a
hackathon deploy; the threat model should state the assumption in one line, and the mainnet story is
a multisig or a burned authority.

### INFO notes, no action required

- `README` says a compromised agent key "cannot change any field of the mandate". It can and does
  write `spent`, `last_nonce`, `spend_count`, `refusal_count`, `status` (to EXPIRED or EXHAUSTED) and
  clears `override_*` by paying. All of those narrow. "Cannot widen any field" is the accurate claim.
- `README` says a malicious merchant "cannot replay a settled charge, because the nonce is monotonic".
  The merchant cannot submit `charge` at all (agent signature), and Solana already rejects a
  re-submitted signed transaction. What the nonce actually buys is idempotency for the agent's own
  at-least-once retries and a binding between an override and one specific charge. Credit the right
  mechanism.
- `grant_override` does not check `expires_at`, only status; past expiry but before the first refusal
  flips the status, an override can be granted. Harmless: `charge` checks the clock before anything.
- `open_mandate` accepts `agent = Pubkey::default()`, which produces a mandate nobody can charge. The
  owner's own choice.
- If the owner names themself as merchant, a charge to the source account itself is a self-transfer:
  the token program moves nothing and does not decrement `delegated_amount`, while `spent` still
  advances. Again the owner's choice; note that `spent` can move without funds moving in that case.
- When a charge breaks both the per-payment ceiling and the cap, the reason reported is
  `OVER_PER_TX_MAX` with `suggested_override = 0`. The zero is the honest signal; a reader that only
  looks at the reason code will think an override could help.
- The `Refused` event carries no counterparty; the indexer recovers it from the instruction's accounts.

## Threat model in README.md against the code

The table below is the audit as of commit 4b50a63, before the fixes in #37. Rows marked against
F1, F2 and F4 describe behaviour that has since changed, and README.md has been corrected.

| README statement | Verdict | Where it overstates |
|---|---|---|
| A compromised agent key can submit charges to the named merchant, up to the per-payment maximum, up to the remaining cap, until the expiry. The owner revokes in one signature. | Holds, one caveat | Once status has flipped to EXPIRED or EXHAUSTED, the one signature is a raw `spl-token revoke`, not `revoke_mandate` (F1). A compromised agent can also strand the mandate (F3) and evict the ring window (F7); neither costs the owner money. |
| A compromised agent key cannot change any field of the mandate, name a different merchant, extend the expiry, grant itself an override, or touch any other mandate. | Holds as intended | "Any field" is loose; the agent writes narrowing fields. See INFO. |
| The program cannot move funds the owner has not delegated. The SPL delegation is the hard ceiling underneath the program's own accounting. | Holds | True of the program as deployed. The upgrade authority is not mentioned (F8). And the delegation can outlive the mandate (F1). |
| A malicious merchant can only receive what the mandate allows, and cannot replay a settled charge, because the nonce is monotonic on payment. | Holds, wrong credit | The merchant cannot submit a charge in the first place; replay of a signed transaction is stopped by Solana. See INFO. |
| A forged mandate account cannot be substituted. `charge` re-derives the mandate address from the fields stored inside it and rejects a mismatch, and the CPI signs as that PDA. | Holds | The re-derivation is the second of three walls (C4). The first is the runtime's owner check on `Account<Mandate>`, which is what stops the forgery from existing; the third is the SPL delegate. |
| The ledger records every decision the agent submits. It cannot record a charge the agent never attempted. No payment happens without a record, and no attempt is judged by the agent instead of by the chain. | Two of three hold | "Every decision the agent submits" is false for declines the token program makes (F4) and for inputs Anchor rejects before `evaluate` (wrong mint, wrong source, wrong ledger), all of which are errors with no entry. "No payment without a record" and "no attempt judged by the agent" hold. |
| Only a paid charge advances the nonce, so a settled payment cannot be replayed while a refused one can still be retried after an override. | Half holds | The retry works only if no other nonce paid in between, and the shipped watcher never retries a refused nonce at all (F2). |

## What was tried and did not break anything

Listed so the absence of a finding is evidence rather than silence.

- Signing every owner instruction with the agent key, and `charge` with a stranger and with the owner.
- Opening a mandate with `agent == owner`, and over a token account the signer does not own.
- Cross-mandate confusion: an attacker's valid mandate pointed at the victim's `source` and at the
  victim's `ledger`; two mandates of one owner with swapped ledgers; the ledger passed as the mandate.
- Two program-owned forgeries injected straight into the VM (impossible on a real cluster, done to
  test the re-derivation in isolation): one at a non-PDA address, one at a PDA the attacker controls.
- `u64::MAX` for cap, per-payment max, charge amount and override amount, around a non-zero `spent`.
- Override above remaining cap, override used after the cap shrank under it, override consumed twice,
  override nonce re-used after payment, same nonce twice in one transaction.
- Revoke then charge, revoke then override, revoke then revoke, revoke then hand re-approval of the
  delegation outside the program.
- Clock warped past expiry with the status still ACTIVE, then after the flip.
- `Pod` bound and byte-exact sizes on `Entry` and `Ledger`; decode of an all-zero slot.
- Frozen merchant account under a mint with a freeze authority.
- 64 multibyte characters of purpose.
- Second mandate on the same source; 32 refusals in a row.
- Read-only: reentrancy (no CPI target other than the two token programs, constrained by
  `Interface<TokenInterface>`), account cosplay across Token and Token-2022 (a mismatched
  `token_program` fails inside the CPI), log injection through `purpose` (the indexer decodes
  `Program data:` events, not text lines; `indexer/src/events.ts:15`), rent-exempt pre-funding of the
  PDA addresses to block `init` (Anchor's `init` handles pre-funded accounts).

## Not covered

The mobile app, the SDK, the watcher's key handling, the merchant terminal and the RPC path are outside this
pass. The SDK's own passes are on [PR 195](https://github.com/Arlencho/veto/pull/195) and [PR 203](https://github.com/Arlencho/veto/pull/203). Dependency advisories were not run (`cargo audit` is not installed here); Anchor 1.2.0 and
anchor-spl 1.2.0 are the pinned versions. The devnet deployment was not probed live.

## If someone forces you (Hold)

Hold landed after this review and the verdicts above do not cover it. This section states, in plain
words, what `programs/veto/src/hold.rs` guarantees when an owner is coerced, and what it does not.

What the deployed program guarantees on a vault that had a guardian before any key was lost:

- An instant withdrawal only goes to a destination this vault has paid before. A new address gets
  money before the wait ends only through `skip`, which needs both keys.
- Anything else waits 1, 2, or 3 days on the chain clock, whichever delay the vault was set to.
- No single key, including the owner's, can shorten a wait. Paying a held withdrawal early (`skip`)
  needs both the owner key and the guardian key. Loosening any rule, including adding or changing
  the guardian, waits out the current delay.
  `recover` only goes to the safe address chosen in advance.
  Neither key alone can recover or close to itself: on an older vault whose safe address is the
  owner or the guardian key, that key alone is refused until the safe address is repaired.
- The guardian is alerted and can stop a held withdrawal, or freeze the whole vault, with one tap.

What it does not do:

- It does not protect a person's physical safety.
- Someone who holds the owner for longer than the delay, or who gets both keys, can still get the money.
- A guardian on the same phone as the owner key is not a second factor. Keep the guardian on a second
  device kept somewhere else.
- The vault's settings, including the safe address, are public on chain. Anyone can read them.

Fixed on devnet, 2026-09-28: on a vault created without a guardian, the program deployed before
that upgrade applied adding a guardian at once, so whoever held the owner key could add a guardian
key and then `skip` a held withdrawal with both keys. The 2026-09-28 upgrade from `74c9e99`
(PR #374 and PR #376, recorded in [DEVNET.md](DEVNET.md)) makes any guardian change wait out the
vault's delay. Vaults created before the 2026-09-26 safe-address upgrade may have a safe address
equal to the guardian and should be repaired ([HOLD_MIGRATIONS.md](HOLD_MIGRATIONS.md)).
