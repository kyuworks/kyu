#!/usr/bin/env bash
# Source this file from a gate wrapper whose .mjs module imports the `yaml` package.

# require_yaml_package <script dir> — exits 1 with the fix when `yaml` cannot be resolved from it.
require_yaml_package() {
  if ! node -e "require.resolve('yaml', { paths: [process.argv[1]] })" "$1" 2> /dev/null; then
    echo "FAIL: the workflow reader stopped before it checked every file; the yaml package is missing, run pnpm install" >&2
    exit 1
  fi
}
