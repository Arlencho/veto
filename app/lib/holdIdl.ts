import { Buffer } from 'buffer';

// Eight-byte markers for the Hold instructions and accounts.
// The parity test checks them against the vault client.
export const INIT_VAULT_DISC = Buffer.from([77, 79, 85, 150, 33, 217, 52, 106]);
export const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
export const WITHDRAW_DISC = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);
export const STOP_DISC = Buffer.from([42, 133, 32, 60, 171, 253, 184, 155]);
export const FREEZE_DISC = Buffer.from([255, 91, 207, 84, 251, 194, 254, 63]);
export const UNFREEZE_DISC = Buffer.from([133, 160, 68, 253, 80, 232, 218, 247]);
export const SKIP_DISC = Buffer.from([154, 63, 181, 53, 19, 26, 117, 45]);
export const RECOVER_DISC = Buffer.from([108, 216, 38, 58, 109, 146, 116, 17]);
export const HOLD_VAULT_DISC = Buffer.from([225, 219, 122, 198, 245, 163, 91, 55]);
export const HOLD_LEDGER_DISC = Buffer.from([195, 103, 143, 50, 70, 255, 84, 161]);

export const MIGRATE_HOLD_VAULT_DISC = Buffer.from([223, 75, 49, 252, 155, 82, 164, 36]);

export const CLOSE_HOLD_VAULT_DISC = Buffer.from([44, 82, 147, 65, 191, 42, 43, 216]);
