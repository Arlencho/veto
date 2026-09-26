//! Veto: a permission to spend, and a legible record when it is declined.
//!
//! A mandate is opened by a human and carries four limits: a total cap, a
//! largest single payment, an expiry, and one allowed merchant. An agent key
//! may submit charges against it and can do nothing else.
//!
//! Caps enforced on chain are not new. Squads ships them, session-key wallets
//! ship them, AP2 standardised the signed mandate that carries them. What
//! every one of those designs has in common is that an overspend becomes an
//! impossible transaction, which protects the money and leaves nothing behind:
//! no artifact, no reason, no trail.
//!
//! This program takes the opposite side, and that is the whole point of it.
//! When a charge breaks a rule, `charge` does not return an error. Returning
//! an error would roll back every account write, so the refusal would leave no
//! trace on chain and would be indistinguishable from nothing having happened.
//! Instead the instruction transfers nothing, writes a refusal to the ledger
//! with a reason code and the override that would have cleared it, logs a
//! readable line, and returns Ok.
//!
//! The transaction confirms. The balance is unchanged. The refusal is a
//! durable artifact with a signature you can open in an explorer.
//!
//! A trade rule is the same idea for one pool. The agent may sell the owner's
//! input token for one pinned output token, inside a cap, a daily limit, a
//! per-trade ceiling, and a price floor. A trade that breaks a rule confirms,
//! moves nothing, and leaves the refusal on the trade ledger.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};
use hold::InitVaultArgs;
use trade::OpenTradeRuleArgs;

pub mod hold;
pub mod hold_state;
pub mod rolling_window;
pub mod state;
pub mod trade;
pub mod trade_state;
pub use hold_state::*;
pub use state::*;
pub use trade_state::*;

declare_id!("3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV");

#[program]
pub mod veto {
    use super::*;

    /// Open a mandate and delegate `cap` to it in the same transaction, so the
    /// owner signs exactly once.
    pub fn open_mandate(ctx: Context<OpenMandate>, args: OpenMandateArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        require!(args.cap > 0, VetoError::CapMustBePositive);
        require!(args.per_tx_max > 0, VetoError::PerTxMaxMustBePositive);
        require!(args.per_tx_max <= args.cap, VetoError::PerTxMaxAboveCap);
        require!(args.expires_at > now, VetoError::ExpiryInThePast);
        require!(
            args.purpose.chars().count() <= PURPOSE_MAX_LEN,
            VetoError::PurposeTooLong
        );
        require_keys_neq!(
            args.merchant,
            Pubkey::default(),
            VetoError::MerchantRequired
        );
        require_keys_neq!(
            args.agent,
            ctx.accounts.owner.key(),
            VetoError::AgentMustNotBeOwner
        );

        let mandate_key = ctx.accounts.mandate.key();
        let mandate = &mut ctx.accounts.mandate;
        mandate.owner = ctx.accounts.owner.key();
        mandate.agent = args.agent;
        mandate.mint = ctx.accounts.mint.key();
        mandate.source = ctx.accounts.source.key();
        mandate.merchant = args.merchant;
        mandate.mandate_id = args.mandate_id;
        mandate.cap = args.cap;
        mandate.spent = 0;
        mandate.per_tx_max = args.per_tx_max;
        mandate.expires_at = args.expires_at;
        mandate.override_amount = 0;
        mandate.override_nonce = 0;
        mandate.last_nonce = 0;
        mandate.purpose = args.purpose;
        mandate.status = STATUS_ACTIVE;
        mandate.spend_count = 0;
        mandate.refusal_count = 0;
        mandate.bump = ctx.bumps.mandate;

        let ledger = &mut ctx.accounts.ledger.load_init()?;
        ledger.mandate = mandate_key;
        ledger.head = 0;
        ledger.total = 0;
        ledger.bump = ctx.bumps.ledger;
        ledger.record(Entry {
            ts: now,
            amount: args.cap,
            counterparty: args.merchant,
            nonce: 0,
            suggested_override: 0,
            kind: KIND_OPENED,
            reason: REASON_OK,
            _pad: [0; 6],
        });

        // Delegate the cap to the mandate PDA. The tokens do not move: the
        // owner keeps them and keeps the right to revoke at any moment.
        token_interface::approve_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token_interface::ApproveChecked {
                    to: ctx.accounts.source.to_account_info(),
                    delegate: ctx.accounts.mandate.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            args.cap,
            ctx.accounts.mint.decimals,
        )?;

        msg!(
            "VETO OPENED cap={} per_tx_max={} expires_at={} purpose={}",
            args.cap,
            args.per_tx_max,
            args.expires_at,
            ctx.accounts.mandate.purpose
        );
        Ok(())
    }

    /// Submit a charge. Signed by the agent, decided by this program.
    ///
    /// Returns Ok whether the charge is paid or refused. See the module doc
    /// for why a refusal must not be an error.
    pub fn charge(ctx: Context<Charge>, amount: u64, nonce: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        // Re-derive the mandate address from its own stored fields. The CPI
        // below signs as this PDA, so this also proves the stored bump is the
        // canonical one.
        let expected = Pubkey::create_program_address(
            &[
                b"mandate",
                ctx.accounts.mandate.owner.as_ref(),
                &ctx.accounts.mandate.mandate_id.to_le_bytes(),
                &[ctx.accounts.mandate.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(VetoError::InvalidMandatePda))?;
        require_keys_eq!(
            expected,
            ctx.accounts.mandate.key(),
            VetoError::InvalidMandatePda
        );

        let reason = evaluate(
            &ctx.accounts.mandate,
            ctx.accounts.mandate.key(),
            &ctx.accounts.source,
            &ctx.accounts.destination,
            amount,
            nonce,
            now,
        );

        if reason == REASON_OK {
            let owner = ctx.accounts.mandate.owner;
            let mandate_id = ctx.accounts.mandate.mandate_id.to_le_bytes();
            let bump = [ctx.accounts.mandate.bump];
            let seeds: &[&[u8]] = &[b"mandate", owner.as_ref(), &mandate_id, &bump];

            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    token_interface::TransferChecked {
                        from: ctx.accounts.source.to_account_info(),
                        to: ctx.accounts.destination.to_account_info(),
                        authority: ctx.accounts.mandate.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                ctx.accounts.mint.decimals,
            )?;

            let mandate = &mut ctx.accounts.mandate;
            mandate.spent = mandate
                .spent
                .checked_add(amount)
                .ok_or(VetoError::MathOverflow)?;
            mandate.spend_count = mandate.spend_count.saturating_add(1);
            mandate.last_nonce = nonce;
            if mandate.override_nonce == nonce {
                mandate.override_nonce = 0;
                mandate.override_amount = 0;
            }
            if mandate.spent >= mandate.cap {
                mandate.status = STATUS_EXHAUSTED;
            }

            ctx.accounts.ledger.load_mut()?.record(Entry {
                ts: now,
                amount,
                counterparty: ctx.accounts.destination.key(),
                nonce,
                suggested_override: 0,
                kind: KIND_PAID,
                reason: REASON_OK,
                _pad: [0; 6],
            });

            msg!(
                "VETO PAID amount={} spent={} of cap={} remaining={}",
                amount,
                mandate.spent,
                mandate.cap,
                mandate.remaining()
            );
            emit!(Paid {
                mandate: mandate.key(),
                amount,
                nonce,
                spent: mandate.spent,
            });
        } else {
            let mandate = &mut ctx.accounts.mandate;
            if reason == REASON_EXPIRED && mandate.status == STATUS_ACTIVE {
                mandate.status = STATUS_EXPIRED;
            }
            mandate.refusal_count = mandate.refusal_count.saturating_add(1);
            let suggestion = suggested_override(mandate, reason, amount);

            ctx.accounts.ledger.load_mut()?.record(Entry {
                ts: now,
                amount,
                counterparty: ctx.accounts.destination.key(),
                nonce,
                suggested_override: suggestion,
                kind: KIND_REFUSED,
                reason,
                _pad: [0; 6],
            });

            msg!(
                "VETO REFUSED reason={} ({}) amount={} per_tx_max={} remaining={} override_to_clear={}",
                reason,
                reason_text(reason),
                amount,
                ctx.accounts.mandate.effective_per_tx_max(nonce),
                ctx.accounts.mandate.remaining(),
                suggestion
            );
            emit!(Refused {
                mandate: ctx.accounts.mandate.key(),
                amount,
                nonce,
                reason,
                suggested_override: suggestion,
            });
        }

        Ok(())
    }

    /// Let one specific charge through above the per-payment ceiling.
    ///
    /// The owner signs, so the override is explicit. It is written to the
    /// ledger, so it is on the record. It raises the per-payment ceiling only:
    /// the total cap stays absolute.
    pub fn grant_override(ctx: Context<OwnerAction>, amount: u64, nonce: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(nonce != 0, VetoError::NonceRequired);
        require!(amount > 0, VetoError::AmountMustBePositive);
        require!(
            ctx.accounts.mandate.status == STATUS_ACTIVE,
            VetoError::MandateNotActive
        );
        require!(
            nonce > ctx.accounts.mandate.last_nonce,
            VetoError::NonceAlreadySettled
        );
        require!(
            amount <= ctx.accounts.mandate.remaining(),
            VetoError::OverrideAboveCap
        );

        let mandate = &mut ctx.accounts.mandate;
        mandate.override_amount = amount;
        mandate.override_nonce = nonce;

        ctx.accounts.ledger.load_mut()?.record(Entry {
            ts: now,
            amount,
            counterparty: mandate.merchant,
            nonce,
            suggested_override: amount,
            kind: KIND_OVERRIDE,
            reason: REASON_OK,
            _pad: [0; 6],
        });

        msg!("VETO OVERRIDE amount={} nonce={}", amount, nonce);
        Ok(())
    }

    /// Withdraw the agent's authority immediately, in one owner signature.
    ///
    /// Allowed from any status except already REVOKED, so an EXPIRED or
    /// EXHAUSTED mandate can still drop its SPL delegation. A second revoke
    /// is refused.
    pub fn revoke_mandate(ctx: Context<OwnerAction>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.mandate.status != STATUS_REVOKED,
            VetoError::MandateNotActive
        );

        let mandate = &mut ctx.accounts.mandate;
        mandate.status = STATUS_REVOKED;
        mandate.override_amount = 0;
        mandate.override_nonce = 0;

        ctx.accounts.ledger.load_mut()?.record(Entry {
            ts: now,
            amount: 0,
            counterparty: mandate.merchant,
            nonce: 0,
            suggested_override: 0,
            kind: KIND_REVOKED,
            reason: REASON_OK,
            _pad: [0; 6],
        });

        // Also drop the SPL delegation, so nothing can be pulled even if this
        // program were replaced.
        token_interface::revoke(CpiContext::new(
            ctx.accounts.token_program.key(),
            token_interface::Revoke {
                source: ctx.accounts.source.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ))?;

        msg!(
            "VETO REVOKED spent={} of cap={}",
            mandate.spent,
            mandate.cap
        );
        Ok(())
    }

    /// Reclaim rent once a mandate is finished. Only the owner, never while active.
    pub fn close_mandate(ctx: Context<CloseMandate>) -> Result<()> {
        require!(
            ctx.accounts.mandate.status != STATUS_ACTIVE,
            VetoError::MandateStillActive
        );
        msg!("VETO CLOSED");
        Ok(())
    }

    /// Open a Hold vault. The vault PDA is the authority of its token account.
    pub fn init_vault(ctx: Context<InitVault>, args: hold::InitVaultArgs) -> Result<()> {
        hold::init_vault(ctx, args)
    }

    /// Move tokens into the vault token account.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        hold::deposit(ctx, amount)
    }

    /// Pay `amount` now when the rules allow it. Otherwise record a hold.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        hold::withdraw(ctx, amount)
    }

    /// Pay a held withdrawal once the chain clock reaches its unlock time.
    pub fn execute(ctx: Context<Execute>, id: u64) -> Result<()> {
        hold::execute(ctx, id)
    }

    /// Cancel one held withdrawal. Owner or guardian, with no wait.
    pub fn stop(ctx: Context<Stop>, id: u64) -> Result<()> {
        hold::stop(ctx, id)
    }

    /// Block every outflow except `recover`. Owner or guardian.
    pub fn freeze(ctx: Context<Freeze>) -> Result<()> {
        hold::freeze(ctx)
    }

    /// Clear a freeze. Both keys, or the owner alone after the delay when no guardian is set.
    pub fn unfreeze(ctx: Context<Unfreeze>) -> Result<()> {
        hold::unfreeze(ctx)
    }

    /// Pay a held withdrawal before its unlock time. Both keys, and not while frozen.
    pub fn skip(ctx: Context<Skip>, id: u64) -> Result<()> {
        hold::skip(ctx, id)
    }

    /// Upgrade the previous Hold layout without relaxing any stored rule.
    pub fn migrate_hold_vault(ctx: Context<MigrateHoldVault>) -> Result<()> {
        hold::migrate_hold_vault(ctx)
    }

    /// Close an idle, unfrozen vault to its stored safe address.
    pub fn close_hold_vault(ctx: Context<CloseHoldVault>) -> Result<()> {
        hold::close_hold_vault(ctx)
    }

    /// Send the whole vault balance to the safe address. Works while frozen.
    pub fn recover(ctx: Context<Recover>) -> Result<()> {
        hold::recover(ctx)
    }

    /// Tighten a rule now. A looser rule waits out the current delay.
    pub fn propose_change(ctx: Context<ProposeChange>, values: HoldChange) -> Result<()> {
        hold::propose_change(ctx, values)
    }

    /// Apply a loosening change once the chain clock reaches `effective_at`.
    pub fn apply_change(ctx: Context<ApplyChange>) -> Result<()> {
        hold::apply_change(ctx)
    }

    /// Drop a loosening change. Owner or guardian.
    pub fn cancel_change(ctx: Context<CancelChange>) -> Result<()> {
        hold::cancel_change(ctx)
    }

    /// Open a trade rule and delegate `cap` of the input token account to it.
    pub fn open_trade_rule(ctx: Context<OpenTradeRule>, args: OpenTradeRuleArgs) -> Result<()> {
        trade::open_trade_rule(ctx, args)
    }

    /// Sell `amount_in` of the pinned input through the pinned pool.
    ///
    /// Returns Ok whether the trade is filled or refused.
    pub fn trade(ctx: Context<Trade>, amount_in: u64, min_out: u64, nonce: u64) -> Result<()> {
        super::trade::trade(ctx, amount_in, min_out, nonce)
    }

    /// Raise the per-trade ceiling for one nonce. The daily limit and the cap stay put.
    pub fn grant_trade_override(
        ctx: Context<GrantTradeOverride>,
        amount_in: u64,
        nonce: u64,
    ) -> Result<()> {
        trade::grant_trade_override(ctx, amount_in, nonce)
    }

    /// Withdraw the agent's authority. Allowed from any status except revoked.
    pub fn revoke_trade_rule(ctx: Context<RevokeTradeRule>) -> Result<()> {
        trade::revoke_trade_rule(ctx)
    }

    /// Reclaim rent once a trade rule is finished or past expiry, and revoke
    /// any delegation the source still gives the rule.
    pub fn close_trade_rule(ctx: Context<CloseTradeRule>) -> Result<()> {
        trade::close_trade_rule(ctx)
    }
}

/// Pure policy evaluation. No writes, no CPI, so it reads as a single list of
/// the rules the owner agreed to. Order matters only for which reason is
/// reported when a charge breaks more than one rule.
fn evaluate(
    mandate: &Mandate,
    mandate_key: Pubkey,
    source: &InterfaceAccount<TokenAccount>,
    destination: &InterfaceAccount<TokenAccount>,
    amount: u64,
    nonce: u64,
    now: i64,
) -> u8 {
    if mandate.status != STATUS_ACTIVE {
        return REASON_NOT_ACTIVE;
    }
    if now >= mandate.expires_at {
        return REASON_EXPIRED;
    }
    if amount == 0 {
        return REASON_ZERO_AMOUNT;
    }
    // Only a paid charge advances the nonce, so a refused charge can be
    // retried after an override without minting a new one.
    if nonce <= mandate.last_nonce {
        return REASON_STALE_NONCE;
    }
    if destination.owner != mandate.merchant {
        return REASON_MERCHANT_NOT_ALLOWED;
    }
    if amount > mandate.effective_per_tx_max(nonce) {
        return REASON_OVER_PER_TX_MAX;
    }
    match mandate.spent.checked_add(amount) {
        Some(total) if total <= mandate.cap => {}
        _ => return REASON_OVER_CAP,
    }
    // The owner can revoke the SPL delegation directly, without this program.
    // Notice that rather than failing the transfer.
    if source.delegate != COption::Some(mandate_key) {
        return REASON_DELEGATE_MISSING;
    }
    if source.delegated_amount < amount || source.amount < amount {
        return REASON_INSUFFICIENT_FUNDS;
    }
    // A frozen account would fail inside transfer_checked and roll the
    // ledger write back with it. Record it as a refusal instead.
    if source.is_frozen() || destination.is_frozen() {
        return REASON_ACCOUNT_FROZEN;
    }
    REASON_OK
}

/// The one-shot override that would clear this exact charge, or zero when none
/// would. An override raises the per-payment ceiling only, so a charge blocked
/// by the total cap cannot be cleared by one and honestly says so.
fn suggested_override(mandate: &Mandate, reason: u8, amount: u64) -> u64 {
    if reason == REASON_OVER_PER_TX_MAX && amount <= mandate.remaining() {
        amount
    } else {
        0
    }
}

fn reason_text(reason: u8) -> &'static str {
    match reason {
        REASON_OK => "ok",
        REASON_NOT_ACTIVE => "mandate not active",
        REASON_EXPIRED => "past expiry",
        REASON_STALE_NONCE => "nonce already settled",
        REASON_MERCHANT_NOT_ALLOWED => "merchant not allowed",
        REASON_OVER_PER_TX_MAX => "over per-payment maximum",
        REASON_OVER_CAP => "over remaining cap",
        REASON_DELEGATE_MISSING => "delegation withdrawn",
        REASON_INSUFFICIENT_FUNDS => "insufficient funds",
        REASON_ZERO_AMOUNT => "zero amount",
        REASON_ACCOUNT_FROZEN => "account frozen",
        _ => "unknown",
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenMandateArgs {
    pub mandate_id: u64,
    pub agent: Pubkey,
    pub merchant: Pubkey,
    pub cap: u64,
    pub per_tx_max: u64,
    pub expires_at: i64,
    pub purpose: String,
}

#[derive(Accounts)]
#[instruction(args: OpenMandateArgs)]
pub struct OpenMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [b"mandate", owner.key().as_ref(), &args.mandate_id.to_le_bytes()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        init,
        payer = owner,
        space = 8 + std::mem::size_of::<Ledger>(),
        seeds = [b"ledger", mandate.key().as_ref()],
        bump
    )]
    pub ledger: AccountLoader<'info, Ledger>,

    #[account(
        mut,
        constraint = source.owner == owner.key() @ VetoError::SourceNotOwnedByOwner,
        constraint = source.mint == mint.key() @ VetoError::MintMismatch,
    )]
    pub source: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Charge<'info> {
    /// The agent holds authority and nothing else. It is not the owner, it
    /// pays only the transaction fee, and it cannot change any limit.
    pub agent: Signer<'info>,

    #[account(
        mut,
        has_one = agent @ VetoError::NotTheAgent,
        has_one = mint @ VetoError::MintMismatch,
        has_one = source @ VetoError::SourceMismatch,
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        seeds = [b"ledger", mandate.key().as_ref()],
        bump,
    )]
    pub ledger: AccountLoader<'info, Ledger>,

    #[account(mut)]
    pub source: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = destination.mint == mandate.mint @ VetoError::MintMismatch,
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct OwnerAction<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheOwner,
        has_one = source @ VetoError::SourceMismatch,
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        seeds = [b"ledger", mandate.key().as_ref()],
        bump,
    )]
    pub ledger: AccountLoader<'info, Ledger>,

    #[account(mut)]
    pub source: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        has_one = owner @ VetoError::NotTheOwner,
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        close = owner,
        seeds = [b"ledger", mandate.key().as_ref()],
        bump,
    )]
    pub ledger: AccountLoader<'info, Ledger>,
}

#[event]
pub struct Paid {
    pub mandate: Pubkey,
    pub amount: u64,
    pub nonce: u64,
    pub spent: u64,
}

#[event]
pub struct Refused {
    pub mandate: Pubkey,
    pub amount: u64,
    pub nonce: u64,
    pub reason: u8,
    pub suggested_override: u64,
}

#[error_code]
pub enum VetoError {
    #[msg("cap must be greater than zero")]
    CapMustBePositive,
    #[msg("per-payment maximum must be greater than zero")]
    PerTxMaxMustBePositive,
    #[msg("per-payment maximum cannot exceed the cap")]
    PerTxMaxAboveCap,
    #[msg("expiry must be in the future")]
    ExpiryInThePast,
    #[msg("purpose is longer than the on-chain limit")]
    PurposeTooLong,
    #[msg("a mandate must name the merchant it may pay")]
    MerchantRequired,
    #[msg("the agent key must not be the owner key")]
    AgentMustNotBeOwner,
    #[msg("source token account is not owned by the mandate owner")]
    SourceNotOwnedByOwner,
    #[msg("token mint does not match the mandate")]
    MintMismatch,
    #[msg("source token account does not match the mandate")]
    SourceMismatch,
    #[msg("ledger does not belong to this mandate")]
    LedgerMismatch,
    #[msg("signer is not the agent named in the mandate")]
    NotTheAgent,
    #[msg("signer is not the owner of this mandate")]
    NotTheOwner,
    #[msg("mandate address does not match its stored fields")]
    InvalidMandatePda,
    #[msg("mandate is not active")]
    MandateNotActive,
    #[msg("mandate is still active")]
    MandateStillActive,
    #[msg("an override needs a non-zero nonce")]
    NonceRequired,
    #[msg("amount must be greater than zero")]
    AmountMustBePositive,
    #[msg("an override cannot raise the total cap")]
    OverrideAboveCap,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("override nonce is at or below the last paid nonce")]
    NonceAlreadySettled,
    #[msg("delay must be 1, 2, or 3 days")]
    DelayNotAllowed,
    #[msg("share must be between 0 and 10000 basis points")]
    ShareOutOfRange,
    #[msg("safe address is required")]
    SafeAddressRequired,
    #[msg("the guardian must be a different key from the owner")]
    GuardianIsOwner,
    #[msg("amount must be greater than zero")]
    PositiveAmountRequired,
    #[msg("arithmetic overflow")]
    HoldMathOverflow,
    #[msg("signer is not the owner of this vault")]
    NotTheVaultOwner,
    #[msg("signer is not the owner or the guardian")]
    NotOwnerOrGuardian,
    #[msg("signer is not the guardian")]
    NotTheGuardian,
    #[msg("both the owner and the guardian must sign")]
    BothKeysRequired,
    #[msg("vault address does not match its stored fields")]
    InvalidVaultPda,
    #[msg("vault token account does not match the vault")]
    VaultTokenMismatch,
    #[msg("token mint does not match the vault")]
    HoldMintMismatch,
    #[msg("source token account is not owned by the vault owner")]
    HoldSourceNotOwned,
    #[msg("destination is the vault token account")]
    DestinationIsVault,
    #[msg("destination does not match the pending withdrawal")]
    DestinationMismatch,
    #[msg("destination is not the safe address")]
    NotTheSafeAddress,
    #[msg("withdrawal is not pending")]
    WithdrawalNotPending,
    #[msg("the chain clock has not reached the unlock time")]
    TooEarly,
    #[msg("the vault is frozen")]
    VaultFrozen,
    #[msg("the vault is not frozen")]
    NotFrozen,
    #[msg("unfreeze is still waiting on the chain clock")]
    UnfreezeNotReady,
    #[msg("a loosening change is already pending")]
    ChangeAlreadyPending,
    #[msg("there is no pending change")]
    NoPendingChange,
    #[msg("the chain clock has not reached the change")]
    ChangeNotReady,
    #[msg("the proposed values match the current rules")]
    ChangeUnchanged,
    #[msg("the vault token account is empty")]
    NothingToRecover,
    #[msg("the vault cannot cover this withdrawal")]
    HoldInsufficientFunds,
    #[msg("token account authority is not the vault")]
    BadVaultAuthority,
    #[msg("trade rule address does not match its stored fields")]
    InvalidTradeRulePda,
    #[msg("the swap moved a different amount than the rule allowed")]
    TradeDeltaMismatch,
    #[msg("pool accounts do not match the trade rule")]
    PoolAccountMismatch,
    #[msg("per-trade maximum, daily limit, and cap are out of order")]
    TradeLimitsOutOfOrder,
    #[msg("floor denominator must be greater than zero")]
    FloorDenominatorRequired,
    #[msg("this exchange is not supported")]
    ExchangeNotSupported,
    #[msg("destination token account is not owned by the rule owner")]
    DestinationNotOwnedByOwner,
    #[msg("an extra account was passed to trade")]
    UnexpectedTradeAccount,
    #[msg("trade rule is not active")]
    TradeRuleNotActive,
    #[msg("trade rule is still active")]
    TradeRuleStillActive,
    #[msg("floor numerator must be greater than zero")]
    FloorRequired,
    #[msg("daily limit must be greater than zero")]
    DailyLimitRequired,
    #[msg("source token account is already delegated to another account")]
    SourceAlreadyDelegated,
    #[msg("account is not an initialized SPL token account")]
    NotATokenAccount,
    #[msg("vault is not the supported legacy Hold layout")]
    InvalidLegacyHoldLayout,
    #[msg("a held withdrawal must be resolved before closing")]
    HoldWithdrawalPending,
    #[msg("safe address must differ from the guardian")]
    SafeAddressIsGuardian,
    #[msg("safe address must differ from the owner")]
    SafeAddressIsOwner,
}

#[derive(Accounts)]
#[instruction(args: InitVaultArgs)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + HoldVault::INIT_SPACE,
        seeds = [b"hold", owner.key().as_ref(), &args.vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        init,
        payer = owner,
        space = 8 + std::mem::size_of::<HoldLedger>(),
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,

    #[account(
        init,
        payer = owner,
        seeds = [b"hold-token", vault.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheVaultOwner,
        has_one = mint @ VetoError::HoldMintMismatch,
        has_one = vault_token @ VetoError::VaultTokenMismatch,
        seeds = [b"hold", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,

    #[account(
        mut,
        constraint = source.mint == vault.mint @ VetoError::HoldMintMismatch,
        constraint = source.owner == owner.key() @ VetoError::HoldSourceNotOwned
    )]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"hold-token", vault.key().as_ref()],
        bump = vault.token_bump
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheVaultOwner,
        has_one = mint @ VetoError::HoldMintMismatch,
        has_one = vault_token @ VetoError::VaultTokenMismatch,
        seeds = [b"hold", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,

    #[account(
        mut,
        seeds = [b"hold-token", vault.key().as_ref()],
        bump = vault.token_bump,
        constraint = vault_token.owner == vault.key() @ VetoError::BadVaultAuthority
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = destination.mint == vault.mint @ VetoError::HoldMintMismatch,
        constraint = destination.owner != vault.key() @ VetoError::DestinationIsVault,
        constraint = destination.key() != vault_token.key() @ VetoError::DestinationIsVault
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        mut,
        has_one = mint @ VetoError::HoldMintMismatch,
        has_one = vault_token @ VetoError::VaultTokenMismatch,
        seeds = [b"hold", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,

    #[account(
        mut,
        seeds = [b"hold-token", vault.key().as_ref()],
        bump = vault.token_bump,
        constraint = vault_token.owner == vault.key() @ VetoError::BadVaultAuthority
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = destination.mint == vault.mint @ VetoError::HoldMintMismatch,
        constraint = destination.owner != vault.key() @ VetoError::DestinationIsVault
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Stop<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = authority.key() == vault.owner || authority.key() == vault.guardian @ VetoError::NotOwnerOrGuardian,
        seeds = [b"hold", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,
}

#[derive(Accounts)]
pub struct Freeze<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = authority.key() == vault.owner || authority.key() == vault.guardian @ VetoError::NotOwnerOrGuardian,
        seeds = [b"hold", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,
}

#[derive(Accounts)]
pub struct Unfreeze<'info> {
    pub owner: Signer<'info>,
    pub guardian: Option<Signer<'info>>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheVaultOwner,
        seeds = [b"hold", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,
}

#[derive(Accounts)]
pub struct Skip<'info> {
    pub owner: Signer<'info>,
    pub guardian: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheVaultOwner,
        has_one = mint @ VetoError::HoldMintMismatch,
        has_one = vault_token @ VetoError::VaultTokenMismatch,
        seeds = [b"hold", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,

    #[account(
        mut,
        seeds = [b"hold-token", vault.key().as_ref()],
        bump = vault.token_bump,
        constraint = vault_token.owner == vault.key() @ VetoError::BadVaultAuthority
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = destination.mint == vault.mint @ VetoError::HoldMintMismatch,
        constraint = destination.owner != vault.key() @ VetoError::DestinationIsVault
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct MigrateHoldVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Exact legacy length, discriminator, stored owner and PDA checked in handler.
    #[account(mut, owner = crate::ID)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"hold-ledger", vault.key().as_ref()], bump,
        constraint = ledger.load()?.vault == vault.key() @ VetoError::InvalidVaultPda)]
    pub ledger: AccountLoader<'info, HoldLedger>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseHoldVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = mint @ VetoError::HoldMintMismatch,
        has_one = vault_token @ VetoError::VaultTokenMismatch,
        has_one = owner @ VetoError::NotTheVaultOwner,
        close = owner,
        seeds = [b"hold", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump,
        close = owner
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,

    #[account(
        mut,
        seeds = [b"hold-token", vault.key().as_ref()],
        bump = vault.token_bump,
        constraint = vault_token.owner == vault.key() @ VetoError::BadVaultAuthority
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = destination.mint == vault.mint @ VetoError::HoldMintMismatch,
        constraint = destination.owner == vault.safe_address @ VetoError::NotTheSafeAddress,
        constraint = destination.owner != vault.key() @ VetoError::DestinationIsVault
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Recover<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = mint @ VetoError::HoldMintMismatch,
        has_one = vault_token @ VetoError::VaultTokenMismatch,
        constraint = authority.key() == vault.owner || authority.key() == vault.guardian @ VetoError::NotOwnerOrGuardian,
        seeds = [b"hold", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,

    #[account(
        mut,
        seeds = [b"hold-token", vault.key().as_ref()],
        bump = vault.token_bump,
        constraint = vault_token.owner == vault.key() @ VetoError::BadVaultAuthority
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = destination.mint == vault.mint @ VetoError::HoldMintMismatch,
        constraint = destination.owner == vault.safe_address @ VetoError::NotTheSafeAddress,
        constraint = destination.owner != vault.key() @ VetoError::DestinationIsVault
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ProposeChange<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheVaultOwner,
        seeds = [b"hold", owner.key().as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,
}

#[derive(Accounts)]
pub struct ApplyChange<'info> {
    #[account(
        mut,
        seeds = [b"hold", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,
}

#[derive(Accounts)]
pub struct CancelChange<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = authority.key() == vault.owner || authority.key() == vault.guardian @ VetoError::NotOwnerOrGuardian,
        seeds = [b"hold", vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, HoldVault>>,

    #[account(
        mut,
        seeds = [b"hold-ledger", vault.key().as_ref()],
        bump = vault.ledger_bump
    )]
    pub ledger: AccountLoader<'info, HoldLedger>,
}

#[derive(Accounts)]
#[instruction(args: OpenTradeRuleArgs)]
pub struct OpenTradeRule<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + TradeRule::INIT_SPACE,
        seeds = [b"trade", owner.key().as_ref(), &args.rule_id.to_le_bytes()],
        bump
    )]
    pub rule: Box<Account<'info, TradeRule>>,

    #[account(
        init,
        payer = owner,
        space = 8 + std::mem::size_of::<TradeLedger>(),
        seeds = [b"trade-ledger", rule.key().as_ref()],
        bump
    )]
    pub ledger: AccountLoader<'info, TradeLedger>,

    #[account(mut)]
    pub source: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    pub destination: Box<Account<'info, anchor_spl::token::TokenAccount>>,
    pub in_mint: Box<Account<'info, anchor_spl::token::Mint>>,
    pub out_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    /// CHECK: Kind 0 requires this account to be the SPL token-swap program.
    pub exchange_program: UncheckedAccount<'info>,

    /// CHECK: Pool state account. Its owner must be `exchange_program`.
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Must own both pool vaults.
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Input vault. Token account of `in_mint`, owned by `pool_authority`.
    pub pool_in_vault: UncheckedAccount<'info>,

    /// CHECK: Output vault. Token account of `out_mint`, owned by `pool_authority`.
    pub pool_out_vault: UncheckedAccount<'info>,

    /// CHECK: Pool LP mint. The fee account must be a token account of this mint.
    pub pool_mint: UncheckedAccount<'info>,

    /// CHECK: Fee token account of `pool_mint`. The key is stored and compared later.
    pub pool_fee_account: UncheckedAccount<'info>,

    #[account(address = anchor_spl::token::ID)]
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    pub agent: Signer<'info>,

    #[account(
        mut,
        has_one = agent @ VetoError::NotTheAgent,
        has_one = source @ VetoError::SourceMismatch,
    )]
    pub rule: Box<Account<'info, TradeRule>>,

    #[account(
        mut,
        seeds = [b"trade-ledger", rule.key().as_ref()],
        bump
    )]
    pub ledger: AccountLoader<'info, TradeLedger>,

    #[account(mut)]
    pub source: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    /// CHECK: Pinned output account. A different key is refusal 11.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// CHECK: Compared with the stored program. A different key is refusal 12.
    pub exchange_program: UncheckedAccount<'info>,

    /// CHECK: Compared with the stored pool. A different key is refusal 12.
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Compared with the stored authority. A different key is refusal 12.
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Compared with the stored input vault. A different key is refusal 12.
    #[account(mut)]
    pub pool_in_vault: UncheckedAccount<'info>,

    /// CHECK: Compared with the stored output vault. A different key is refusal 12.
    #[account(mut)]
    pub pool_out_vault: UncheckedAccount<'info>,

    /// CHECK: Compared with the stored pool mint. A different key is refusal 12.
    #[account(mut)]
    pub pool_mint: UncheckedAccount<'info>,

    /// CHECK: Compared with the stored fee account. A different key is refusal 12.
    #[account(mut)]
    pub pool_fee_account: UncheckedAccount<'info>,

    #[account(address = anchor_spl::token::ID)]
    pub token_program: Program<'info, anchor_spl::token::Token>,
}

#[derive(Accounts)]
pub struct GrantTradeOverride<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheOwner,
    )]
    pub rule: Box<Account<'info, TradeRule>>,

    #[account(
        mut,
        seeds = [b"trade-ledger", rule.key().as_ref()],
        bump
    )]
    pub ledger: AccountLoader<'info, TradeLedger>,
}

#[derive(Accounts)]
pub struct RevokeTradeRule<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VetoError::NotTheOwner,
        has_one = source @ VetoError::SourceMismatch,
    )]
    pub rule: Box<Account<'info, TradeRule>>,

    #[account(
        mut,
        seeds = [b"trade-ledger", rule.key().as_ref()],
        bump
    )]
    pub ledger: AccountLoader<'info, TradeLedger>,

    #[account(mut)]
    pub source: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    #[account(address = anchor_spl::token::ID)]
    pub token_program: Program<'info, anchor_spl::token::Token>,
}

#[derive(Accounts)]
pub struct CloseTradeRule<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        has_one = owner @ VetoError::NotTheOwner,
    )]
    pub rule: Box<Account<'info, TradeRule>>,

    #[account(
        mut,
        close = owner,
        seeds = [b"trade-ledger", rule.key().as_ref()],
        bump
    )]
    pub ledger: AccountLoader<'info, TradeLedger>,

    /// CHECK: The rule's pinned source. It may already be closed. When it is
    /// still a token account delegated to this rule, close revokes that.
    #[account(mut, address = rule.source @ VetoError::SourceMismatch)]
    pub source: UncheckedAccount<'info>,

    #[account(address = anchor_spl::token::ID)]
    pub token_program: Program<'info, anchor_spl::token::Token>,
}
