# Native integration and operator tooling

The product backend is Rust under `backend/` and `meta-service/`. The old Node business
implementation, JSON/vault store, provider adapters, workers, SSO and dedicated regression
tests were removed in GH-34. Do not add another business backend here.

This directory retains ESM tooling only:

- `dev.mjs` starts the Console and the explicitly configured Rust API.
- `generate-openapi.mjs` generates the public description from schema-only modules in
  `tools/api-contract/`; it imports no business runtime.
- `meta/` orchestrates local native roles and isolated RustFS storage, and supplies the
  metadata client used by operator/test tools. It does not serve product requests.
- `rust-*.test.mjs`, `contract.test.mjs`, `meta-service.test.mjs` and
  `local-runtime.test.mjs` exercise actual native executables using isolated temporary S3.
- `test-support/` contains synthetic records, mock external provider responses and native
  process/test helpers. These are never product startup defaults or a behavioral oracle.

Run `npm run check` and `npm run backend:check`. Native HTTP contract coverage runs in
the latter gate, including its all-operation coverage assertion. See
[retirement and verification](../docs/native-backend-retirement.md).
