# TiDB AgentSpace

**A persistent space for AI agents.**

Give your agent a place to work with files and data across sessions. Connect Codex CLI, Claude Code, Pi, or another external agent with scoped access, then reopen the saved work in Studio. Studio and agents use the same Rust API.

AgentSpace currently provides PostgreSQL-compatible databases, persistent File Systems, and resource/action permissions through Workspace Keys. Agents run in their own tools. Agent identity, online status, hosted agent execution, Runs, and Memory are not implemented.

## Get your first result

1. Open [Home in Studio](https://drive9.ai/studio/#overview) and sign in or choose **Try without an account**. A new Workspace prepares a default File System; temporary workspaces expire after 48 hours.
2. Select **Try with an agent** in the US sales sample. The existing sales journey saves a CSV and lets you grant only its File System and the required actions.
3. Follow the key handoff to start your external agent. Keep the key in its environment or secret settings, outside chat.
4. Ask the agent to analyze the sample and save the report. Open the report in Studio, then return to **Files** to find the saved result in a later session. A report file's existence alone does not verify which agent wrote it.

Home links to saved resources and resumable quickstarts. **Agents** explains connection, **Files** and **Databases** open resource collections, and **Access** manages Workspace Keys. **More** contains Quickstarts, Developers, Usage, and Settings. Existing Studio URLs and Workspace APIs remain supported.

## Run your first query

1. Open the [Database tutorial in Studio](https://drive9.ai/studio/#tutorials?kind=database) and sign in.
2. Choose an existing PostgreSQL-compatible database or select **Create database** and finish creation. The tutorial opens with your database selected.
3. Select **Load sample orders**, then **Run tutorial query**. The six orders total **510** in sales across three regions: AMER 90, APAC 240 and EMEA 180.
4. Open the database's SQL workspace to edit the query and explore the table.

For files, open the [File System tutorial](https://drive9.ai/studio/#tutorials?kind=filesystem). Choose or create a File System and follow the steps to save, preview and query the sample CSV.

## Connect an agent

In Studio, open **Agents** for the setup guide, or **Access** to create a Workspace Key and select the actions and resources the agent needs. Save the revealed secret in the agent's secret store. Exchange it at the Global API for a short-lived Region access Token, then call the Region API with that Token. The [API guide](docs/api-guide.md) includes requests for discovery, exchange and renewal. Key administration uses Owner authentication.

### API clients

Download a client and copy a list-resources example from [Studio Developers](https://drive9.ai/studio/#api). Both clients use a Workspace endpoint and a scoped API key.

| Language   | Source in this repository                                                                                                         | Runtime                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| JavaScript | [TypeScript source](src/clients/javascript/workspace-agent.ts) · [Single-file download source](src/generated/workspace-agent.mjs) | Node.js 24+                   |
| Python     | [Single-file source](src/clients/python/workspace_agent.py)                                                                       | Python 3.9+, standard library |

## Local setup

Install the [pinned Rust toolchain](rust-toolchain.toml) and make `rustfs` 1.0.4, `curl` and `tar` available on your path. From the repository root:

```sh
cargo run --locked -p workspace-build-tools -- prepare
cargo build --locked -p workspace-backend
./meta-service/target/debug/workspace-backend local init --directory .data/meta-runtime --api-port 4318
./meta-service/target/debug/workspace-backend local serve --directory .data/meta-runtime
```

The last command runs in the foreground. In another terminal, run `curl --fail http://127.0.0.1:4318/api/health` to check the API. Stop the local stack with Ctrl-C and run `local serve` again to reopen it. `local init` is a one-time operation. Keep the runtime directory private. It contains storage credentials and encryption keys.

To use the optional React Console, install the Node and npm versions pinned in [.node-version](.node-version) and [package.json](package.json), then run:

```sh
npm ci
npm run dev:console
```

Open [the local Console](http://127.0.0.1:5173). A new local Workspace starts empty with local demo files enabled. To create real resources, configure `product.providers.postgresProvider` as `db9-anonymous` or `product.providers.filesProvider` as `drive9-anonymous` in the private `.data/meta-runtime/rust-api.json` before starting the stack. Creating a resource provisions a real trial. See [PostgreSQL setup and limits](docs/db9-postgres.md) and [File System provisioning](docs/decisions/0004-drive9-anonymous-provider.md).

## OpenAPI and development

```sh
cargo run --locked -p workspace-openapi -- export
cargo run --locked -p workspace-openapi -- check
```

Rust generates the Agent, Owner and operator contracts. The [API guide](docs/api-guide.md) explains which contract and credentials to use. For contributor setup, acceptance tests and delivery checks, see [CONTRIBUTING.md](CONTRIBUTING.md).

| Looking for                                      | Start here                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| API executable, local commands and deployment    | [Rust host](backend/host/) · [runtime guide](docs/rust-backend.md) · [hosted Studio](docs/native-studio-deployment.md) |
| HTTP handlers, OpenAPI and product operations    | [API](backend/api/) · [OpenAPI](backend/openapi/) · [product](backend/product/)                                        |
| Workspace permissions and metadata storage       | [Workspace](backend/workspace/) · [Meta](meta-service/) · [metadata architecture](docs/slatedb-metadata-design.md)     |
| Console and generated client                     | [React application](src/) · [API client](src/api/)                                                                     |
| Product status, limitations and design decisions | [start-here.md](start-here.md) · [architecture](docs/architecture.md)                                                  |

## Project name

The repository is [mem9-ai/tidb-agentspace](https://github.com/mem9-ai/tidb-agentspace). The service domain and existing API, SDK, skill URLs, and local helper identifiers remain unchanged. TiDB AgentSpace is the selected project name; potential confusion with Google’s historical Agentspace branding remains a consideration before broad launch. This implementation does not establish trademark clearance.

## License

TiDB AgentSpace is licensed under the [Apache License, Version 2.0](LICENSE). Third-party components retain their respective licenses.
