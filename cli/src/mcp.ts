import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  COMMANDS,
  decisionLines,
  executeDecisions,
  executePay,
  executeRequestRule,
  executeStatus,
  payLines,
  statusLines,
} from "./commands.js";
import { CliError, errorText } from "./errors.js";
import { assertAgentKeyMode } from "./files.js";
import { renderQrPng } from "./qr.js";
import type { Runtime } from "./runtime.js";

const SCAN_INSTRUCTION = "Scan this on your phone and hold to approve.";

const payInput = z
  .object({
    amount: z.string().describe("Amount in base units."),
    rule: z.string().optional().describe("Rule address. Omit to use the rule saved by veto connect."),
  })
  .strict();

const payOutput = z.object({
  kind: z.enum(["paid", "refused"]),
  amount: z.string(),
  amountBaseUnits: z.string(),
  token: z.string(),
  mint: z.string(),
  payee: z.string(),
  reasonCode: z.number().int(),
  reasonText: z.string(),
  override: z.string(),
  signature: z.string(),
  explorer: z.string(),
});

const statusInput = z.preprocess((value) => (value === undefined ? {} : value), z.object({}).strict());

const statusOutput = z.object({
  remaining: z.string(),
  cap: z.string(),
  largest: z.string(),
  expiry: z.string(),
  feeSol: z.string(),
  feeWarning: z.string().nullable(),
});

const decisionsInput = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z
    .object({
      limit: z.number().optional().describe("How many rows to return, from 1 to 1000."),
    })
    .strict(),
);

const decisionsOutput = z.object({
  decisions: z.array(
    z.object({
      kind: z.string(),
      amount: z.string(),
      reasonText: z.string(),
      signature: z.string(),
    }),
  ),
});

const requestInput = z
  .object({
    payee: z.string().describe("Payee address."),
    max: z.string().describe("Most per payment, in base units."),
    cap: z.string().describe("Total, in base units."),
    days: z.string().describe("How many days the rule lasts."),
    purpose: z.string().describe("Purpose."),
    mint: z.string().optional().describe("Mint address. On devnet this defaults to devnet USDC."),
  })
  .strict();

const requestOutput = z.object({
  url: z.string(),
  instruction: z.string(),
});

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guard(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    // Every failure becomes a tool error here, so the MCP SDK never forwards a raw message
    // that could hold the RPC URL and its API key.
    return toolError(errorText(err));
  }
}

export async function createMcpServer(runtime: Runtime): Promise<McpServer> {
  await assertAgentKeyMode(runtime.home);
  const server = new McpServer({ name: "veto", version: "0.1.1" });
  for (const command of COMMANDS) {
    if (command.tool === undefined || !command.enabled) continue;
    if (command.tool === "veto_pay") registerPay(server, runtime);
    else if (command.tool === "veto_status") registerStatus(server, runtime);
    else if (command.tool === "veto_decisions") registerDecisions(server, runtime);
    else if (command.tool === "veto_request_rule") registerRequestRule(server, runtime);
    else throw new CliError(`No handler for ${command.tool}.`);
  }
  return server;
}

export async function serveMcp(runtime: Runtime): Promise<void> {
  const server = await createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function registerPay(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "veto_pay",
    {
      description:
        "Spends money. Pays an amount in base units from the owner's tokens to the rule's payee, within the rule's per-payment maximum and total. A paid call moves real tokens and cannot be undone, and calling twice pays twice. A refusal is a normal result. The result states the amount in the token and in base units, the token, the payee, the reason, the override, the signature, and the explorer link.",
      inputSchema: payInput,
      outputSchema: payOutput,
      annotations: {
        title: "Pay from the Veto rule",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(async () => {
        const outcome = await executePay(runtime, args.amount, args.rule);
        return {
          content: [{ type: "text", text: payLines(outcome).join("\n") }],
          structuredContent: outcome,
        };
      }),
  );
}

function registerStatus(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "veto_status",
    {
      description:
        "What the rule can still pay today, the cap, the largest payment, the expiry, and the agent's fee in SOL. Amounts name the token.",
      inputSchema: statusInput,
      outputSchema: statusOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const outcome = await executeStatus(runtime);
        return {
          content: [{ type: "text", text: statusLines(outcome).join("\n") }],
          structuredContent: {
            remaining: outcome.remaining,
            cap: outcome.cap,
            largest: outcome.largest,
            expiry: outcome.expiry,
            feeSol: `${outcome.feeAmount} SOL`,
            feeWarning: outcome.feeWarning,
          },
        };
      }),
  );
}

function registerDecisions(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "veto_decisions",
    {
      description: "Decisions on the rule, newest first. Each amount names the token.",
      inputSchema: decisionsInput,
      outputSchema: decisionsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const decisions = await executeDecisions(runtime, args.limit);
        return {
          content: [{ type: "text", text: decisionLines(decisions).join("\n") }],
          structuredContent: { decisions },
        };
      }),
  );
}

function registerRequestRule(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "veto_request_rule",
    {
      description: "Build a rule request. The owner scans the QR on the phone and holds to approve.",
      inputSchema: requestInput,
      outputSchema: requestOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const url = await executeRequestRule(runtime, args);
        const png = renderQrPng(url);
        return {
          content: [
            { type: "text", text: url },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: SCAN_INSTRUCTION },
          ],
          structuredContent: { url, instruction: SCAN_INSTRUCTION },
        };
      }),
  );
}
