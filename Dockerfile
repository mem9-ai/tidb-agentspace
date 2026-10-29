# API and Console remain independent. Node is build tooling only in the preparation stage.
FROM node:24.22.1-bookworm-slim AS duckdb
WORKDIR /source
COPY scripts/prepare-duckdb.mjs scripts/duckdb-runtime.json ./scripts/
RUN node scripts/prepare-duckdb.mjs

FROM rust:1.99.1-bookworm AS builder
WORKDIR /source
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_RELEASE_DEBUG=0
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo ./.cargo
COPY backend ./backend
COPY meta-service ./meta-service
COPY public/openapi.json ./public/openapi.json
COPY scripts/duckdb-runtime.json ./scripts/duckdb-runtime.json
COPY --from=duckdb /source/.data/duckdb-native/2.0.0 ./.data/duckdb-native/2.0.0
RUN cargo build --release --locked -p workspace-backend \
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
