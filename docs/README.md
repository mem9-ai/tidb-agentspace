# TiDB AgentSpace documentation

| To understand or run                                  | Start here                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| First local Workspace                                 | [Local setup and health check](../README.md#local-setup)                                                                                     |
| Product architecture, supported resources and roadmap | [Architecture](architecture.md), [public resource kinds](decisions/0058-public-resource-kinds.md)                                            |
| Backend modules and data flow                         | [Rust crate map](rust-backend.md#modules)                                                                                                    |
| Metadata startup, transactions and writer recovery    | [Running Meta Service](meta-service.md), [SlateDB design and implementation status](slatedb-metadata-design.md#implementation-and-iteration) |
| Global and regional APIs                              | [API guide](api-guide.md), [Global entry](global-public-api.md), [regional Tokens](regional-token-api.md)                                    |
| Console and hosting                                   | [React Console](../src/README.md), [independent delivery](independent-delivery.md)                                                           |
| Contribution and verification                         | [Contributor guide](../CONTRIBUTING.md), [engineering standards](standards/README.md)                                                        |

The [decision index](decisions/README.md) links accepted choices and their amendments. Dated verification reports record what ran against a particular revision. The [deprecated archive](deprecated/README.md) preserves retired designs, operating instructions and measurements with links to their replacements.
