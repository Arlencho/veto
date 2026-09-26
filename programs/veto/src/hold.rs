//! Hold: a vault where a large withdrawal waits, and a second key can stop it.
//!
//! Instant withdrawal requires every one of these: the vault is not frozen,
//! the destination token account has already been paid by this vault, the
//! 24 hour total including this amount is within `daily_limit`, and that
//! total is within `big_share_bps` of the current vault balance. Anything
//! else is held until the chain clock passes `unlock_at`. It is not refused,
//! except when the pending list is full or the vault cannot cover the amount:
//! those two write a refusal and pay nothing, so the array cannot be walked
//! off the end and an unpaid hold is still on the record.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use crate::hold_state::*;
use crate::VetoError;
use crate::{
    ApplyChange, CancelChange, CloseHoldVault, Deposit, Execute, Freeze, InitVault,
    MigrateHoldVault, ProposeChange, Recover, Skip, Stop, Unfreeze, Withdraw,
};

pub fn init_vault(ctx: Context<InitVault>, args: InitVaultArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_rules(
        args.delay_secs,
        args.big_share_bps,
        args.safe_address,
        args.guardian,
        ctx.accounts.owner.key(),
        ctx.accounts.vault.key(),
    )?;

    let vault_key = ctx.accounts.vault.key();
    let token_key = ctx.accounts.vault_token.key();
    let bump = ctx.bumps.vault;
    let token_bump = ctx.bumps.vault_token;
    let ledger_bump = ctx.bumps.ledger;

    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.guardian = args.guardian;
    vault.safe_address = args.safe_address;
    vault.mint = ctx.accounts.mint.key();
    vault.vault_token = token_key;
    vault.vault_id = args.vault_id;
    vault.daily_limit = args.daily_limit;
    vault.window_spent = 0;
    vault.daily_buckets =
        [crate::rolling_window::TradeBucket::default(); crate::rolling_window::BUCKET_COUNT];
    vault.window_start = 0;
    vault.delay_secs = args.delay_secs;
    vault.unfreeze_at = 0;
    vault.next_withdrawal_id = 1;
    vault.big_share_bps = args.big_share_bps;
    vault.frozen = false;
    vault.known_len = 0;
    vault.bump = bump;
    vault.token_bump = token_bump;
    vault.ledger_bump = ledger_bump;

    let ledger = &mut ctx.accounts.ledger.load_init()?;
    ledger.vault = vault_key;
    ledger.head = 0;
    ledger.total = 0;
    ledger.bump = ledger_bump;
    write_record(
        ledger,
        now,
        0,
        args.safe_address,
        0,
        HOLD_KIND_OPENED,
        HOLD_REASON_NONE,
    );

    emit!(HoldOpened {
        vault: vault_key,
        owner: vault.owner,
        guardian: vault.guardian,
        safe_address: vault.safe_address,
        daily_limit: vault.daily_limit,
        delay_secs: vault.delay_secs,
        big_share_bps: vault.big_share_bps,
    });
    msg!(
        "HOLD OPENED daily_limit={} delay_secs={} big_share_bps={}",
        vault.daily_limit,
        vault.delay_secs,
        vault.big_share_bps
    );
    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(amount > 0, VetoError::PositiveAmountRequired);
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.vault_token.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        amount,
        vault_key,
        0,
        HOLD_KIND_DEPOSITED,
        HOLD_REASON_NONE,
    );
    emit!(HoldDeposited {
        vault: vault_key,
        amount,
    });
    msg!("HOLD DEPOSITED amount={}", amount);
    Ok(())
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(amount > 0, VetoError::PositiveAmountRequired);
    let destination = ctx.accounts.destination.key();
    let balance = ctx.accounts.vault_token.amount;

    if amount > balance {
        refuse(
            ctx,
            amount,
            destination,
            HOLD_REASON_INSUFFICIENT_FUNDS,
            now,
        )?;
        return Ok(());
    }

    if can_pay_now(&ctx.accounts.vault, balance, destination, amount, now)? {
        record_release(&mut ctx.accounts.vault, amount, now);
        transfer_out(&ctx, amount)?;
        let vault_key = ctx.accounts.vault.key();
        write_record(
            &mut *ctx.accounts.ledger.load_mut()?,
            now,
            amount,
            destination,
            0,
            HOLD_KIND_PAID,
            HOLD_REASON_NONE,
        );
        emit!(HoldPaid {
            vault: vault_key,
            amount,
            destination,
        });
        msg!("HOLD PAID amount={} destination={}", amount, destination);
        return Ok(());
    }

    let unlock_at = now
        .checked_add(ctx.accounts.vault.delay_secs)
        .ok_or(error!(VetoError::HoldMathOverflow))?;
    let Some(index) = first_empty(&ctx.accounts.vault) else {
        refuse(ctx, amount, destination, HOLD_REASON_PENDING_FULL, now)?;
        return Ok(());
    };

    let id = ctx.accounts.vault.next_withdrawal_id;
    ctx.accounts.vault.next_withdrawal_id = id
        .checked_add(1)
        .ok_or(error!(VetoError::HoldMathOverflow))?;
    ctx.accounts.vault.pending[index] = PendingWithdrawal {
        id,
        amount,
        destination,
        unlock_at,
        status: WITHDRAWAL_PENDING,
    };
    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        amount,
        destination,
        id,
        HOLD_KIND_HELD,
        HOLD_REASON_NONE,
    );
    emit!(HoldHeld {
        vault: vault_key,
        id,
        amount,
        destination,
        unlock_at,
    });
    msg!(
        "HOLD HELD id={} amount={} unlock_at={}",
        id,
        amount,
        unlock_at
    );
    Ok(())
}

pub fn execute(ctx: Context<Execute>, id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let index = find_pending(&ctx.accounts.vault, id)?;
    require!(!ctx.accounts.vault.frozen, VetoError::VaultFrozen);
    let row = ctx.accounts.vault.pending[index];
    require!(now >= row.unlock_at, VetoError::TooEarly);
    require_keys_eq!(
        ctx.accounts.destination.key(),
        row.destination,
        VetoError::DestinationMismatch
    );
    require!(
        ctx.accounts.vault_token.amount >= row.amount,
        VetoError::HoldInsufficientFunds
    );

    record_release(&mut ctx.accounts.vault, row.amount, now);
    let info = ctx.accounts.vault.to_account_info();
    transfer_out_parts(
        info,
        &ctx.accounts.vault,
        &ctx.accounts.vault_token,
        &ctx.accounts.destination,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        row.amount,
    )?;
    remember(&mut ctx.accounts.vault, row.destination);
    ctx.accounts.vault.pending[index] = PendingWithdrawal::default();

    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        row.amount,
        row.destination,
        id,
        HOLD_KIND_PAID,
        HOLD_REASON_NONE,
    );
    emit!(HoldExecuted {
        vault: vault_key,
        id,
        amount: row.amount,
        destination: row.destination,
    });
    msg!("HOLD EXECUTED id={} amount={}", id, row.amount);
    Ok(())
}

pub fn stop(ctx: Context<Stop>, id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let index = find_pending(&ctx.accounts.vault, id)?;
    let row = ctx.accounts.vault.pending[index];
    ctx.accounts.vault.pending[index] = PendingWithdrawal::default();
    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        row.amount,
        row.destination,
        id,
        HOLD_KIND_STOPPED,
        HOLD_REASON_NONE,
    );
    emit!(HoldStopped {
        vault: vault_key,
        id,
        amount: row.amount,
    });
    msg!("HOLD STOPPED id={}", id);
    Ok(())
}

pub fn freeze(ctx: Context<Freeze>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.vault.frozen, VetoError::VaultFrozen);
    ctx.accounts.vault.frozen = true;
    let vault_key = ctx.accounts.vault.key();
    let by = ctx.accounts.authority.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        0,
        by,
        0,
        HOLD_KIND_FROZEN,
        HOLD_REASON_NONE,
    );
    emit!(HoldFrozen {
        vault: vault_key,
        by,
    });
    msg!("HOLD FROZEN");
    Ok(())
}

pub fn unfreeze(ctx: Context<Unfreeze>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.vault.frozen, VetoError::NotFrozen);

    let both = match &ctx.accounts.guardian {
        Some(guardian) => {
            require!(
                ctx.accounts.vault.guardian != Pubkey::default(),
                VetoError::NotTheGuardian
            );
            require_keys_eq!(
                guardian.key(),
                ctx.accounts.vault.guardian,
                VetoError::NotTheGuardian
            );
            require_keys_neq!(
                guardian.key(),
                ctx.accounts.owner.key(),
                VetoError::BothKeysRequired
            );
            true
        }
        None => false,
    };

    if both {
        let vault_key = ctx.accounts.vault.key();
        finish_unfreeze(
            &mut ctx.accounts.vault,
            vault_key,
            &mut ctx.accounts.ledger,
            now,
        )?;
        return Ok(());
    }

    require!(
        ctx.accounts.vault.guardian == Pubkey::default(),
        VetoError::BothKeysRequired
    );

    if ctx.accounts.vault.unfreeze_at == 0 {
        let effective_at = now
            .checked_add(ctx.accounts.vault.delay_secs)
            .ok_or(error!(VetoError::HoldMathOverflow))?;
        ctx.accounts.vault.unfreeze_at = effective_at;
        let vault_key = ctx.accounts.vault.key();
        write_record(
            &mut *ctx.accounts.ledger.load_mut()?,
            now,
            0,
            Pubkey::default(),
            0,
            HOLD_KIND_UNFREEZE_SCHEDULED,
            HOLD_REASON_NONE,
        );
        emit!(HoldUnfreezeScheduled {
            vault: vault_key,
            effective_at,
        });
        msg!("HOLD UNFREEZE SCHEDULED effective_at={}", effective_at);
        return Ok(());
    }

    require!(
        now >= ctx.accounts.vault.unfreeze_at,
        VetoError::UnfreezeNotReady
    );
    let vault_key = ctx.accounts.vault.key();
    finish_unfreeze(
        &mut ctx.accounts.vault,
        vault_key,
        &mut ctx.accounts.ledger,
        now,
    )?;
    Ok(())
}

pub fn skip(ctx: Context<Skip>, id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.vault.guardian != Pubkey::default(),
        VetoError::BothKeysRequired
    );
    require_keys_eq!(
        ctx.accounts.guardian.key(),
        ctx.accounts.vault.guardian,
        VetoError::NotTheGuardian
    );
    require_keys_neq!(
        ctx.accounts.guardian.key(),
        ctx.accounts.owner.key(),
        VetoError::BothKeysRequired
    );
    require!(!ctx.accounts.vault.frozen, VetoError::VaultFrozen);

    let index = find_pending(&ctx.accounts.vault, id)?;
    let row = ctx.accounts.vault.pending[index];
    require_keys_eq!(
        ctx.accounts.destination.key(),
        row.destination,
        VetoError::DestinationMismatch
    );
    require!(
        ctx.accounts.vault_token.amount >= row.amount,
        VetoError::HoldInsufficientFunds
    );

    record_release(&mut ctx.accounts.vault, row.amount, now);
    let info = ctx.accounts.vault.to_account_info();
    transfer_out_parts(
        info,
        &ctx.accounts.vault,
        &ctx.accounts.vault_token,
        &ctx.accounts.destination,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        row.amount,
    )?;
    remember(&mut ctx.accounts.vault, row.destination);
    ctx.accounts.vault.pending[index] = PendingWithdrawal::default();

    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        row.amount,
        row.destination,
        id,
        HOLD_KIND_SKIPPED,
        HOLD_REASON_NONE,
    );
    emit!(HoldSkipped {
        vault: vault_key,
        id,
        amount: row.amount,
        destination: row.destination,
    });
    msg!("HOLD SKIPPED id={} amount={}", id, row.amount);
    Ok(())
}

/// The previous layout is the current Borsh prefix without rolling buckets.
/// Never accept arbitrary short accounts or re-migrate a current account.
pub fn migrate_hold_vault(ctx: Context<MigrateHoldVault>) -> Result<()> {
    let info = ctx.accounts.vault.to_account_info();
    let current_len = 8 + HoldVault::INIT_SPACE;
    require!(
        info.data_len() == LEGACY_HOLD_VAULT_LEN,
        VetoError::InvalidLegacyHoldLayout
    );
    let mut bytes = info.try_borrow_data()?.to_vec();
    bytes.resize(current_len, 0);
    let mut vault = HoldVault::try_deserialize(&mut bytes.as_slice())?;
    require_keys_eq!(
        vault.owner,
        ctx.accounts.owner.key(),
        VetoError::NotTheVaultOwner
    );
    require_vault_signer(info.key(), &vault)?;
    // Retain the full total even if the old fixed window has expired. The
    // unknown payment timestamps cannot justify freeing any allowance early.
    crate::rolling_window::record_release(
        &mut vault.daily_buckets,
        vault.window_spent,
        Clock::get()?.unix_timestamp,
    );
    let top_up = Rent::get()?
        .minimum_balance(current_len)
        .saturating_sub(info.lamports());
    if top_up > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: info.clone(),
                },
            ),
            top_up,
        )?;
    }
    info.resize(current_len)?;
    vault.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
    Ok(())
}

pub fn close_hold_vault(ctx: Context<CloseHoldVault>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(!vault.frozen, VetoError::VaultFrozen);
    require!(
        vault
            .pending
            .iter()
            .all(|row| row.status == WITHDRAWAL_EMPTY),
        VetoError::HoldWithdrawalPending
    );
    transfer_out_parts(
        vault.to_account_info(),
        vault,
        &ctx.accounts.vault_token,
        &ctx.accounts.destination,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        ctx.accounts.vault_token.amount,
    )?;
    let id = vault.vault_id.to_le_bytes();
    let bump = [vault.bump];
    let seeds: &[&[u8]] = &[b"hold", vault.owner.as_ref(), &id, &bump];
    token_interface::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        token_interface::CloseAccount {
            account: ctx.accounts.vault_token.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: vault.to_account_info(),
        },
        &[seeds],
    ))?;
    Ok(())
}

pub fn recover(ctx: Context<Recover>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let amount = ctx.accounts.vault_token.amount;
    require!(amount > 0, VetoError::NothingToRecover);
    require!(
        ctx.accounts.destination.owner == ctx.accounts.vault.safe_address,
        VetoError::NotTheSafeAddress
    );

    // These rows are claims on the balance that is about to leave. execute
    // needs no key, so a row left in place pays the old destination out of
    // the next deposit. Clear them before the transfer.
    for slot in ctx.accounts.vault.pending.iter_mut() {
        *slot = PendingWithdrawal::default();
    }

    let info = ctx.accounts.vault.to_account_info();
    transfer_out_parts(
        info,
        &ctx.accounts.vault,
        &ctx.accounts.vault_token,
        &ctx.accounts.destination,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        amount,
    )?;

    let destination = ctx.accounts.destination.key();
    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        amount,
        destination,
        0,
        HOLD_KIND_RECOVERED,
        HOLD_REASON_NONE,
    );
    emit!(HoldRecovered {
        vault: vault_key,
        amount,
        destination,
    });
    msg!("HOLD RECOVERED amount={}", amount);
    Ok(())
}

pub fn propose_change(ctx: Context<ProposeChange>, values: HoldChange) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_rules(
        values.delay_secs,
        values.big_share_bps,
        values.safe_address,
        values.guardian,
        ctx.accounts.owner.key(),
        ctx.accounts.vault.key(),
    )?;

    let mut tighten = 0u8;
    let mut loosen = 0u8;
    let vault = &ctx.accounts.vault;
    if values.daily_limit < vault.daily_limit {
        tighten |= CHANGE_DAILY;
    } else if values.daily_limit > vault.daily_limit {
        loosen |= CHANGE_DAILY;
    }
    if values.delay_secs > vault.delay_secs {
        tighten |= CHANGE_DELAY;
    } else if values.delay_secs < vault.delay_secs {
        loosen |= CHANGE_DELAY;
    }
    if values.big_share_bps < vault.big_share_bps {
        tighten |= CHANGE_SHARE;
    } else if values.big_share_bps > vault.big_share_bps {
        loosen |= CHANGE_SHARE;
    }
    if values.guardian != vault.guardian {
        let adding = vault.guardian == Pubkey::default() && values.guardian != Pubkey::default();
        if adding {
            tighten |= CHANGE_GUARDIAN;
        } else {
            loosen |= CHANGE_GUARDIAN;
        }
    }
    if values.safe_address != vault.safe_address {
        loosen |= CHANGE_SAFE;
    }
    require!(tighten != 0 || loosen != 0, VetoError::ChangeUnchanged);
    if loosen != 0 {
        require!(!vault.change.active, VetoError::ChangeAlreadyPending);
    }

    let vault = &mut ctx.accounts.vault;
    if tighten & CHANGE_DAILY != 0 {
        vault.daily_limit = values.daily_limit;
    }
    if tighten & CHANGE_DELAY != 0 {
        vault.delay_secs = values.delay_secs;
    }
    if tighten & CHANGE_SHARE != 0 {
        vault.big_share_bps = values.big_share_bps;
    }
    if tighten & CHANGE_GUARDIAN != 0 {
        vault.guardian = values.guardian;
    }

    let vault_key = vault.key();
    if tighten != 0 {
        write_record(
            &mut *ctx.accounts.ledger.load_mut()?,
            now,
            0,
            Pubkey::default(),
            0,
            HOLD_KIND_CHANGE_APPLIED,
            tighten,
        );
        emit!(HoldChangeApplied {
            vault: vault_key,
            fields: tighten,
        });
        msg!("HOLD CHANGE APPLIED fields={}", tighten);
    }
    if loosen != 0 {
        let effective_at = now
            .checked_add(vault.delay_secs)
            .ok_or(error!(VetoError::HoldMathOverflow))?;
        vault.change = PendingChange {
            active: true,
            fields: loosen,
            big_share_bps: values.big_share_bps,
            daily_limit: values.daily_limit,
            delay_secs: values.delay_secs,
            guardian: values.guardian,
            safe_address: values.safe_address,
            effective_at,
        };
        write_record(
            &mut *ctx.accounts.ledger.load_mut()?,
            now,
            0,
            values.safe_address,
            0,
            HOLD_KIND_CHANGE_PROPOSED,
            loosen,
        );
        emit!(HoldChangeProposed {
            vault: vault_key,
            effective_at,
            fields: loosen,
        });
        msg!(
            "HOLD CHANGE PROPOSED effective_at={} fields={}",
            effective_at,
            loosen
        );
    }
    Ok(())
}

pub fn apply_change(ctx: Context<ApplyChange>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.vault.change.active, VetoError::NoPendingChange);
    require!(
        now >= ctx.accounts.vault.change.effective_at,
        VetoError::ChangeNotReady
    );
    let pending = ctx.accounts.vault.change;
    if pending.fields & CHANGE_DELAY != 0 {
        require!(
            delay_allowed(pending.delay_secs),
            VetoError::DelayNotAllowed
        );
    }
    if pending.fields & CHANGE_SHARE != 0 {
        require!(
            u64::from(pending.big_share_bps) <= HOLD_BPS_DENOMINATOR,
            VetoError::ShareOutOfRange
        );
    }
    if pending.fields & CHANGE_GUARDIAN != 0 && pending.guardian != Pubkey::default() {
        require_keys_neq!(
            pending.guardian,
            ctx.accounts.vault.owner,
            VetoError::GuardianIsOwner
        );
    }
    if pending.fields & CHANGE_SAFE != 0 {
        require!(
            pending.safe_address != Pubkey::default(),
            VetoError::SafeAddressRequired
        );
        require_keys_neq!(
            pending.safe_address,
            ctx.accounts.vault.key(),
            VetoError::SafeAddressRequired
        );
    }

    let vault = &mut ctx.accounts.vault;
    if pending.fields & CHANGE_DAILY != 0 {
        vault.daily_limit = pending.daily_limit;
    }
    if pending.fields & CHANGE_DELAY != 0 {
        vault.delay_secs = pending.delay_secs;
    }
    if pending.fields & CHANGE_SHARE != 0 {
        vault.big_share_bps = pending.big_share_bps;
    }
    if pending.fields & CHANGE_GUARDIAN != 0 {
        vault.guardian = pending.guardian;
    }
    if pending.fields & CHANGE_SAFE != 0 {
        vault.safe_address = pending.safe_address;
    }
    vault.change = PendingChange::default();

    let vault_key = vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        0,
        pending.safe_address,
        0,
        HOLD_KIND_CHANGE_APPLIED,
        pending.fields,
    );
    emit!(HoldChangeApplied {
        vault: vault_key,
        fields: pending.fields,
    });
    msg!("HOLD CHANGE APPLIED fields={}", pending.fields);
    Ok(())
}

pub fn cancel_change(ctx: Context<CancelChange>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.vault.change.active, VetoError::NoPendingChange);
    ctx.accounts.vault.change = PendingChange::default();
    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        0,
        Pubkey::default(),
        0,
        HOLD_KIND_CHANGE_CANCELLED,
        HOLD_REASON_NONE,
    );
    emit!(HoldChangeCancelled { vault: vault_key });
    msg!("HOLD CHANGE CANCELLED");
    Ok(())
}

fn finish_unfreeze<'info>(
    vault: &mut HoldVault,
    vault_key: Pubkey,
    ledger: &mut AccountLoader<'info, HoldLedger>,
    now: i64,
) -> Result<()> {
    vault.frozen = false;
    vault.unfreeze_at = 0;
    write_record(
        &mut *ledger.load_mut()?,
        now,
        0,
        Pubkey::default(),
        0,
        HOLD_KIND_UNFROZEN,
        HOLD_REASON_NONE,
    );
    emit!(HoldUnfrozen { vault: vault_key });
    msg!("HOLD UNFROZEN");
    Ok(())
}

fn refuse(
    ctx: Context<Withdraw>,
    amount: u64,
    destination: Pubkey,
    reason: u8,
    now: i64,
) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    write_record(
        &mut *ctx.accounts.ledger.load_mut()?,
        now,
        amount,
        destination,
        0,
        HOLD_KIND_REFUSED,
        reason,
    );
    emit!(HoldRefused {
        vault: vault_key,
        amount,
        destination,
        reason,
    });
    msg!("HOLD REFUSED reason={} amount={}", reason, amount);
    Ok(())
}

fn can_pay_now(
    vault: &HoldVault,
    balance: u64,
    destination: Pubkey,
    amount: u64,
    now: i64,
) -> Result<bool> {
    if vault.frozen || !is_known(vault, &destination) {
        return Ok(false);
    }
    let Some(daily_next) = crate::rolling_window::spent(&vault.daily_buckets, now)
        .and_then(|spent| spent.checked_add(amount))
    else {
        return Ok(false);
    };
    if daily_next > vault.daily_limit {
        return Ok(false);
    }
    let cap = share_cap(balance, vault.big_share_bps)?;
    Ok(daily_next <= cap)
}

fn record_release(vault: &mut HoldVault, amount: u64, now: i64) {
    crate::rolling_window::record_release(&mut vault.daily_buckets, amount, now);
}

fn share_cap(balance: u64, bps: u16) -> Result<u64> {
    let bps = u64::from(bps);
    require!(bps <= HOLD_BPS_DENOMINATOR, VetoError::ShareOutOfRange);
    let whole = balance / HOLD_BPS_DENOMINATOR;
    let rem = balance % HOLD_BPS_DENOMINATOR;
    let from_whole = whole
        .checked_mul(bps)
        .ok_or(error!(VetoError::HoldMathOverflow))?;
    let from_rem = rem
        .checked_mul(bps)
        .ok_or(error!(VetoError::HoldMathOverflow))?
        / HOLD_BPS_DENOMINATOR;
    from_whole
        .checked_add(from_rem)
        .ok_or(error!(VetoError::HoldMathOverflow).into())
}

fn is_known(vault: &HoldVault, destination: &Pubkey) -> bool {
    let n = (vault.known_len as usize).min(HOLD_KNOWN_CAPACITY);
    vault.known[..n].contains(destination)
}

fn remember(vault: &mut HoldVault, destination: Pubkey) {
    if is_known(vault, &destination) {
        return;
    }
    let len = vault.known_len as usize;
    if len >= HOLD_KNOWN_CAPACITY {
        return;
    }
    vault.known[len] = destination;
    vault.known_len = vault.known_len.saturating_add(1);
}

fn first_empty(vault: &HoldVault) -> Option<usize> {
    vault
        .pending
        .iter()
        .position(|row| row.status == WITHDRAWAL_EMPTY)
}

fn find_pending(vault: &HoldVault, id: u64) -> Result<usize> {
    vault
        .pending
        .iter()
        .position(|row| row.status == WITHDRAWAL_PENDING && row.id == id)
        .ok_or(error!(VetoError::WithdrawalNotPending))
}

fn require_rules(
    delay_secs: i64,
    big_share_bps: u16,
    safe_address: Pubkey,
    guardian: Pubkey,
    owner: Pubkey,
    vault: Pubkey,
) -> Result<()> {
    require!(delay_allowed(delay_secs), VetoError::DelayNotAllowed);
    require!(
        u64::from(big_share_bps) <= HOLD_BPS_DENOMINATOR,
        VetoError::ShareOutOfRange
    );
    require!(
        safe_address != Pubkey::default(),
        VetoError::SafeAddressRequired
    );
    require_keys_neq!(safe_address, vault, VetoError::SafeAddressRequired);
    if guardian != Pubkey::default() {
        require_keys_neq!(guardian, owner, VetoError::GuardianIsOwner);
    }
    Ok(())
}

fn write_record(
    ledger: &mut HoldLedger,
    ts: i64,
    amount: u64,
    destination: Pubkey,
    withdrawal_id: u64,
    kind: u8,
    reason: u8,
) {
    ledger.record(HoldEntry {
        ts,
        amount,
        destination,
        withdrawal_id,
        kind,
        reason,
        _pad: [0; 6],
    });
}

fn require_vault_signer(key: Pubkey, vault: &HoldVault) -> Result<()> {
    let id_bytes = vault.vault_id.to_le_bytes();
    let bump = [vault.bump];
    let expected = Pubkey::create_program_address(
        &[b"hold", vault.owner.as_ref(), &id_bytes, &bump],
        &crate::ID,
    )
    .map_err(|_| error!(VetoError::InvalidVaultPda))?;
    require_keys_eq!(expected, key, VetoError::InvalidVaultPda);

    let token_bump = [vault.token_bump];
    let token =
        Pubkey::create_program_address(&[b"hold-token", key.as_ref(), &token_bump], &crate::ID)
            .map_err(|_| error!(VetoError::InvalidVaultPda))?;
    require_keys_eq!(token, vault.vault_token, VetoError::VaultTokenMismatch);
    Ok(())
}

fn transfer_out(ctx: &Context<Withdraw>, amount: u64) -> Result<()> {
    let info = ctx.accounts.vault.to_account_info();
    transfer_out_parts(
        info,
        &ctx.accounts.vault,
        &ctx.accounts.vault_token,
        &ctx.accounts.destination,
        &ctx.accounts.mint,
        &ctx.accounts.token_program,
        amount,
    )
}

fn transfer_out_parts<'info>(
    vault_info: AccountInfo<'info>,
    vault: &HoldVault,
    vault_token: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    require_vault_signer(vault_info.key(), vault)?;
    require_keys_eq!(
        vault_token.key(),
        vault.vault_token,
        VetoError::VaultTokenMismatch
    );
    require!(
        vault_token.owner == vault_info.key(),
        VetoError::BadVaultAuthority
    );
    require_keys_eq!(vault_token.mint, vault.mint, VetoError::HoldMintMismatch);
    require_keys_eq!(mint.key(), vault.mint, VetoError::HoldMintMismatch);
    require_keys_eq!(destination.mint, vault.mint, VetoError::HoldMintMismatch);
    require_keys_neq!(
        destination.key(),
        vault_token.key(),
        VetoError::DestinationIsVault
    );
    require!(
        destination.owner != vault_info.key(),
        VetoError::DestinationIsVault
    );

    let id_bytes = vault.vault_id.to_le_bytes();
    let bump = [vault.bump];
    let seeds: &[&[u8]] = &[b"hold", vault.owner.as_ref(), &id_bytes, &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            token_interface::TransferChecked {
                from: vault_token.to_account_info(),
                to: destination.to_account_info(),
                authority: vault_info,
                mint: mint.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )?;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultArgs {
    pub vault_id: u64,
    pub guardian: Pubkey,
    pub safe_address: Pubkey,
    pub daily_limit: u64,
    pub delay_secs: i64,
    pub big_share_bps: u16,
}

#[event]
pub struct HoldOpened {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub guardian: Pubkey,
    pub safe_address: Pubkey,
    pub daily_limit: u64,
    pub delay_secs: i64,
    pub big_share_bps: u16,
}

#[event]
pub struct HoldDeposited {
    pub vault: Pubkey,
    pub amount: u64,
}

#[event]
pub struct HoldPaid {
    pub vault: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct HoldHeld {
    pub vault: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub destination: Pubkey,
    pub unlock_at: i64,
}

#[event]
pub struct HoldRefused {
    pub vault: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    pub reason: u8,
}

#[event]
pub struct HoldExecuted {
    pub vault: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct HoldStopped {
    pub vault: Pubkey,
    pub id: u64,
    pub amount: u64,
}

#[event]
pub struct HoldFrozen {
    pub vault: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct HoldUnfrozen {
    pub vault: Pubkey,
}

#[event]
pub struct HoldUnfreezeScheduled {
    pub vault: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct HoldSkipped {
    pub vault: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct HoldRecovered {
    pub vault: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct HoldChangeProposed {
    pub vault: Pubkey,
    pub effective_at: i64,
    pub fields: u8,
}

#[event]
pub struct HoldChangeApplied {
    pub vault: Pubkey,
    pub fields: u8,
}

#[event]
pub struct HoldChangeCancelled {
    pub vault: Pubkey,
}
