# Releasing the SDKs and CLI to npm (FLIG-14)

Four packages are published to the public npm registry, all at the same version:

| Package | Contents |
|---|---|
| `@flightdeckhq/schema` | Event schema, limits, route normalization; ESM + `.d.ts` |
| `@flightdeckhq/worker` | `withFlightdeck`, `handleFlightdeck`, `flightdeck(env)`; ESM + `.d.ts` |
| `@flightdeckhq/browser` | `init`, `track`, `identify`; ESM + `.d.ts`, under 3 KB gzip |
| `@flightdeckhq/create` | The CLI, one bundled `dist/cli.js` with a shebang (Node 24+) |

Everything else in the workspace is `private` and never published. The code is
licensed MIT (`LICENSE` at the root, copied into each package).

## How the packages are built

- The libraries build with `tsc -p tsconfig.build.json` (TypeScript 7 emits JS
  and declarations) into `dist/`. The CLI builds with esbuild. `prepack` runs
  `build`, so `pnpm pack` and `pnpm publish` always ship a fresh `dist/`.
- In the workspace, each library's `exports` points at `src/index.ts`, so tests,
  typecheck, the apps and the examples use source and never need a build.
  `publishConfig.exports` replaces it in the packed manifest with
  `{ types: ./dist/index.d.ts, import: ./dist/index.js }`; pnpm applies it on
  `pack` and `publish`.
- Relative imports in library sources end in `.js`, so `dist/` loads in plain
  Node ESM and resolves under `moduleResolution: nodenext` as well as `bundler`.
- Workspace dependencies are `workspace:^`; pnpm rewrites them to `^<version>`.
- `files` limits each tarball to `dist/`, `README.md`, `LICENSE` and
  `package.json`.

`pnpm smoke:pack` ([`scripts/pack-smoke.sh`](../../scripts/pack-smoke.sh)) checks
all of this the way a user would: it packs every package, fails on any file
outside that list or a leftover `workspace:` range, installs the tarballs with
npm into a scratch project outside the workspace, typechecks a Worker using
`withFlightdeck` and `flightdeck(env).track` and a browser file calling `init`
(with TypeScript 5 and the repo's TypeScript), imports each library in Node, and
runs `@flightdeckhq/create --help` from the installed bin. CI runs it on every PR.

## Cutting a release

1. On a branch, set the version in all four packages and open a PR:

   ```bash
   pnpm release:version set 0.2.0
   ```

   `scripts/release-version.mjs` rewrites the `version` of every non-private
   package under `packages/`. Use a prerelease such as `0.2.0-rc.1` to publish
   under the `next` dist-tag instead of `latest`.
2. After it merges, tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0 <merge-sha> && git push origin v0.2.0
   ```

3. The tag starts [`.github/workflows/release.yml`](../../.github/workflows/release.yml).
   It fails unless every package is at the tag's version
   (`pnpm release:version check v0.2.0`), then runs lint, typecheck, tests, the
   build, the browser size check and the pack smoke test, and publishes with
   `pnpm -r publish --access public --no-git-checks --provenance`. pnpm publishes
   in dependency order and skips versions that are already on npm, so a failed
   run can be re-run.
4. Check the result: `npm view @flightdeckhq/worker version`, and the provenance
   badge on each package's npm page.

To rehearse without uploading, run the workflow by hand (Actions -> release ->
Run workflow) with `dry_run` checked; it runs every step and publishes with
`--dry-run`. A real publish only runs from a `v*` tag. Locally,
`pnpm -r publish --dry-run --no-git-checks --access public --json` lists each
tarball's files without credentials.

## Credentials

The workflow authenticates with a granular npm access token in the `NPM_TOKEN`
GitHub Actions secret (repository secret, or on the `npm` environment the job
runs in). Create it on npmjs.com as a granular token with an expiry, "bypass
two-factor authentication" enabled (CI cannot answer a 2FA prompt), and read and
write access to all packages, since the four packages do not exist yet. After
the first publish, narrow it to the `flightdeckhq` organization and the
`@flightdeckhq/create` package, or switch to trusted publishing (below). The
job writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` to `~/.npmrc`;
pnpm expands the variable when it reads the file, so the token is never written
to disk or logged. The `id-token: write` permission lets npm sign provenance.

The npm organization `flightdeckhq` and the `NPM_TOKEN` secret are set up. To
publish 0.1.0, run the workflow once with `dry_run`, then push `v0.1.0`. If the
token expires or is revoked, create a new one as above and replace the secret.

## Switching to trusted publishing (OIDC)

Once the packages exist on npm, replace the long-lived token with npm trusted
publishing, which mints a short-lived credential from the workflow's OIDC token:

1. On npmjs.com, for each of the four packages: Settings -> Trusted publishing
   -> GitHub Actions, repository `gmackie/flightdeck`, workflow `release.yml`,
   environment `npm`.
2. In `release.yml`, delete the `NODE_AUTH_TOKEN` env, the empty-token check and
   the `~/.npmrc` line. Keep `id-token: write`. Trusted publishing needs a
   recent npm CLI; if pnpm's own publish does not support it yet, publish each
   tarball from `pnpm -r pack` with `npm publish <tgz> --access public` instead.
   Provenance is generated automatically with trusted publishing.
3. Cut a release, confirm it published, then delete the `NPM_TOKEN` secret and
   revoke the token on npmjs.com. Optionally set each package to "require
   two-factor authentication and disallow tokens".
