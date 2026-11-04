#!/usr/bin/env bash
# Opt-in CI probe: prove a source change reuses lower-level layers and reaches the binary.
set -euo pipefail
fixture=specs/gh-150/fixtures/us-sales.csv
scratch="$(mktemp -d)"
container_id=''
cleanup() {
  cp "$scratch/original.csv" "$fixture"
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  rm -rf "$scratch"
}
cp "$fixture" "$scratch/original.csv"
trap cleanup EXIT
marker="cache_probe_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}"
printf '999999,2026-01-01,California,%s,1,1\n' "$marker" >> "$fixture"
start=$SECONDS
docker buildx build --platform linux/amd64 --load --progress plain \
  --tag workspace-api:cache-benchmark . > "$scratch/build.log" 2>&1 || {
    cat "$scratch/build.log"
    exit 1
  }
cat "$scratch/build.log"
printf 'Incremental image rebuild: %s seconds\n' "$((SECONDS - start))"
# The lower-level crate build must come from the previous build's layer cache.
layer="$(grep -E '^#[0-9]+ \[builder [^]]+\] RUN find backend/contracts ' "$scratch/build.log" | head -n 1 | cut -d ' ' -f 1)"
[[ -n "$layer" ]] && grep -Eq "^${layer} CACHED([[:space:]]|$)" "$scratch/build.log"
# This uniquely modified fixture is compiled into the product. Checking the final
# executable catches stale image layers even when Cargo or BuildKit reports a hit.
container_id="$(docker create --entrypoint /usr/local/bin/workspace-backend workspace-api:cache-benchmark runtime-info)"
docker cp "$container_id:/usr/local/bin/workspace-backend" "$scratch/workspace-backend"
grep -aFq "$marker" "$scratch/workspace-backend"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint /usr/local/bin/workspace-backend workspace-api:cache-benchmark runtime-info
printf 'Incremental layer and changed executable content verified.\n'
