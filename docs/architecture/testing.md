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

These tests use mocked Chrome APIs. They do not prove that real Chrome delivers tab events, suspends the worker or reports URLs as assumed. That is covered by the manual smoke test in the README.

## Coverage

```powershell
npm run test:coverage
```

This writes a text summary to the console and an HTML report to `coverage/index.html`, using the V8 provider. Coverage covers `domain`, `application`, `infrastructure`, `extension/protocol.ts`, `extension/chrome-tabs.ts` and `extension/session-connection-store.ts`. No coverage figures are recorded in this repository. They have to be produced by running the command.

## Deferred: end-to-end browser tests

End-to-end tests (for example, Playwright loading the unpacked extension and driving the side panel) are **deferred to Phase 2**. Testing a side panel and service worker restarts in real Chrome needs a persistent-context browser setup and an extension-aware harness. That would roughly double the tooling in this first phase. Until then, the UI and Chrome adapters are verified manually with the steps in the README.
