import { CliError } from "./errors.js";
import { TRADE_RULE_DISABLED } from "./features.js";

const FLAGS = ["key", "rule", "payee", "mint", "max", "cap", "days", "purpose", "rpc", "cluster", "limit"] as const;

type Flag = (typeof FLAGS)[number];

export type Args = {
  command: string;
  help: boolean;
  positionals: string[];
  key?: string;
  rule?: string;
  payee?: string;
  mint?: string;
  max?: string;
  cap?: string;
  days?: string;
  purpose?: string;
  rpc?: string;
  cluster?: string;
  limit?: string;
};

export const USAGE = `veto connect [--key <file>] [--rule <address>] [--payee <address>] [--mint <address>] [--max <base units>] [--cap <base units>] [--days <n>] [--purpose <text>] [--rpc <url>] [--cluster devnet|mainnet-beta]
veto pay <amount in base units> [--rule <address>]
veto status
veto decisions [--limit <n>]
veto mcp

${TRADE_RULE_DISABLED}`;

function isFlag(name: string): name is Flag {
  return (FLAGS as readonly string[]).includes(name);
}

export function parseArgs(argv: readonly string[]): Args {
  const out: Args = { command: "", help: false, positionals: [] };
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    out.help = true;
    return out;
  }
  if (first.startsWith("-")) throw new CliError(`Unknown flag ${first}.`);
  out.command = first;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "--help" || token === "-h") {
      out.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (!isFlag(name)) throw new CliError(`Unknown flag --${name}.`);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const value = inline === undefined ? argv[i + 1] : inline;
      if (inline === undefined) i += 1;
      if (value === undefined || value.startsWith("--") || value.trim() === "") {
        throw new CliError(`Flag --${name} needs a value.`);
      }
      out[name] = value;
      continue;
    }
    if (token.startsWith("-")) throw new CliError(`Unknown flag ${token}.`);
    out.positionals.push(token);
  }
  return out;
}

export function rejectUnused(args: Args, allowed: readonly Flag[]): void {
  for (const name of FLAGS) {
    if (args[name] !== undefined && !allowed.includes(name)) {
      throw new CliError(`Flag --${name} is not used by this command.`);
    }
  }
}

export function rejectPositionals(args: Args): void {
  if (args.positionals.length > 0) {
    throw new CliError(`Unexpected argument ${args.positionals[0] ?? ""}.`);
  }
}
