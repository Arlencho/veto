export class CliError extends Error {
  readonly code: string;

  constructor(message: string, code = "error") {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

/** Printed when getProgramAccounts filters are refused. --rule is the fallback. */
export const FILTERS_REFUSED =
  "The RPC refuses getProgramAccounts filters. Pass --rule <address>.";

export function rpcRefusesFilters(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /getProgramAccounts|secondary index|method not found|410 gone/i.test(message);
}

export function isForeignAgent(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("does not equal the agent key");
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\`]+/gi;
const SECRET_PARAM = /\b(api[-_]?key|apikey|access[-_]?token|token|auth|key|secret|password)\s*=\s*[^\s&"'<>\\`]*/gi;

/**
 * Error text with every URL and every credential-like query parameter removed. An RPC URL can
 * carry an API key, and error text reaches the terminal, the assistant, and MCP client logs.
 */
export function redactRpc(text: string): string {
  return text.replace(URL_PATTERN, "[url hidden]").replace(SECRET_PARAM, "$1=[hidden]");
}

/** The message of any thrown value, safe to print or hand to an MCP client. */
export function errorText(err: unknown): string {
  return redactRpc(err instanceof Error ? err.message : String(err));
}
