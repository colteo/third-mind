# ThirdMind

ThirdMind is a free, open-source Chrome extension for **collaborative reasoning between a human, ChatGPT and Claude**. It does not simply show two chatbot answers side by side. It runs a **structured, multi-round debate**: the human sets the question and constraints, and the debate engine coordinates independent analysis, cross-examination, refinement and convergence.

> **Status: Phase 2.1 (conversation linking).** Debates still run in **simulation mode only**: every participant response is produced by a deterministic local simulator and is labelled as simulated. In addition, the side panel can **link** one open ChatGPT conversation and one open Claude conversation by tab. Linking only records which tab shows which conversation. ThirdMind does **not** read conversation contents, send messages or automate either website, and the simulated debate does not use linked conversations.

## What is implemented

- A Manifest V3 Chrome extension built with WXT, React and TypeScript (strict mode).
- A Chrome **side panel** UI with:
  - session setup: topic, optional constraints, simulation scenario;
  - a participant overview (Human, GPT Simulator, Claude Simulator);
  - phase progress and a debate timeline grouped by round;
  - controls (start, pause, resume, add constraint, reset) that reflect the actual engine state;
  - results as a **structured report** and a **conversational summary**, with disagreements and unresolved questions stated explicitly.
- A **pure, deterministic debate engine** (`evolve` and `decide`) with four logical rounds:
  1. Independent Analysis (both participants requested concurrently, neither sees the other)
  2. Cross-Examination
  3. Refinement
  4. Convergence
- **Adaptive stopping.** The engine may finish early only when every participant's structured assessment reports no material issues. This is never considered after round 1, and the maximum of four rounds is always enforced.
- **Human interruption.** Pause waits for in-flight work, constraints can be added while paused, and those constraints are included in every later request.
- **Side-effect safety.** Each provider request has a stable operation id, the dispatch is recorded before the provider is called (write-ahead), and in-flight work is never replayed automatically after a restart.
- **MV3 recovery.** An operational checkpoint in `chrome.storage.session` lets the debate survive service worker restarts.
- **Linked conversations (Phase 2.1).** A separate *Linked conversations* section in the side panel:
  - discovers open ChatGPT and Claude tabs with the Chrome Tabs API and classifies them by exact origin and URL pattern;
  - lists open conversations per provider and lets the human select and explicitly confirm one per provider (never automatically);
  - shows each link as *Linked*, *Unavailable* (temporary), *Stale* (the tab now shows something else) or *Disconnected* (the tab was closed);
  - supports **Disconnect**, explicit **Reconnect** to a tab that shows the same conversation, and **Refresh**;
  - keeps links current through tab events and re-verifies them on service worker start and on every panel connection.

  See [docs/architecture/conversation-links.md](docs/architecture/conversation-links.md).
- Vitest unit tests for the domain, application, simulator and messaging protocol.
- GitHub Actions CI (typecheck, lint, test with coverage, build).

## What is simulated

- **GPT Simulator** and **Claude Simulator** are scripted stand-ins with different viewpoints: one incremental and evidence-first, one risk-focused. They are *not* GPT or Claude. Their output is generic test data that references the topic and constraints.
- The structured assessments that drive early stopping are scripted. No semantic judgement or reasoning-quality score is involved.
- Three scenarios are available: **Full debate**, **Early convergence** and **Provider failure**.

## Supported conversation URLs

| Provider | Recognized conversation URLs                                              |
| -------- | ------------------------------------------------------------------------- |
| ChatGPT  | `https://chatgpt.com/c/<uuid>`, `https://chatgpt.com/g/g-<slug>/c/<uuid>` |
| Claude   | `https://claude.ai/chat/<uuid>`                                           |

Query strings and fragments are ignored. Other pages on these sites (home page, new chat, projects, shared links) are shown as "not a saved conversation" and cannot be linked. Lookalike hosts, other schemes or ports, `chat.openai.com` and `www.` variants are not recognized.

## Permissions

| Permission  | Why                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `sidePanel` | The side panel UI                                                                                                            |
| `storage`   | `chrome.storage.session`: the debate checkpoint and the conversation links (in memory, cleared on browser exit or extension reload) |
| `tabs`      | Reading the URL and title of open tabs to discover existing ChatGPT and Claude conversations                                 |

The `tabs` permission is sensitive. Chrome shows it as *"Read your browsing history"* because it exposes the URL and title of every open tab. ThirdMind classifies each tab in memory and immediately discards everything that is not a ChatGPT or Claude tab. For linked conversations it stores only the provider, tab id, conversation id, canonical conversation URL and connection state, never titles or content, and it never sends or logs this metadata. There are no host permissions and no content scripts. The full justification is in [docs/architecture/conversation-links.md](docs/architecture/conversation-links.md#permission-tabs).

## What is not implemented yet

- Any interaction with ChatGPT or Claude: no content scripts, host permissions, DOM access, conversation reading or automated messaging. Linked conversations are associations only (Phase 2.1). Real provider integration starts in Phase 2.2.
- Using linked conversations in a debate. The debate still uses the simulators.
- Persistent history of past debates. The checkpoint is in memory only and is discarded when the browser exits.
- Links that survive an extension reload or a browser restart (`storage.session` is cleared in both cases).
- End-to-end browser tests (deferred to Phase 2, see [docs/architecture/testing.md](docs/architecture/testing.md)).
- Extension icons, localization and a published Chrome Web Store listing.
- A license. One has not been selected yet.

## Prerequisites

- **Node.js 22.12 or later** (Node 24 is recommended; see `.nvmrc`). Check with `node --version`.
- **npm** (ships with Node.js).
- **Google Chrome** or another Chromium browser with side panel support (Chrome 116 or later).

## Installation

```powershell
cd C:\third-mind
npm install
```

`npm install` also runs `wxt prepare` (the `postinstall` script), which generates `.wxt/` including the TypeScript configuration that `tsconfig.json` extends. It also creates `package-lock.json`, which should be committed.

## Development

```powershell
npm run dev        # Start WXT in development mode with hot reload
```

WXT writes the development build to `.output/chrome-mv3-dev/`. If WXT cannot launch a browser automatically (that requires the optional `web-ext` package), load that directory manually as described below.

## Build

```powershell
npm run build      # Production build in .output/chrome-mv3/
npm run zip        # Zipped build in .output/
```

## Loading the unpacked extension in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select `C:\third-mind\.output\chrome-mv3`.
5. Click the ThirdMind toolbar icon (pin it from the puzzle-piece menu if needed). The side panel opens.

Manual smoke test:

1. Enter a topic, choose **Full debate** and the **Slow** response pace, and click **Start debate**. Both simulators start round 1 concurrently. (The **Standard** pace finishes a whole debate in about six seconds, which leaves little time to press Pause.)
2. Click **Pause** during round 1, 2 or 3. The status shows *Pausing…* until the in-flight simulated responses arrive, then *Paused*. No further round starts.
3. Add a constraint and click **Resume**. Every later contribution, from both simulators, lists the constraint under "Constraints respected". If you pause during the final round, constraints cannot be added (no request would carry them) and the panel says so.
4. When the debate completes, the **Results** card appears above the timeline. Switch between **Structured report** and **Conversational summary**.
5. Click **Start a new debate**, confirm, and start a second debate with a different topic.
6. Try **Early convergence** (stops after round 3) and **Provider failure** (the Claude simulator fails in round 2).

To exercise recovery, start a debate, then stop the service worker from `chrome://extensions` → ThirdMind → *service worker* → DevTools, or from `chrome://serviceworker-internals`. Reopen the panel. The session is restored as *Paused*, and interrupted requests are listed with a **Request again** button.

### Smoke test: linked conversations (Phase 2.1)

After rebuilding, reload the extension in `chrome://extensions`. If the extension was installed before, Chrome disables it until you accept the new `tabs` permission (*Read your browsing history*); accept it, or remove the extension and load it unpacked again.

1. **Empty state.** With no ChatGPT or Claude tab open, open the panel. *Linked conversations* says "No ChatGPT conversations found. Open a ChatGPT conversation in another tab and click Refresh." and the same for Claude.
2. **Provider page only.** Open `https://chatgpt.com/` (no conversation) and click **Refresh**. The ChatGPT section says that one ChatGPT tab is open but does not show a saved conversation. Nothing can be linked.
3. **Discovery.** Open two existing ChatGPT conversations (`https://chatgpt.com/c/…`) and one Claude conversation (`https://claude.ai/chat/…`) in separate tabs and click **Refresh**. ChatGPT lists two candidates and Claude one, each with its tab title, a shortened conversation id and *Available*. Nothing is selected, and **Link selected conversation** stays disabled, also for Claude's single candidate.
4. **Link.** Select a ChatGPT conversation and click **Link selected conversation**. It shows *Linked* with the tab title. Link the Claude conversation the same way.
5. **Simulation unaffected.** Start a simulated debate. It runs exactly as before and is still labelled as simulated. The links are unchanged and unused.
6. **Navigation.** In the linked ChatGPT tab, open a different conversation from the sidebar. Without any action in ThirdMind, the ChatGPT link becomes *Stale*: "The tab now shows a different conversation." Click **New chat** in the linked Claude tab: the Claude link becomes *Stale* ("no longer shows this conversation").
7. **Reconnect.** Navigate the ChatGPT tab back to the originally linked conversation. The link stays *Stale* (there is no automatic relink), and the tab is offered with a **Reconnect** button. Click it: the link becomes *Linked*.
8. **Tab closure.** Close the linked ChatGPT tab. The link becomes *Disconnected*: "The tab was closed." Reopen the same conversation in a new tab and click **Refresh**: **Reconnect** is offered for the new tab.
9. **Disconnect.** Click **Disconnect**. The section returns to the selection list.
10. **Panel and worker restart.** Link a conversation, close the panel, navigate the linked tab to another conversation, then stop the service worker (`chrome://serviceworker-internals` → ThirdMind → *Stop*). Reopen the panel: the link is restored and shown as *Stale*, because it was reconciled with the open tabs.
11. **Extension reload.** Reload the extension in `chrome://extensions` and reopen the panel: no links remain. This is expected, because `storage.session` is cleared.
12. **Lookalike URLs.** Open a non-provider page whose URL mentions a conversation URL only in its query (for example `https://example.com/?u=https://chatgpt.com/c/…`) and click **Refresh**. It is not listed.
13. **Narrow panel.** Drag the side panel to its narrowest width. Titles wrap, and every button stays reachable.

## Tests

```powershell
npm test               # Run all unit tests once
npm run test:watch     # Watch mode
npm run test:coverage  # Tests with a V8 coverage report in coverage/
npm run typecheck      # TypeScript strict type check
npm run lint           # ESLint, including module-boundary rules
npm run verify         # typecheck + lint + test + build
```

## Architecture

ThirdMind is a modular monolith with lightweight hexagonal boundaries and a pure functional core ([ADR 0001](docs/adr/0001-modular-monolith-functional-core.md)).

```text
src/
├── domain/          Pure debate state machine; pure conversation link model
├── ports/           Interfaces: providers, checkpoints, clock, ids, tabs, URL recognition, connection store
├── application/     Debate runner and connection coordinator (imperative shells), read models
├── infrastructure/  Deterministic simulators, provider URL rules, in-memory stores
├── extension/       Chrome integration: background host, messaging, storage and Tabs API adapters
├── ui/              React side panel
└── entrypoints/     WXT entrypoints (background, sidepanel)
```

The debate runs in the background service worker. The side panel renders snapshots it receives over a typed `runtime.Port`. All dependencies point toward the domain, and ESLint enforces this.

More detail:

- [Architecture overview](docs/architecture/overview.md)
- [Debate engine: states, events, commands](docs/architecture/debate-engine.md)
- [Runtime, messaging and recovery](docs/architecture/runtime-and-recovery.md)
- [Conversation links (Phase 2.1)](docs/architecture/conversation-links.md)
- [Testing](docs/architecture/testing.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
