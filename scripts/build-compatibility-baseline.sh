#!/usr/bin/env bash
# Build the reviewed predecessor before building the candidate in the shared Cargo cache.
set -euo pipefail
destination=${1:?provide an output directory for the predecessor binaries}
root=$(git rev-parse --show-toplevel)
revision=$(node -p "require('./tools/api-contract/compatibility-baseline.json').previousRuntime")
source_dir=$(mktemp -d)
trap 'rm -rf "$source_dir"' EXIT
git archive "$revision" | tar -x -C "$source_dir"
export CARGO_TARGET_DIR="$root/meta-service/target"
(
  cd "$source_dir"
  cargo run --locked -p workspace-build-tools -- prepare
  cargo build --locked -p workspace-backend -p workspace-meta-service --bins
)
mkdir -p "$destination"
cp "$CARGO_TARGET_DIR/debug/workspace-backend" "$CARGO_TARGET_DIR/debug/workspace-meta-service" "$destination/"
printf '%s\n' "$revision" > "$destination/source-revision"
