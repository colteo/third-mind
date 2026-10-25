# Architecture overview

ThirdMind is a single Chrome extension. Inside it, the code is a **modular monolith**: one build and one deployable, split into modules with explicit boundaries. The debate logic is a **pure functional core** surrounded by a thin imperative shell. External capabilities sit behind **ports** in the lightweight hexagonal style.

The reasoning behind this structure is recorded in [ADR 0001](../adr/0001-modular-monolith-functional-core.md).

## Directory layout

```text
src/
├── domain/            Pure debate model (types, events, commands, evolve, decide, stopping policy) and conversation link model
├── ports/             Interfaces for external capabilities (providers, checkpoints, clock, ids, tabs, URL recognition, connection store)
├── application/       Debate runner and connection coordinator (imperative shells), read models
├── infrastructure/
│   ├── simulator/     Deterministic GPT and Claude simulators (temporary, Phase 1)
│   ├── conversation-urls.ts        Provider URL rules (Phase 2.1)
│   ├── memory-connection-store.ts
│   └── memory-checkpoint-store.ts
├── extension/         Chrome integration: protocol, background host, side panel client, storage and Tabs API adapters
├── ui/                React side panel interface
├── entrypoints/       WXT entrypoints (background service worker, side panel page)
└── test-support/      Test fixtures (not shipped, excluded from coverage)
```

WXT expects entrypoints in `src/entrypoints/` (configured via `srcDir: 'src'`). Entrypoints contain no logic. They only call into `extension/` and `ui/`.

## Module responsibilities

| Module           | Responsibility                                                                                     | May depend on                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `domain`         | Session state, invariants, `evolve(state, event)`, `decide(state)`, stopping policy, request building; conversation link model and transitions | nothing                                                               |
| `ports`          | `ContributionProvider`, `CheckpointStore`, `Clock`, `IdGenerator`, `TabSource`, `ConversationRecognizer`, `ConnectionStore` | `domain` (types)                                                      |
| `application`    | `createDebateRunner` (serializes events, executes commands, persists checkpoints); `createConnectionCoordinator` (tab discovery, reconciliation, link commands); read models | `domain`, `ports`                                                     |
| `infrastructure` | Port implementations without Chrome: simulator providers, provider URL rules, in-memory stores     | `domain`, `ports`                                                     |
| `extension`      | Composition root in the service worker; typed messaging; `storage.session` adapters; Tabs API adapter | `domain`, `ports`, `application`, `infrastructure`, `wxt`             |
| `ui`             | Side panel React components                                                                        | `domain`, `application` (read models), `extension` (protocol, client), `infrastructure/simulator/scenarios` (labels only) |

These rules are enforced by `no-restricted-imports` in `eslint.config.js`. In particular, `domain`, `ports`, `application` and `infrastructure` cannot import React, WXT or Chrome APIs.

## Dependency direction

```text
            ui ───────────────┐
             │                │
             ▼                ▼
        extension ───► application ───► ports ───► domain
             │                                       ▲
             └──────► infrastructure ────────────────┘
```

Every arrow points toward the domain. The domain depends on nothing.

## Runtime contexts

```text
┌────────────────────────── Chrome ──────────────────────────┐
│                                                            │
│  Side panel page (React)         Background service worker │
│  ┌──────────────────────┐ Port   ┌───────────────────────┐ │
│  │ ui/ + side-panel-    │◄──────►│ extension/background- │ │
│  │ client               │ typed  │ host (composition     │ │
│  └──────────────────────┘ msgs   │ root)                 │ │
│                                  │   └ application/runner│ │
│                                  │       ├ domain        │ │
│                                  │       └ simulator     │ │
│                                  └──────────┬────────────┘ │
│                                             │              │
│                                   chrome.storage.session   │
│                                   (operational checkpoint) │
└────────────────────────────────────────────────────────────┘
```

The debate runs in the background service worker, not in the side panel. Closing the panel does not stop a debate, and the panel only renders snapshots that it receives. See [runtime-and-recovery.md](runtime-and-recovery.md).

The connection coordinator (Phase 2.1) also runs in the service worker, next to the debate runner but independent of it. It reads open tabs through `chrome.tabs` and stores links in `chrome.storage.session` under its own key. See [conversation-links.md](conversation-links.md).

## Replacing the simulator

The simulator implements `ContributionProvider`. A later live adapter (for example, one that talks to a connected ChatGPT tab through a content script) will:

1. implement `ContributionProvider` with `origin: 'live'`;
2. be registered by the composition root (`extension/background-host.ts`) in `createProviders`;
3. add a new `ProviderType` member for its participants.

The domain and application layers stay unchanged. The operation identifier passed in every request is stable, and live adapters should use it for idempotency or deduplication where the target supports that.

## Further reading

- [Debate engine](debate-engine.md): state machine, events, commands, stopping policy, operation lifecycle.
- [Runtime and recovery](runtime-and-recovery.md): MV3 lifecycle, messaging, checkpoints, reconciliation.
- [Conversation links](conversation-links.md): Phase 2.1 tab discovery, link lifecycle, permissions.
- [Testing](testing.md): test strategy and coverage.
