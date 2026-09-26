//! Hold vault: big withdrawals wait, and a second key can stop them.
//!
//! Same harness as `red_team.rs`. Build first with
//! `ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys`.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::Instruction, program_pack::Pack, system_instruction, system_program,
        },
        AccountDeserialize, Discriminator, InstructionData, Space, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    veto::{
        hold::{
            HoldChangeApplied, HoldChangeCancelled, HoldChangeProposed, HoldDeposited,
            HoldExecuted, HoldFrozen, HoldHeld, HoldPaid, HoldRecovered, HoldRefused, HoldSkipped,
            HoldStopped, HoldUnfreezeScheduled, HoldUnfrozen,
        },
        hold_state::*,
        Entry, HoldChange, Ledger, Mandate,
    },
};

const DECIMALS: u8 = 6;
const ONE: u64 = 1_000_000;
const PROGRAM_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/veto.so"));

struct Rules {
    vault_id: u64,
    guardian: bool,
    daily_limit: u64,
    delay_secs: i64,
    big_share_bps: u16,
    deposit: u64,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            vault_id: 1,
            guardian: true,
            daily_limit: 100 * ONE,
            delay_secs: HOLD_DELAY_1_DAY,
            big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
            deposit: 1_000 * ONE + 1,
        }
    }
}

struct World {
    svm: LiteSVM,
    owner: Keypair,
    guardian: Keypair,
    safe: Pubkey,
    safe_token: Pubkey,
    mint: Pubkey,
    source: Pubkey,
    vault: Pubkey,
    vault_token: Pubkey,
    ledger: Pubkey,
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| format!("{e:?}"))?;
    match svm.send_transaction(tx) {
        Ok(meta) => {
            svm.expire_blockhash();
            Ok(meta.logs)
        }
        Err(e) => {
            svm.expire_blockhash();
            Err(format!("{:?}\n{}", e.err, e.meta.pretty_logs()))
        }
    }
}

fn assert_err(result: Result<Vec<String>, String>, needle: &str) {
    match result {
        Ok(_) => panic!("expected an error containing {needle:?}, transaction succeeded"),
        Err(e) => assert!(
            e.contains(needle),
            "expected {needle:?} in error, got:\n{e}"
        ),
    }
}

fn now(svm: &LiteSVM) -> i64 {
    let clock: Clock = svm.get_sysvar();
    clock.unix_timestamp
}

fn warp(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

fn token_balance(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let raw = svm.get_account(key).expect("token account exists");
    spl_token::state::Account::unpack(&raw.data)
        .expect("token account unpacks")
        .amount
}

fn read_vault(svm: &LiteSVM, key: &Pubkey) -> HoldVault {
    let raw = svm.get_account(key).expect("vault exists");
    let mut data: &[u8] = &raw.data;
    HoldVault::try_deserialize(&mut data).expect("vault deserializes")
}

fn read_ledger(svm: &LiteSVM, key: &Pubkey) -> HoldLedger {
    let raw = svm.get_account(key).expect("hold ledger exists");
    let start = 8;
    let end = start + std::mem::size_of::<HoldLedger>();
    *bytemuck::from_bytes::<HoldLedger>(&raw.data[start..end])
}

fn last_entry(svm: &LiteSVM, key: &Pubkey) -> HoldEntry {
    let ledger = read_ledger(svm, key);
    let last = (ledger.head as usize + HOLD_LEDGER_CAPACITY - 1) % HOLD_LEDGER_CAPACITY;
    ledger.entries[last]
}

fn pending_rows(vault: &HoldVault) -> Vec<PendingWithdrawal> {
    vault
        .pending
        .iter()
        .copied()
        .filter(|row| row.status == WITHDRAWAL_PENDING)
        .collect()
}

fn newest_pending(vault: &HoldVault) -> PendingWithdrawal {
    pending_rows(vault)
        .into_iter()
        .max_by_key(|row| row.id)
        .expect("a withdrawal is pending")
}

fn decode_b64(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let (a, b, c, d) = (chunk[0], chunk[1], chunk[2], chunk[3]);
        let av = val(a)?;
        let bv = val(b)?;
        let cv = if c == b'=' { 0 } else { val(c)? };
        let dv = if d == b'=' { 0 } else { val(d)? };
        out.push((av << 2) | (bv >> 4));
        if c != b'=' {
            out.push((bv << 4) | (cv >> 2));
        }
        if d != b'=' {
            out.push((cv << 6) | dv);
        }
    }
    Some(out)
}

fn saw_event(logs: &[String], disc: &[u8]) -> bool {
    logs.iter().any(|line| {
        let Some(data) = line.strip_prefix("Program data: ") else {
            return false;
        };
        let Some(raw) = decode_b64(data.trim()) else {
            return false;
        };
        raw.len() >= disc.len() && raw[..disc.len()] == *disc
    })
}

fn assert_recorded(logs: &[String], line: &str, disc: &[u8]) {
    assert!(
        logs.iter().any(|entry| entry.contains(line)),
        "missing log {line:?}\n{}",
        logs.join("\n")
    );
    assert!(
        saw_event(logs, disc),
        "missing event for {line:?}\n{}",
        logs.join("\n")
    );
}

fn assert_last(w: &World, kind: u8, reason: u8) {
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, kind, "ledger kind");
    assert_eq!(entry.reason, reason, "ledger reason");
}

fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let account = Keypair::new();
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            10_000_000,
            spl_token::state::Account::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_account3(&spl_token::ID, &account.pubkey(), mint, owner)
            .unwrap(),
    ];
    send(svm, payer, &[payer, &account], &ixs).expect("create token account");
    account.pubkey()
}

fn pdas(owner: &Pubkey, vault_id: u64) -> (Pubkey, Pubkey, Pubkey) {
    let (vault, _) = Pubkey::find_program_address(
        &[b"hold", owner.as_ref(), &vault_id.to_le_bytes()],
        &veto::id(),
    );
    let (vault_token, _) =
        Pubkey::find_program_address(&[b"hold-token", vault.as_ref()], &veto::id());
    let (ledger, _) = Pubkey::find_program_address(&[b"hold-ledger", vault.as_ref()], &veto::id());
    (vault, vault_token, ledger)
}

fn boot() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let e_flags = u32::from_le_bytes(PROGRAM_BYTES[48..52].try_into().unwrap());
    assert!(
        e_flags == 0,
        "veto.so must be SBPF v0 for LiteSVM 0.10; run make build-test"
    );
    svm.add_program(veto::id(), PROGRAM_BYTES)
        .expect("program loads");
    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 100_000_000_000).unwrap();
    (svm, owner)
}

fn create_mint(svm: &mut LiteSVM, owner: &Keypair) -> Pubkey {
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let ixs = [
        system_instruction::create_account(
            &owner.pubkey(),
            &mint,
            10_000_000,
            spl_token::state::Mint::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_mint2(
            &spl_token::ID,
            &mint,
            &owner.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(svm, owner, &[owner, &mint_kp], &ixs).expect("create mint");
    mint
}

fn mint_to(svm: &mut LiteSVM, owner: &Keypair, mint: &Pubkey, dest: &Pubkey, amount: u64) {
    send(
        svm,
        owner,
        &[owner],
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            mint,
            dest,
            &owner.pubkey(),
            &[],
            amount,
        )
        .unwrap()],
    )
    .expect("mint");
}

fn open_vault(rules: Rules) -> World {
    let (mut svm, owner) = boot();
    let guardian = Keypair::new();
    svm.airdrop(&guardian.pubkey(), 100_000_000_000).unwrap();
    let safe_kp = Keypair::new();
    let safe = safe_kp.pubkey();
    let mint = create_mint(&mut svm, &owner);
    let source = create_token_account(&mut svm, &owner, &mint, &owner.pubkey());
    let safe_token = create_token_account(&mut svm, &owner, &mint, &safe);
    if rules.deposit > 0 {
        mint_to(&mut svm, &owner, &mint, &source, rules.deposit);
    }

    let (vault, vault_token, ledger) = pdas(&owner.pubkey(), rules.vault_id);
    let init = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::InitVault {
            args: veto::hold::InitVaultArgs {
                vault_id: rules.vault_id,
                guardian: if rules.guardian {
                    guardian.pubkey()
                } else {
                    Pubkey::default()
                },
                safe_address: safe,
                daily_limit: rules.daily_limit,
                delay_secs: rules.delay_secs,
                big_share_bps: rules.big_share_bps,
            },
        }
        .data(),
        veto::accounts::InitVault {
            owner: owner.pubkey(),
            vault,
            ledger,
            vault_token,
            mint,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &owner, &[&owner], &[init]).expect("init vault");

    if rules.deposit > 0 {
        let deposit = Instruction::new_with_bytes(
            veto::id(),
            &veto::instruction::Deposit {
                amount: rules.deposit,
            }
            .data(),
            veto::accounts::Deposit {
                owner: owner.pubkey(),
                vault,
                ledger,
                source,
                vault_token,
                mint,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
        );
        let logs = send(&mut svm, &owner, &[&owner], &[deposit]).expect("deposit");
        assert_recorded(&logs, "HOLD DEPOSITED", HoldDeposited::DISCRIMINATOR);
        assert_eq!(token_balance(&svm, &source), 0);
        let entry = last_entry(&svm, &ledger);
        assert_eq!(entry.kind, HOLD_KIND_DEPOSITED);
    }
    assert_eq!(token_balance(&svm, &vault_token), rules.deposit);

    let token = svm.get_account(&vault_token).expect("vault token");
    let unpacked = spl_token::state::Account::unpack(&token.data).unwrap();
    assert_eq!(
        unpacked.owner, vault,
        "the vault PDA is the token authority"
    );

    World {
        svm,
        owner,
        guardian,
        safe,
        safe_token,
        mint,
        source,
        vault,
        vault_token,
        ledger,
    }
}

fn withdraw_ix(w: &World, owner: &Pubkey, amount: u64, dest: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Withdraw { amount }.data(),
        veto::accounts::Withdraw {
            owner: *owner,
            vault: w.vault,
            ledger: w.ledger,
            vault_token: w.vault_token,
            destination: *dest,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

fn withdraw(w: &mut World, amount: u64, dest: &Pubkey) -> Result<Vec<String>, String> {
    let owner = w.owner.insecure_clone();
    let ix = withdraw_ix(w, &owner.pubkey(), amount, dest);
    send(&mut w.svm, &owner, &[&owner], &[ix])
}

fn execute_ix(w: &World, id: u64, dest: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Execute { id }.data(),
        veto::accounts::Execute {
            vault: w.vault,
            ledger: w.ledger,
            vault_token: w.vault_token,
            destination: *dest,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

fn execute(w: &mut World, id: u64, dest: &Pubkey, payer: &Keypair) -> Result<Vec<String>, String> {
    let ix = execute_ix(w, id, dest);
    send(&mut w.svm, payer, &[payer], &[ix])
}

fn stop(w: &mut World, id: u64, authority: &Keypair) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Stop { id }.data(),
        veto::accounts::Stop {
            authority: authority.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, authority, &[authority], &[ix])
}

fn freeze(w: &mut World, authority: &Keypair) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Freeze {}.data(),
        veto::accounts::Freeze {
            authority: authority.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, authority, &[authority], &[ix])
}

fn unfreeze(
    w: &mut World,
    owner: &Keypair,
    guardian: Option<&Keypair>,
) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Unfreeze {}.data(),
        veto::accounts::Unfreeze {
            owner: owner.pubkey(),
            guardian: guardian.map(|key| key.pubkey()),
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    match guardian {
        Some(guardian) => send(&mut w.svm, owner, &[owner, guardian], &[ix]),
        None => send(&mut w.svm, owner, &[owner], &[ix]),
    }
}

fn skip(
    w: &mut World,
    id: u64,
    dest: &Pubkey,
    owner: &Keypair,
    guardian: &Keypair,
) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Skip { id }.data(),
        veto::accounts::Skip {
            owner: owner.pubkey(),
            guardian: guardian.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
            vault_token: w.vault_token,
            destination: *dest,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    if owner.pubkey() == guardian.pubkey() {
        send(&mut w.svm, owner, &[owner], &[ix])
    } else {
        send(&mut w.svm, owner, &[owner, guardian], &[ix])
    }
}

fn recover(w: &mut World, authority: &Keypair, dest: &Pubkey) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Recover {}.data(),
        veto::accounts::Recover {
            authority: authority.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
            vault_token: w.vault_token,
            destination: *dest,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, authority, &[authority], &[ix])
}

fn current_rules(w: &World) -> HoldChange {
    let vault = read_vault(&w.svm, &w.vault);
    HoldChange {
        daily_limit: vault.daily_limit,
        delay_secs: vault.delay_secs,
        big_share_bps: vault.big_share_bps,
        guardian: vault.guardian,
        safe_address: vault.safe_address,
    }
}

fn propose(w: &mut World, values: HoldChange) -> Result<Vec<String>, String> {
    let owner = w.owner.insecure_clone();
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::ProposeChange { values }.data(),
        veto::accounts::ProposeChange {
            owner: owner.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[ix])
}

fn apply_change(w: &mut World, payer: &Keypair) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::ApplyChange {}.data(),
        veto::accounts::ApplyChange {
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, payer, &[payer], &[ix])
}

fn cancel_change(w: &mut World, authority: &Keypair) -> Result<Vec<String>, String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::CancelChange {}.data(),
        veto::accounts::CancelChange {
            authority: authority.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, authority, &[authority], &[ix])
}

fn new_dest(w: &mut World) -> Pubkey {
    let owner = w.owner.insecure_clone();
    create_token_account(&mut w.svm, &owner, &w.mint, &Pubkey::new_unique())
}

/// Pay 1 base unit to `dest` after the delay so the address is known, then
/// move the clock beyond the last retained hourly bucket.
fn arm_known(w: &mut World, dest: &Pubkey) {
    withdraw(w, 1, dest).expect("first payment to a new address is held");
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    assert_eq!(row.destination, *dest);
    assert_eq!(token_balance(&w.svm, dest), 0);
    let owner = w.owner.insecure_clone();
    warp(&mut w.svm, row.unlock_at);
    execute(w, row.id, dest, &owner).expect("execute the first payment");
    assert_eq!(token_balance(&w.svm, dest), 1);
    warp(&mut w.svm, row.unlock_at + HOLD_WINDOW_SECS + 3600);
}

fn known_world(rules: Rules) -> (World, Pubkey) {
    let mut w = open_vault(rules);
    let dest = new_dest(&mut w);
    arm_known(&mut w, &dest);
    (w, dest)
}

fn share_of(balance: u64, bps: u16) -> u64 {
    ((balance as u128) * u128::from(bps) / u128::from(HOLD_BPS_DENOMINATOR)) as u64
}

#[test]
fn the_mandate_and_ledger_layouts_stay_the_same() {
    assert_eq!(std::mem::size_of::<Entry>(), 72);
    assert_eq!(std::mem::size_of::<Ledger>(), 2344);
    assert_eq!(Mandate::INIT_SPACE, 302);
    assert_eq!(8 + HoldVault::INIT_SPACE, 1691);
}

#[test]
fn an_everyday_withdrawal_to_a_known_address_is_paid_at_once() {
    let (mut w, dest) = known_world(Rules::default());
    let before = token_balance(&w.svm, &w.vault_token);
    let logs = withdraw(&mut w, 10 * ONE, &dest).expect("instant");
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    assert_last(&w, HOLD_KIND_PAID, HOLD_REASON_NONE);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault)).is_empty());
    assert_eq!(token_balance(&w.svm, &w.vault_token), before - 10 * ONE);
    assert_eq!(token_balance(&w.svm, &dest), 10 * ONE + 1);
}

#[test]
fn a_withdrawal_over_the_daily_limit_is_held_and_not_paid() {
    let (mut w, dest) = known_world(Rules::default());
    let before = token_balance(&w.svm, &w.vault_token);
    let clock = now(&w.svm);
    let logs = withdraw(&mut w, 101 * ONE, &dest).expect("held");
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_last(&w, HOLD_KIND_HELD, HOLD_REASON_NONE);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    assert_eq!(token_balance(&w.svm, &dest), 1);
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    assert_eq!(row.amount, 101 * ONE);
    assert_eq!(row.unlock_at, clock + HOLD_DELAY_1_DAY);
}

#[test]
fn a_withdrawal_to_a_new_address_is_held_until_it_has_been_paid_once() {
    let (mut w, known) = known_world(Rules::default());
    let fresh = new_dest(&mut w);
    let before = token_balance(&w.svm, &w.vault_token);
    let logs = withdraw(&mut w, 10 * ONE, &fresh).expect("new address is held");
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &fresh), 0);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let owner = w.owner.insecure_clone();
    warp(&mut w.svm, row.unlock_at);
    let logs = execute(&mut w, row.id, &fresh, &owner).expect("execute");
    assert_recorded(&logs, "HOLD EXECUTED", HoldExecuted::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &fresh), 10 * ONE);
    warp(&mut w.svm, row.unlock_at + HOLD_WINDOW_SECS + 3600);
    let logs = withdraw(&mut w, 10 * ONE, &fresh).expect("second payment is instant");
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &fresh), 20 * ONE);
    let _ = known;
}

#[test]
fn a_withdrawal_over_a_quarter_of_the_vault_in_a_day_is_held() {
    let rules = Rules {
        daily_limit: 10_000 * ONE,
        ..Rules::default()
    };
    let (mut w, dest) = known_world(rules);
    let before = token_balance(&w.svm, &w.vault_token);
    assert_eq!(before, 1_000 * ONE);
    assert_eq!(share_of(before, HOLD_DEFAULT_BIG_SHARE_BPS), 250 * ONE);
    let logs = withdraw(&mut w, 250 * ONE, &dest).expect("quarter is instant");
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &dest), 250 * ONE + 1);
    let vault_after = token_balance(&w.svm, &w.vault_token);
    let logs = withdraw(&mut w, 1, &dest).expect("one past the quarter is held");
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_after);
    assert_eq!(token_balance(&w.svm, &dest), 250 * ONE + 1);
}

#[test]
fn execute_pays_after_the_wait_and_refuses_one_second_before_it() {
    let (mut w, _known) = known_world(Rules::default());
    let dest = new_dest(&mut w);
    withdraw(&mut w, 25 * ONE, &dest).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    warp(&mut w.svm, row.unlock_at - 1);
    assert_err(execute(&mut w, row.id, &dest, &stranger), "TooEarly");
    assert_eq!(token_balance(&w.svm, &dest), 0);
    assert_eq!(
        newest_pending(&read_vault(&w.svm, &w.vault)).unlock_at,
        row.unlock_at
    );
    warp(&mut w.svm, row.unlock_at);
    let logs = execute(&mut w, row.id, &dest, &stranger).expect("a stranger can execute");
    assert_recorded(&logs, "HOLD EXECUTED", HoldExecuted::DISCRIMINATOR);
    assert_last(&w, HOLD_KIND_PAID, HOLD_REASON_NONE);
    assert_eq!(token_balance(&w.svm, &dest), 25 * ONE);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault)).is_empty());
    assert_eq!(execute_ix(&w, row.id, &dest).data.len(), 16);
}

#[test]
fn the_owner_or_the_guardian_can_stop_a_pending_withdrawal() {
    let (mut w, dest) = known_world(Rules::default());
    let other = new_dest(&mut w);
    withdraw(&mut w, 200 * ONE, &dest).unwrap();
    withdraw(&mut w, 200 * ONE, &other).unwrap();
    let rows = pending_rows(&read_vault(&w.svm, &w.vault));
    assert_eq!(rows.len(), 2);
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let before = token_balance(&w.svm, &w.vault_token);
    let logs = stop(&mut w, rows[0].id, &owner).expect("owner stops");
    assert_recorded(&logs, "HOLD STOPPED", HoldStopped::DISCRIMINATOR);
    assert_last(&w, HOLD_KIND_STOPPED, HOLD_REASON_NONE);
    let logs = stop(&mut w, rows[1].id, &guardian).expect("guardian stops");
    assert_recorded(&logs, "HOLD STOPPED", HoldStopped::DISCRIMINATOR);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault)).is_empty());
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    assert_eq!(token_balance(&w.svm, &dest), 1);
    assert_eq!(token_balance(&w.svm, &other), 0);
}

#[test]
fn freeze_blocks_execute_until_both_keys_unfreeze() {
    let (mut w, _known) = known_world(Rules::default());
    let dest = new_dest(&mut w);
    withdraw(&mut w, 80 * ONE, &dest).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    warp(&mut w.svm, row.unlock_at);
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let logs = freeze(&mut w, &guardian).expect("guardian freezes");
    assert_recorded(&logs, "HOLD FROZEN", HoldFrozen::DISCRIMINATOR);
    assert!(read_vault(&w.svm, &w.vault).frozen);
    assert_err(execute(&mut w, row.id, &dest, &owner), "VaultFrozen");
    assert_err(
        skip(&mut w, row.id, &dest, &owner, &guardian),
        "VaultFrozen",
    );
    assert_eq!(token_balance(&w.svm, &dest), 0);
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let logs = unfreeze(&mut w, &owner, Some(&guardian)).expect("both keys");
    assert_recorded(&logs, "HOLD UNFROZEN", HoldUnfrozen::DISCRIMINATOR);
    assert!(!read_vault(&w.svm, &w.vault).frozen);
    let logs = execute(&mut w, row.id, &dest, &owner).expect("execute after unfreeze");
    assert_recorded(&logs, "HOLD EXECUTED", HoldExecuted::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &dest), 80 * ONE);
}

#[test]
fn recover_sends_the_whole_balance_to_the_safe_address_while_frozen() {
    let (mut w, _dest) = known_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let logs = freeze(&mut w, &owner).unwrap();
    assert_recorded(&logs, "HOLD FROZEN", HoldFrozen::DISCRIMINATOR);
    let vault_before = token_balance(&w.svm, &w.vault_token);
    assert!(vault_before > 0);
    let safe = w.safe_token;
    let logs = recover(&mut w, &owner, &safe).expect("recover while frozen");
    assert_recorded(&logs, "HOLD RECOVERED", HoldRecovered::DISCRIMINATOR);
    assert_last(&w, HOLD_KIND_RECOVERED, HOLD_REASON_NONE);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 0);
    assert_eq!(token_balance(&w.svm, &w.safe_token), vault_before);
}

#[test]
fn unfreeze_and_skip_do_nothing_unless_both_keys_sign() {
    let (mut w, _known) = known_world(Rules::default());
    let dest = new_dest(&mut w);
    withdraw(&mut w, 40 * ONE, &dest).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    freeze(&mut w, &owner).unwrap();

    assert_err(unfreeze(&mut w, &owner, None), "BothKeysRequired");
    assert_err(unfreeze(&mut w, &owner, Some(&stranger)), "NotTheGuardian");
    assert_err(unfreeze(&mut w, &guardian, Some(&owner)), "ConstraintSeeds");
    assert!(read_vault(&w.svm, &w.vault).frozen);

    assert_err(
        skip(&mut w, row.id, &dest, &owner, &stranger),
        "NotTheGuardian",
    );
    assert_eq!(token_balance(&w.svm, &dest), 0);
    assert_eq!(
        newest_pending(&read_vault(&w.svm, &w.vault)).unlock_at,
        row.unlock_at
    );

    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let logs = unfreeze(&mut w, &owner, Some(&guardian)).unwrap();
    assert_recorded(&logs, "HOLD UNFROZEN", HoldUnfrozen::DISCRIMINATOR);
    let before = token_balance(&w.svm, &w.vault_token);
    let logs = skip(&mut w, row.id, &dest, &owner, &guardian).expect("both keys skip");
    assert_recorded(&logs, "HOLD SKIPPED", HoldSkipped::DISCRIMINATOR);
    assert_last(&w, HOLD_KIND_SKIPPED, HOLD_REASON_NONE);
    assert!(now(&w.svm) < row.unlock_at);
    assert_eq!(token_balance(&w.svm, &dest), 40 * ONE);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before - 40 * ONE);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault)).is_empty());

    let mut alone = open_vault(Rules {
        vault_id: 7,
        guardian: false,
        ..Rules::default()
    });
    let owner = alone.owner.insecure_clone();
    freeze(&mut alone, &owner).unwrap();
    let clock = now(&alone.svm);
    let logs = unfreeze(&mut alone, &owner, None).expect("schedule");
    assert_recorded(
        &logs,
        "HOLD UNFREEZE SCHEDULED",
        HoldUnfreezeScheduled::DISCRIMINATOR,
    );
    assert_last(&alone, HOLD_KIND_UNFREEZE_SCHEDULED, HOLD_REASON_NONE);
    let armed = read_vault(&alone.svm, &alone.vault);
    assert!(armed.frozen);
    assert_eq!(armed.unfreeze_at, clock + armed.delay_secs);
    assert_err(unfreeze(&mut alone, &owner, None), "UnfreezeNotReady");
    assert_eq!(
        read_vault(&alone.svm, &alone.vault).unfreeze_at,
        armed.unfreeze_at
    );
    warp(&mut alone.svm, armed.unfreeze_at - 1);
    assert_err(unfreeze(&mut alone, &owner, None), "UnfreezeNotReady");
    warp(&mut alone.svm, armed.unfreeze_at);
    let logs = unfreeze(&mut alone, &owner, None).expect("delay elapsed");
    assert_recorded(&logs, "HOLD UNFROZEN", HoldUnfrozen::DISCRIMINATOR);
    assert!(!read_vault(&alone.svm, &alone.vault).frozen);

    let dest = new_dest(&mut alone);
    withdraw(&mut alone, 5 * ONE, &dest).unwrap();
    let held = newest_pending(&read_vault(&alone.svm, &alone.vault));
    let other = Keypair::new();
    alone.svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    assert_err(
        skip(&mut alone, held.id, &dest, &owner, &other),
        "BothKeysRequired",
    );
    assert_eq!(token_balance(&alone.svm, &dest), 0);
}

#[test]
fn tightening_applies_at_once_and_loosening_waits_out_the_current_delay() {
    let (mut w, dest) = known_world(Rules {
        delay_secs: HOLD_DELAY_3_DAYS,
        guardian: false,
        ..Rules::default()
    });
    let guardian = Keypair::new();
    w.svm.airdrop(&guardian.pubkey(), 1_000_000_000).unwrap();
    let mut tighten = current_rules(&w);
    tighten.daily_limit = 40 * ONE;
    tighten.delay_secs = HOLD_DELAY_3_DAYS;
    tighten.big_share_bps = 1_000;
    tighten.guardian = guardian.pubkey();
    let logs = propose(&mut w, tighten).expect("tighten");
    assert_recorded(
        &logs,
        "HOLD CHANGE APPLIED",
        HoldChangeApplied::DISCRIMINATOR,
    );
    let vault = read_vault(&w.svm, &w.vault);
    assert_eq!(vault.daily_limit, 40 * ONE);
    assert_eq!(vault.big_share_bps, 1_000);
    assert_eq!(vault.guardian, guardian.pubkey());
    assert!(!vault.change.active);
    let logs = withdraw(&mut w, 40 * ONE, &dest).expect("inside the new limit");
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    let held_at = token_balance(&w.svm, &w.vault_token);
    let logs = withdraw(&mut w, 1 * ONE, &dest).expect("over the new limit is held");
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.vault_token), held_at);

    let (mut w, dest) = known_world(Rules {
        delay_secs: HOLD_DELAY_3_DAYS,
        ..Rules::default()
    });
    let old = current_rules(&w);
    let new_guardian = Keypair::new();
    w.svm
        .airdrop(&new_guardian.pubkey(), 1_000_000_000)
        .unwrap();
    let new_safe_owner = Pubkey::new_unique();
    let owner = w.owner.insecure_clone();
    let new_safe = create_token_account(&mut w.svm, &owner, &w.mint, &new_safe_owner);
    let loosen = HoldChange {
        daily_limit: 400 * ONE,
        delay_secs: HOLD_DELAY_1_DAY,
        big_share_bps: 5_000,
        guardian: new_guardian.pubkey(),
        safe_address: new_safe_owner,
    };
    let clock = now(&w.svm);
    let logs = propose(&mut w, loosen).expect("loosen");
    assert_recorded(
        &logs,
        "HOLD CHANGE PROPOSED",
        HoldChangeProposed::DISCRIMINATOR,
    );
    let vault = read_vault(&w.svm, &w.vault);
    assert_eq!(vault.daily_limit, old.daily_limit);
    assert_eq!(vault.delay_secs, HOLD_DELAY_3_DAYS);
    assert_eq!(vault.big_share_bps, old.big_share_bps);
    assert_eq!(vault.guardian, old.guardian);
    assert_eq!(vault.safe_address, old.safe_address);
    assert!(vault.change.active);
    assert_eq!(vault.change.effective_at, clock + HOLD_DELAY_3_DAYS);
    let owner = w.owner.insecure_clone();
    assert_err(apply_change(&mut w, &owner), "ChangeNotReady");
    assert_err(freeze(&mut w, &new_guardian), "NotOwnerOrGuardian");
    let old_guardian = w.guardian.insecure_clone();
    let logs = cancel_change(&mut w, &old_guardian).expect("guardian cancels");
    assert_recorded(
        &logs,
        "HOLD CHANGE CANCELLED",
        HoldChangeCancelled::DISCRIMINATOR,
    );
    assert!(!read_vault(&w.svm, &w.vault).change.active);

    let clock = now(&w.svm);
    propose(&mut w, loosen).unwrap();
    let effective = read_vault(&w.svm, &w.vault).change.effective_at;
    assert_eq!(effective, clock + HOLD_DELAY_3_DAYS);
    warp(&mut w.svm, effective - 1);
    assert_err(apply_change(&mut w, &owner), "ChangeNotReady");
    assert_eq!(read_vault(&w.svm, &w.vault).daily_limit, old.daily_limit);
    warp(&mut w.svm, effective);
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let logs = apply_change(&mut w, &stranger).expect("apply");
    assert_recorded(
        &logs,
        "HOLD CHANGE APPLIED",
        HoldChangeApplied::DISCRIMINATOR,
    );
    let vault = read_vault(&w.svm, &w.vault);
    assert_eq!(vault.daily_limit, 400 * ONE);
    assert_eq!(vault.delay_secs, HOLD_DELAY_1_DAY);
    assert_eq!(vault.big_share_bps, 5_000);
    assert_eq!(vault.guardian, new_guardian.pubkey());
    assert_eq!(vault.safe_address, new_safe_owner);
    assert!(!vault.change.active);
    assert_err(freeze(&mut w, &old_guardian), "NotOwnerOrGuardian");
    freeze(&mut w, &new_guardian).unwrap();
    assert!(read_vault(&w.svm, &w.vault).frozen);
    let owner = w.owner.insecure_clone();
    let old_safe = w.safe_token;
    assert_err(recover(&mut w, &owner, &old_safe), "NotTheSafeAddress");
    let vault_before = token_balance(&w.svm, &w.vault_token);
    recover(&mut w, &owner, &new_safe).unwrap();
    assert_eq!(token_balance(&w.svm, &new_safe), vault_before);
    assert_eq!(token_balance(&w.svm, &w.safe_token), 0);
    let _ = dest;
}

#[test]
fn a_stolen_owner_key_moves_at_most_the_instant_allowance() {
    let (mut w, dest) = known_world(Rules::default());
    let vault_before = token_balance(&w.svm, &w.vault_token);
    assert_eq!(vault_before, 1_000 * ONE);
    let allowance = 100 * ONE;
    assert!(allowance < share_of(vault_before, HOLD_DEFAULT_BIG_SHARE_BPS));
    let known_before = token_balance(&w.svm, &dest);
    let attacker_token = new_dest(&mut w);
    let logs = withdraw(&mut w, allowance, &dest).expect("allowance is instant");
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    let logs = withdraw(&mut w, 1, &dest).expect("past the allowance is held");
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    let fresh = new_dest(&mut w);
    withdraw(&mut w, 50 * ONE, &fresh).unwrap();
    let owner = w.owner.insecure_clone();
    let raw = spl_token::instruction::transfer(
        &spl_token::ID,
        &w.vault_token,
        &attacker_token,
        &owner.pubkey(),
        &[],
        allowance,
    )
    .unwrap();
    assert!(send(&mut w.svm, &owner, &[&owner], &[raw]).is_err());
    assert_err(
        recover(&mut w, &owner, &attacker_token),
        "NotTheSafeAddress",
    );
    let held = pending_rows(&read_vault(&w.svm, &w.vault));
    assert_eq!(held.len(), 2);
    assert_err(execute(&mut w, held[0].id, &dest, &owner), "TooEarly");
    let guardian = w.guardian.insecure_clone();
    freeze(&mut w, &guardian).unwrap();
    warp(
        &mut w.svm,
        held[0].unlock_at.max(held[1].unlock_at) + HOLD_WINDOW_SECS,
    );
    assert_err(execute(&mut w, held[0].id, &dest, &owner), "VaultFrozen");
    assert_err(execute(&mut w, held[1].id, &fresh, &owner), "VaultFrozen");
    assert_eq!(
        token_balance(&w.svm, &w.vault_token),
        vault_before - allowance
    );
    assert_eq!(token_balance(&w.svm, &dest), known_before + allowance);
    assert_eq!(token_balance(&w.svm, &fresh), 0);
    assert_eq!(token_balance(&w.svm, &attacker_token), 0);
    assert_eq!(token_balance(&w.svm, &w.safe_token), 0);
}

#[test]
fn a_stolen_guardian_key_cannot_move_money_anywhere_but_the_safe_address() {
    let (mut w, shop) = known_world(Rules::default());
    let guardian = w.guardian.insecure_clone();
    let owner = w.owner.insecure_clone();
    let pocket = new_dest(&mut w);
    let before = token_balance(&w.svm, &w.vault_token);
    let shop_before = token_balance(&w.svm, &shop);

    let ix = withdraw_ix(&w, &guardian.pubkey(), 10 * ONE, &pocket);
    assert_err(
        send(&mut w.svm, &guardian, &[&guardian], &[ix]),
        "ConstraintSeeds",
    );
    let raw = spl_token::instruction::transfer(
        &spl_token::ID,
        &w.vault_token,
        &pocket,
        &guardian.pubkey(),
        &[],
        before,
    )
    .unwrap();
    assert!(send(&mut w.svm, &guardian, &[&guardian], &[raw]).is_err());
    assert_err(recover(&mut w, &guardian, &pocket), "NotTheSafeAddress");
    let mut redirect = current_rules(&w);
    redirect.safe_address = guardian.pubkey();
    let propose_ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::ProposeChange { values: redirect }.data(),
        veto::accounts::ProposeChange {
            owner: guardian.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    assert_err(
        send(&mut w.svm, &guardian, &[&guardian], &[propose_ix]),
        "ConstraintSeeds",
    );
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    assert_eq!(token_balance(&w.svm, &pocket), 0);
    assert_eq!(read_vault(&w.svm, &w.vault).safe_address, w.safe);

    let pending_dest = new_dest(&mut w);
    withdraw(&mut w, 30 * ONE, &pending_dest).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    assert_err(
        skip(&mut w, row.id, &pending_dest, &guardian, &guardian),
        "ConstraintSeeds",
    );
    assert_err(execute(&mut w, row.id, &pocket, &guardian), "TooEarly");
    assert_err(
        execute(&mut w, row.id, &pending_dest, &guardian),
        "TooEarly",
    );
    warp(&mut w.svm, row.unlock_at);
    assert_err(
        execute(&mut w, row.id, &pocket, &guardian),
        "DestinationMismatch",
    );
    assert_eq!(token_balance(&w.svm, &pending_dest), 0);
    let logs = stop(&mut w, row.id, &guardian).expect("guardian stops the hold");
    assert_recorded(&logs, "HOLD STOPPED", HoldStopped::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    let safe = w.safe_token;
    let logs = recover(&mut w, &guardian, &safe).expect("recover to safe");
    assert_recorded(&logs, "HOLD RECOVERED", HoldRecovered::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.safe_token), before);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 0);
    assert_eq!(token_balance(&w.svm, &pocket), 0);
    assert_eq!(token_balance(&w.svm, &pending_dest), 0);
    assert_eq!(token_balance(&w.svm, &shop), shop_before);
    let _ = owner;
}

#[test]
fn no_single_key_shortens_a_wait_or_loosens_a_rule_before_the_delay() {
    let (mut w, _known) = known_world(Rules {
        delay_secs: HOLD_DELAY_3_DAYS,
        ..Rules::default()
    });
    let dest = new_dest(&mut w);
    withdraw(&mut w, 70 * ONE, &dest).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_err(
        skip(&mut w, row.id, &dest, &owner, &stranger),
        "NotTheGuardian",
    );
    assert_eq!(
        newest_pending(&read_vault(&w.svm, &w.vault)).unlock_at,
        row.unlock_at
    );
    assert_eq!(token_balance(&w.svm, &dest), 0);
    let before = token_balance(&w.svm, &w.vault_token);
    let logs = skip(&mut w, row.id, &dest, &owner, &guardian).expect("both keys");
    assert_recorded(&logs, "HOLD SKIPPED", HoldSkipped::DISCRIMINATOR);
    assert!(now(&w.svm) < row.unlock_at);
    assert_eq!(token_balance(&w.svm, &dest), 70 * ONE);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before - 70 * ONE);

    let (mut w, _known) = known_world(Rules {
        delay_secs: HOLD_DELAY_3_DAYS,
        ..Rules::default()
    });
    let dest = new_dest(&mut w);
    withdraw(&mut w, 15 * ONE, &dest).unwrap();
    let original = newest_pending(&read_vault(&w.svm, &w.vault)).unlock_at;
    let mut values = current_rules(&w);
    values.delay_secs = HOLD_DELAY_1_DAY;
    values.daily_limit = 500 * ONE;
    let clock = now(&w.svm);
    propose(&mut w, values).unwrap();
    let vault = read_vault(&w.svm, &w.vault);
    assert_eq!(vault.delay_secs, HOLD_DELAY_3_DAYS);
    assert_eq!(vault.daily_limit, 100 * ONE);
    assert_eq!(newest_pending(&vault).unlock_at, original);
    assert_eq!(vault.change.effective_at, clock + HOLD_DELAY_3_DAYS);
    warp(&mut w.svm, vault.change.effective_at);
    let owner = w.owner.insecure_clone();
    apply_change(&mut w, &owner).unwrap();
    let vault = read_vault(&w.svm, &w.vault);
    assert_eq!(vault.delay_secs, HOLD_DELAY_1_DAY);
    assert_eq!(
        pending_rows(&vault)
            .into_iter()
            .find(|row| row.destination == dest)
            .expect("old hold")
            .unlock_at,
        original
    );
    let fresh = new_dest(&mut w);
    let clock = now(&w.svm);
    withdraw(&mut w, 15 * ONE, &fresh).unwrap();
    assert_eq!(
        newest_pending(&read_vault(&w.svm, &w.vault)).unlock_at,
        clock + HOLD_DELAY_1_DAY
    );
}

#[test]
fn the_wait_and_the_daily_window_follow_the_chain_clock_only() {
    let (mut w, dest) = known_world(Rules::default());
    let held = new_dest(&mut w);
    withdraw(&mut w, 25 * ONE, &held).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    assert_eq!(execute_ix(&w, row.id, &held).data.len(), 16);
    let owner = w.owner.insecure_clone();
    warp(&mut w.svm, row.unlock_at - 1);
    assert_err(execute(&mut w, row.id, &held, &owner), "TooEarly");
    warp(&mut w.svm, row.unlock_at);
    execute(&mut w, row.id, &held, &owner).unwrap();
    assert_eq!(token_balance(&w.svm, &held), 25 * ONE);

    let rolled = now(&w.svm) + HOLD_WINDOW_SECS + 3600;
    warp(&mut w.svm, rolled);
    withdraw(&mut w, 100 * ONE, &dest).unwrap();
    let spent_at = now(&w.svm);
    let window_start = spent_at;
    warp(&mut w.svm, window_start + HOLD_WINDOW_SECS - 1);
    let before = token_balance(&w.svm, &w.vault_token);
    let logs = withdraw(&mut w, 1, &dest).expect("still inside the window");
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    warp(&mut w.svm, (window_start.div_euclid(3600) + 25) * 3600);
    let logs = withdraw(&mut w, 1 * ONE, &dest).expect("window rolled");
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before - 1 * ONE);
}

#[test]
fn recover_and_stop_succeed_for_the_right_signer_frozen_or_not() {
    let (mut w, dest) = known_world(Rules::default());
    withdraw(&mut w, 200 * ONE, &dest).unwrap();
    let other = new_dest(&mut w);
    withdraw(&mut w, 210 * ONE, &other).unwrap();
    let rows = pending_rows(&read_vault(&w.svm, &w.vault));
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_err(stop(&mut w, rows[0].id, &stranger), "NotOwnerOrGuardian");
    let logs = stop(&mut w, rows[0].id, &owner).unwrap();
    assert_recorded(&logs, "HOLD STOPPED", HoldStopped::DISCRIMINATOR);
    assert!(!read_vault(&w.svm, &w.vault).frozen);
    freeze(&mut w, &guardian).unwrap();
    let logs = stop(&mut w, rows[1].id, &guardian).unwrap();
    assert_recorded(&logs, "HOLD STOPPED", HoldStopped::DISCRIMINATOR);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault)).is_empty());
    let sitting = token_balance(&w.svm, &w.vault_token);
    let safe = w.safe_token;
    assert_err(recover(&mut w, &stranger, &safe), "NotOwnerOrGuardian");
    let logs = recover(&mut w, &guardian, &safe).unwrap();
    assert_recorded(&logs, "HOLD RECOVERED", HoldRecovered::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.safe_token), sitting);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 0);

    let (mut open, _dest) = known_world(Rules {
        vault_id: 4,
        ..Rules::default()
    });
    assert!(!read_vault(&open.svm, &open.vault).frozen);
    let owner = open.owner.insecure_clone();
    let sitting = token_balance(&open.svm, &open.vault_token);
    let safe = open.safe_token;
    recover(&mut open, &owner, &safe).unwrap();
    assert_eq!(token_balance(&open.svm, &open.safe_token), sitting);
    assert_eq!(token_balance(&open.svm, &open.vault_token), 0);
}

#[test]
fn a_full_pending_list_refuses_the_next_hold_and_pays_nothing() {
    let mut w = open_vault(Rules {
        daily_limit: 1_000 * ONE,
        big_share_bps: 10_000,
        deposit: 100,
        ..Rules::default()
    });
    let dest = new_dest(&mut w);
    for _ in 0..HOLD_PENDING_CAPACITY {
        let logs = withdraw(&mut w, 1, &dest).unwrap();
        assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    }
    assert_eq!(
        pending_rows(&read_vault(&w.svm, &w.vault)).len(),
        HOLD_PENDING_CAPACITY
    );
    assert_eq!(token_balance(&w.svm, &dest), 0);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 100);
    let logs = withdraw(&mut w, 1, &dest).expect("full list still succeeds");
    assert_recorded(&logs, "HOLD REFUSED", HoldRefused::DISCRIMINATOR);
    assert_last(&w, HOLD_KIND_REFUSED, HOLD_REASON_PENDING_FULL);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 100);
    assert_eq!(token_balance(&w.svm, &dest), 0);
    assert_eq!(
        pending_rows(&read_vault(&w.svm, &w.vault)).len(),
        HOLD_PENDING_CAPACITY
    );
    let id = newest_pending(&read_vault(&w.svm, &w.vault)).id;
    let owner = w.owner.insecure_clone();
    stop(&mut w, id, &owner).unwrap();
    let logs = withdraw(&mut w, 1, &dest).unwrap();
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(
        pending_rows(&read_vault(&w.svm, &w.vault)).len(),
        HOLD_PENDING_CAPACITY
    );
    assert_eq!(token_balance(&w.svm, &dest), 0);
}

#[test]
fn checked_arithmetic_does_not_wrap_the_share_or_the_unlock_time() {
    let (mut w, _dest) = known_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let fresh = new_dest(&mut w);
    warp(&mut w.svm, i64::MAX - HOLD_DELAY_1_DAY + 1);
    let before = token_balance(&w.svm, &w.vault_token);
    assert_err(withdraw(&mut w, 1, &fresh), "HoldMathOverflow");
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    assert_eq!(token_balance(&w.svm, &fresh), 0);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault)).is_empty());
    let _ = owner;

    let mut huge = open_vault(Rules {
        vault_id: 9,
        daily_limit: u64::MAX,
        big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
        deposit: 0,
        ..Rules::default()
    });
    // `open_vault` minted nothing useful when deposit is 0. Fund the source, then deposit max.
    let owner = huge.owner.insecure_clone();
    mint_to(&mut huge.svm, &owner, &huge.mint, &huge.source, u64::MAX);
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Deposit { amount: u64::MAX }.data(),
        veto::accounts::Deposit {
            owner: owner.pubkey(),
            vault: huge.vault,
            ledger: huge.ledger,
            source: huge.source,
            vault_token: huge.vault_token,
            mint: huge.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut huge.svm, &owner, &[&owner], &[ix]).expect("deposit max");
    assert_eq!(token_balance(&huge.svm, &huge.vault_token), u64::MAX);
    let dest = new_dest(&mut huge);
    arm_known(&mut huge, &dest);
    let balance = token_balance(&huge.svm, &huge.vault_token);
    let cap = share_of(balance, HOLD_DEFAULT_BIG_SHARE_BPS);
    assert!(cap > balance / 5, "share cap collapsed: {cap} of {balance}");
    assert!(cap < balance);
    let logs = withdraw(&mut huge, cap, &dest).expect("exact share is instant");
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    assert_eq!(token_balance(&huge.svm, &huge.vault_token), balance - cap);
    let left = token_balance(&huge.svm, &huge.vault_token);
    let logs = withdraw(&mut huge, 1, &dest).expect("one past the share is held");
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&huge.svm, &huge.vault_token), left);
}

#[test]
fn a_full_known_list_still_pays_and_does_not_grow() {
    let mut w = open_vault(Rules {
        daily_limit: 1_000 * ONE,
        big_share_bps: 10_000,
        deposit: 100,
        ..Rules::default()
    });
    let mut known = Vec::new();
    for _ in 0..(HOLD_KNOWN_CAPACITY / HOLD_PENDING_CAPACITY) {
        let mut batch = Vec::new();
        for _ in 0..HOLD_PENDING_CAPACITY {
            let dest = new_dest(&mut w);
            withdraw(&mut w, 1, &dest).unwrap();
            batch.push((dest, newest_pending(&read_vault(&w.svm, &w.vault)).id));
        }
        let unlock = newest_pending(&read_vault(&w.svm, &w.vault)).unlock_at;
        warp(&mut w.svm, unlock);
        let owner = w.owner.insecure_clone();
        for (dest, id) in &batch {
            execute(&mut w, *id, dest, &owner).unwrap();
            assert_eq!(token_balance(&w.svm, dest), 1);
        }
        known.extend(batch);
    }
    assert_eq!(known.len(), HOLD_KNOWN_CAPACITY);
    assert_eq!(
        read_vault(&w.svm, &w.vault).known_len as usize,
        HOLD_KNOWN_CAPACITY
    );
    let extra = new_dest(&mut w);
    withdraw(&mut w, 1, &extra).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    warp(&mut w.svm, row.unlock_at);
    let owner = w.owner.insecure_clone();
    execute(&mut w, row.id, &extra, &owner).unwrap();
    assert_eq!(token_balance(&w.svm, &extra), 1);
    assert_eq!(
        read_vault(&w.svm, &w.vault).known_len as usize,
        HOLD_KNOWN_CAPACITY
    );
    warp(&mut w.svm, row.unlock_at + HOLD_WINDOW_SECS + 3600);
    let before = token_balance(&w.svm, &w.vault_token);
    let logs = withdraw(&mut w, 1, &extra).unwrap();
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    assert_eq!(token_balance(&w.svm, &extra), 1);
}

#[test]
fn everyday_door_refuses_a_second_burst_across_the_old_window_edge() {
    let (mut w, dest) = known_world(Rules::default());
    withdraw(&mut w, 1, &dest).unwrap();
    let start = now(&w.svm);
    warp(&mut w.svm, start + HOLD_WINDOW_SECS - 1);
    withdraw(&mut w, 100 * ONE - 1, &dest).unwrap();
    let before = token_balance(&w.svm, &dest);
    warp(&mut w.svm, start + HOLD_WINDOW_SECS);
    let logs = withdraw(&mut w, 100 * ONE, &dest).unwrap();
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &dest), before);
}

#[test]
fn everyday_releases_never_exceed_the_limit_in_any_randomized_24_hours() {
    for seed in 1..=4u64 {
        let (mut w, dest) = known_world(Rules {
            deposit: 100_000 * ONE,
            big_share_bps: 10_000,
            ..Rules::default()
        });
        let mut random = seed;
        let mut clock = now(&w.svm);
        let mut paid = Vec::<(i64, u64)>::new();
        for _ in 0..400 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            clock += ((random >> 32) % 3600 + 1) as i64;
            warp(&mut w.svm, clock);
            let amount = (random % 100 + 1) * ONE;
            let before = token_balance(&w.svm, &dest);
            withdraw(&mut w, amount, &dest).unwrap();
            let released = token_balance(&w.svm, &dest) - before;
            if released != 0 {
                paid.push((clock, released));
            }
            let total: u64 = paid
                .iter()
                .filter(|(ts, _)| *ts > clock - HOLD_WINDOW_SECS)
                .map(|(_, amount)| amount)
                .sum();
            assert!(
                total <= 100 * ONE,
                "seed {seed}, time {clock}, released {total}"
            );
            let owner = w.owner.insecure_clone();
            for row in pending_rows(&read_vault(&w.svm, &w.vault)) {
                stop(&mut w, row.id, &owner).unwrap();
            }
        }
        assert!(paid.len() > 10);
    }
}

#[test]
fn legacy_vault_recovery_requires_the_saved_pre_upgrade_binary() {
    let (mut w, _) = known_world(Rules::default());
    let mut legacy = w.svm.get_account(&w.vault).unwrap();
    legacy.data.truncate(1291);
    w.svm.set_account(w.vault, legacy).unwrap();
    let balance = token_balance(&w.svm, &w.vault_token);
    let owner = w.owner.insecure_clone();
    let safe = w.safe_token;
    assert_err(recover(&mut w, &owner, &safe), "AccountDidNotDeserialize");
    assert_eq!(token_balance(&w.svm, &w.vault_token), balance);
    assert_eq!(token_balance(&w.svm, &safe), 0);
}

#[test]
fn share_cap_holds_a_second_burst_across_the_old_window_edge() {
    let (mut w, dest) = known_world(Rules {
        daily_limit: u64::MAX,
        ..Rules::default()
    });
    withdraw(&mut w, 1, &dest).unwrap();
    let start = now(&w.svm);
    warp(&mut w.svm, start + HOLD_WINDOW_SECS - 1);
    let logs = withdraw(&mut w, 200 * ONE, &dest).unwrap();
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    let before = token_balance(&w.svm, &dest);
    warp(&mut w.svm, start + HOLD_WINDOW_SECS);
    let logs = withdraw(&mut w, 100 * ONE, &dest).unwrap();
    assert_recorded(&logs, "HOLD HELD", HoldHeld::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &dest), before);
    let expiry = ((start + HOLD_WINDOW_SECS - 1).div_euclid(3600) + 25) * 3600;
    warp(&mut w.svm, expiry);
    let logs = withdraw(&mut w, 100 * ONE, &dest).unwrap();
    assert_recorded(&logs, "HOLD PAID", HoldPaid::DISCRIMINATOR);
    assert_eq!(token_balance(&w.svm, &dest), before + 100 * ONE);
}

#[test]
fn share_cap_bounds_every_instant_release_in_randomized_24_hours() {
    for seed in 1..=4u64 {
        let bps = (seed * 500) as u16;
        let (mut w, dest) = known_world(Rules {
            deposit: 100_000 * ONE,
            daily_limit: u64::MAX,
            big_share_bps: bps,
            ..Rules::default()
        });
        let mut random = seed;
        let mut clock = now(&w.svm);
        let mut paid = Vec::<(i64, u64)>::new();
        let mut held = 0;
        for _ in 0..400 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            clock += ((random >> 32) % 3600 + 1) as i64;
            warp(&mut w.svm, clock);
            let balance = token_balance(&w.svm, &w.vault_token);
            let cap = share_of(balance, bps);
            let amount = cap / 4 + random % (cap / 2 + 1) + 1;
            let before = token_balance(&w.svm, &dest);
            withdraw(&mut w, amount, &dest).unwrap();
            let released = token_balance(&w.svm, &dest) - before;
            if released != 0 {
                assert_eq!(released, amount);
                paid.push((clock, released));
                let total: u64 = paid
                    .iter()
                    .filter(|(ts, _)| *ts > clock - HOLD_WINDOW_SECS)
                    .map(|(_, amount)| amount)
                    .sum();
                assert!(
                    total <= cap,
                    "seed {seed}, time {clock}, released {total}, cap {cap}"
                );
            } else {
                held += 1;
            }
            let owner = w.owner.insecure_clone();
            for row in pending_rows(&read_vault(&w.svm, &w.vault)) {
                stop(&mut w, row.id, &owner).unwrap();
            }
        }
        assert!(paid.len() > 10);
        assert!(held > 10);
    }
}

// Wire instructions keep these regression fixtures runnable against the old binary.
fn recovery_ix(w: &World, signer: Pubkey, close: bool, destination: Pubkey) -> Instruction {
    use anchor_lang::solana_program::instruction::AccountMeta;
    let disc = if close {
        [44, 82, 147, 65, 191, 42, 43, 216]
    } else {
        [223, 75, 49, 252, 155, 82, 164, 36]
    };
    let mut accounts = vec![
        AccountMeta::new(signer, true),
        AccountMeta::new(w.vault, false),
    ];
    if close {
        accounts.extend([
            AccountMeta::new(w.ledger, false),
            AccountMeta::new(w.vault_token, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ]);
    } else {
        accounts.push(AccountMeta::new(w.ledger, false));
        accounts.push(AccountMeta::new_readonly(system_program::ID, false));
    }
    Instruction::new_with_bytes(veto::id(), &disc, accounts)
}

fn legacy_fixture(w: &mut World, spent: u64) -> Vec<u8> {
    let mut raw = w.svm.get_account(&w.vault).unwrap();
    raw.data.truncate(1291);
    raw.lamports = w.svm.minimum_balance_for_rent_exemption(1291);
    raw.data[184..192].copy_from_slice(&spent.to_le_bytes());
    // Preserve a queued loosening change and its two-key policy fields.
    raw.data[1199] = 1;
    raw.data[1200] = CHANGE_SAFE;
    raw.data[1251..1283].copy_from_slice(w.safe.as_ref());
    raw.data[1283..1291].copy_from_slice(&(now(&w.svm) + HOLD_DELAY_1_DAY).to_le_bytes());
    // Even an old/expired window must be retained conservatively on migration.
    raw.data[192..200].copy_from_slice(&1i64.to_le_bytes());
    raw.data[227] = 1;
    raw.data[231..263].copy_from_slice(w.safe_token.as_ref());
    let bytes = raw.data.clone();
    w.svm.set_account(w.vault, raw).unwrap();
    bytes
}

#[test]
fn migration_preserves_legacy_fields_and_spend_for_the_next_day() {
    let mut w = open_vault(Rules::default());
    warp(&mut w.svm, 100 * 86400 + 3599);
    let before = legacy_fixture(&mut w, 90 * ONE);
    let lamports_before = w.svm.get_account(&w.vault).unwrap().lamports;
    let ix = recovery_ix(&w, w.owner.pubkey(), false, w.safe_token);
    send(&mut w.svm, &w.owner, &[&w.owner], &[ix]).unwrap();
    assert_eq!(&w.svm.get_account(&w.vault).unwrap().data[..1291], &before);
    assert!(w.svm.get_account(&w.vault).unwrap().lamports > lamports_before);
    let dest = w.safe_token;
    withdraw(&mut w, 10 * ONE, &dest).unwrap();
    assert_eq!(token_balance(&w.svm, &dest), 10 * ONE);
    let t = now(&w.svm);
    warp(&mut w.svm, t + 86400 - 1);
    withdraw(&mut w, 1, &dest).unwrap();
    assert_eq!(token_balance(&w.svm, &dest), 10 * ONE);
    assert_eq!(pending_rows(&read_vault(&w.svm, &w.vault)).len(), 1);
    let ix = recovery_ix(&w, w.owner.pubkey(), false, dest);
    assert!(send(&mut w.svm, &w.owner, &[&w.owner], &[ix]).is_err());
}

#[test]
fn close_returns_all_tokens_to_safe_and_all_account_rent_to_owner() {
    let mut w = open_vault(Rules::default());
    let balance = token_balance(&w.svm, &w.vault_token);
    let rent: u64 = [w.vault, w.vault_token, w.ledger]
        .iter()
        .map(|k| w.svm.get_account(k).unwrap().lamports)
        .sum();
    let owner_before = w.svm.get_account(&w.owner.pubkey()).unwrap().lamports;
    let ix = recovery_ix(&w, w.owner.pubkey(), true, w.safe_token);
    // Separate fee payer makes the rent destination assertion exact.
    send(&mut w.svm, &w.guardian, &[&w.guardian, &w.owner], &[ix]).unwrap();
    assert_eq!(token_balance(&w.svm, &w.safe_token), balance);
    assert_eq!(
        w.svm.get_account(&w.owner.pubkey()).unwrap().lamports,
        owner_before + rent
    );
    for key in [w.vault, w.vault_token, w.ledger] {
        assert!(w.svm.get_account(&key).is_none_or(|a| a.lamports == 0));
    }
}

#[test]
fn close_refuses_held_frozen_wrong_destination_and_non_owner() {
    let mut w = open_vault(Rules::default());
    for (signer, dest) in [
        (w.guardian.pubkey(), w.safe_token),
        (w.owner.pubkey(), w.source),
    ] {
        let ix = recovery_ix(&w, signer, true, dest);
        let key = if signer == w.owner.pubkey() {
            &w.owner
        } else {
            &w.guardian
        };
        assert!(send(&mut w.svm, key, &[key], &[ix]).is_err());
    }
    let dest = w.safe_token;
    withdraw(&mut w, ONE, &dest).unwrap();
    let ix = recovery_ix(&w, w.owner.pubkey(), true, dest);
    assert_err(
        send(&mut w.svm, &w.owner, &[&w.owner], &[ix]),
        "HoldWithdrawalPending",
    );
    let guardian = w.guardian.insecure_clone();
    stop(&mut w, 1, &guardian).unwrap();
    freeze(&mut w, &guardian).unwrap();
    let ix = recovery_ix(&w, w.owner.pubkey(), true, dest);
    assert_err(
        send(&mut w.svm, &w.owner, &[&w.owner], &[ix]),
        "VaultFrozen",
    );
}

#[test]
fn migration_refuses_non_owner_and_preserves_frozen_holds_and_changes() {
    let mut w = open_vault(Rules::default());
    let dest = w.safe_token;
    withdraw(&mut w, ONE, &dest).unwrap();
    let guardian = w.guardian.insecure_clone();
    freeze(&mut w, &guardian).unwrap();
    let before = legacy_fixture(&mut w, ONE);
    let ix = recovery_ix(&w, w.guardian.pubkey(), false, dest);
    assert_err(
        send(&mut w.svm, &w.guardian, &[&w.guardian], &[ix]),
        "NotTheVaultOwner",
    );
    assert_eq!(w.svm.get_account(&w.vault).unwrap().data, before);
    let ix = recovery_ix(&w, w.owner.pubkey(), false, dest);
    send(&mut w.svm, &w.owner, &[&w.owner], &[ix]).unwrap();
    assert_eq!(&w.svm.get_account(&w.vault).unwrap().data[..1291], &before);
    let owner = w.owner.insecure_clone();
    assert_err(unfreeze(&mut w, &owner, None), "BothKeysRequired");
    let ix = recovery_ix(&w, w.owner.pubkey(), true, dest);
    assert_err(
        send(&mut w.svm, &w.owner, &[&w.owner], &[ix]),
        "VaultFrozen",
    );
}

#[test]
fn migration_rejects_unknown_lengths_bad_discriminators_and_forged_pdas() {
    for variant in 0..5 {
        let mut w = open_vault(Rules::default());
        legacy_fixture(&mut w, ONE);
        let mut raw = w.svm.get_account(&w.vault).unwrap();
        match variant {
            0 => raw.data.push(0),
            1 => {
                raw.data.pop();
            }
            2 => raw.data[0] ^= 1,
            3 => raw.data[168] ^= 1,
            _ => raw.owner = system_program::ID,
        }
        w.svm.set_account(w.vault, raw.clone()).unwrap();
        let ix = recovery_ix(&w, w.owner.pubkey(), false, w.safe_token);
        assert!(send(&mut w.svm, &w.owner, &[&w.owner], &[ix]).is_err());
        assert_eq!(w.svm.get_account(&w.vault).unwrap().data, raw.data);
    }
}

#[test]
fn migration_does_not_reopen_the_share_limit() {
    let mut w = open_vault(Rules {
        daily_limit: 1000 * ONE,
        ..Rules::default()
    });
    warp(&mut w.svm, 100 * 86400 + 3599);
    legacy_fixture(&mut w, 250 * ONE);
    let ix = recovery_ix(&w, w.owner.pubkey(), false, w.safe_token);
    send(&mut w.svm, &w.owner, &[&w.owner], &[ix]).unwrap();
    let dest = w.safe_token;
    let t = now(&w.svm);
    warp(&mut w.svm, t + 86400 - 1);
    withdraw(&mut w, 1, &dest).unwrap();
    assert_eq!(token_balance(&w.svm, &dest), 0);
    assert_eq!(pending_rows(&read_vault(&w.svm, &w.vault)).len(), 1);
}

#[test]
fn lifecycle_events_keep_history_after_migration_and_close() {
    let mut w = open_vault(Rules::default());
    legacy_fixture(&mut w, ONE);
    let before = w.svm.get_account(&w.vault).unwrap().lamports;
    let ix = recovery_ix(&w, w.owner.pubkey(), false, w.safe_token);
    let logs = send(&mut w.svm, &w.owner, &[&w.owner], &[ix]).unwrap();
    let rent = w.svm.get_account(&w.vault).unwrap().lamports - before;
    let ledger = read_ledger(&w.svm, &w.ledger);
    let entry =
        ledger.entries[(ledger.head as usize + HOLD_LEDGER_CAPACITY - 1) % HOLD_LEDGER_CAPACITY];
    assert_eq!(entry.kind, HOLD_KIND_MIGRATED);
    assert_eq!(entry.amount, rent);
    assert_eq!(entry.destination, w.vault);
    check_lifecycle_event(
        &logs,
        MIGRATED_DISC,
        w.vault,
        w.owner.pubkey(),
        rent,
        w.vault,
    );
    let amount = token_balance(&w.svm, &w.vault_token);
    let ix = recovery_ix(&w, w.owner.pubkey(), true, w.safe_token);
    let logs = send(&mut w.svm, &w.owner, &[&w.owner], &[ix]).unwrap();
    check_lifecycle_event(
        &logs,
        CLOSED_DISC,
        w.vault,
        w.owner.pubkey(),
        amount,
        w.safe_token,
    );
    assert!(w.svm.get_account(&w.ledger).is_none_or(|a| a.lamports == 0));
}

fn check_lifecycle_event(
    logs: &[String],
    disc: &[u8],
    vault: Pubkey,
    owner: Pubkey,
    amount: u64,
    destination: Pubkey,
) {
    let raw = logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: ").and_then(decode_b64))
        .find(|raw| raw.starts_with(disc))
        .expect("lifecycle event must survive account closure");
    assert_eq!(raw.len(), 112);
    assert_eq!(&raw[8..40], vault.as_ref());
    assert_eq!(&raw[40..72], owner.as_ref());
    assert_eq!(&raw[72..80], &amount.to_le_bytes());
    assert_eq!(&raw[80..112], destination.as_ref());
}

const MIGRATED_DISC: &[u8] = &[32, 149, 140, 45, 3, 28, 129, 197];

const CLOSED_DISC: &[u8] = &[111, 175, 192, 227, 192, 83, 108, 99];
