# ADR 0001: Modular monolith with lightweight hexagonal boundaries and a deterministic functional core

- **Status:** Accepted
- **Scope:** Whole codebase, starting in Phase 1

## Context

ThirdMind coordinates a multi-round debate between a human and two AI participants. The final product will integrate with existing ChatGPT and Claude browser sessions. Those integrations are fragile and slow, and they can fail or be interrupted part-way through. The extension runs on Chrome Manifest V3, whose background service worker can be terminated at any time.

Phase 1 replaces the real integrations with deterministic simulators. The simulators must be replaceable later without rewriting the debate logic.

The forces at play:

- **Correctness under interruption.** Pauses, restarts and late results must never produce duplicate rounds, skipped dependencies or silently re-sent messages.
- **Testability.** The rules of the debate (phases, dependencies, stopping, pausing) must be checkable without a browser.
- **Replaceable integrations.** Provider adapters will change often, and the debate rules should not.
- **Small team, open source.** The structure must be easy for a reviewer to understand. Heavy layering or frameworks would cost more than they return.

## Decision

1. **One deployable (modular monolith).** The extension is a single WXT project with one `package.json`. Modules are directories with explicit public entry points (`index.ts`), not separate packages or services.
2. **A pure functional core.** The debate is modelled as serializable state plus events:
   - `evolve(state, event)` is a pure transition. It never mutates, reads clocks or generates identifiers.
   - `decide(state)` is a pure policy that returns commands describing the next work.
   - Time and identifiers are inputs carried by events.
3. **An imperative shell.** `application/debate-runner.ts` serializes all changes, turns commands into events, persists checkpoints (write-ahead before side effects), and calls providers.
4. **Lightweight hexagonal ports.** External capabilities are small TypeScript interfaces in `ports/`: `ContributionProvider`, `CheckpointStore`, `Clock` and `IdGenerator`. There is no dependency-injection framework, no repositories and no controller layer. The composition root (`extension/background-host.ts`) wires plain objects together.
5. **Boundaries enforced by lint.** `no-restricted-imports` rules in `eslint.config.js` stop the domain and application layers from importing React, WXT, Chrome APIs or infrastructure.

## Consequences

**Positive**

- The whole state machine is unit-tested in Node, with no browser or timing dependencies.
- Duplicate and late events are handled explicitly (`ignored` versus `rejected`), which makes recovery behaviour reviewable.
- Simulators and future live adapters are interchangeable behind `ContributionProvider`.
- Session state round-trips through JSON, which is what makes MV3 checkpointing straightforward.

**Negative and trade-offs**

- There is more ceremony than calling providers directly from UI code. Events, commands and the runner loop must be understood.
- Every state change copies immutable data. This is negligible at debate scale (a few dozen contributions).
- Each new provider capability needs a port change first, which is deliberate friction.

**Neutral**

- If a later phase needs a separate process (for example, a native host), the ports already describe what crosses that boundary.

## Alternatives considered

- **React state plus effects driving the debate in the side panel.** Rejected. It ties the debate lifecycle to the UI lifecycle, and closing the panel would stop the debate. It is also hard to test deterministically.
- **A state-machine library (for example, XState).** Rejected for Phase 1. The machine is small, and a hand-written discriminated union keeps the dependency footprint minimal and the semantics explicit. This can be revisited if the machine grows substantially.
- **Multiple packages in a monorepo (`core`, `extension`, `ui`).** Rejected as premature. It would add build and release tooling with no current consumer of the packages on their own.
