//! Account layout for a Hold vault.
//!
//! This is a separate account from `Mandate` and `Ledger`. Those layouts are
//! not used here and are not modified.

use anchor_lang::prelude::*;

/// Remembered destination token accounts. A full list does not grow and does
/// not evict: a new address can still be paid after the wait, and it stays
/// unknown, so the next withdrawal to it waits again.
pub const HOLD_KNOWN_CAPACITY: usize = 16;

/// Concurrent held withdrawals. A full list refuses the next hold with a
/// recorded reason. It does not pay it, and it does not write past the array.
pub const HOLD_PENDING_CAPACITY: usize = 8;

/// Decisions kept on the hold ledger. Older ones fall out of the ring.
pub const HOLD_LEDGER_CAPACITY: usize = 32;

/// Exact pre-330 Borsh size including the discriminator. Never infer this from a future layout.
pub const LEGACY_HOLD_VAULT_LEN: usize = 1291;

pub const HOLD_WINDOW_SECS: i64 = 24 * 60 * 60;
pub const HOLD_DELAY_1_DAY: i64 = HOLD_WINDOW_SECS;
pub const HOLD_DELAY_2_DAYS: i64 = 2 * HOLD_WINDOW_SECS;
pub const HOLD_DELAY_3_DAYS: i64 = 3 * HOLD_WINDOW_SECS;

pub const HOLD_BPS_DENOMINATOR: u64 = 10_000;
/// 25 percent of the vault. Init takes an explicit value. This is the one
/// the product uses when the owner does not pick another.
pub const HOLD_DEFAULT_BIG_SHARE_BPS: u16 = 2_500;

pub const WITHDRAWAL_EMPTY: u8 = 0;
pub const WITHDRAWAL_PENDING: u8 = 1;

// Record kinds. `PAID` covers an instant withdrawal and `execute`.
// `withdrawal_id` is zero on an instant payment and on actions that are not
// a withdrawal.
pub const HOLD_KIND_OPENED: u8 = 0;
pub const HOLD_KIND_DEPOSITED: u8 = 1;
pub const HOLD_KIND_PAID: u8 = 2;
pub const HOLD_KIND_HELD: u8 = 3;
pub const HOLD_KIND_STOPPED: u8 = 4;
pub const HOLD_KIND_FROZEN: u8 = 5;
pub const HOLD_KIND_UNFROZEN: u8 = 6;
pub const HOLD_KIND_SKIPPED: u8 = 7;
pub const HOLD_KIND_RECOVERED: u8 = 8;
pub const HOLD_KIND_CHANGE_PROPOSED: u8 = 9;
pub const HOLD_KIND_CHANGE_APPLIED: u8 = 10;
pub const HOLD_KIND_CHANGE_CANCELLED: u8 = 11;
pub const HOLD_KIND_REFUSED: u8 = 12;
/// Armed by `unfreeze` when no guardian is set. The vault stays frozen.
pub const HOLD_KIND_UNFREEZE_SCHEDULED: u8 = 13;
/// Rent top-up in lamports, destination is the migrated vault.
pub const HOLD_KIND_MIGRATED: u8 = 14;

/// `reason` on a `HOLD_KIND_REFUSED` entry.
pub const HOLD_REASON_NONE: u8 = 0;
pub const HOLD_REASON_INSUFFICIENT_FUNDS: u8 = 1;
pub const HOLD_REASON_PENDING_FULL: u8 = 2;

/// Bits on a rule-change record (`reason`) and on `PendingChange::fields`.
pub const CHANGE_DAILY: u8 = 1;
pub const CHANGE_DELAY: u8 = 2;
pub const CHANGE_SHARE: u8 = 4;
pub const CHANGE_GUARDIAN: u8 = 8;
pub const CHANGE_SAFE: u8 = 16;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct PendingWithdrawal {
    pub id: u64,
    pub amount: u64,
    pub destination: Pubkey,
    pub unlock_at: i64,
    pub status: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct PendingChange {
    pub active: bool,
    /// Which fields wait. See `CHANGE_*`.
    pub fields: u8,
    pub big_share_bps: u16,
    pub daily_limit: u64,
    pub delay_secs: i64,
    pub guardian: Pubkey,
    pub safe_address: Pubkey,
    pub effective_at: i64,
}

/// The desired rules, passed whole to `propose_change`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct HoldChange {
    pub daily_limit: u64,
    pub delay_secs: i64,
    pub big_share_bps: u16,
    pub guardian: Pubkey,
    pub safe_address: Pubkey,
}

/// Funds live in the vault token account. Its authority is this PDA, so a
/// raw transfer signed by the owner or the guardian cannot move them.
#[account]
#[derive(InitSpace)]
pub struct HoldVault {
    pub owner: Pubkey,
    /// `Pubkey::default()` means no guardian is set.
    pub guardian: Pubkey,
    /// Wallet that must own the token account `recover` pays.
    pub safe_address: Pubkey,
    pub mint: Pubkey,
    pub vault_token: Pubkey,
    pub vault_id: u64,
    pub daily_limit: u64,
    /// Unused legacy fixed-window fields, retained to preserve account layout.
    pub window_spent: u64,
    pub window_start: i64,
    pub delay_secs: i64,
    /// When no guardian is set, `unfreeze` arms this timestamp and finishes
    /// only once the chain clock reaches it. Zero means no unfreeze is waiting.
    pub unfreeze_at: i64,
    pub next_withdrawal_id: u64,
    pub big_share_bps: u16,
    pub frozen: bool,
    pub known_len: u8,
    pub bump: u8,
    pub token_bump: u8,
    pub ledger_bump: u8,
    pub known: [Pubkey; HOLD_KNOWN_CAPACITY],
    pub pending: [PendingWithdrawal; HOLD_PENDING_CAPACITY],
    pub change: PendingChange,
    /// Rolling daily and share accounting, retaining the current and preceding 24 hours.
    /// Appended so all existing field offsets remain stable.
    pub daily_buckets: [crate::rolling_window::TradeBucket; crate::rolling_window::BUCKET_COUNT],
}

#[zero_copy]
pub struct HoldEntry {
    pub ts: i64,
    pub amount: u64,
    pub destination: Pubkey,
    pub withdrawal_id: u64,
    pub kind: u8,
    pub reason: u8,
    pub _pad: [u8; 6],
}

#[account(zero_copy)]
pub struct HoldLedger {
    pub vault: Pubkey,
    pub total: u32,
    pub head: u16,
    pub bump: u8,
    pub _pad: [u8; 1],
    pub entries: [HoldEntry; HOLD_LEDGER_CAPACITY],
}

impl HoldLedger {
    pub fn record(&mut self, entry: HoldEntry) {
        let slot = self.head as usize % HOLD_LEDGER_CAPACITY;
        self.entries[slot] = entry;
        self.head = ((slot + 1) % HOLD_LEDGER_CAPACITY) as u16;
        self.total = self.total.saturating_add(1);
    }
}

pub fn delay_allowed(delay_secs: i64) -> bool {
    delay_secs == HOLD_DELAY_1_DAY
        || delay_secs == HOLD_DELAY_2_DAYS
        || delay_secs == HOLD_DELAY_3_DAYS
}
