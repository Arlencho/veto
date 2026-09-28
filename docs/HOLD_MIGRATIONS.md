# Hold layout migrations

A layout upgrade must ship an owner-authorized migration before deployment.
Never deploy a layout that strands vault funds or resets release accounting.

The pre-330 Hold layout is exactly 1,291 bytes, including its discriminator.
The current layout is 1,691 bytes. PR 337 changed accounting behavior without
adding another layout. `migrate_hold_vault` accepts only the old layout, checks
program ownership, discriminator, owner signature and stored PDA seeds, and
charges the owner only the rent shortfall. It preserves the entire old prefix,
including pending withdrawals, freezes, unfreeze timers and queued rule changes.
It places all `window_spent` in the current hour, even if the old window expired.
The conservative rolling window retains that total for at least 24 hours and
up to 25 hours. A second migration fails rather than resetting accounting.

The app discovers old vaults and offers the owner an Update this vault action.
Legacy accounts can be displayed but cannot produce an instant-payment preview.
The SDK exposes `HoldVault.migrateHoldVault({ owner, vaultId })`; it needs no
successful current-layout decode. Read the migrated vault again before use.
Watcher alerts continue reading legacy pending rows at their unchanged offsets.

After migration, the owner can use `close_hold_vault` or SDK
`HoldVault.closeHoldVault({ owner, vaultId, destination, mint })`.
The destination token account must belong to the vault's existing safe address.
Closure refuses any pending withdrawal or freeze, transfers the full balance,
and closes the token account, vault and ledger, returning their rent to the owner.
Resolve holds and unfreeze through the existing rules first. A guardian cannot
migrate or close alone, and closure cannot redirect funds or apply a queued safe
address change early. The safe address must differ from the owner for the owner
to close: on a pre-#344 vault whose safe address is the owner key, close is
refused with `SafeAddressIsOwner` until the safe address is repaired.
Existing Recover semantics are unchanged.

The old devnet demo vault `8n9EcgXwSWVbQgnunw6oin8hYcpRDr1CkkvozhpiAyVj`
needed the upgraded program and its owner's signature. Its owner migrated it on
2026-09-26, signature
`2SUSRUvHKBdUsEWAPqwxxopGV1nTQAcwmQeVqZWvCcBBmTzf2pz3YJxXX5oR8a795a58xH3TXDKy6Jk5YS9ecYrC`
(recorded in [DEVNET.md](DEVNET.md)). It has not been closed.

Migration now requires the writable `hold-ledger` PDA in addition to owner,
vault and system program. Use the synchronized client and IDL. It appends kind
14 to the surviving ledger and emits `HoldMigrated` with vault, owner, amount
and destination. The amount is the rent top-up in lamports and destination is
the vault; no tokens move. Existing ledger rows remain intact.

Close emits `HoldClosed` with vault, owner, amount in token base units and the
safe token account destination before closing accounts. Its ledger is deleted;
the transaction event preserves the final sweep in indexed history.

New vaults and proposed rules reject safe addresses equal to either owner or
guardian. Apply validates the resulting rules too, including old queued proposals.
An existing vault with safe equal to guardian can propose an independent safe
address and apply it after the normal delay. The old recovery destination remains
in effect while that change waits. On such a vault the guardian alone cannot
`recover`: the program refuses it with `SafeAddressIsGuardian`, and the owner can
still recover. The guardian can still cancel the repair; that veto stays because
the program cannot tell an honest repair from a stolen owner key moving the safe
address.

An existing vault with safe equal to owner is refused the same way: the owner
alone cannot `recover` or `close_hold_vault` (`SafeAddressIsOwner`), the
guardian still can recover, and the owner repairs it with `propose_change` then
`apply_change` after the delay.

The guardian keeps its cancel on that repair too. On a vault with safe equal to
owner and a guardian, a hostile guardian can freeze the vault and cancel every
repair, leaving only the guardian able to release funds, through `recover` to
the owner wallet. No theft is possible: the owner key alone cannot recover or
close to itself, and the guardian can only pay the owner. Repair any vault with
safe equal to owner before this upgrade is deployed, while the current devnet
program still lets the owner recover to itself. No vault documented in
[DEVNET.md](DEVNET.md) has safe equal to owner: the demo vault
`7BNXEuccpJVHuDgCSRZ3TsBovkHe9tJSC5qcHytWbwy8` and the legacy vault
`8n9EcgXwSWVbQgnunw6oin8hYcpRDr1CkkvozhpiAyVj` (issue #368) have safe equal to
guardian, and the Hold journey vaults use a freshly generated safe address.

These checks compare keys only. A safe address that is a different wallet the
guardian (or the owner) also controls cannot be detected on chain.

On a vault with safe equal to the guardian or the owner, repair the safe
address before tightening any rule. `require_rules` runs on every proposal, so a
tightening proposal that keeps the old safe address is refused with
`SafeAddressIsGuardian` or `SafeAddressIsOwner`.
