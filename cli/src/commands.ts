import {
  LOW_FEE_LAMPORTS,
  RuleRequestRejected,
  VetoAgent,
  createRuleRequest,
  decisionsForMandate,
  mandatesForAgent,
  parseRuleRequest,
} from "@veto-hq/agent-sdk";
import type { AgentMandate, Decision, RuleRequest } from "@veto-hq/agent-sdk";
import { USAGE, parseArgs, rejectPositionals, rejectUnused, type Args } from "./args.js";
import { DEFAULT_RPC, assertGenesis, explorerTx, parseCluster, type Cluster } from "./cluster.js";
import { CliError, FILTERS_REFUSED, errorText, isForeignAgent, rpcRefusesFilters } from "./errors.js";
import { TRADE_RULE_DISABLED, tradeRuleEnabled } from "./features.js";
import { loadOrCreateKey, readConfig, readKeyFile, writeConfig } from "./files.js";
import {
  DEVNET_USDC_MINT,
  MCP_CONFIG_LINE,
  approvedSentence,
  formatTokenUnits,
  formatUnits,
  formatUtcDay,
  isActive,
  parseBaseUnits,
  parseDays,
  readDecimals,
  tokenSymbol,
  unixSeconds,
} from "./money.js";
import type { Runtime } from "./runtime.js";
import { PublicKey, canonicalAddress, type Connection, type Keypair as AgentKey, type PublicKey as Address } from "./web3.js";

const POLL_MS = 5_000;
/** Clock skew allowed between this machine and the phone when checking the approved expiry. */
const EXPIRY_SLACK_SECONDS = 3_600n;
const SECONDS_PER_DAY = 86_400n;
const AIRDROP_LAMPORTS = 1_000_000_000;
const CONNECT_FLAGS = ["key", "rule", "payee", "mint", "max", "cap", "days", "purpose", "rpc", "cluster"] as const;

type RuleFields = {
  payee: string;
  max: string;
  cap: string;
  days: string;
  purpose: string;
  mint: string;
};

export type CommandSpec = {
  name: string;
  cli: boolean;
  tool?: string;
  enabled: boolean;
  disabledMessage?: string;
};

/** CLI commands and MCP tools. A disabled row is not exposed as a tool. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: "connect", cli: true, enabled: true },
  { name: "pay", cli: true, tool: "veto_pay", enabled: true },
  { name: "status", cli: true, tool: "veto_status", enabled: true },
  { name: "decisions", cli: true, tool: "veto_decisions", enabled: true },
  { name: "request-rule", cli: false, tool: "veto_request_rule", enabled: true },
  {
    name: "trade",
    cli: true,
    tool: "veto_trade",
    enabled: tradeRuleEnabled,
    disabledMessage: TRADE_RULE_DISABLED,
  },
  { name: "mcp", cli: true, enabled: true },
];

export type PayOutcome = {
  kind: "paid" | "refused";
  /** The amount asked, in the token, such as "0.50 USDC". Paid only when kind is paid. */
  amount: string;
  amountBaseUnits: string;
  /** Token symbol when the mint is known, the shortened mint otherwise. */
  token: string;
  mint: string;
  payee: string;
  reasonCode: number;
  reasonText: string;
  override: string;
  signature: string;
  explorer: string;
};

export type StatusOutcome = {
  remaining: string;
  cap: string;
  largest: string;
  expiry: string;
  /** SOL amount without the token name, so the command line can say "Fee SOL". */
  feeAmount: string;
  feeWarning: string | null;
};

export type DecisionOutcome = {
  kind: string;
  amount: string;
  reasonText: string;
  signature: string;
};

export type RuleRequestInput = {
  payee: string;
  max: string;
  cap: string;
  days: string;
  purpose: string;
  mint?: string;
};

export async function run(argv: readonly string[], runtime: Runtime): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      runtime.stdout(USAGE);
      return 0;
    }
    const entry = COMMANDS.find((command) => command.cli && command.name === args.command);
    if (!entry) throw new CliError(`Unknown command ${args.command}.`);
    if (!entry.enabled) {
      throw new CliError(entry.disabledMessage ?? `Unknown command ${args.command}.`);
    }
    if (entry.name === "connect") await connect(args, runtime);
    else if (entry.name === "pay") await pay(args, runtime);
    else if (entry.name === "status") await status(args, runtime);
    else if (entry.name === "decisions") await decisions(args, runtime);
    else if (entry.name === "mcp") await mcp(args, runtime);
    else throw new CliError(`Unknown command ${args.command}.`);
    return 0;
  } catch (err) {
    runtime.stderr(errorText(err));
    return 1;
  }
}

async function connect(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, CONNECT_FLAGS);
  rejectPositionals(args);
  const cluster = parseCluster(args.cluster);
  const rpc = args.rpc?.trim() || DEFAULT_RPC[cluster];
  const loaded = await loadOrCreateKey(runtime.home, args.key);
  runtime.stdout(`Agent ${loaded.keypair.publicKey.toBase58()}`);
  runtime.stdout("This key lives on your machine. Veto never holds it.");
  const connection = runtime.connect(rpc);
  await assertGenesis(connection, cluster);
  await maybeAirdrop(connection, loaded.keypair.publicKey, cluster, runtime);
  const address =
    args.rule !== undefined
      ? await namedRule(connection, args.rule, loaded.keypair, runtime)
      : await requestAndWait(connection, loaded.keypair, cluster, args, runtime);
  await showRule(connection, address, loaded.keypair, runtime);
  await writeConfig(runtime.home, { rule: address, rpc, cluster, key: loaded.path });
}

async function pay(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, ["rule"]);
  if (args.positionals.length !== 1) {
    throw new CliError("Usage: veto pay <amount in base units> [--rule <address>].");
  }
  const amountText = args.positionals[0];
  if (amountText === undefined) {
    throw new CliError("Usage: veto pay <amount in base units> [--rule <address>].");
  }
  const outcome = await executePay(runtime, amountText, args.rule);
  for (const line of payLines(outcome)) runtime.stdout(line);
}

export function payLines(outcome: PayOutcome): string[] {
  return [
    `kind ${outcome.kind}`,
    `amount ${outcome.amount} (${outcome.amountBaseUnits} base units)`,
    `payee ${outcome.payee}`,
    `reason ${outcome.reasonCode} ${outcome.reasonText}`,
    `override ${outcome.override}`,
    `signature ${outcome.signature}`,
    outcome.explorer,
  ];
}

export async function executePay(runtime: Runtime, amountText: string, rule?: string): Promise<PayOutcome> {
  const amount = parseBaseUnits(amountText, "Amount");
  const stored = await readConfig(runtime.home);
  const keypair = await readKeyFile(stored.key);
  const connection = runtime.connect(stored.rpc);
  const address = rule !== undefined ? canonicalAddress(rule, "Rule address") : stored.rule;
  const veto = await openMandate(connection, address, keypair);
  const view = await veto.status();
  if (!isActive(view.status, view.expiresAt, unixSeconds(runtime.now()))) {
    throw new CliError("No active rule.");
  }
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  const symbol = tokenSymbol(view.mint);
  const nonce = await veto.nextNonce();
  const outcome = await veto.charge({ amount, nonce, guardPendingOverride: true });
  return {
    kind: outcome.kind,
    amount: `${formatTokenUnits(amount, decimals)} ${symbol}`,
    amountBaseUnits: amount.toString(),
    token: symbol,
    mint: view.mint,
    payee: view.merchant,
    reasonCode: outcome.reasonCode,
    reasonText: outcome.reasonText,
    override: `${formatTokenUnits(outcome.suggestedOverride, decimals)} ${symbol}`,
    signature: outcome.signature,
    explorer: explorerTx(outcome.signature, stored.cluster),
  };
}

async function status(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, []);
  rejectPositionals(args);
  const outcome = await executeStatus(runtime);
  for (const line of statusLines(outcome)) runtime.stdout(line);
}

export function statusLines(outcome: StatusOutcome): string[] {
  const lines = [
    `Can still pay ${outcome.remaining} today`,
    `Cap ${outcome.cap}`,
    `Largest payment ${outcome.largest}`,
    `Ends ${outcome.expiry}`,
    `Fee SOL ${outcome.feeAmount}`,
  ];
  if (outcome.feeWarning) lines.push(outcome.feeWarning);
  return lines;
}

export async function executeStatus(runtime: Runtime): Promise<StatusOutcome> {
  const { connection, veto } = await openSaved(runtime);
  const view = await veto.status();
  if (!isActive(view.status, view.expiresAt, unixSeconds(runtime.now()))) {
    throw new CliError("No active rule.");
  }
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  const symbol = tokenSymbol(view.mint);
  const named = (amount: bigint) => `${formatTokenUnits(amount, decimals)} ${symbol}`;
  return {
    remaining: named(view.remaining),
    cap: named(view.cap),
    largest: named(view.perTxMax),
    expiry: formatUtcDay(view.expiresAt),
    feeAmount: formatUnits(view.agentLamports, 9),
    feeWarning: view.feeWarning,
  };
}

async function decisions(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, ["limit"]);
  rejectPositionals(args);
  const rows = await executeDecisions(runtime, args.limit);
  for (const line of decisionLines(rows)) runtime.stdout(line);
}

export function decisionLines(rows: readonly DecisionOutcome[]): string[] {
  if (rows.length === 0) return ["No decisions."];
  return rows.map((row) => `${row.kind} ${row.amount} ${row.reasonText} ${row.signature}`);
}

export async function executeDecisions(runtime: Runtime, limit?: string | number): Promise<DecisionOutcome[]> {
  const checked = parseLimit(limit);
  const { connection, veto } = await openSaved(runtime);
  const view = await veto.status();
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  const symbol = tokenSymbol(view.mint);
  const page = await decisionsForMandate(
    connection,
    veto.mandate,
    checked === undefined ? undefined : { limit: checked },
  );
  return [...page].reverse().map((row) => decisionOutcome(row, decimals, symbol));
}

export async function executeRequestRule(runtime: Runtime, fields: RuleRequestInput): Promise<string> {
  const cluster = await savedCluster(runtime.home);
  const mint = fields.mint !== undefined ? fields.mint : cluster === "devnet" ? DEVNET_USDC_MINT : undefined;
  if (mint === undefined || mint.trim() === "") {
    throw new CliError("Mint address is required.");
  }
  const loaded = await loadOrCreateKey(runtime.home, undefined);
  return ruleRequestUrl(loaded.keypair.publicKey.toBase58(), {
    payee: fields.payee,
    max: fields.max,
    cap: fields.cap,
    days: fields.days,
    purpose: fields.purpose,
    mint,
  });
}

export function ruleRequestUrl(agent: string, fields: RuleFields): string {
  try {
    return createRuleRequest({
      agent,
      payee: fields.payee.trim(),
      mint: fields.mint.trim(),
      cap: parseBaseUnits(fields.cap, "Total"),
      max: parseBaseUnits(fields.max, "Most per payment"),
      days: parseDays(fields.days),
      purpose: fields.purpose.trim(),
    });
  } catch (err) {
    if (err instanceof RuleRequestRejected || err instanceof CliError) {
      throw new CliError(err.message);
    }
    throw err;
  }
}

async function mcp(args: Args, runtime: Runtime): Promise<void> {
  rejectUnused(args, []);
  rejectPositionals(args);
  const { serveMcp } = await import("./mcp.js");
  await serveMcp(runtime);
}

async function maybeAirdrop(
  connection: Connection,
  owner: Address,
  cluster: Cluster,
  runtime: Runtime,
): Promise<void> {
  if (cluster !== "devnet") return;
  const balance = await connection.getBalance(owner, "confirmed");
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new CliError("Could not read the agent SOL balance.");
  }
  if (BigInt(balance) >= LOW_FEE_LAMPORTS) return;
  const signature = await connection.requestAirdrop(owner, AIRDROP_LAMPORTS);
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) throw new CliError("The devnet airdrop failed.");
  runtime.stdout("Requested an airdrop. This devnet key held under 20 base fees of SOL.");
}

async function namedRule(
  connection: Connection,
  rule: string,
  keypair: AgentKey,
  runtime: Runtime,
): Promise<string> {
  const address = canonicalAddress(rule, "Rule address");
  const veto = await openMandate(connection, address, keypair);
  const view = await veto.status();
  if (!isActive(view.status, view.expiresAt, unixSeconds(runtime.now()))) {
    throw new CliError("This rule is not active.");
  }
  return address;
}

async function requestAndWait(
  connection: Connection,
  keypair: AgentKey,
  cluster: Cluster,
  args: Args,
  runtime: Runtime,
): Promise<string> {
  const fields = await askRule(args, cluster, runtime);
  const url = ruleRequestUrl(keypair.publicKey.toBase58(), fields);
  const parsed = parseRuleRequest(url);
  if (!parsed.ok) throw new CliError("The rule request could not be read back.");
  const request = parsed.request;
  runtime.stdout(url);
  runtime.stdout(runtime.qr(url));
  runtime.stdout("Waiting for you to approve on the phone.");
  for (let poll = 0; poll < runtime.maxPolls; poll += 1) {
    let rules;
    try {
      rules = await mandatesForAgent(connection, keypair.publicKey);
    } catch (err) {
      if (rpcRefusesFilters(err)) throw new CliError(FILTERS_REFUSED);
      throw err;
    }
    const now = unixSeconds(runtime.now());
    const matches = rules.filter((rule) => matchesRequest(rule, keypair.publicKey, request, now));
    if (matches.length > 1) {
      for (const rule of matches) {
        runtime.stdout(`Matching rule ${rule.address.toBase58()} from owner ${rule.owner.toBase58()}`);
      }
      throw new CliError(
        "Several rules match this request, so none was chosen. Run veto connect --rule <address> with the rule your phone shows.",
      );
    }
    const match = matches[0];
    if (match) {
      runtime.stdout(`Rule ${match.address.toBase58()}`);
      runtime.stdout(`Owner ${match.owner.toBase58()}`);
      runtime.stdout("Check that this owner and rule match what your phone shows.");
      return match.address.toBase58();
    }
    await runtime.sleep(POLL_MS);
  }
  throw new CliError("Still waiting for you to approve on the phone.");
}

/**
 * A rule answers the request only when it names this agent, the requested payee, mint and
 * purpose, and stays within the requested total, per-payment maximum and days. The owner may
 * lower the limits on the phone but never raise them. Anyone can open a rule for this agent, so
 * the newest rule for the key proves nothing.
 */
function matchesRequest(rule: AgentMandate, agent: Address, request: RuleRequest, now: bigint): boolean {
  if (!rule.agent.equals(agent) || !isActive(rule.status, rule.expiresAt, now)) return false;
  if (rule.merchant.toBase58() !== request.payee) return false;
  if (rule.mint.toBase58() !== request.mint) return false;
  if (rule.purpose !== request.purpose) return false;
  if (rule.cap <= 0n || rule.cap > request.cap) return false;
  if (rule.perTxMax <= 0n || rule.perTxMax > request.max) return false;
  const latest = now + BigInt(request.days) * SECONDS_PER_DAY + EXPIRY_SLACK_SECONDS;
  return rule.expiresAt <= latest;
}

async function askRule(args: Args, cluster: Cluster, runtime: Runtime): Promise<RuleFields> {
  const payee = await givenOrAsk(args.payee, "Payee address", runtime);
  const max = await givenOrAsk(args.max, "Most per payment, in base units", runtime);
  const cap = await givenOrAsk(args.cap, "Total, in base units", runtime);
  const days = await givenOrAsk(args.days, "Days", runtime);
  const purpose = await givenOrAsk(args.purpose, "Purpose", runtime);
  const mint =
    args.mint !== undefined
      ? args.mint
      : cluster === "devnet"
        ? DEVNET_USDC_MINT
        : await runtime.ask("Mint address");
  return { payee, max, cap, days, purpose, mint };
}

async function givenOrAsk(value: string | undefined, prompt: string, runtime: Runtime): Promise<string> {
  if (value !== undefined) return value;
  return runtime.ask(prompt);
}

async function showRule(
  connection: Connection,
  address: string,
  keypair: AgentKey,
  runtime: Runtime,
): Promise<void> {
  const veto = await openMandate(connection, address, keypair);
  const view = await veto.status();
  const decimals = await readDecimals(connection, new PublicKey(view.mint));
  runtime.stdout(
    approvedSentence({
      cap: view.cap,
      max: view.perTxMax,
      decimals,
      symbol: tokenSymbol(view.mint),
      expiresAt: view.expiresAt,
      payee: view.merchant,
    }),
  );
  runtime.stdout(MCP_CONFIG_LINE);
}

async function openSaved(runtime: Runtime): Promise<{ connection: Connection; veto: VetoAgent }> {
  const stored = await readConfig(runtime.home);
  const keypair = await readKeyFile(stored.key);
  const connection = runtime.connect(stored.rpc);
  const veto = await openMandate(connection, stored.rule, keypair);
  return { connection, veto };
}

async function openMandate(connection: Connection, address: string, keypair: AgentKey): Promise<VetoAgent> {
  try {
    return await VetoAgent.fromMandate(connection, address, keypair);
  } catch (err) {
    if (isForeignAgent(err)) throw new CliError("This key is not the rule's agent.");
    throw err;
  }
}

async function savedCluster(home: string): Promise<Cluster> {
  try {
    return (await readConfig(home)).cluster;
  } catch (err) {
    if (err instanceof CliError && err.code === "config-missing") return "devnet";
    throw err;
  }
}

function parseLimit(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw new CliError("Limit must be a whole number from 1 to 1000.");
    }
    return value;
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new CliError("Limit must be a whole number from 1 to 1000.");
  }
  const limit = Number(trimmed);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new CliError("Limit must be a whole number from 1 to 1000.");
  }
  return limit;
}

function decisionOutcome(row: Decision, decimals: number, symbol: string): DecisionOutcome {
  return {
    kind: row.kind,
    amount: `${formatTokenUnits(row.amount, decimals)} ${symbol}`,
    reasonText: row.reasonText,
    signature: row.signature,
  };
}
