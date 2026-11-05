# The Scalar fork (the API explorer)

The engine's API docs page has a request builder ("Try it") that opens on one operation, prefilled from the OpenAPI document. It is
[Scalar](https://github.com/scalar/scalar)'s API client (MIT), **built from a fork of Scalar's source that this folder keeps**: an upstream
release pinned in `UPSTREAM`, the engine's changes to it as a short patch series in `patches/`, and `entry.ts`, which is ours and turns
Scalar's modal into the `window.ForgeExplorer` that `src/api-docs/contract.ts` describes. The build output is vendored, as it was before.

| Path                                      | What                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM`                                | The upstream repository, the release tag and the commit it must be. The build stops if the tag was moved.                      |
| `patches/NNNN-name.patch`                 | The engine's changes to upstream's source, in order, each with a header that says why. Applied with `git apply`.               |
| `entry.ts`                                | `window.ForgeExplorer` (`version`, `mount`), on top of Scalar's API client modal. Not a patch: it is a file upstream doesn't have. |
| `vite.config.ts`                          | Bundles `entry.ts` into one script and one stylesheet, and lists the packages inside the script (for the notices).             |
| `../vendor/scalar/explorer.js.br`         | The script (minified IIFE), brotli-compressed at quality 11.                                                                   |
| `../vendor/scalar/explorer.css.br`        | The stylesheet. The script loads it itself, from the URL beside its own (`explorer.js` -> `explorer.css`).                     |
| `../vendor/scalar/VERSION`                | `scalar <release> + <n> patches` (also `ForgeExplorer.version`), the upstream commit, the patches, and the sha256 of both files. |
| `../vendor/scalar/LICENSE`                | Scalar's MIT licence (from the pinned checkout).                                                                               |
| `../THIRD_PARTY_NOTICES.md`               | Every package inside the script, with its licence text. Written by the build; the build refuses a licence that isn't MIT, ISC, BSD, Apache-2.0 or alike. |

Nothing else of Scalar ships: not the API reference app (the engine has its own docs page), not the hosted features (telemetry, Ask AI and
the agent, the hosted client button, the proxy, web fonts). Those are either absent from the bundle or switched off by configuration; the
build fails if the bundle mentions a hosted Scalar service or loads anything from the network (`guardHostedFeatures` in
`scripts/update-scalar.ts`), and `test/explorer.test.ts` checks in a browser that a session makes no request to any host but the API's.

## Rebuilding

```bash
bun scripts/update-scalar.ts            # build, then write vendor/scalar/* and THIRD_PARTY_NOTICES.md
bun scripts/update-scalar.ts --check    # build, and fail when the vendored files differ from it (writes nothing)
bun scripts/update-scalar.ts --clean    # throw the cache away first: a fresh clone, install and build
```

The script clones upstream (shallow, the pinned tag) into `~/.cache/archlast-forge/scalar` (`FORGE_SCALAR_CACHE` moves it; keep it outside
this repository and any folder with a `node_modules/.bin` above it, because pnpm puts every ancestor's on `PATH` and upstream must build
with its own TypeScript), checks out the pinned commit clean, applies `patches/*.patch` in order (a patch that does not apply stops the build and
names it), installs upstream's dependencies with the pnpm version upstream pins (`pnpm install --frozen-lockfile`), builds the workspace
packages the API client uses, copies `entry.ts`, `vite.config.ts` and the contract's types into `packages/api-client/forge-explorer/` of
the checkout, and runs `vite build` there. Everything comes from the patched **source**, never from npm's dist files. It needs network, Git,
Node 22+ and `npx` (or `pnpm`/`bunx`). A first run takes a few minutes (about two on a fast machine); when `UPSTREAM` and the patches have
not changed, the dependencies are not built again and a run takes seconds.

## Updating upstream

1. Pick the release: `git ls-remote --tags https://github.com/scalar/scalar 'release-*'`, the newest (it is also GitHub's "latest release").
   `@scalar/api-client` in `packages/api-client/package.json` at that commit should be the version npm calls `latest`.
2. Rebase the patches onto it, in the cache checkout the build left:

   ```bash
   cd ~/.cache/archlast-forge/scalar/src
   git fetch --depth 1 origin tag <new-tag> && git checkout --detach <new-tag>
   git apply --3way <this repository>/packages/dashboard/scalar/patches/0001-*.patch   # one patch at a time; fix the conflicts, then:
   git diff -- packages/<the packages the patch touches> > the new 0001 patch    # keep its header text, see "Adding a patch"
   git checkout -- . && git clean -fdq                                              # back to pristine, and on to the next patch
   ```

   A patch that no longer applies means upstream rewrote that code: look at why the patch existed (its header) and whether upstream now
   does it itself. Delete the patch if so.
3. Put the new tag and commit in `UPSTREAM`, run `bun scripts/update-scalar.ts`, and read the diff of `entry.ts`' needs against upstream's
   `packages/api-client/src/v2/features/modal` (the modal's options, `createApiClientModal`) and `workspace-store`'s auth store, which
   `entry.ts` uses.
4. `cd packages/dashboard && bun test test/explorer.test.ts`, then commit `UPSTREAM`, the patches and the vendored files together, and
   add a line under "Unreleased" in `apps/docs/content/release-notes.mdx`.

## Adding a patch

Prefer configuration (a `ForgeExplorer` option mapped onto a Scalar option in `entry.ts`) over a patch: a patch is a cost on every update.
When upstream cannot do it, edit the pristine checkout in the cache (`git checkout -- . && git clean -fdq` first), then:

```bash
git diff --src-prefix=a/ --dst-prefix=b/ -- packages/ > /tmp/body.patch
```

and save it as `patches/NNNN-short-name.patch` with a header before the first `diff --git` line (`git apply` ignores text before it): a
`Subject:` line and a paragraph that says **why** (what the engine needs, what upstream does instead), which files it touches, and what to
do when it stops applying. Keep it small and local, so it merges cleanly: a `v-if`, a constant, not a refactor.

## What `ForgeExplorer.mount(el, options)` does with each option

Everything is Scalar's own configuration, except what a patch says. `el` should be a plain element near the end of `<body>`: the builder
is a `position: fixed` overlay and does not escape an ancestor with a `transform` or `filter`.

| Option                    | Maps to                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document`                | A structured clone, added to Scalar's workspace store as the one document. Without `servers` it gets `baseServerUrl` as its server.                                     |
| `baseServerUrl`           | Scalar's `baseServerURL`, and the server of a document that names none.                                                                                                 |
| `theme.mode`              | The `light-mode` / `dark-mode` class on the builder's root, which carry Scalar's colour set and `color-scheme`.                                                         |
| `theme.accent`            | `--scalar-color-accent` (and links, focus ring, selection tint).                                                                                                        |
| `theme.background`        | `--scalar-background-1`: the builder's surface. `surface` is `--scalar-background-2`; `-3` is `surface` mixed with `text`.                                              |
| `theme.text`, `muted`     | `--scalar-color-1` and `--scalar-color-2` (`-3` is `muted` toward the background); `--scalar-button-1` is `text`, its label `background`.                              |
| `theme.border`            | `--scalar-border-color`.                                                                                                                                                |
| `theme.font`, `monoFont`  | `--scalar-font`, `--scalar-font-code`. No web font is loaded: the page's own are used.                                                                                  |
| `theme.radius`            | `--scalar-radius` and the scale derived from it. Scalar's own tokens (`--scalar-*`) can also be set by CSS on `.forge-explorer`.                                         |
| `auth.preferredScheme`    | Scalar's `authentication.preferredSecurityScheme`, and the OAuth2 preset below applies to that scheme only (to every OAuth2 scheme when it is not given).               |
| `auth.oauth2.clientId`    | The flows' `x-scalar-client-id`: the Client ID field starts with it (the visitor can change it).                                                                         |
| `auth.oauth2.scopes`      | The flows' `selectedScopes`, those the flow declares.                                                                                                                    |
| `auth.oauth2.tokenUrl`    | The flows' `tokenUrl`; a path is resolved like a link on the API's server (`/oauth/token` is that server's origin).                                                                                                           |
| `auth.oauth2.extraParams` | The flows' `x-scalar-security-body`: upstream sends these form fields with the token request (RFC 8707 `resource`, `audience`, ...).                                     |
| `credentials`             | Scalar's auth store (`setAuthSecrets`): `http` -> bearer token or basic username and password, `apiKey` -> its value, `oauth2` -> client id and secret of the first flow the scheme has (client credentials preferred), and its access token, unless `expiresAt` is past. A scheme is selected first when it has credentials and `auth.preferredScheme` is not set. |
| `onCredentials`           | The auth store's change hook, de-duplicated: called with every credential the visitor enters or fetches, as `credentials` has them. `expiresAt` is `expires_in` of a token the builder fetched. |
| `codeSamples`             | Scalar's `hiddenClients`: every client except `curl` -> `shell/curl`, `node` -> `node/fetch`, `python` -> `python/requests`, `go` -> `go/native`, `php` -> `php/curl`, `ruby` -> `ruby/native`, `java` -> `java/okhttp`, `csharp` -> `csharp/httpclient`. The first is selected. Scalar lists clients in its own order. An operation's `x-codeSamples` are not touched. |
| `strings`                 | Scalar's localization overrides. Keys are the dot paths of Scalar's English text, `apiClient.<group>.<key>`, e.g. `apiClient.requestBlock.requestBody`; see `packages/api-client/src/v2/features/localization/translations.ts` in the checkout for the list. `{name}` placeholders keep working. |

Beyond the contract: a client-credentials token that has ended is fetched again, with the same request, before a request is sent (the
builder's `customFetch`, `tokenAwareFetch` in `entry.ts`); the visitor presses "Authorize" only the first time. Tokens of other flows
are not renewed on their own (upstream's own "Refresh" button does that when the server issued a refresh token).

`instance.onClose` is called when the visitor closes the builder (its close button, Escape, the backdrop), not when the page calls `close()`
or `destroy()`. `update()` takes effect on an open builder too: a new `document` replaces the one shown (the open operation re-renders), new
`credentials` replace those of the schemes they name (without calling `onCredentials`, which is only for what the visitor does).

Credentials live in memory only: Scalar's workspace store is created without a persistence plugin, so nothing is written to
`localStorage`, `sessionStorage` or IndexedDB, and a reload forgets everything the page didn't keep itself (`onCredentials` is how it does).

### The page's CSS

The stylesheet is loaded on first use and is Tailwind v4: its rules sit in `@layer`s. **A page's own unlayered CSS beats every layered
rule**, whatever the specificity, so an unlayered `* { margin: 0; padding: 0 }` or `button { ... }` on the host page would reach into
the builder. Put the page's stylesheet in a layer (`@layer docs { ... }`, or `@import url(...) layer(docs)`) declared before the builder
loads, or scope its element selectors under the page's own root, and mount the builder outside that root.

## Size

A single script and a stylesheet, loaded only when "Try it" is first pressed: about 3.3 MB of script (1.0 MB gzip, 0.81 MB brotli) and
165 KB of CSS (23 KB brotli). Most of it is Scalar's own code, the markdown and syntax-highlighting stack (`@scalar/code-highlight`, about a
quarter of the script), Radix Vue's components, CodeMirror, Zod and the Vue runtime; `bun scripts/update-scalar.ts` prints the sizes, and the
build's `licenses.json` (in the cache checkout, `packages/api-client/forge-explorer/dist`) has each package's share. A patch that swapped the
markdown renderer for something small is the one change that would shrink it a lot (and it is also the HTML sanitizer: not a light change).

## Tests

`cd packages/dashboard && bun test test/explorer.test.ts` loads the vendored script in Chromium (CHROMIUM_PATH, or a system chromium; the
test skips without one) against a small API on a local server: opening an operation, sending it with a bearer or API key credential, the
OAuth2 client-credentials flow with the preset (`resource`, Basic client authentication, token renewal), the theme reaching the CSS variables,
`update()`, `close()`/`onClose`, strings, code samples, and that no request leaves for any host but that server.

## Patches in the series

| Patch                                    | Why                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001-no-hosted-defaults.patch`          | The web layout defaults to Scalar's hosted proxy; the builder never uses that layout, but a default that sends credentials through a third party should not exist. OAuth2 form placeholders pointed at Scalar's demo server. |
| `0002-modal-empty-response-no-promotion.patch` | The empty response panel of the modal has a "Powered by scalar.com" link and ASCII art.                                                |

Upstream's own configuration already covers what the engine asked for, so it is not patched: the hosted client button (`hideClientButton`),
extra token parameters (`x-scalar-security-body`), the proxy (`proxyUrl`, unset), persistence (none unless a plugin is added), telemetry
(the PostHog plugin is only included by the API reference app).

## Licence

Scalar is MIT licensed (see `../vendor/scalar/LICENSE`, "Copyright (c) 2023-present Scalar"); the notice is kept with the build and in
`../THIRD_PARTY_NOTICES.md`, together with those of every package inside the script. `entry.ts`, `vite.config.ts` and the build script
are the engine's own.
