import { readFileSync } from "node:fs";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";

const idl = JSON.parse(readFileSync(new URL("./idl/veto.json", import.meta.url), "utf8")) as Idl;
const coder = new BorshAccountsCoder(idl);

/** The generic Borsh decoder accepts truncated integer fields as zero.
 * Refuse legacy Hold accounts rather than presenting empty rolling buckets.
 */
export function decodeHoldVault(data: Buffer) {
  if (data.length === 1291) throw new Error("Legacy Hold vault: the owner must migrate_hold_vault before use");
  const size = coder.size("HoldVault");
  if (data.length < size) throw new Error(`Hold vault account is ${data.length} bytes, need ${size}`);
  return coder.decode("HoldVault", data);
}
