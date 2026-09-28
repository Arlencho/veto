# Changelog

## 0.1.1 (2026-09-28)

- `veto connect` accepts only a rule that answers the request (this key, payee, mint and purpose, with limits no higher than asked), refuses to pick among several matches, and prints the rule and its owner. Pass `--owner` to refuse rules opened by any other wallet.
- New `--owner <your wallet address>` flag on `veto connect` limits the match to rules opened by that wallet.
- `veto pay` and the `veto_pay` MCP tool charge the rule saved by `veto connect`.
- `veto_pay` states the amount, token, mint and payee, and is annotated as a spending tool. `veto_status` and `veto_decisions` are annotated as read-only.
- Error text never includes the RPC URL or credential-like query parameters, in the terminal or in MCP tool errors.
- `veto_request_rule` never writes a second agent key.
- The help text no longer says the trade rule is missing from the program. It says trading from the companion is switched off and agents trade through the SDK.
- The package now ships the full Apache License 2.0 text as `LICENSE`.
- Depends on `@veto-hq/agent-sdk` 0.1.1.

## 0.1.0 (2026-09-27)

- The veto command for agent pairing, payments, status, decisions, and MCP tools.
- Public npm package metadata, clean distribution builds, and build plus test checks before publishing.
- Node 22 or newer is required.
- A dedicated executable launcher supports npm command symlinks.
