# Build instructions

These instructions reproduce, byte for byte, the extension package submitted
to addons.mozilla.org.

## Required environment

| Requirement | Value |
|---|---|
| Operating system | Any (Linux, macOS or Windows). The submitted build was made on Windows 11. |
| Node.js | v20 or later. The submitted build used v24.6.0. Install from https://nodejs.org/ (LTS installer) or via your package manager. |
| npm dependencies | **None.** The build scripts import Node built-in modules only, so `npm install` is *not* required to build the extension. |
| Other tools | None. No compiler, no bundler, no task runner. |

## Steps

```sh
git clone https://github.com/Fredo0xJtl/Comparateur-de-Paniers
cd Comparateur-de-Paniers
sh build.sh
```

`build.sh` is the install/build script: it performs every step, and there are
no prerequisite steps beyond installing Node.js. It runs:

```sh
node tools/build-firefox-extension.mjs   # assembles dist/extension-firefox/
node tools/package-firefox-extension.mjs # zips it into release-assets/
```

On Windows without a POSIX shell, run those two commands directly.

## Output

```
release-assets/comparateur-de-paniers-connecteur-drive-<version>.zip
```

`<version>` is the `version` field of `extension/manifest.json`. Compare this
file with the submitted package.

## What the build does

Source files are **not** transpiled, concatenated, minified or otherwise
machine-generated. Every JavaScript, HTML and CSS file in the package is the
human-readable file found under `extension/` in this repository, copied
verbatim.

The build script performs exactly three transformations:

1. **`manifest.json`** is written from `extension/manifest.json` with the
   development origins (local dev server, LAN addresses) removed. A production
   build aborts if any development origin survives the filter.
2. **`shared/bridge-origins.js`** is generated. It contains a single constant,
   `BRIDGE_ORIGIN_PATTERNS`, the runtime origin allowlist the service worker
   checks before accepting any message.
3. **`*.test.js` files are excluded** from the package.

Everything else is identical to the repository contents.

## Verifying the package

```sh
node tools/validate-extension.mjs   # refuses dev origins, test ids, test files
node tools/privacy-check.mjs        # asserts the package contains no network call
```
