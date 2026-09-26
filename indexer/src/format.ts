import type { Comparison, Decision } from "./types.js";

export function decisionToJson(d: Decision): Record<string, unknown> {
  return {
    ...(d.vault ? { vault: d.vault, owner: d.owner, destination: d.destination, amount_unit: d.kind === "hold_migrated" ? "lamports" : "token_base_units" } : {}),
    signature: d.signature,
    slot: d.slot,
    timestamp: d.timestamp,
    timestamp_iso: d.timestamp === null ? null : new Date(d.timestamp * 1000).toISOString(),
    ...(d.rule ? { rule: d.rule, amount_in: d.amountIn?.toString(), amount_out: d.amountOut?.toString(), min_out: d.minOut?.toString() } : { mandate: d.mandate }),
    ...(!d.rule ? { amount: d.amount.toString() } : {}),
    nonce: d.nonce.toString(),
    counterparty: d.counterparty,
    kind: d.kind,
    reason: d.reason,
    reason_text: d.reasonText,
    suggested_override: d.suggestedOverride.toString(),
  };
}

export function formatTable(decisions: Decision[]): string {
  if (decisions.length === 0) {
    return "(no Paid or Refused events found)";
  }
  const rows = decisions.map((d) => ({
    time: d.timestamp === null ? "-" : new Date(d.timestamp * 1000).toISOString(),
    kind: d.kind,
    amount: d.amount.toString(),
    reason: `${d.reasonText} (${d.reason})`,
    override: d.suggestedOverride.toString(),
    counterparty: d.counterparty,
    signature: d.signature,
  }));
  const headers = {
    time: "TIME",
    kind: "KIND",
    amount: "AMOUNT",
    reason: "REASON",
    override: "OVERRIDE",
    counterparty: "COUNTERPARTY",
    signature: "SIGNATURE",
  };
  const keys = Object.keys(headers) as (keyof typeof headers)[];
  const widths: Record<string, number> = {};
  for (const key of keys) {
    widths[key] = Math.max(headers[key].length, ...rows.map((row) => row[key].length));
  }
  const line = (row: Record<string, string>) =>
    keys.map((key) => row[key].padEnd(widths[key] ?? 0)).join("  ");
  const headerLine = line(headers);
  const rule = keys.map((key) => "-".repeat(widths[key] ?? 0)).join("  ");
  return [headerLine, rule, ...rows.map(line)].join("\n");
}

export function formatComparison(cmp: Comparison): string {
  const lines = [
    `ring paid/refused entries: ${cmp.ringDecisions}`,
    `matched exactly: ${cmp.matched}`,
    `indexer extras (older than the ring, expected after wrap): ${cmp.extraInIndexer.length}`,
    `overlap ok: ${cmp.ok ? "yes" : "NO"}`,
  ];
  for (const row of cmp.rows) {
    const nonce = row.ring.nonce.toString();
    if (row.equal) {
      const tsNote = row.diffs.find((d) => d.startsWith("timestamp:"));
      const sig = row.indexed?.signature ?? "-";
      lines.push(
        `  MATCH kind=${row.ring.kindName} nonce=${nonce} amount=${row.ring.amount} sig=${sig}${tsNote ? ` (${tsNote})` : ""}`,
      );
    } else {
      lines.push(`  MISS kind=${row.ring.kindName} nonce=${nonce} amount=${row.ring.amount}`);
      for (const diff of row.diffs) lines.push(`    ${diff}`);
    }
  }
  return lines.join("\n");
}
