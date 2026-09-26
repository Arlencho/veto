import { PublicKey } from '@solana/web3.js';

export const SAFE_WALLET_GUIDANCE = 'The safe address must be a wallet the guardian does not control, for example a cold wallet or an exchange deposit address you own.';
export const OWNER_SAFE_WARNING = 'If you choose your owner wallet, a stolen owner key would also reach the safe address and could spend money recovered there. This choice requires explicit risk confirmation.';
export const GUARDIAN_RECOVERY_COPY = 'The guardian can stop a waiting withdrawal, freeze the vault, or immediately recover the entire balance to the configured safe address. Acting alone, it cannot choose another destination. Anyone controlling the safe wallet can spend money recovered there.';

export function validateHoldAddresses(ownerText: string, guardianText: string, safeText: string, ownerSafeConfirmed = false) {
  if (!safeText.trim()) throw new Error('Enter a safe address explicitly before continuing.');
  let owner: PublicKey;
  let guardian: PublicKey;
  let safeAddress: PublicKey;
  try {
    owner = new PublicKey(ownerText.trim());
    guardian = new PublicKey(guardianText.trim());
    safeAddress = new PublicKey(safeText.trim());
  } catch {
    throw new Error('Enter valid Solana addresses for the guardian and safe wallet.');
  }
  if (guardian.equals(PublicKey.default) || safeAddress.equals(PublicKey.default)) {
    throw new Error('Choose a nonzero guardian key and safe address.');
  }
  if (safeAddress.equals(guardian)) throw new Error(SAFE_WALLET_GUIDANCE);
  if (guardian.equals(owner)) throw new Error('The guardian key has to be a different key from yours.');
  if (safeAddress.equals(owner) && !ownerSafeConfirmed) throw new Error(OWNER_SAFE_WARNING);
  return { guardian, safeAddress };
}
