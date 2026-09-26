//! Attacks against the Hold vault. Each test is one attempt to move tokens
//! the rules do not allow. A passing test means that attempt paid nothing.
//!
//! Build first, same as the other program suites:
//! `ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys`.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program_pack::Pack,
            system_instruction, system_program,
        },
        AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::str::FromStr,
    veto::{hold_state::*, HoldChange},
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

struct Sibling {
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
    let err = match result {
        Ok(_) => panic!("expected an error containing {needle:?}, transaction succeeded"),
        Err(err) => err,
    };
    assert!(
        err.contains(needle),
        "expected {needle:?} in error, got:\n{err}"
    );
}

fn assert_err_one_of(result: Result<Vec<String>, String>, needles: &[&str]) {
    let err = match result {
        Ok(_) => panic!("expected one of {needles:?}, transaction succeeded"),
        Err(err) => err,
    };
    assert!(
        needles.iter().any(|needle| err.contains(needle)),
        "expected one of {needles:?}, got:\n{err}"
    );
}

fn assert_held(logs: &[String]) {
    assert!(
        logs.iter().any(|line| line.contains("HOLD HELD")),
        "expected a hold, logs:\n{}",
        logs.join("\n")
    );
}

fn assert_paid(logs: &[String]) {
    assert!(
        logs.iter().any(|line| line.contains("HOLD PAID")),
        "expected an instant payment, logs:\n{}",
        logs.join("\n")
    );
}

fn assert_refused(logs: &[String]) {
    assert!(
        logs.iter().any(|line| line.contains("HOLD REFUSED")),
        "expected a refusal, logs:\n{}",
        logs.join("\n")
    );
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

fn share_of(balance: u64, bps: u16) -> u64 {
    (u128::from(balance) * u128::from(bps) / u128::from(HOLD_BPS_DENOMINATOR)) as u64
}

fn token_2022_id() -> Pubkey {
    Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
}

fn overwrite_vault(svm: &mut LiteSVM, key: &Pubkey, vault: &HoldVault) {
    let real = svm.get_account(key).expect("vault");
    let mut data = Vec::new();
    vault.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), real.data.len(), "serialized vault size");
    svm.set_account(
        *key,
        Account {
            lamports: real.lamports,
            data,
            owner: veto::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn clone_account_to(svm: &mut LiteSVM, from: &Pubkey, to: &Pubkey) {
    let real = svm.get_account(from).expect("source account");
    svm.set_account(
        *to,
        Account {
            lamports: real.lamports,
            data: real.data.clone(),
            owner: real.owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
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
        "veto.so must be SBPF v0 for LiteSVM 0.10; run the v0 build"
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

fn init_ix(
    owner: Pubkey,
    vault: Pubkey,
    ledger: Pubkey,
    vault_token: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
    args: veto::hold::InitVaultArgs,
) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::InitVault { args }.data(),
        veto::accounts::InitVault {
            owner,
            vault,
            ledger,
            vault_token,
            mint,
            token_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
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
    let init = init_ix(
        owner.pubkey(),
        vault,
        ledger,
        vault_token,
        mint,
        spl_token::ID,
        veto::hold::InitVaultArgs {
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
        send(&mut svm, &owner, &[&owner], &[deposit]).expect("deposit");
    }

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

fn withdraw_accounts(
    owner: Pubkey,
    vault: Pubkey,
    ledger: Pubkey,
    vault_token: Pubkey,
    destination: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
    amount: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Withdraw { amount }.data(),
        veto::accounts::Withdraw {
            owner,
            vault,
            ledger,
            vault_token,
            destination,
            mint,
            token_program,
        }
        .to_account_metas(None),
    )
}

fn withdraw(w: &mut World, amount: u64, dest: &Pubkey) -> Result<Vec<String>, String> {
    let owner = w.owner.insecure_clone();
    let ix = withdraw_accounts(
        owner.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        *dest,
        w.mint,
        spl_token::ID,
        amount,
    );
    send(&mut w.svm, &owner, &[&owner], &[ix])
}

fn execute_accounts(
    vault: Pubkey,
    ledger: Pubkey,
    vault_token: Pubkey,
    destination: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
    id: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Execute { id }.data(),
        veto::accounts::Execute {
            vault,
            ledger,
            vault_token,
            destination,
            mint,
            token_program,
        }
        .to_account_metas(None),
    )
}

fn execute(w: &mut World, id: u64, dest: &Pubkey, payer: &Keypair) -> Result<Vec<String>, String> {
    let ix = execute_accounts(
        w.vault,
        w.ledger,
        w.vault_token,
        *dest,
        w.mint,
        spl_token::ID,
        id,
    );
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
        Some(guardian) if guardian.pubkey() != owner.pubkey() => {
            send(&mut w.svm, owner, &[owner, guardian], &[ix])
        }
        _ => send(&mut w.svm, owner, &[owner], &[ix]),
    }
}

fn skip_ix(
    owner: Pubkey,
    guardian: Pubkey,
    vault: Pubkey,
    ledger: Pubkey,
    vault_token: Pubkey,
    destination: Pubkey,
    mint: Pubkey,
    id: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Skip { id }.data(),
        veto::accounts::Skip {
            owner,
            guardian,
            vault,
            ledger,
            vault_token,
            destination,
            mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

fn skip(
    w: &mut World,
    id: u64,
    dest: &Pubkey,
    owner: &Keypair,
    guardian: &Keypair,
) -> Result<Vec<String>, String> {
    let ix = skip_ix(
        owner.pubkey(),
        guardian.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        *dest,
        w.mint,
        id,
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

fn deposit_from(w: &mut World, source: &Pubkey, amount: u64) -> Result<Vec<String>, String> {
    let owner = w.owner.insecure_clone();
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Deposit { amount }.data(),
        veto::accounts::Deposit {
            owner: owner.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
            source: *source,
            vault_token: w.vault_token,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[ix])
}

fn new_dest(w: &mut World, owner_wallet: &Pubkey) -> Pubkey {
    let payer = w.owner.insecure_clone();
    let mint = w.mint;
    create_token_account(&mut w.svm, &payer, &mint, owner_wallet)
}

fn arm_known(w: &mut World, dest: &Pubkey) {
    withdraw(w, 1, dest).expect("first payment to a new address is held");
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let owner = w.owner.insecure_clone();
    warp(&mut w.svm, row.unlock_at);
    execute(w, row.id, dest, &owner).expect("execute the first payment");
    assert_eq!(token_balance(&w.svm, dest), 1);
    warp(&mut w.svm, row.unlock_at + HOLD_WINDOW_SECS + 3600);
}

fn known_world(rules: Rules) -> (World, Pubkey) {
    let mut w = open_vault(rules);
    let shop = Pubkey::new_unique();
    let dest = new_dest(&mut w, &shop);
    arm_known(&mut w, &dest);
    (w, dest)
}

fn open_sibling(w: &mut World, vault_id: u64, deposit: u64) -> Sibling {
    let owner = w.owner.insecure_clone();
    let mint = w.mint;
    let source = create_token_account(&mut w.svm, &owner, &mint, &owner.pubkey());
    if deposit > 0 {
        mint_to(&mut w.svm, &owner, &mint, &source, deposit);
    }
    let (vault, vault_token, ledger) = pdas(&owner.pubkey(), vault_id);
    let init = init_ix(
        owner.pubkey(),
        vault,
        ledger,
        vault_token,
        mint,
        spl_token::ID,
        veto::hold::InitVaultArgs {
            vault_id,
            guardian: w.guardian.pubkey(),
            safe_address: w.safe,
            daily_limit: 100 * ONE,
            delay_secs: HOLD_DELAY_1_DAY,
            big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
        },
    );
    send(&mut w.svm, &owner, &[&owner], &[init]).expect("init sibling");
    if deposit > 0 {
        let ix = Instruction::new_with_bytes(
            veto::id(),
            &veto::instruction::Deposit { amount: deposit }.data(),
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
        send(&mut w.svm, &owner, &[&owner], &[ix]).expect("deposit sibling");
    }
    Sibling {
        vault,
        vault_token,
        ledger,
    }
}

fn token_2022_ix(program: Pubkey, data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: program,
        accounts,
        data,
    }
}

fn create_token_2022_mint(svm: &mut LiteSVM, owner: &Keypair) -> Pubkey {
    let program = token_2022_id();
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let mut data = vec![20, DECIMALS];
    data.extend_from_slice(owner.pubkey().as_ref());
    data.push(0);
    let ixs = [
        system_instruction::create_account(
            &owner.pubkey(),
            &mint,
            10_000_000,
            spl_token::state::Mint::LEN as u64,
            &program,
        ),
        token_2022_ix(program, data, vec![AccountMeta::new(mint, false)]),
    ];
    send(svm, owner, &[owner, &mint_kp], &ixs).expect("create token-2022 mint");
    let raw = svm.get_account(&mint).expect("mint account");
    spl_token::state::Mint::unpack(&raw.data).expect("token-2022 base mint unpacks");
    mint
}

fn create_token_2022_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let program = token_2022_id();
    let account = Keypair::new();
    let mut data = vec![18];
    data.extend_from_slice(owner.as_ref());
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            10_000_000,
            spl_token::state::Account::LEN as u64,
            &program,
        ),
        token_2022_ix(
            program,
            data,
            vec![
                AccountMeta::new(account.pubkey(), false),
                AccountMeta::new_readonly(*mint, false),
            ],
        ),
    ];
    send(svm, payer, &[payer, &account], &ixs).expect("create token-2022 account");
    account.pubkey()
}

fn mint_token_2022(svm: &mut LiteSVM, owner: &Keypair, mint: &Pubkey, dest: &Pubkey, amount: u64) {
    let program = token_2022_id();
    let mut data = vec![7];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = token_2022_ix(
        program,
        data,
        vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(owner.pubkey(), true),
        ],
    );
    send(svm, owner, &[owner], &[ix]).expect("mint token-2022");
}

fn token_2022_balance(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let raw = svm.get_account(key).expect("token-2022 account exists");
    u64::from_le_bytes(raw.data[64..72].try_into().unwrap())
}

#[test]
fn execute_or_skip_to_an_attacker_account_of_the_same_mint_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let pocket = new_dest(&mut w, &attacker.pubkey());
    let payee = new_dest(&mut w, &Pubkey::new_unique());
    withdraw(&mut w, 40 * ONE, &payee).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    warp(&mut w.svm, row.unlock_at);
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();

    assert_err(
        execute(&mut w, row.id, &pocket, &attacker),
        "DestinationMismatch",
    );
    assert_err(
        skip(&mut w, row.id, &pocket, &owner, &guardian),
        "DestinationMismatch",
    );

    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &pocket), 0);
    assert_eq!(token_balance(&w.svm, &payee), 0);
    assert_eq!(newest_pending(&read_vault(&w.svm, &w.vault)).id, row.id);
}

#[test]
fn recover_to_a_token_account_the_safe_address_does_not_own_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let pocket = new_dest(&mut w, &attacker.pubkey());
    let owner_wallet = w.owner.pubkey();
    let owner_token = new_dest(&mut w, &owner_wallet);
    let owner = w.owner.insecure_clone();
    let other_mint = create_mint(&mut w.svm, &owner);
    let wrong_mint = create_token_account(&mut w.svm, &owner, &other_mint, &w.safe);
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let safe_before = token_balance(&w.svm, &w.safe_token);
    let guardian = w.guardian.insecure_clone();

    assert_err(recover(&mut w, &guardian, &pocket), "NotTheSafeAddress");
    assert_err(recover(&mut w, &owner, &owner_token), "NotTheSafeAddress");
    assert_err(recover(&mut w, &owner, &wrong_mint), "HoldMintMismatch");

    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &w.safe_token), safe_before);
    assert_eq!(token_balance(&w.svm, &pocket), 0);
    assert_eq!(token_balance(&w.svm, &owner_token), 0);
    assert_eq!(token_balance(&w.svm, &wrong_mint), 0);
}

#[test]
fn a_fake_vault_or_another_vaults_token_account_moves_nothing() {
    let (mut w, shop) = known_world(Rules::default());
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let pocket = new_dest(&mut w, &attacker.pubkey());
    withdraw(&mut w, 30 * ONE, &pocket).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    warp(&mut w.svm, row.unlock_at);
    let real_vault = token_balance(&w.svm, &w.vault_token);
    let owner = w.owner.insecure_clone();

    let forged = Pubkey::new_unique();
    clone_account_to(&mut w.svm, &w.vault, &forged);
    let (forged_ledger, _) =
        Pubkey::find_program_address(&[b"hold-ledger", forged.as_ref()], &veto::id());
    clone_account_to(&mut w.svm, &w.ledger, &forged_ledger);
    let ix = execute_accounts(
        forged,
        forged_ledger,
        w.vault_token,
        pocket,
        w.mint,
        spl_token::ID,
        row.id,
    );
    assert_err_one_of(
        send(&mut w.svm, &attacker, &[&attacker], &[ix]),
        &[
            "ConstraintSeeds",
            "InvalidVaultPda",
            "AccountNotInitialized",
        ],
    );

    let sibling = open_sibling(&mut w, 2, 80 * ONE);
    let sibling_before = token_balance(&w.svm, &sibling.vault_token);
    let ix = execute_accounts(
        w.vault,
        w.ledger,
        sibling.vault_token,
        pocket,
        w.mint,
        spl_token::ID,
        row.id,
    );
    assert_err_one_of(
        send(&mut w.svm, &attacker, &[&attacker], &[ix]),
        &["ConstraintSeeds", "VaultTokenMismatch", "ConstraintHasOne"],
    );
    let ix = execute_accounts(
        w.vault,
        sibling.ledger,
        w.vault_token,
        pocket,
        w.mint,
        spl_token::ID,
        row.id,
    );
    assert_err(
        send(&mut w.svm, &attacker, &[&attacker], &[ix]),
        "ConstraintSeeds",
    );

    let ix = withdraw_accounts(
        owner.pubkey(),
        w.vault,
        w.ledger,
        pocket,
        shop,
        w.mint,
        spl_token::ID,
        1,
    );
    assert_err_one_of(
        send(&mut w.svm, &owner, &[&owner], &[ix]),
        &["ConstraintSeeds", "VaultTokenMismatch", "ConstraintHasOne"],
    );

    assert_eq!(token_balance(&w.svm, &w.vault_token), real_vault);
    assert_eq!(token_balance(&w.svm, &sibling.vault_token), sibling_before);
    assert_eq!(token_balance(&w.svm, &pocket), 0);
    assert_eq!(token_balance(&w.svm, &shop), 1);
    assert_eq!(newest_pending(&read_vault(&w.svm, &w.vault)).id, row.id);
}

#[test]
fn a_withdrawal_id_from_another_vault_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let main_dest = new_dest(&mut w, &Pubkey::new_unique());
    withdraw(&mut w, 20 * ONE, &main_dest).unwrap();
    let main_row = newest_pending(&read_vault(&w.svm, &w.vault));

    let sibling = open_sibling(&mut w, 4, 90 * ONE);
    let owner = w.owner.insecure_clone();
    let sibling_dest = new_dest(&mut w, &attacker.pubkey());
    let ix = withdraw_accounts(
        owner.pubkey(),
        sibling.vault,
        sibling.ledger,
        sibling.vault_token,
        sibling_dest,
        w.mint,
        spl_token::ID,
        15 * ONE,
    );
    send(&mut w.svm, &owner, &[&owner], &[ix]).expect("sibling hold");
    // One more hold so the sibling has an id the main vault never issued.
    let ix = withdraw_accounts(
        owner.pubkey(),
        sibling.vault,
        sibling.ledger,
        sibling.vault_token,
        sibling_dest,
        w.mint,
        spl_token::ID,
        16 * ONE,
    );
    send(&mut w.svm, &owner, &[&owner], &[ix]).expect("second sibling hold");
    let ix = withdraw_accounts(
        owner.pubkey(),
        sibling.vault,
        sibling.ledger,
        sibling.vault_token,
        sibling_dest,
        w.mint,
        spl_token::ID,
        17 * ONE,
    );
    send(&mut w.svm, &owner, &[&owner], &[ix]).expect("third sibling hold");
    let foreign = newest_pending(&read_vault(&w.svm, &sibling.vault));
    assert!(foreign.id != main_row.id);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault))
        .iter()
        .all(|row| row.id != foreign.id));

    warp(&mut w.svm, foreign.unlock_at.max(main_row.unlock_at));
    let main_before = token_balance(&w.svm, &w.vault_token);
    let sibling_before = token_balance(&w.svm, &sibling.vault_token);

    assert_err(
        execute(&mut w, foreign.id, &sibling_dest, &attacker),
        "WithdrawalNotPending",
    );
    assert_err(
        execute(&mut w, main_row.id, &sibling_dest, &attacker),
        "DestinationMismatch",
    );
    let ix = execute_accounts(
        sibling.vault,
        sibling.ledger,
        sibling.vault_token,
        main_dest,
        w.mint,
        spl_token::ID,
        main_row.id,
    );
    assert_err_one_of(
        send(&mut w.svm, &attacker, &[&attacker], &[ix]),
        &["WithdrawalNotPending", "DestinationMismatch"],
    );

    assert_eq!(token_balance(&w.svm, &w.vault_token), main_before);
    assert_eq!(token_balance(&w.svm, &sibling.vault_token), sibling_before);
    assert_eq!(token_balance(&w.svm, &sibling_dest), 0);
    assert_eq!(token_balance(&w.svm, &main_dest), 0);
}

#[test]
fn replaying_execute_on_a_paid_id_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let payee = new_dest(&mut w, &Pubkey::new_unique());
    withdraw(&mut w, 25 * ONE, &payee).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let owner = w.owner.insecure_clone();
    let vault_at_hold = token_balance(&w.svm, &w.vault_token);

    warp(&mut w.svm, row.unlock_at - 1);
    assert_err(execute(&mut w, row.id, &payee, &owner), "TooEarly");
    assert_eq!(token_balance(&w.svm, &payee), 0);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_at_hold);

    warp(&mut w.svm, row.unlock_at);
    let ix = execute_accounts(
        w.vault,
        w.ledger,
        w.vault_token,
        payee,
        w.mint,
        spl_token::ID,
        row.id,
    );
    assert!(
        send(&mut w.svm, &owner, &[&owner], &[ix.clone(), ix]).is_err(),
        "two executes of one id in one transaction paid"
    );
    assert_eq!(token_balance(&w.svm, &payee), 0);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_at_hold);

    execute(&mut w, row.id, &payee, &owner).expect("the single execute pays once");
    assert_eq!(token_balance(&w.svm, &payee), 25 * ONE);
    assert_eq!(
        token_balance(&w.svm, &w.vault_token),
        vault_at_hold - 25 * ONE
    );
    let settled_vault = token_balance(&w.svm, &w.vault_token);
    assert_err(
        execute(&mut w, row.id, &payee, &owner),
        "WithdrawalNotPending",
    );
    assert_eq!(token_balance(&w.svm, &payee), 25 * ONE);
    assert_eq!(token_balance(&w.svm, &w.vault_token), settled_vault);
    assert!(pending_rows(&read_vault(&w.svm, &w.vault)).is_empty());
}

#[test]
fn skip_signed_by_the_guardian_twice_or_by_the_owner_as_both_roles_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let payee = new_dest(&mut w, &Pubkey::new_unique());
    withdraw(&mut w, 35 * ONE, &payee).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();

    let twice = skip_ix(
        guardian.pubkey(),
        guardian.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        payee,
        w.mint,
        row.id,
    );
    assert_err(
        send(&mut w.svm, &guardian, &[&guardian], &[twice]),
        "ConstraintSeeds",
    );

    let owner_both = skip_ix(
        owner.pubkey(),
        owner.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        payee,
        w.mint,
        row.id,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[owner_both]),
        "NotTheGuardian",
    );

    // Defence in depth: even if the stored guardian were overwritten to the
    // owner, one key in both slots still does not count as both keys.
    let mut forged = read_vault(&w.svm, &w.vault);
    forged.guardian = forged.owner;
    overwrite_vault(&mut w.svm, &w.vault, &forged);
    let owner_both = skip_ix(
        owner.pubkey(),
        owner.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        payee,
        w.mint,
        row.id,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[owner_both]),
        "BothKeysRequired",
    );

    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &payee), 0);
    assert_eq!(newest_pending(&read_vault(&w.svm, &w.vault)).id, row.id);
}

#[test]
fn unfreeze_or_skip_with_one_key_when_a_guardian_exists_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let payee = new_dest(&mut w, &Pubkey::new_unique());
    withdraw(&mut w, 45 * ONE, &payee).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    assert_err(
        skip(&mut w, row.id, &payee, &owner, &stranger),
        "NotTheGuardian",
    );
    let owner_alone = skip_ix(
        owner.pubkey(),
        owner.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        payee,
        w.mint,
        row.id,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[owner_alone]),
        "NotTheGuardian",
    );
    let guardian_alone = skip_ix(
        guardian.pubkey(),
        guardian.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        payee,
        w.mint,
        row.id,
    );
    assert_err(
        send(&mut w.svm, &guardian, &[&guardian], &[guardian_alone]),
        "ConstraintSeeds",
    );
    assert_eq!(token_balance(&w.svm, &payee), 0);

    freeze(&mut w, &guardian).unwrap();
    assert_err(unfreeze(&mut w, &owner, None), "BothKeysRequired");
    assert_err(unfreeze(&mut w, &owner, Some(&stranger)), "NotTheGuardian");
    assert_err(unfreeze(&mut w, &owner, Some(&owner)), "NotTheGuardian");
    assert_err(unfreeze(&mut w, &guardian, Some(&owner)), "ConstraintSeeds");
    assert_err(unfreeze(&mut w, &guardian, None), "ConstraintSeeds");
    assert!(read_vault(&w.svm, &w.vault).frozen);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &payee), 0);
    assert_eq!(newest_pending(&read_vault(&w.svm, &w.vault)).id, row.id);
}

#[test]
fn the_guardian_cannot_propose_a_change() {
    let (mut w, shop) = known_world(Rules::default());
    let guardian = w.guardian.insecure_clone();
    let before = current_rules(&w);
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let mut values = before;
    values.daily_limit = u64::MAX;
    values.big_share_bps = 10_000;
    values.safe_address = guardian.pubkey();
    values.delay_secs = HOLD_DELAY_1_DAY;
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::ProposeChange { values }.data(),
        veto::accounts::ProposeChange {
            owner: guardian.pubkey(),
            vault: w.vault,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    assert_err(
        send(&mut w.svm, &guardian, &[&guardian], &[ix]),
        "ConstraintSeeds",
    );
    let after = current_rules(&w);
    assert_eq!(after.daily_limit, before.daily_limit);
    assert_eq!(after.big_share_bps, before.big_share_bps);
    assert_eq!(after.safe_address, before.safe_address);
    assert_eq!(after.guardian, before.guardian);
    assert_eq!(after.delay_secs, before.delay_secs);
    assert!(!read_vault(&w.svm, &w.vault).change.active);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &shop), 1);
}

#[test]
fn apply_change_before_effective_at_moves_nothing_and_leaves_the_rules() {
    let (mut w, dest) = known_world(Rules {
        delay_secs: HOLD_DELAY_3_DAYS,
        daily_limit: 100 * ONE,
        ..Rules::default()
    });
    let old = current_rules(&w);
    let mut loosen = old;
    loosen.daily_limit = 400 * ONE;
    let clock = now(&w.svm);
    propose(&mut w, loosen).unwrap();
    let owner = w.owner.insecure_clone();
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let dest_before = token_balance(&w.svm, &dest);

    assert_err(apply_change(&mut w, &owner), "ChangeNotReady");
    // 200 fits the loosened limit and the current share, and exceeds today's limit.
    let logs = withdraw(&mut w, 200 * ONE, &dest).unwrap();
    assert_held(&logs);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &dest), dest_before);
    assert_eq!(read_vault(&w.svm, &w.vault).daily_limit, old.daily_limit);

    let effective = read_vault(&w.svm, &w.vault).change.effective_at;
    assert_eq!(effective, clock + HOLD_DELAY_3_DAYS);
    warp(&mut w.svm, effective - 1);
    assert_err(apply_change(&mut w, &owner), "ChangeNotReady");
    assert_eq!(read_vault(&w.svm, &w.vault).daily_limit, old.daily_limit);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &dest), dest_before);
}

#[test]
fn a_mixed_proposal_does_not_loosen_any_rule_before_the_delay() {
    let (mut w, known) = known_world(Rules {
        delay_secs: HOLD_DELAY_1_DAY,
        daily_limit: 1_000 * ONE,
        big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
        ..Rules::default()
    });
    let fresh = new_dest(&mut w, &Pubkey::new_unique());
    let clock = now(&w.svm);
    withdraw(&mut w, 40 * ONE, &fresh).unwrap();
    let original_unlock = newest_pending(&read_vault(&w.svm, &w.vault)).unlock_at;
    assert_eq!(original_unlock, clock + HOLD_DELAY_1_DAY);

    let new_guardian = Keypair::new();
    w.svm
        .airdrop(&new_guardian.pubkey(), 1_000_000_000)
        .unwrap();
    let new_safe_owner = Pubkey::new_unique();
    let owner = w.owner.insecure_clone();
    let new_safe = create_token_account(&mut w.svm, &owner, &w.mint, &new_safe_owner);
    let old_guardian = w.guardian.pubkey();
    let old_safe = w.safe;
    let proposal = HoldChange {
        daily_limit: 400 * ONE,
        delay_secs: HOLD_DELAY_3_DAYS,
        big_share_bps: 8_000,
        guardian: new_guardian.pubkey(),
        safe_address: new_safe_owner,
    };
    let clock = now(&w.svm);
    propose(&mut w, proposal).unwrap();

    let vault = read_vault(&w.svm, &w.vault);
    assert_eq!(
        vault.daily_limit,
        400 * ONE,
        "daily tighten should apply now"
    );
    assert_eq!(
        vault.delay_secs, HOLD_DELAY_3_DAYS,
        "longer delay should apply now"
    );
    assert_eq!(vault.big_share_bps, HOLD_DEFAULT_BIG_SHARE_BPS);
    assert_eq!(vault.guardian, old_guardian);
    assert_eq!(vault.safe_address, old_safe);
    assert!(vault.change.active);
    assert_eq!(
        vault.change.fields,
        CHANGE_SHARE | CHANGE_GUARDIAN | CHANGE_SAFE
    );
    assert_eq!(vault.change.effective_at, clock + HOLD_DELAY_3_DAYS);
    assert_eq!(
        pending_rows(&vault)
            .iter()
            .find(|row| row.destination == fresh)
            .expect("original hold")
            .unlock_at,
        original_unlock
    );

    let vault_before = token_balance(&w.svm, &w.vault_token);
    let known_before = token_balance(&w.svm, &known);
    // 300 is inside the loosened share and the tightened daily, and outside today's share.
    let logs = withdraw(&mut w, 300 * ONE, &known).unwrap();
    assert_held(&logs);
    let raised = newest_pending(&read_vault(&w.svm, &w.vault));
    assert_eq!(raised.unlock_at, clock + HOLD_DELAY_3_DAYS);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &known), known_before);

    let owner = w.owner.insecure_clone();
    assert_err(apply_change(&mut w, &owner), "ChangeNotReady");
    assert_err(recover(&mut w, &owner, &new_safe), "NotTheSafeAddress");
    assert_err(freeze(&mut w, &new_guardian), "NotOwnerOrGuardian");
    assert!(!read_vault(&w.svm, &w.vault).frozen);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &new_safe), 0);
    assert_eq!(token_balance(&w.svm, &known), known_before);

    // Still inside the old share and the tightened daily, so an ordinary payment still works.
    let logs = withdraw(&mut w, 200 * ONE, &known).unwrap();
    assert_paid(&logs);
    assert_eq!(token_balance(&w.svm, &known), known_before + 200 * ONE);
    assert_eq!(
        token_balance(&w.svm, &w.vault_token),
        vault_before - 200 * ONE
    );
    assert_eq!(
        read_vault(&w.svm, &w.vault).big_share_bps,
        HOLD_DEFAULT_BIG_SHARE_BPS
    );
}

#[test]
fn share_and_daily_limit_arithmetic_holds_at_u64_edges() {
    let (mut zero_daily, dest) = known_world(Rules {
        daily_limit: 0,
        big_share_bps: 10_000,
        deposit: 80 * ONE,
        ..Rules::default()
    });
    let before = token_balance(&zero_daily.svm, &zero_daily.vault_token);
    let dest_before = token_balance(&zero_daily.svm, &dest);
    let logs = withdraw(&mut zero_daily, 1, &dest).unwrap();
    assert_held(&logs);
    assert_eq!(
        token_balance(&zero_daily.svm, &zero_daily.vault_token),
        before
    );
    assert_eq!(token_balance(&zero_daily.svm, &dest), dest_before);

    let (mut zero_share, dest) = known_world(Rules {
        daily_limit: u64::MAX,
        big_share_bps: 0,
        deposit: 80 * ONE,
        ..Rules::default()
    });
    let before = token_balance(&zero_share.svm, &zero_share.vault_token);
    let dest_before = token_balance(&zero_share.svm, &dest);
    let logs = withdraw(&mut zero_share, 1, &dest).unwrap();
    assert_held(&logs);
    assert_eq!(
        token_balance(&zero_share.svm, &zero_share.vault_token),
        before
    );
    assert_eq!(token_balance(&zero_share.svm, &dest), dest_before);

    let (mut dust, dest) = known_world(Rules {
        vault_id: 11,
        daily_limit: u64::MAX,
        big_share_bps: 1,
        deposit: 9_999,
        ..Rules::default()
    });
    let before = token_balance(&dust.svm, &dust.vault_token);
    assert!(share_of(before, 1) == 0, "oracle cap should be zero");
    let dest_before = token_balance(&dust.svm, &dest);
    let logs = withdraw(&mut dust, 1, &dest).unwrap();
    assert_held(&logs);
    assert_eq!(token_balance(&dust.svm, &dust.vault_token), before);
    assert_eq!(token_balance(&dust.svm, &dest), dest_before);

    let mut huge = open_vault(Rules {
        vault_id: 12,
        daily_limit: u64::MAX,
        big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
        deposit: 0,
        ..Rules::default()
    });
    let owner = huge.owner.insecure_clone();
    let source = huge.source;
    mint_to(&mut huge.svm, &owner, &huge.mint, &source, u64::MAX);
    deposit_from(&mut huge, &source, u64::MAX).unwrap();
    let dest = new_dest(&mut huge, &Pubkey::new_unique());
    arm_known(&mut huge, &dest);
    let balance = token_balance(&huge.svm, &huge.vault_token);
    let cap = share_of(balance, HOLD_DEFAULT_BIG_SHARE_BPS);
    assert!(cap > balance / 5 && cap < balance, "cap {cap} of {balance}");
    let dest_before = token_balance(&huge.svm, &dest);
    let logs = withdraw(&mut huge, cap, &dest).unwrap();
    assert_paid(&logs);
    assert_eq!(token_balance(&huge.svm, &huge.vault_token), balance - cap);
    assert_eq!(token_balance(&huge.svm, &dest), dest_before + cap);
    let left = token_balance(&huge.svm, &huge.vault_token);
    let paid = token_balance(&huge.svm, &dest);
    let logs = withdraw(&mut huge, 1, &dest).unwrap();
    assert_held(&logs);
    assert_eq!(token_balance(&huge.svm, &huge.vault_token), left);
    assert_eq!(token_balance(&huge.svm, &dest), paid);

    // Recycle a near-max payment back into the vault inside the same window.
    // The next instant amount overflows u64 when added to rolling spend.
    let mut edge = open_vault(Rules {
        vault_id: 13,
        daily_limit: u64::MAX,
        big_share_bps: 10_000,
        deposit: 0,
        ..Rules::default()
    });
    let owner = edge.owner.insecure_clone();
    let source = edge.source;
    mint_to(&mut edge.svm, &owner, &edge.mint, &source, u64::MAX);
    let owner_dest = new_dest(&mut edge, &owner.pubkey());
    let almost = u64::MAX - 10;
    deposit_from(&mut edge, &source, almost).unwrap();
    withdraw(&mut edge, almost, &owner_dest).unwrap();
    let row = newest_pending(&read_vault(&edge.svm, &edge.vault));
    warp(&mut edge.svm, row.unlock_at);
    execute(&mut edge, row.id, &owner_dest, &owner).unwrap();
    assert_eq!(token_balance(&edge.svm, &owner_dest), almost);
    deposit_from(&mut edge, &owner_dest, almost).unwrap();
    let vault_state = read_vault(&edge.svm, &edge.vault);
    assert_eq!(
        veto::rolling_window::spent(&vault_state.daily_buckets, now(&edge.svm)),
        Some(almost)
    );
    let before = token_balance(&edge.svm, &edge.vault_token);
    let dest_before = token_balance(&edge.svm, &owner_dest);
    let result = withdraw(&mut edge, 11, &owner_dest);
    if let Ok(logs) = &result {
        assert_held(logs);
    }
    assert_eq!(token_balance(&edge.svm, &edge.vault_token), before);
    assert_eq!(token_balance(&edge.svm, &owner_dest), dest_before);
}

#[test]
fn daily_allowance_returns_only_when_the_oldest_hour_expires() {
    let (mut w, dest) = known_world(Rules::default());
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let logs = withdraw(&mut w, 100 * ONE, &dest).unwrap();
    assert_paid(&logs);
    let start = now(&w.svm);
    assert_eq!(
        veto::rolling_window::spent(&read_vault(&w.svm, &w.vault).daily_buckets, start),
        Some(100 * ONE)
    );
    let filled = token_balance(&w.svm, &w.vault_token);
    let dest_filled = token_balance(&w.svm, &dest);
    assert_eq!(filled, vault_before - 100 * ONE);

    warp(&mut w.svm, start + HOLD_WINDOW_SECS - 1);
    let logs = withdraw(&mut w, 1, &dest).unwrap();
    assert_held(&logs);
    assert_eq!(token_balance(&w.svm, &w.vault_token), filled);
    assert_eq!(token_balance(&w.svm, &dest), dest_filled);
    let still = read_vault(&w.svm, &w.vault);
    assert_eq!(
        veto::rolling_window::spent(&still.daily_buckets, now(&w.svm)),
        Some(100 * ONE)
    );

    let expiry = (start.div_euclid(3600) + 25) * 3600;
    warp(&mut w.svm, expiry);
    let logs = withdraw(&mut w, 100 * ONE, &dest).unwrap();
    assert_paid(&logs);
    assert_eq!(token_balance(&w.svm, &w.vault_token), filled - 100 * ONE);
    assert_eq!(token_balance(&w.svm, &dest), dest_filled + 100 * ONE);
    let rolled = read_vault(&w.svm, &w.vault);
    assert_eq!(
        veto::rolling_window::spent(&rolled.daily_buckets, expiry),
        Some(100 * ONE)
    );
}

#[test]
fn a_full_pending_list_still_lets_the_owner_stop_freeze_and_recover() {
    let (mut w, shop) = known_world(Rules::default());
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let pocket = new_dest(&mut w, &attacker.pubkey());
    for _ in 0..HOLD_PENDING_CAPACITY {
        let logs = withdraw(&mut w, 200 * ONE, &pocket).unwrap();
        assert_held(&logs);
    }
    assert_eq!(
        pending_rows(&read_vault(&w.svm, &w.vault)).len(),
        HOLD_PENDING_CAPACITY
    );
    let logs = withdraw(&mut w, 200 * ONE, &pocket).unwrap();
    assert_refused(&logs);
    assert_eq!(token_balance(&w.svm, &pocket), 0);

    let shop_before = token_balance(&w.svm, &shop);
    let logs = withdraw(&mut w, 1 * ONE, &shop).unwrap();
    assert_paid(&logs);
    assert_eq!(token_balance(&w.svm, &shop), shop_before + 1 * ONE);

    let owner = w.owner.insecure_clone();
    freeze(&mut w, &owner).unwrap();
    assert!(read_vault(&w.svm, &w.vault).frozen);
    let id = newest_pending(&read_vault(&w.svm, &w.vault)).id;
    stop(&mut w, id, &owner).unwrap();
    assert_eq!(token_balance(&w.svm, &pocket), 0);

    let sitting = token_balance(&w.svm, &w.vault_token);
    let safe = w.safe_token;
    recover(&mut w, &owner, &safe).unwrap();
    assert_eq!(token_balance(&w.svm, &w.safe_token), sitting);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 0);
    assert_eq!(token_balance(&w.svm, &pocket), 0);
}

#[test]
fn a_token_2022_mint_or_a_mint_mismatch_moves_nothing() {
    let (mut svm, owner) = boot();
    let mint = create_token_2022_mint(&mut svm, &owner);
    let source = create_token_2022_account(&mut svm, &owner, &mint, &owner.pubkey());
    mint_token_2022(&mut svm, &owner, &mint, &source, 40 * ONE);
    assert_eq!(token_2022_balance(&svm, &source), 40 * ONE);
    let safe = Pubkey::new_unique();
    let (vault, vault_token, ledger) = pdas(&owner.pubkey(), 1);
    let ix = init_ix(
        owner.pubkey(),
        vault,
        ledger,
        vault_token,
        mint,
        token_2022_id(),
        veto::hold::InitVaultArgs {
            vault_id: 1,
            guardian: Pubkey::default(),
            safe_address: safe,
            daily_limit: 10 * ONE,
            delay_secs: HOLD_DELAY_1_DAY,
            big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
        },
    );
    match send(&mut svm, &owner, &[&owner], &[ix]) {
        Ok(logs) => panic!("token-2022 init succeeded:\n{}", logs.join("\n")),
        Err(err) => {
            assert!(
                err.contains("ConstraintAddress"),
                "token-2022 mint was not refused as the wrong token program:\n{err}"
            );
            assert!(svm.get_account(&vault).is_none(), "{err}");
            assert_eq!(token_2022_balance(&svm, &source), 40 * ONE, "{err}");
        }
    }

    let (mut w, shop) = known_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let other_mint = create_mint(&mut w.svm, &owner);
    let wrong = create_token_account(&mut w.svm, &owner, &other_mint, &Pubkey::new_unique());
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let ix = withdraw_accounts(
        owner.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        wrong,
        w.mint,
        spl_token::ID,
        5 * ONE,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[ix]),
        "HoldMintMismatch",
    );
    let ix = withdraw_accounts(
        owner.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        shop,
        other_mint,
        spl_token::ID,
        5 * ONE,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[ix]),
        "HoldMintMismatch",
    );
    let ix = withdraw_accounts(
        owner.pubkey(),
        w.vault,
        w.ledger,
        w.vault_token,
        shop,
        w.mint,
        token_2022_id(),
        5 * ONE,
    );
    assert!(
        send(&mut w.svm, &owner, &[&owner], &[ix]).is_err(),
        "classic vault accepted the token-2022 program"
    );
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &shop), 1);
    assert_eq!(token_balance(&w.svm, &wrong), 0);
}

#[test]
fn a_destination_that_is_the_vault_token_account_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let payee = new_dest(&mut w, &Pubkey::new_unique());
    withdraw(&mut w, 15 * ONE, &payee).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    warp(&mut w.svm, row.unlock_at);
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let vault_token = w.vault_token;
    let same_account = &[
        "DestinationIsVault",
        "ConstraintDuplicateMutableAccount",
        "NotTheSafeAddress",
    ];

    assert_err_one_of(withdraw(&mut w, 1 * ONE, &vault_token), same_account);
    assert_err_one_of(
        execute(&mut w, row.id, &vault_token, &attacker),
        same_account,
    );
    assert_err_one_of(
        skip(&mut w, row.id, &vault_token, &owner, &guardian),
        same_account,
    );
    assert_err_one_of(recover(&mut w, &owner, &vault_token), same_account);

    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
    assert_eq!(token_balance(&w.svm, &payee), 0);
    assert_eq!(newest_pending(&read_vault(&w.svm, &w.vault)).id, row.id);
}

#[test]
fn init_vault_rejects_a_safe_address_equal_to_the_vault_and_the_owner_key_rules() {
    fn reject_init(
        edit: impl FnOnce(&Pubkey, &Pubkey, &mut veto::hold::InitVaultArgs),
        needle: &str,
    ) {
        let (mut svm, owner) = boot();
        let mint = create_mint(&mut svm, &owner);
        let source = create_token_account(&mut svm, &owner, &mint, &owner.pubkey());
        mint_to(&mut svm, &owner, &mint, &source, 50 * ONE);
        let (vault, vault_token, ledger) = pdas(&owner.pubkey(), 1);
        let mut args = veto::hold::InitVaultArgs {
            vault_id: 1,
            guardian: Pubkey::new_unique(),
            safe_address: Pubkey::new_unique(),
            daily_limit: 10,
            delay_secs: HOLD_DELAY_1_DAY,
            big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
        };
        edit(&owner.pubkey(), &vault, &mut args);
        let ix = init_ix(
            owner.pubkey(),
            vault,
            ledger,
            vault_token,
            mint,
            spl_token::ID,
            args,
        );
        assert_err(send(&mut svm, &owner, &[&owner], &[ix]), needle);
        assert!(
            svm.get_account(&vault).is_none(),
            "rejected init still created a vault ({needle})"
        );
        assert_eq!(token_balance(&svm, &source), 50 * ONE);
    }

    reject_init(
        |_, _, args| args.safe_address = args.guardian,
        "SafeAddressIsGuardian",
    );
    reject_init(
        |owner, _, args| args.safe_address = *owner,
        "SafeAddressIsOwner",
    );

    reject_init(
        |_owner, vault, args| args.safe_address = *vault,
        "SafeAddressRequired",
    );
    reject_init(
        |_owner, _vault, args| args.safe_address = Pubkey::default(),
        "SafeAddressRequired",
    );
    reject_init(
        |owner, _vault, args| args.guardian = *owner,
        "GuardianIsOwner",
    );
    reject_init(
        |_owner, _vault, args| args.delay_secs = 0,
        "DelayNotAllowed",
    );
    reject_init(
        |_owner, _vault, args| args.delay_secs = HOLD_DELAY_1_DAY - 1,
        "DelayNotAllowed",
    );
    reject_init(
        |_owner, _vault, args| args.delay_secs = 4 * HOLD_WINDOW_SECS,
        "DelayNotAllowed",
    );
    reject_init(
        |_owner, _vault, args| args.big_share_bps = 10_001,
        "ShareOutOfRange",
    );

    let (mut svm, victim) = boot();
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    let mint = create_mint(&mut svm, &victim);
    let source = create_token_account(&mut svm, &victim, &mint, &victim.pubkey());
    mint_to(&mut svm, &victim, &mint, &source, 50 * ONE);
    let (vault, vault_token, ledger) = pdas(&victim.pubkey(), 1);
    let ix = init_ix(
        victim.pubkey(),
        vault,
        ledger,
        vault_token,
        mint,
        spl_token::ID,
        veto::hold::InitVaultArgs {
            vault_id: 1,
            guardian: Pubkey::default(),
            safe_address: Pubkey::new_unique(),
            daily_limit: 10,
            delay_secs: HOLD_DELAY_1_DAY,
            big_share_bps: HOLD_DEFAULT_BIG_SHARE_BPS,
        },
    );
    assert!(
        send(&mut svm, &attacker, &[&attacker], &[ix]).is_err(),
        "attacker initialized the victim vault"
    );
    assert!(svm.get_account(&vault).is_none());
    assert_eq!(token_balance(&svm, &source), 50 * ONE);

    let (mut svm, owner) = boot();
    let mint = create_mint(&mut svm, &owner);
    let source = create_token_account(&mut svm, &owner, &mint, &owner.pubkey());
    mint_to(&mut svm, &owner, &mint, &source, 50 * ONE);
    let (vault, vault_token, ledger) = pdas(&owner.pubkey(), 3);
    let ix = init_ix(
        owner.pubkey(),
        vault,
        ledger,
        vault_token,
        mint,
        spl_token::ID,
        veto::hold::InitVaultArgs {
            vault_id: 3,
            guardian: Pubkey::default(),
            safe_address: owner.pubkey(),
            daily_limit: 10,
            delay_secs: HOLD_DELAY_2_DAYS,
            big_share_bps: 0,
        },
    );
    assert_err(
        send(&mut svm, &owner, &[&owner], &[ix]),
        "SafeAddressIsOwner",
    );
    assert!(svm.get_account(&vault).is_none());
    assert_eq!(token_balance(&svm, &source), 50 * ONE);

    let (mut w, _shop) = known_world(Rules::default());
    let vault_before = token_balance(&w.svm, &w.vault_token);
    let mut steal_guardian = current_rules(&w);
    steal_guardian.guardian = w.owner.pubkey();
    steal_guardian.daily_limit = steal_guardian.daily_limit.saturating_add(1);
    assert_err(propose(&mut w, steal_guardian), "GuardianIsOwner");
    let mut steal_safe = current_rules(&w);
    steal_safe.safe_address = w.vault;
    steal_safe.daily_limit = steal_safe.daily_limit.saturating_add(1);
    assert_err(propose(&mut w, steal_safe), "SafeAddressRequired");
    let vault = read_vault(&w.svm, &w.vault);
    assert_eq!(vault.guardian, w.guardian.pubkey());
    assert_eq!(vault.safe_address, w.safe);
    assert_eq!(vault.daily_limit, 100 * ONE);
    assert!(!vault.change.active);
    assert_eq!(token_balance(&w.svm, &w.vault_token), vault_before);
}

#[test]
fn a_raw_transfer_or_approval_by_the_owner_or_the_guardian_moves_nothing() {
    let (mut w, _shop) = known_world(Rules::default());
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let pocket = new_dest(&mut w, &attacker.pubkey());
    let owner = w.owner.insecure_clone();
    let guardian = w.guardian.insecure_clone();
    let before = token_balance(&w.svm, &w.vault_token);

    let raw = spl_token::instruction::transfer(
        &spl_token::ID,
        &w.vault_token,
        &pocket,
        &owner.pubkey(),
        &[],
        before,
    )
    .unwrap();
    assert!(send(&mut w.svm, &owner, &[&owner], &[raw]).is_err());
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
    let approve = spl_token::instruction::approve(
        &spl_token::ID,
        &w.vault_token,
        &attacker.pubkey(),
        &owner.pubkey(),
        &[],
        before,
    )
    .unwrap();
    assert!(send(&mut w.svm, &owner, &[&owner], &[approve]).is_err());

    assert_eq!(token_balance(&w.svm, &w.vault_token), before);
    assert_eq!(token_balance(&w.svm, &pocket), 0);
}

#[test]
fn a_withdrawal_queued_before_recover_cannot_spend_a_later_deposit() {
    let (mut w, _shop) = known_world(Rules::default());
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let pocket = new_dest(&mut w, &attacker.pubkey());
    let queued = 400 * ONE;
    withdraw(&mut w, queued, &pocket).unwrap();
    let row = newest_pending(&read_vault(&w.svm, &w.vault));
    assert_eq!(row.amount, queued);
    assert_eq!(row.destination, pocket);

    let owner = w.owner.insecure_clone();
    let sitting = token_balance(&w.svm, &w.vault_token);
    let safe = w.safe_token;
    recover(&mut w, &owner, &safe).unwrap();
    assert_eq!(token_balance(&w.svm, &w.safe_token), sitting);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 0);
    assert_eq!(token_balance(&w.svm, &pocket), 0);

    warp(&mut w.svm, row.unlock_at);
    assert!(execute(&mut w, row.id, &pocket, &attacker).is_err());
    assert_eq!(token_balance(&w.svm, &pocket), 0);
    assert_eq!(token_balance(&w.svm, &w.vault_token), 0);

    let later = 500 * ONE;
    let source = w.source;
    mint_to(&mut w.svm, &owner, &w.mint, &source, later);
    deposit_from(&mut w, &source, later).unwrap();
    assert_eq!(token_balance(&w.svm, &w.vault_token), later);
    assert_err(
        execute(&mut w, row.id, &pocket, &attacker),
        "WithdrawalNotPending",
    );
    assert_eq!(token_balance(&w.svm, &pocket), 0);
    assert_eq!(token_balance(&w.svm, &w.vault_token), later);
    assert_eq!(token_balance(&w.svm, &w.safe_token), sitting);
}

#[test]
fn unsafe_safe_changes_are_rejected_without_partial_tightening() {
    for owner_safe in [false, true] {
        for combined in [false, true] {
            let mut w = open_vault(Rules::default());
            let before = w.svm.get_account(&w.vault).unwrap().data;
            let mut values = current_rules(&w);
            values.safe_address = if owner_safe {
                w.owner.pubkey()
            } else {
                w.guardian.pubkey()
            };
            if combined {
                values.daily_limit = 1;
                values.delay_secs = HOLD_DELAY_2_DAYS;
            }
            assert_err(
                propose(&mut w, values),
                if owner_safe {
                    "SafeAddressIsOwner"
                } else {
                    "SafeAddressIsGuardian"
                },
            );
            assert_eq!(w.svm.get_account(&w.vault).unwrap().data, before);
        }
    }
}

#[test]
fn changing_guardian_to_the_safe_wallet_is_rejected() {
    let mut w = open_vault(Rules::default());
    let mut values = current_rules(&w);
    values.guardian = values.safe_address;
    assert_err(propose(&mut w, values), "SafeAddressIsGuardian");
}

#[test]
fn legacy_unsafe_safe_can_be_repaired_by_owner_after_the_normal_delay() {
    let mut w = open_vault(Rules::default());
    let mut legacy = read_vault(&w.svm, &w.vault);
    legacy.safe_address = legacy.guardian;
    overwrite_vault(&mut w.svm, &w.vault, &legacy);
    let mut values = current_rules(&w);
    values.safe_address = w.safe;
    propose(&mut w, values).unwrap();
    let owner = w.owner.insecure_clone();
    assert_err(apply_change(&mut w, &owner), "ChangeNotReady");
    let pending = read_vault(&w.svm, &w.vault);
    assert_eq!(pending.safe_address, legacy.guardian);
    warp(&mut w.svm, pending.change.effective_at);
    apply_change(&mut w, &owner).unwrap();
    assert_eq!(read_vault(&w.svm, &w.vault).safe_address, w.safe);
}

#[test]
fn old_pending_changes_cannot_apply_unsafe_resulting_rules() {
    for fields in [CHANGE_SAFE, CHANGE_GUARDIAN, CHANGE_SAFE | CHANGE_GUARDIAN] {
        for owner_safe in [false, true] {
            if owner_safe && fields == CHANGE_GUARDIAN {
                continue;
            }
            let mut w = open_vault(Rules::default());
            let mut vault = read_vault(&w.svm, &w.vault);
            vault.change.active = true;
            vault.change.fields = fields;
            vault.change.effective_at = 0;
            vault.change.guardian = if fields == CHANGE_GUARDIAN {
                vault.safe_address
            } else {
                vault.guardian
            };
            vault.change.safe_address = if owner_safe {
                vault.owner
            } else {
                vault.guardian
            };
            overwrite_vault(&mut w.svm, &w.vault, &vault);
            let before = w.svm.get_account(&w.vault).unwrap().data;
            let owner = w.owner.insecure_clone();
            assert_err(
                apply_change(&mut w, &owner),
                if owner_safe {
                    "SafeAddressIsOwner"
                } else {
                    "SafeAddressIsGuardian"
                },
            );
            assert_eq!(w.svm.get_account(&w.vault).unwrap().data, before);
        }
    }
}

#[test]
fn combined_guardian_addition_cannot_take_the_current_safe_during_the_delay() {
    let mut w = open_vault(Rules {
        guardian: false,
        ..Rules::default()
    });
    let mut values = current_rules(&w);
    values.guardian = values.safe_address;
    values.safe_address = Pubkey::new_unique();
    assert_err(propose(&mut w, values), "SafeAddressIsGuardian");
    assert_eq!(read_vault(&w.svm, &w.vault).guardian, Pubkey::default());
}
