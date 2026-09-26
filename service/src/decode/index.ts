import { PublicKey } from '@solana/web3.js';
import idl from '../../../indexer/idl/veto.json' with { type: 'json' };
import { decodeIxData, decisionsFromTx } from '../../../indexer/src/events.js';
import type { Decision, CompiledIx } from '../../../indexer/src/types.js';

export const PROGRAM_ID = '3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV';

/** The JSON encoding returned by getTransaction, including version 0 loaded keys. */
export type RpcInstruction = { programIdIndex: number; accounts: number[]; data: string };
export type RpcTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: RpcInstruction[] } };
  meta: null | {
    err: unknown;
    logMessages: string[] | null;
    innerInstructions?: { index: number; instructions: RpcInstruction[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  };
};
export type Location = { signature: string; slot: number; timestamp: number | null; instructionIndex: number; innerInstructionIndex: number | null };
type OwnerRecord = Location & { owner: string; mandate: string; ledger: string };
export type OpenMandate = OwnerRecord & {
  kind: 'open_mandate'; source: string; mint: string; token_program: string; system_program: string;
  mandate_id: bigint; agent: string; merchant: string; cap: bigint; per_tx_max: bigint; expires_at: bigint; purpose: string;
};
export type GrantOverride = OwnerRecord & { kind: 'grant_override'; source: string; token_program: string; amount: bigint; nonce: bigint };
export type RevokeMandate = OwnerRecord & { kind: 'revoke_mandate'; source: string; token_program: string };
export type CloseMandate = OwnerRecord & { kind: 'close_mandate' };
export type ChargeDecision = Decision & Location & { kind: 'paid' | 'refused' | 'traded' };
export type HoldLifecycle = Decision & Location & { kind: 'hold_migrated' | 'hold_closed'; owner: string; vault: string; destination: string };
export type DecodedRecord = OpenMandate | GrantOverride | RevokeMandate | CloseMandate | ChargeDecision | HoldLifecycle;
type LocatedInstruction = CompiledIx & Pick<Location, 'instructionIndex' | 'innerInstructionIndex'>;
const names = ['open_mandate', 'grant_override', 'revoke_mandate', 'close_mandate', 'charge', 'migrate_hold_vault', 'close_hold_vault'];
const layouts = idl.instructions.filter(ix => names.includes(ix.name));

/** Flatten in execution order, resolving static, loaded writable, then loaded readonly keys. */
export function transactionInstructions(tx: RpcTransaction): LocatedInstruction[] {
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const key = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) throw new Error('Invalid transaction account index');
    return keys[index];
  };
  const out: LocatedInstruction[] = [];
  const append = (ix: RpcInstruction, instructionIndex: number, innerInstructionIndex: number | null) => {
    out.push({ programId: key(ix.programIdIndex), accounts: ix.accounts.map(key), data: decodeIxData(ix.data), instructionIndex, innerInstructionIndex });
  };
  tx.transaction.message.instructions.forEach((ix, index) => {
    append(ix, index, null);
    for (const group of tx.meta?.innerInstructions ?? []) {
      if (group.index === index) group.instructions.forEach((inner, innerIndex) => append(inner, index, innerIndex));
    }
  });
  return out;
}

/** Decode committed changes only. Incomplete charge logs fail explicitly instead of losing history. */
export function decodeTransaction(tx: RpcTransaction, programId = PROGRAM_ID): DecodedRecord[] {
  if (!tx.meta || tx.meta.err != null) return [];
  const signature = tx.transaction.signatures[0];
  if (!signature) throw new Error('Missing transaction signature');
  const instructions = transactionInstructions(tx).filter(ix => ix.programId === programId);
  const decisions = decisionsFromTx({
    signature, slot: tx.slot, blockTime: tx.blockTime, err: null,
    logs: tx.meta.logMessages ?? [], accountKeys: tx.transaction.message.accountKeys, instructions,
  }, programId);
  const remaining = [...decisions];
  const records: DecodedRecord[] = [];
  for (const ix of instructions) {
    const layout = layouts.find(l => ix.data.subarray(0, 8).equals(Buffer.from(l.discriminator)));
    if (!layout) continue;
    const location: Location = { signature, slot: tx.slot, timestamp: tx.blockTime, instructionIndex: ix.instructionIndex, innerInstructionIndex: ix.innerInstructionIndex };
    try {
      if (ix.accounts.length < layout.accounts.length) throw new Error('Missing instruction accounts');
      const accounts = Object.fromEntries(layout.accounts.map((a, index) => [a.name, ix.accounts[index]]));
      const owner = { ...location, owner: accounts.owner, mandate: accounts.mandate, ledger: accounts.ledger };
      const data = ix.data;
      switch (layout.name) {
        case 'open_mandate': {
          const length = data.readUInt32LE(104);
          if (data.length !== 108 + length) throw new Error('Invalid purpose length');
          records.push({ ...owner, kind: 'open_mandate', source: accounts.source, mint: accounts.mint,
            token_program: accounts.token_program, system_program: accounts.system_program,
            mandate_id: data.readBigUInt64LE(8), agent: new PublicKey(data.subarray(16, 48)).toBase58(),
            merchant: new PublicKey(data.subarray(48, 80)).toBase58(), cap: data.readBigUInt64LE(80),
            per_tx_max: data.readBigUInt64LE(88), expires_at: data.readBigInt64LE(96),
            purpose: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(108)),
          });
          break;
        }
        case 'grant_override':
          if (data.length !== 24) throw new Error('Invalid override length');
          records.push({ ...owner, kind: 'grant_override', source: accounts.source, token_program: accounts.token_program, amount: data.readBigUInt64LE(8), nonce: data.readBigUInt64LE(16) });
          break;
        case 'revoke_mandate':
          if (data.length !== 8) throw new Error('Invalid revoke length');
          records.push({ ...owner, kind: 'revoke_mandate', source: accounts.source, token_program: accounts.token_program });
          break;
        case 'close_mandate':
          if (data.length !== 8) throw new Error('Invalid close length');
          records.push({ ...owner, kind: 'close_mandate' });
          break;
        case 'migrate_hold_vault':
        case 'close_hold_vault': {
          if (data.length !== 8) throw new Error('Invalid Hold instruction length');
          const kind = layout.name === 'migrate_hold_vault' ? 'hold_migrated' : 'hold_closed';
          const index = remaining.findIndex(d => d.kind === kind && d.vault === accounts.vault && d.owner === accounts.owner);
          if (index < 0) throw new Error('Missing Hold lifecycle event');
          const [decision] = remaining.splice(index, 1);
          if (!decision.destination) throw new Error('Missing Hold destination');
          records.push({ ...decision, ...location, kind, vault: accounts.vault, owner: accounts.owner, destination: decision.destination });
          break;
        }
        case 'charge': {
          if (data.length !== 24) throw new Error('Invalid charge length');
          const amount = data.readBigUInt64LE(8), nonce = data.readBigUInt64LE(16);
          const index = remaining.findIndex(d => (d.kind === 'paid' || d.kind === 'refused' || d.kind === 'traded') && d.mandate === accounts.mandate && d.amount === amount && d.nonce === nonce);
          if (index < 0) throw new Error('Missing Paid or Refused decision');
          const [decision] = remaining.splice(index, 1);
          if (decision.kind !== 'paid' && decision.kind !== 'refused' && decision.kind !== 'traded') throw new Error('Invalid charge decision');
          records.push({ ...decision, kind: decision.kind, ...location, counterparty: accounts.destination });
          break;
        }
      }
    } catch (error) {
      throw new Error(`Malformed or incomplete ${layout.name} at instruction ${ix.instructionIndex}`, { cause: error });
    }
  }
  if (remaining.length) throw new Error('Decision event without matching instruction');
  return records;
}
