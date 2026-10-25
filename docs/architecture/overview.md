# Architecture overview

ThirdMind is a free, open-source, browser-first Chrome extension intended to orchestrate debates between existing or empty ChatGPT and Claude browser conversations. It requires no API keys, local provider bridge, paid APIs, or hosted backend. The two execution modes are **Simulation** and **Browser Conversations** (internal mode `live`). Browser Conversations currently supports linking, identity tracking, and page diagnostics; autonomous submission and reply acquisition remain unavailable and preflight blocks execution.

The code is a **modular monolith**: one build and one deployable, split into modules with explicit boundaries. The debate logic is a **pure functional core** surrounded by a thin imperative shell. External capabilities sit behind **ports** in the lightweight hexagonal style. The shared runner, checkpoints, uncertain outcomes, operation correlation, durable claims, and duplicate protection serve browser execution and controlled tests without a provider backend.

The [browser exchange fixture](browser-message-exchange-fixture.md) is a controlled local browser test using real Chrome messaging and synthetic pages, not live provider integration. Its harness and durable operation journal remain independent of production consumer-site capabilities.

The reasoning behind this structure is recorded in [ADR 0001](../adr/0001-modular-monolith-functional-core.md).

## Directory layout

```text
src/
├── domain/            Pure debate model (types, events, commands, evolve, decide, stopping policy) and conversation link model
├── ports/             Interfaces for external capabilities (providers, checkpoints, clock, ids, tabs, URL recognition, connection store, page transport)
├── application/       Debate runner and connection coordinator (imperative shells), read models
├── infrastructure/
│   ├── simulator/     Deterministic GPT and Claude simulators (temporary, Phase 1)
│   ├── conversation-urls.ts        Provider URL rules (Phase 2.1)
│   ├── provider-pages.ts           Provider page readiness rules (Phase 2.2B foundation)
│   ├── memory-connection-store.ts
│   └── memory-checkpoint-store.ts
├── extension/         Chrome integration: protocol, background host, side panel client, storage and Tabs API adapters,
│                      provider transport (worker side) and provider content script
├── ui/                React side panel interface
├── entrypoints/       WXT entrypoints (background service worker, side panel page, ChatGPT and Claude content scripts)
└── test-support/      Test fixtures (not shipped, excluded from coverage)
```

WXT expects entrypoints in `src/entrypoints/` (configured via `srcDir: 'src'`). Entrypoints contain no logic. They only call into `extension/` and `ui/`.

## Module responsibilities

| Module           | Responsibility                                                                                     | May depend on                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `domain`         | Session state, invariants, `evolve(state, event)`, `decide(state)`, stopping policy, request building; conversation link model and transitions | nothing                                                               |
| `ports`          | `ContributionProvider`, `CheckpointStore`, `Clock`, `IdGenerator`, `TabSource`, `ConversationRecognizer`, `ConnectionStore`, `ProviderPageTransport` | `domain` (types)                                                      |
| `application`    | `createDebateRunner` (serializes events, executes commands, persists checkpoints); `createConnectionCoordinator` (tab discovery, reconciliation, link commands); read models | `domain`, `ports`                                                     |
| `infrastructure` | Port implementations without Chrome: simulator providers, provider URL rules, provider page readiness rules, in-memory stores | `domain`, `ports`                                                     |
| `extension`      | Composition root in the service worker; typed messaging; `storage.session` adapters; Tabs API adapter; provider page transport and content script logic | `domain`, `ports`, `application`, `infrastructure`, `wxt`             |
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
│                                                            │
│  chatgpt.com / claude.ai tab (top frame, isolated world)   │
│  ┌──────────────────────┐ tabs.sendMessage / answer        │
│  │ provider content     │◄────────────────► service worker │
│  │ script (readiness    │ runtime.sendMessage (page-hello) │
│  │ only)                │─────────────────► (transport)    │
│  └──────────────────────┘                                  │
└────────────────────────────────────────────────────────────┘
```

The debate runs in the background service worker, not in the side panel. Closing the panel does not stop a debate, and the panel only renders snapshots that it receives. See [runtime-and-recovery.md](runtime-and-recovery.md).

The connection coordinator (Phase 2.1) also runs in the service worker, next to the debate runner but independent of it. It reads open tabs through `chrome.tabs` and stores links in `chrome.storage.session` under its own key. See [conversation-links.md](conversation-links.md).

The provider page transport (Phase 2.2B foundation) runs in the service worker too and talks to small content scripts in the ChatGPT and Claude tabs. It only reads page readiness, is independent of the debate and of the link state, and is wired by the composition root. See [provider-transport.md](provider-transport.md).

## Replacing the simulator

The simulator implements `ContributionProvider`. A later live adapter (for example, one that talks to a connected ChatGPT tab through the provider page transport) will:

1. implement `ContributionProvider` with `origin: 'live'`;
2. be registered by the composition root (`extension/background-host.ts`) in `createProviders`;
3. add a new `ProviderType` member for its participants.

The domain and application layers stay unchanged. The operation identifier passed in every request is stable, and live adapters should use it for idempotency or deduplication where the target supports that.

## Further reading

- [Debate engine](debate-engine.md): state machine, events, commands, stopping policy, operation lifecycle.
- [Runtime and recovery](runtime-and-recovery.md): MV3 lifecycle, messaging, checkpoints, reconciliation.
- [Conversation links](conversation-links.md): Phase 2.1 tab discovery, link lifecycle, permissions.
- [Provider page transport](provider-transport.md): content scripts, trust boundaries, stale-answer protection, failure outcomes.
- [Testing](testing.md): test strategy and coverage.
