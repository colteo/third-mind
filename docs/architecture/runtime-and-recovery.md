# Runtime, messaging and recovery

## Manifest

WXT generates a Manifest V3 `manifest.json` from `wxt.config.ts` and the entrypoints:

| Key           | Value                                         | Why                                                        |
| ------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `permissions` | `sidePanel`, `storage`, `tabs`                | Side panel UI; `storage.session` checkpoint and conversation links; reading open tab URLs and titles to discover conversations (Phase 2.1) |
| `side_panel`  | `default_path: sidepanel.html`                | Generated from `src/entrypoints/sidepanel/`                |
| `background`  | service worker                                | Generated from `src/entrypoints/background.ts`             |
| `action`      | `default_title: Open ThirdMind`               | Clicking the toolbar icon opens the side panel             |

ThirdMind requests no host permissions and has no content scripts. It does not inject scripts, scrape any DOM, access cookies, call private endpoints or send messages to ChatGPT or Claude. The `tabs` permission (Phase 2.1) is used only to read the URL and title of open tabs; see [conversation-links.md](conversation-links.md#permission-tabs).

## Where the debate runs

The debate runner lives in the **background service worker** (`src/extension/background-host.ts`). The side panel is a view:

- it connects to the worker with `runtime.connect({ name: 'thirdmind/side-panel' })`;
- it sends `ClientMessage` commands (`start`, `pause`, `resume`, `add-constraint`, `reissue-operation`, `reset`);
- it sends conversation link commands (`refresh-connections`, `link-conversation`, `reconnect-conversation`, `disconnect-conversation`), which the host routes to the connection coordinator, never to the debate runner;
- it renders `HostMessage` snapshots (debate) and `connections` views (links), which are separate messages, and shows `command-rejected` reasons.

Every command except `start` carries the `sessionId` of the session the panel displayed. The runner checks it inside its serialized queue and rejects commands for any other session, so a stale panel cannot pause, change or discard a newer session. A `reset` for a session that is already gone succeeds without effect. After any rejection the host sends a fresh snapshot so the panel re-syncs.

`start` also carries the simulated response `pace` (`standard` or `slow`). It is stored in the checkpoint's setup, so restored providers keep the same pace. The pace changes only the mock providers' artificial latency; the engine and runner never delay on purpose.

Messages are defined in `src/extension/protocol.ts`. Client messages are validated with `parseClientMessage` before use. The host also rejects ports with an unexpected name or sender.

Keeping the debate out of the panel means that closing or reloading the panel does not affect the debate. On reconnect, the panel receives the current snapshot.

## MV3 service worker lifecycle

Chrome may stop the service worker when it is idle and restart it on demand. ThirdMind does not assume a permanently running worker:

- All listeners are registered synchronously when the worker starts.
- After every applied event, the runner writes a **checkpoint** (`{ version, session, setup }`) to `chrome.storage.session`.
- Before calling a provider, the runner persists `ContributionDispatched` (write-ahead).
- When the worker starts, `runner.initialize()` loads the checkpoint and records `RuntimeRecovered`.

### Why `storage.session`

`chrome.storage.session` is held in memory. It survives service worker restarts, but it is cleared when the browser exits or the extension is reloaded or updated, and it is not written to disk. This is the smallest mechanism that makes the debate recoverable across worker restarts. It deliberately avoids building a permanent archive of provider conversations. **Reset** clears it immediately.

### Recovery behaviour

| State found in checkpoint             | After `RuntimeRecovered`                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pending` operation (never sent)      | stays `pending`; dispatched normally after resume                                        |
| `dispatched` operation (maybe sent)   | becomes `uncertain`; blocks resume until the human chooses **Request again**             |
| `running` or `pausing` session        | becomes `paused` with reason `runtime-restart`                                           |
| `paused`, `completed`, `failed`, `idle` | status unchanged                                                                       |

The panel shows a notice and lists uncertain requests, each with an explicit **Request again** button. If a late result for an uncertain operation does arrive, it is accepted (reconciled). That cannot happen with the in-process simulator, but it can with future live adapters. Once an operation has been superseded, late results for it are discarded.

### Keep-alive

The worker is kept alive only by ordinary activity: port messages and extension API calls. Simulated provider delays are about 1–2 seconds, well below Chrome's idle timeout. No keep-alive hacks are used.

## Conversation links across restarts

Conversation links (Phase 2.1) use the same `storage.session` mechanism under a separate key (`thirdmind.connections.v1`). Tab events are lost while the worker is suspended, so links are reconciled with a fresh tab scan when the worker starts and whenever a panel connects. Details: [conversation-links.md](conversation-links.md#reconciliation-worker-restart-and-panel-reconnection).

## Known gaps in recovery (Phase 1)

- **In-flight simulator calls do not survive a restart.** They run as timers inside the worker. After a restart, their operations are always `uncertain`, even though re-issuing them is harmless for a simulator. The conservative path (an explicit human decision) is used anyway, so that the behaviour matches what live providers will require.
- **Browser exit or extension reload discards the session.** This is a consequence of `storage.session` and is intended for Phase 1.
- **No checkpoint migration.** The checkpoint has `version: 1`. A future incompatible change must either migrate it or discard it.
- **The checkpoint payload is trusted.** Only its envelope is validated, because only this extension writes it.
- **Recovery has no automated test against real Chrome.** It is covered by unit tests at the domain and runner level (see [testing.md](testing.md)), but there is no end-to-end test that terminates a real service worker.
