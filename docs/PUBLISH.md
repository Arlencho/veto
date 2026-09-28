# Publishing the SDK and companion CLI

Version 0.1.0 of both packages was published to npm on 2026-09-27. The steps below are for the next release.

Version 0.1.1 of both packages is prepared for release: the manifests, lockfiles, MCP server
version and changelogs say 0.1.1, and it is not on npm until the founder runs the commands below.
The READMEs keep stating 0.1.0 as the published version until then. After both 0.1.1 registry
checks pass, change those README lines (root `README.md`, `sdk/README.md`, `cli/README.md`) and
the other docs that name 0.1.0 as the npm version.

Only the founder runs the publish commands below, from an approved checkout,
using an npm account authorized for the `@veto-hq` scope and its two-factor code.
Use Node 22 or newer, matching the package engines and CI.

## Prepare and inspect

From the repository root:

```bash
cd sdk
npm ci
npm run prepublishOnly
npm run typecheck
npm pack --dry-run
cd ../cli
npm ci
npm run prepublishOnly
npm run typecheck
npm pack --dry-run
cd ..
```

`npm pack --dry-run` does not run `prepublishOnly`, so run the checks explicitly.
Each build deletes its old `dist` output first and disables source maps.
The SDK builds to `dist/src` and copies its runtime IDL into `dist/idl`.
The `files` whitelist permits only `dist`, `README.md` and `LICENSE` (the full
Apache License 2.0 text, a copy of the repository `LICENSE`); npm also includes
`package.json` automatically. Changelogs remain in the repository.
Reject a file list containing keys, `.env` files, tests, fixtures, source maps,
or anything outside those allowed paths. Inspect the listed files for secrets
and local paths before publishing.

The CLI manifest depends on registry version `@veto-hq/agent-sdk@0.1.1`.
Its development lockfile retains a link to `../sdk` at that version, so `npm ci`
works before the SDK release is on the registry. Build the SDK first. The lockfile is not shipped;
consumers resolve the registry dependency. Do not regenerate the CLI lockfile
against the registry until the SDK release exists there.

## Founder release commands

From the repository root, publish the SDK first. These commands prompt for the
founder's fresh two-factor code when npm requests it. Do not put the code in a
file or command history. The founder must already be authenticated with npm.

```bash
cd sdk
npm publish --access public
npm view @veto-hq/agent-sdk@0.1.1 version
cd ../cli
npm publish --access public
npm view @veto-hq/veto@0.1.1 version
cd ..
```

Each publish runs `prepublishOnly`, which rebuilds and runs that package's tests.
Stop if either publish or version lookup fails. Publish the CLI only after the
SDK version lookup returns `0.1.1`.

## Verify the registry release

After both packages are published, use a fresh directory outside the checkout:

```bash
mkdir veto-npm-check
cd veto-npm-check
npm init -y
npm install @veto-hq/agent-sdk@0.1.1 @veto-hq/veto@0.1.1
node --input-type=module -e 'import { VetoAgent, HoldVault } from "@veto-hq/agent-sdk"; console.log(typeof VetoAgent, typeof HoldVault)'
npx veto --help
```

The import should print `function function`. The CLI should print its help.
These checks do not charge a rule or access a phone. The 0.1.1 changelogs are
dated 2026-09-28; correct the date if the publish happens on another day. Change
the README version lines only after both registry checks pass.
