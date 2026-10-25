# Testing

## Strategy

| Layer                         | Tested with                            | Files                                                      |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Domain (state machine)        | Vitest, pure function tests            | `src/domain/engine.test.ts`                                |
| Application (runner, reports) | Vitest, in-memory store and simulators | `src/application/*.test.ts`                                |
| Simulator                     | Vitest                                 | `src/infrastructure/simulator/mock-provider.test.ts`       |
| Messaging protocol            | Vitest                                 | `src/extension/protocol.test.ts`                           |
| Result views (React)          | Vitest, `react-dom/server` static render | `src/ui/components/Results.test.ts`                      |
| Conversation link model       | Vitest, pure function tests            | `src/domain/connections.test.ts`                           |
| Provider URL recognition      | Vitest                                 | `src/infrastructure/conversation-urls.test.ts`             |
| Connection coordinator        | Vitest, mocked tab source, in-memory store | `src/application/connection-coordinator.test.ts`       |
| Tabs API adapter              | Vitest, mocked `chrome.tabs` object    | `src/extension/chrome-tabs.test.ts`                        |
| Connection store              | Vitest, mocked `wxt/browser` storage   | `src/extension/session-connection-store.test.ts`           |
| Connections panel (React)     | Vitest, `react-dom/server` static render | `src/ui/components/ConversationConnections.test.ts`      |
| Provider page readiness rules | Vitest, fake page environments         | `src/infrastructure/provider-pages.test.ts`                |
| Provider transport protocol   | Vitest                                 | `src/extension/provider-transport-protocol.test.ts`        |
| Provider transport (worker and content script handler) | Vitest, mocked `chrome.tabs`, real content script handler on fake pages, fake timers | `src/extension/provider-transport.test.ts` |
| Real Chrome behaviour, other React UI | Manual (see README)            | none                                                       |

The result view test renders `ResultsView` with `renderToStaticMarkup` in the Node environment, so it needs no DOM library or extra dependency. It checks which tab is selected and which panel is hidden for each view, and that both views describe the same session. Click handling is not exercised without a DOM; the keyboard logic is tested through the pure `nextResultView`.

The domain tests drive the engine through a small synchronous shell (`settle` and `step` in `src/test-support/fixtures.ts`) that turns commands into events in the same way the runner does. The runner tests use a controllable provider whose calls stay in flight until the test resolves them. That makes pausing, write-ahead and restart behaviour observable.

## Required behaviours and where they are covered

| #  | Behaviour                                     | Test (describe block)                                                              |
| -- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1  | Valid session initialization                  | `engine.test.ts` → session initialization                                          |
| 2  | Start transition                              | `engine.test.ts` → start transition                                                |
| 3  | Maximum round enforcement                     | `engine.test.ts` → maximum round enforcement                                       |
| 4  | Independent first-round contributions         | `engine.test.ts` → round 1: independent contributions                              |
| 5  | Dependency handling between rounds            | `engine.test.ts` → dependencies between rounds                                     |
| 6  | Pause transition                              | `engine.test.ts` → pause transition; `debate-runner.test.ts` → pause, constraints and resume |
| 7  | Adding a human constraint                     | `engine.test.ts` → human constraints                                               |
| 8  | Resume transition                             | `engine.test.ts` → resume transition                                               |
| 9  | Constraint propagation into later requests    | `engine.test.ts` → constraint propagation; runner and simulator tests              |
| 10 | Successful completion                         | `engine.test.ts` → successful completion; runner "full simulated debate"           |
| 11 | Early stopping with explicit assessment       | `engine.test.ts` → adaptive early stopping; runner "early-convergence"             |
| 12 | Provider failure                              | `engine.test.ts` → provider failure; runner "provider failure"                     |
| 13 | Duplicate event handling                      | `engine.test.ts` → duplicate event handling                                        |
| 14 | Invalid state transitions                     | `engine.test.ts` → invalid state transitions                                       |
| 15 | Uncertain operation recovery                  | `engine.test.ts` → uncertain operation recovery; runner "side-effect safety and recovery" |
| 16 | Pause with a response in flight, constraint, resume to completion without duplicates | `debate-runner.test.ts` → interactive pause, constraint and resume |
| 17 | No constraint accepted after the final round  | `engine.test.ts` → human constraints; `debate-runner.test.ts` → interactive pause, constraint and resume |
| 18 | Pause survives a service worker restart       | `debate-runner.test.ts` → interactive pause, constraint and resume                 |
| 19 | Reset (running, pausing, completed) and a new session; late results from an obsolete session | `debate-runner.test.ts` → reset and new sessions |
| 20 | Commands for an obsolete session are rejected | `debate-runner.test.ts` → reset and new sessions; `protocol.test.ts`              |
| 21 | Panel close and reopen                        | `debate-runner.test.ts` → side panel reconnection                                  |
| 22 | Result view switching                         | `Results.test.ts`                                                                  |
| 23 | Simulated pace delays responses (fake timers) | `mock-provider.test.ts`                                                            |

### Conversation links (Phase 2.1)

| #  | Behaviour                                     | Test (file → describe block)                                                       |
| -- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1  | ChatGPT URL recognition                       | `conversation-urls.test.ts` → ChatGPT URL recognition                              |
| 2  | Claude URL recognition                        | `conversation-urls.test.ts` → Claude URL recognition                               |
| 3  | Unsupported URL rejection                     | `conversation-urls.test.ts` → unsupported URLs                                     |
| 4  | Hostname spoofing and lookalike domains       | `conversation-urls.test.ts` → hostname spoofing and lookalike domains              |
| 5  | Conversation versus home page classification  | `conversation-urls.test.ts` → conversation versus provider page classification   |
| 6  | Multiple open conversations                   | `connection-coordinator.test.ts` → tab discovery                                   |
| 7  | Explicit selection (no automatic choice)      | `connection-coordinator.test.ts` → tab discovery; `connections.test.ts` → explicit conversation selection; `ConversationConnections.test.ts` |
| 8  | Connection confirmation                       | `connection-coordinator.test.ts` → connection confirmation                         |
| 9  | Tab closure                                   | `connection-coordinator.test.ts` → tab lifecycle; `connections.test.ts` → link lifecycle |
| 10 | Navigation to another conversation            | `connection-coordinator.test.ts` → tab lifecycle                                   |
| 11 | Stale connection detection                    | `connections.test.ts` → link lifecycle; coordinator → tab lifecycle                |
| 12 | Explicit reconnection                         | `connections.test.ts` → explicit reconnection; coordinator → explicit reconnection |
| 13 | Service worker restart reconciliation         | `connection-coordinator.test.ts` → service worker restart and side panel reconnection |
| 14 | Side panel reconnection                       | `connection-coordinator.test.ts` → service worker restart and side panel reconnection |
| 15 | Duplicate tab events                          | `connection-coordinator.test.ts` → tab lifecycle; `connections.test.ts` → reconciliation |
| 16 | Invalid client messages                       | `protocol.test.ts` → connection message parsing                                    |
| 17 | Missing permission or failed tab queries      | `chrome-tabs.test.ts`; `connection-coordinator.test.ts` → failed tab queries       |
| 18 | Isolation between simulation and link metadata | `session-connection-store.test.ts` → isolation…; `protocol.test.ts` → keeps debate snapshots and connection views apart |

### New chats and identity reconciliation (Phase 2.2A)

| #  | Behaviour                                     | Test (file → describe block)                                                       |
| -- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| 19 | Valid ChatGPT and Claude new-chat URLs        | `conversation-urls.test.ts` → new-chat entry points                                |
| 20 | Unsupported provider paths stay unlinkable    | `conversation-urls.test.ts` → conversation versus provider page classification; new-chat entry points (temporary and incognito chats) |
| 21 | Spoofed new-chat origins                      | `conversation-urls.test.ts` → hostname spoofing and lookalike domains; coordinator → new chat discovery |
| 22 | Explicit pending link creation                | `connections.test.ts` → explicit new chat linking; coordinator → explicit new chat linking |
| 23 | Successful identity reconciliation            | `connections.test.ts` → identity reconciliation of a pending new chat; coordinator → identity reconciliation |
| 24 | Ambiguous transition requiring confirmation   | `connections.test.ts` → identity reconciliation…, explicit identity confirmation; coordinator → service worker recovery of new chats |
| 25 | Switching to an unrelated conversation        | `connections.test.ts` → identity reconciliation… (already open elsewhere, other provider, other origin); coordinator → identity reconciliation |
| 26 | Closing a pending tab; reopening the provider | `connections.test.ts` → identity reconciliation…; coordinator → closing and reopening a pending new chat |
| 27 | Tab id reuse                                  | `connections.test.ts` → identity reconciliation… (tab id reuse); coordinator → service worker recovery of new chats |
| 28 | Service worker recovery                       | coordinator → service worker recovery of new chats                                 |
| 29 | Multiple tabs from the same provider          | coordinator → identity reconciliation (other tabs of the same provider)            |
| 30 | Saved-conversation linking regression         | all Phase 2.1 tests above, unchanged in intent; coordinator → explicit new chat linking (saved link next to a pending one) |
| 31 | Simulator regression                          | `engine.test.ts`, `debate-runner.test.ts`, `mock-provider.test.ts` (unchanged)     |
| 32 | Invalid and stale protocol requests           | `protocol.test.ts` → connection message parsing, message routing; coordinator → stale identity confirmation requests |
| 33 | Storage schema migration                      | `connections.test.ts` → migration of version 1 registries; `session-connection-store.test.ts` → migration from the Phase 2.1 schema |

### Provider page transport (Phase 2.2B foundation)

| #  | Behaviour                                     | Test (file → describe block)                                                       |
| -- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| 34 | Valid provider origin                         | `provider-transport.test.ts` → valid provider origin; `provider-transport-protocol.test.ts` → message senders |
| 35 | Invalid provider origin (lookalike, query, scheme, port, other provider) | `provider-transport.test.ts` → invalid provider origin; `provider-pages.test.ts` → provider-specific readiness detection |
| 36 | Missing content script                        | `provider-transport.test.ts` → missing content script; transport timeout (synchronous throw) |
| 37 | Closed tab (before and during a request)      | `provider-transport.test.ts` → closed tab                                          |
| 38 | Navigation during a request (event, missed event, reload, other document, other request, back/forward cache) | `provider-transport.test.ts` → navigation during a request |
| 39 | Worker restart                                | `provider-transport.test.ts` → worker restart                                      |
| 40 | Incorrect message sender (both directions)    | `provider-transport.test.ts` → incorrect message sender; `provider-transport-protocol.test.ts` → message senders |
| 41 | Unsupported page                              | `provider-transport.test.ts` → unsupported page                                    |
| 42 | Transport timeout (outcome unknown, late answers ignored) | `provider-transport.test.ts` → transport timeout                       |
| 43 | Provider-specific readiness detection         | `provider-pages.test.ts`; `provider-transport.test.ts` → provider-specific readiness detection |
| 44 | Malformed messages and dropped extra fields   | `provider-transport-protocol.test.ts` → provider transport message parsing         |
| 45 | Panel page check: provider only, no tab or code | `protocol.test.ts` → page check messages; `ConversationConnections.test.ts` → page connection checks |

The transport tests run the real content script handler (`handleTransportRequest`) on fake page environments behind a fake `chrome.tabs`, so the request and answer pass through both parsers and both sender checks. They do not load the content scripts into Chrome, do not run against chatgpt.com or claude.ai, and do not verify the composer selectors. That is covered only by the manual smoke test in the README.

These tests use mocked Chrome APIs. They do not prove that real Chrome delivers tab events, suspends the worker or reports URLs as assumed. That is covered by the manual smoke test in the README.

## Coverage

```powershell
npm run test:coverage
```

This writes a text summary to the console and an HTML report to `coverage/index.html`, using the V8 provider. Coverage covers `domain`, `application`, `infrastructure`, `extension/protocol.ts`, `extension/chrome-tabs.ts`, `extension/session-connection-store.ts`, `extension/provider-transport.ts`, `extension/provider-transport-protocol.ts` and `extension/provider-content-script.ts` (whose live entry point, `startProviderContentScript`, is not exercised). No coverage figures are recorded in this repository. They have to be produced by running the command.

## Deferred: end-to-end browser tests

End-to-end tests (for example, Playwright loading the unpacked extension and driving the side panel) are **deferred to Phase 2**. Testing a side panel and service worker restarts in real Chrome needs a persistent-context browser setup and an extension-aware harness. That would roughly double the tooling in this first phase. Until then, the UI and Chrome adapters are verified manually with the steps in the README.
