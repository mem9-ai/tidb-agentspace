# React Console

The Console is an independently served React and TypeScript application. [App.tsx](App.tsx) connects navigation and session state to the [feature workspaces](features/). To trace an interaction, start in its feature, follow the call into the [regional API client](api/region-client.ts) or [Global API client](api/global-client.ts), then find its handler in the [Rust API](../backend/api/).

[Shared UI adapters](ui/) own TiUI components and theme overrides. Keep authorization in the backend. The client renders permitted actions and handles service errors. Read the [frontend contribution notes](AGENTS.md) before changing components or styling.

Follow the [local setup](../README.md#local-setup) to start the native API. With the pinned Node and npm versions, run `npm ci` and `npm run dev:console` from the root. Use `npm run build:console` for a production build and [browser verification](../docs/standards/browser-verification.md) for a changed interaction.
