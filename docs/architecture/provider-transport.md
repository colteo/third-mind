# Provider page transport (Phase 2.2B foundation)

The provider page transport is the channel between the background service worker and the ChatGPT and Claude pages open in the user's browser. In this iteration it only **reads readiness**: which provider owns a tab, what kind of page it shows, whether the page has loaded and is visible, and whether the provider's message box exists. It does **not** read conversations or submit prompts, and the debate still uses the simulators.

The security decisions are recorded in [ADR 0004](../adr/0004-provider-content-script-boundary.md).

## Components

```text
 Side panel                 Background service worker                         Provider tab (top frame)
┌──────────────┐  Port   ┌──────────────────────────────────────────┐       ┌─────────────────────────────┐
│ "Check page  │────────►│ background-host                          │       │ chatgpt.content.ts /        │
│  connection" │ check-  │  └ link from ConnectionCoordinator       │       │ claude.content.ts           │
│  (provider)  │ provider│     (refresh first; tab must be linked)  │       │  └ provider-content-script  │
│              │ -page   │  └ ProviderTransport.probe(tabId, prov.) │ tabs. │     handleTransportRequest   │
│              │◄────────│     1 read tab, check exact origin       │ send  │      ├ check sender          │
│ result text  │ page-   │     2 sendMessage(frameId 0) + timeout   │ Msg   │      ├ parse request         │
└──────────────┘ check   │     3 re-read tab, check traces          │──────►│      └ inspectProviderPage   │
                         │     4 parse + match answer               │◄──────│         (URL rules, readyState│
                         │                                          │ answer│          visibility, composer)│
                         │  runtime.onMessage ◄─────────────────────┼───────│ page-hello (once per load)  │
                         │   receivePageMessage: check sender,      │       └─────────────────────────────┘
                         │   record new document                    │
                         │  tabs.onUpdated/onRemoved → traces       │
                         └──────────────────────────────────────────┘
```

| File | Layer | Responsibility |
| ---- | ----- | -------------- |
| `src/ports/index.ts` | ports | Provider-neutral types: `ProviderPageTransport`, `ProviderPageReport`, `ProviderPageStatus`, `ProviderPageReadiness`, `TransportFailure` |
| `src/infrastructure/provider-pages.ts` | infrastructure | Provider-specific readiness rules (composer selectors) and the pure `inspectProviderPage` / `providerPageReadiness` functions |
| `src/extension/provider-transport-protocol.ts` | extension | Wire messages, strict parsers, sender checks for both directions |
| `src/extension/provider-transport.ts` | extension | Worker side: `probe`, navigation traces, `page-hello` handling, timeouts, error classification |
| `src/extension/provider-content-script.ts` | extension | Content script side: `handleTransportRequest` (pure) and `startProviderContentScript` |
| `src/entrypoints/chatgpt.content.ts`, `claude.content.ts` | entrypoints | Manifest declarations; no logic |

The domain, the debate engine, the connection model and the checkpoint format are unchanged. The application layer is unchanged: the transport is wired by the composition root, and its port is ready for a future live `ContributionProvider`.

## Messages

All transport messages carry `channel: 'thirdmind/provider-transport'` and `version: 1`.

| Message | Direction | Fields | Sent with |
| ------- | --------- | ------ | --------- |
| `inspect-page` | worker → content script | `requestId`, `provider` | `tabs.sendMessage(tabId, …, { frameId: 0 })` |
| `page-report` | content script → worker (answer) | `requestId`, `pageInstanceId`, `report` | `sendResponse` |
| `page-refused` | content script → worker (answer) | `requestId`, `pageInstanceId`, `reason` (`wrong-provider`, `unsupported-page`) | `sendResponse` |
| `page-hello` | content script → worker | `provider`, `pageInstanceId` | `runtime.sendMessage`, once per document |

`pageInstanceId` is a random UUID generated when a content script starts. It identifies one document in one tab.

Side panel messages (over the existing port): `check-provider-page { provider }` and the host message `page-check { provider, tabId, result }`.

## Trust boundaries

| Boundary | Untrusted side | Checks |
| -------- | -------------- | ------ |
| Side panel → worker | Panel commands (stale panels, bugs) | Parsed by `parseClientMessage`; a page check names only a provider; the host uses the tab of the current link after a fresh reconciliation, and only while that link is `linked` |
| Worker → content script | Any extension context or other extension trying to message the page | `isExtensionSender`: this extension's id, no `tab`, extension origin. Only `inspect-page` is understood; anything else gets no answer |
| Content script → worker | Provider pages, their frames, other extensions | `checkPageSender`: this extension's id, a valid tab id, `frameId` 0, URL classified as the claimed provider by exact origin, Chrome's `origin` equal to that URL's origin. One-off messages are never answered |
| Answer → worker | A page that changed, a different document, a buggy or tampered script | Strict parsing that rebuilds the answer; fresh `requestId`; provider, page kind and conversation id must match the tab URL; `pageInstanceId` must match the last known document |

The content script runs in the isolated world, so page JavaScript cannot call its functions or replace its globals. Page JavaScript can still change the DOM, which is why the report contains only coarse facts and why nothing in it is used as proof of identity: conversation identity still comes from the tab URL reported by Chrome.

## Probe sequence and stale-answer protection

1. **Validate the tab.** `tabs.get(tabId)`. Missing → `tab-closed`; no URL → `tab-unreadable`; not a supported origin → `unsupported-page`; other provider → `wrong-provider`. Nothing is sent in these cases.
2. **Start or confirm the trace.** The worker keeps, per tab, a navigation number, the last URL and the last known `pageInstanceId`. A URL that differs from the trace starts a new navigation.
3. **Send** `inspect-page` with a new `requestId` to frame 0, racing a timeout (default 3 s).
4. **Re-validate.** Re-read the tab. Closed → `tab-closed` (`unknown`). If the navigation number changed during the request (a tab event with a new URL, a removal, or a `page-hello` with a new `pageInstanceId`) or the URL differs from step 1 (events are lost while the worker is suspended) → `navigated`.
5. **Validate the answer.** Malformed or for another request → `invalid-response`. Refused → the refusal reason. The page's own classification must match the tab URL, and its `pageInstanceId` must match the last known document; otherwise → `navigated`.
6. **Report** `ProviderPageStatus` with the derived readiness.

## Failures and outcomes

| Failure | Outcome | Meaning |
| ------- | ------- | ------- |
| `transport-unavailable` | not-performed | No Tabs API in this context |
| `tab-closed` | not-performed before sending, unknown after | The tab does not exist |
| `tab-unreadable` | not-performed before sending, unknown after | Chrome did not expose the URL |
| `unsupported-page`, `wrong-provider` | not-performed | Nothing was sent, or the page refused |
| `content-script-unavailable` | not-performed | No receiver in the tab: it was opened before the extension was installed, updated or reloaded, or its document is not ready |
| `navigated` | unknown | The answer would describe a document the tab no longer shows |
| `timeout` | unknown | No answer in time. **Never** evidence that the page failed |
| `invalid-response` | unknown | The answer was not accepted |
| `transport-error` | unknown | Any other messaging error |

`not-performed` is reserved for cases where the page certainly did not act. Later phases that submit prompts must treat `unknown` like the debate engine treats an `uncertain` operation: never retry automatically, never record a failure, and let the human decide (see [debate-engine.md](debate-engine.md#provider-operations)).

## Readiness

| Readiness | Condition |
| --------- | --------- |
| `ready` | A conversation or new chat, `readyState` is `interactive` or `complete`, and the composer exists |
| `loading` | `readyState` is `loading` |
| `composer-missing` | A chat page without a composer: signed out, still rendering, an error page, or a changed page structure |
| `not-a-chat-page` | Any other provider page (settings, projects, …) |

Visibility (`visible` or `hidden`) is reported separately. A background tab can be ready, but browsers throttle hidden tabs, which later phases will have to account for.

Composer selectors (unverified, see [Limitations](#limitations)):

| Provider | Selector |
| -------- | -------- |
| ChatGPT | `#prompt-textarea` |
| Claude | `div.ProseMirror[contenteditable="true"]` |

## Lifecycle and recovery

| Event | Effect |
| ----- | ------ |
| Content script starts (page load, reload, navigation to a new document) | Sends `page-hello`; the worker records the new `pageInstanceId` and marks a navigation |
| Single-page navigation (URL change without a new document) | `tabs.onUpdated` reports the URL; the worker marks a navigation. The content script keeps running and classifies the new URL on the next request |
| Tab closed or replaced | Marks a navigation; the next probe reports `tab-closed` |
| Service worker restart | Traces are lost. In-flight requests are lost with their answer channel and are never replayed. The next probe validates the tab from scratch. Content scripts hold no worker state and keep answering |
| Extension reload or update | Old content scripts are orphaned and stop listening (`ctx.onInvalidated`). Open provider tabs report `content-script-unavailable` until reloaded |
| Back/forward cache | Chrome closes the message channel; reported as `navigated` (`unknown`) |

## Permissions

See [ADR 0004](../adr/0004-provider-content-script-boundary.md#decision). In short: no new entries in `permissions`, no `host_permissions`. The content scripts' match patterns (`https://chatgpt.com/*`, `https://claude.ai/*`) are the only new capability, and Chrome shows them as access to data on those two sites. `wxt dev` adds those patterns as host permissions for its development reloader; production builds (`npm run build`) do not.

## Limitations

- **Not verified against the real websites by automated tests.** All tests use mocked Chrome APIs and fake pages. The composer selectors come from manual inspection and will break when the providers change their pages.
- Tabs opened before the extension was installed, updated or reloaded need a manual reload.
- Readiness does not prove that the user is signed in, that the conversation exists, or that a prompt could be submitted.
- Only the top frame is supported. Provider features that render the composer in an iframe would read as `composer-missing`.
- Chrome error messages are matched by pattern; they are not a stable API.
- Results are not persisted and are shown only in the panel that is open.
- No live AI message exchange exists yet.

## Next steps toward message exchange

1. **Verify readiness on the real sites** (signed in and signed out, conversations and new chats, light and dark themes, narrow windows) and correct the selectors.
2. **Reading the latest reply.** Add an `read-latest-reply` request that returns only the newest assistant message of the linked conversation, with a size limit, and only when the page is `ready`. Decide how to detect "still generating" without private endpoints (for example, the presence of the stop button).
3. **Submitting a prompt.** Add `submit-prompt { operationId, text }`. The content script must record handled `operationId`s per document so a re-delivered request is not submitted twice, and must report `submitted` only after the provider has visibly accepted the message. A timeout stays `unknown` and maps to the engine's `uncertain` operation, resolved by the human.
4. **Live `ContributionProvider`.** Implement the port with `origin: 'live'` on top of the transport, map transport outcomes to provider results and uncertain operations, and register it in the composition root next to the simulators.
5. **Reply completion.** Use a bounded `MutationObserver` in the content script, started per request and stopped on answer, timeout or invalidation, with streamed progress over a port if needed.
6. **Content-script coverage** with a real browser (Playwright with a persistent context), deferred until then.
