# Contributing

Veto runs on devnet and has not been externally audited. Issues and pull requests are welcome. For anything that touches the program or how money moves, open an issue first so we agree on the design before the code.

## Toolchain

- Rust 1.89.0, pinned in `rust-toolchain.toml`
- Solana CLI and Anchor 1.2.0
- Node 22 for the TypeScript packages

## Build and test

The program:

```bash
make test
```

The README explains why this is `make test` and not `anchor build && cargo test`.

Every TypeScript package (`app`, `cli`, `sdk`, `tools`, `indexer`, `terminal`, `watcher`, `service`) is checked the same way:

```bash
cd <package> && npm ci && npm run typecheck && npm test
```

`app` and `service` typecheck against the SDK, so run `npm ci` in `sdk` first. The `service` tests need a local Postgres. `make test-scripts` runs the script checks that do not need a cluster.

Reading devnet needs no keys. Deploying needs the maintainer backup of `keys/program.json`, as described under Build and run in the README.

## Android APK

Setup for the Expo app is in [app/README.md](app/README.md). The public tester build and the RPC key it needs are in [docs/TESTERS.md](docs/TESTERS.md). Add `--local` to the EAS command to build on your own machine.

## Pull requests

- CI runs eleven jobs, one per package plus the program, the scripts and the watcher image. All must pass, and CI fails a suite that runs no tests.
- Every pull request gets an independent review before merge. Changes to the program or a money path get a second one.
- Amounts are integer base units everywhere. No floats in money code.
- Never commit keys, `.env` values or RPC URLs that carry credentials. `keys/` is gitignored.
- Report security issues as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

Contributions are licensed under Apache 2.0, the same as the project.
