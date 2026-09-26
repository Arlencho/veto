import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

type NamedDisc = { name: string; discriminator: number[] };

type IdlFile = {
  address: string;
  instructions: NamedDisc[];
  accounts: NamedDisc[];
  events: NamedDisc[];
};

function loadIdl(): IdlFile {
  const path = fileURLToPath(new URL("../idl/veto.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as IdlFile;
}

function discriminator(list: readonly NamedDisc[], name: string): Buffer {
  const found = list.find((item) => item.name === name);
  if (!found) throw new Error(`idl: missing ${name}`);
  return Buffer.from(found.discriminator);
}

const idl = loadIdl();

/** Program id recorded in the bundled IDL (`indexer/idl/veto.json`). */
export const PROGRAM_ID = new PublicKey(idl.address);

export const CHARGE_DISCRIMINATOR = discriminator(idl.instructions, "charge");
export const INIT_VAULT_DISCRIMINATOR = discriminator(idl.instructions, "init_vault");
export const DEPOSIT_DISCRIMINATOR = discriminator(idl.instructions, "deposit");
export const WITHDRAW_DISCRIMINATOR = discriminator(idl.instructions, "withdraw");
export const EXECUTE_HOLD_DISCRIMINATOR = discriminator(idl.instructions, "execute");
export const STOP_DISCRIMINATOR = discriminator(idl.instructions, "stop");
export const FREEZE_DISCRIMINATOR = discriminator(idl.instructions, "freeze");
export const UNFREEZE_DISCRIMINATOR = discriminator(idl.instructions, "unfreeze");
export const SKIP_DISCRIMINATOR = discriminator(idl.instructions, "skip");
export const RECOVER_DISCRIMINATOR = discriminator(idl.instructions, "recover");
export const PROPOSE_CHANGE_DISCRIMINATOR = discriminator(idl.instructions, "propose_change");
export const APPLY_CHANGE_DISCRIMINATOR = discriminator(idl.instructions, "apply_change");
export const CANCEL_CHANGE_DISCRIMINATOR = discriminator(idl.instructions, "cancel_change");
export const MANDATE_DISCRIMINATOR = discriminator(idl.accounts, "Mandate");
export const LEDGER_DISCRIMINATOR = discriminator(idl.accounts, "Ledger");
export const HOLD_VAULT_DISCRIMINATOR = discriminator(idl.accounts, "HoldVault");
export const HOLD_LEDGER_DISCRIMINATOR = discriminator(idl.accounts, "HoldLedger");
export const TRADE_DISCRIMINATOR = discriminator(idl.instructions, "trade");
export const TRADE_RULE_DISCRIMINATOR = discriminator(idl.accounts, "TradeRule");
export const TRADE_LEDGER_DISCRIMINATOR = discriminator(idl.accounts, "TradeLedger");
export const PAID_EVENT_DISCRIMINATOR = discriminator(idl.events, "Paid");
export const REFUSED_EVENT_DISCRIMINATOR = discriminator(idl.events, "Refused");
export const TRADED_EVENT_DISCRIMINATOR = discriminator(idl.events, "Traded");
export const TRADE_REFUSED_EVENT_DISCRIMINATOR = discriminator(idl.events, "TradeRefused");

export const MIGRATE_HOLD_VAULT_DISCRIMINATOR = discriminator(idl.instructions, "migrate_hold_vault");

export const CLOSE_HOLD_VAULT_DISCRIMINATOR = discriminator(idl.instructions, "close_hold_vault");
