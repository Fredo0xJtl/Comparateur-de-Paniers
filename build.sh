#!/bin/sh
# Builds the Firefox extension package exactly as submitted to
# addons.mozilla.org. See BUILD.md.
#
# No prerequisite installation step is needed beyond Node.js v20+:
# the build scripts use Node built-in modules only.
set -e

node --version

node tools/build-firefox-extension.mjs
node tools/package-firefox-extension.mjs
