# API and Console remain independent. Node is build tooling only in the preparation stage.
FROM node:24.22.1-bookworm-slim AS duckdb
WORKDIR /source
COPY scripts/prepare-duckdb.mjs scripts/duckdb-runtime.json ./scripts/
RUN node scripts/prepare-duckdb.mjs

FROM rust:1.99.1-bookworm AS chef
RUN cargo install --locked --version 0.1.77 cargo-chef
WORKDIR /source
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_RELEASE_DEBUG=0

# A source-only edit changes the planner layer but leaves its dependency recipe identical.
FROM chef AS planner
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo ./.cargo
COPY backend ./backend
COPY meta-service ./meta-service
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY .cargo ./.cargo
COPY rust-toolchain.toml ./
COPY scripts/duckdb-runtime.json ./scripts/duckdb-runtime.json
COPY --from=duckdb /source/.data/duckdb-native/2.0.0 ./.data/duckdb-native/2.0.0
COPY --from=planner /source/recipe.json ./recipe.json
# Export this ordinary layer too: cache mounts alone are not persisted by the GHA backend.
RUN cargo chef cook --release --locked --target-dir /source/meta-service/target \
    -p workspace-backend --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
# Keep stable lower-level crates in separately cached layers. Every layer builds
# real sources (not cargo-chef's dependency skeleton) with the final toolchain.
COPY backend/contracts ./backend/contracts
COPY backend/meta-client ./backend/meta-client
COPY backend/workspace ./backend/workspace
COPY backend/identity ./backend/identity
COPY backend/providers ./backend/providers
COPY backend/execute ./backend/execute
COPY meta-service ./meta-service
RUN find backend/contracts backend/meta-client backend/workspace backend/identity \
    backend/providers backend/execute meta-service -type f -exec touch {} + \
    && cargo build --release --locked --lib --target-dir /source/meta-service/target \
    -p workspace-providers -p workspace-execute -p workspace-meta-service

COPY backend/product ./backend/product
COPY specs/gh-150/fixtures/us-sales.csv ./specs/gh-150/fixtures/us-sales.csv
RUN find backend/product -type f -exec touch {} + \
    && cargo build --release --locked --lib --target-dir /source/meta-service/target -p workspace-product

COPY backend/api ./backend/api
COPY public/openapi.json public/owner-openapi.json public/global-openapi.json public/agent-entry-openapi.json ./public/
RUN find backend/api -type f -exec touch {} + \
    && cargo build --release --locked --lib --target-dir /source/meta-service/target -p workspace-api

# Copy the complete workspace for the final binary, including any new crates.
COPY backend ./backend
COPY meta-service ./meta-service
RUN find backend/host -type f -exec touch {} + \
    && for manifest in backend/*/Cargo.toml; do \
      case "$manifest" in \
        backend/contracts/*|backend/meta-client/*|backend/workspace/*|backend/identity/*|backend/providers/*|backend/execute/*|backend/product/*|backend/api/*|backend/host/*) ;; \
        *) find "$(dirname "$manifest")" -type f -exec touch {} + ;; \
      esac; \
    done \
    && cargo build --release --locked --target-dir /source/meta-service/target -p workspace-backend \
    && /source/meta-service/target/release/workspace-backend runtime-info

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 workspace && useradd --uid 1000 --gid 1000 --no-create-home workspace
WORKDIR /app
COPY --from=builder /source/meta-service/target/release/workspace-backend /usr/local/bin/workspace-backend
USER 1000:1000
EXPOSE 4318
# Private native plan/config/secrets are mounted separately. Missing config fails closed.
ENTRYPOINT ["workspace-backend"]
CMD ["serve", "--config", "/run/workspace/deployment.json"]
