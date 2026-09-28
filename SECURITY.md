# Security policy

## Report a vulnerability privately

Do not open a public issue, pull request or discussion for a vulnerability.

Report it through GitHub private vulnerability reporting on this repository: open the
**Security** tab and choose **Report a vulnerability**. The report is visible only to the repository maintainers.

Include what you found, the affected file or instruction, the commit you read, and the steps or
transactions that show it. A devnet transaction signature is the most useful evidence.

## Status

Veto runs on Solana devnet only. The program `3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV`
is not deployed on mainnet, and devnet tokens have no value. The devnet program is upgradeable
by one key, named in the README threat model and in [docs/DEVNET.md](docs/DEVNET.md). Known
issues are listed in the README, including the Hold known issue under "If someone forces you".

In scope: the Anchor program under `programs/veto/`, the Android app under `app/`, the agent SDK
under `sdk/`, the CLI under `cli/`, and the watcher, indexer and tools in this repository.

## No bounty

There is no bug bounty and no payment for reports.

## Testing

Test against your own devnet accounts. Do not act on accounts, vaults or rules you do not own,
and do not load public RPC endpoints or the tester RPC key beyond what a proof needs.
