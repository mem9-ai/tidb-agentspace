#!/usr/bin/env bash
# Keep path-dependent Cargo artifacts from different source revisions in separate targets.
set -euo pipefail
destination=${1:?provide an output directory for the predecessor binaries}
revision=$(node -p "require('./tools/api-contract/compatibility-baseline.json').previousRuntime")
source_dir=$(mktemp -d)
trap 'rm -rf "$source_dir"' EXIT
git archive "$revision" | tar -x -C "$source_dir"
export CARGO_TARGET_DIR="$source_dir/target"
(
  cd "$source_dir"
  cargo run --locked -p workspace-build-tools -- prepare
  cargo build --locked -p workspace-backend -p workspace-meta-service --bins
)
mkdir -p "$destination"
cp "$CARGO_TARGET_DIR/debug/workspace-backend" "$CARGO_TARGET_DIR/debug/workspace-meta-service" "$destination/"
printf '%s\n' "$revision" > "$destination/source-revision"
