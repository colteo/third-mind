# Controlled browser message exchange

Prompt 015 adds a test-only implementation of the existing `LiveProviderAdapter` port. Production conversation linking, provider content scripts, provider authorization declarations, and the deterministic debate engine are unchanged. Nothing registers this adapter in the production composition root.

## Files

All implementation files are new:

| File | Responsibility |
| --- | --- |
| `src/test-support/browser-exchange/protocol.ts` | Separate versioned fixture channel, bounded payloads, request/response parsing, exact fixture origin and paths |
| `src/test-support/browser-exchange/adapter.ts` | Existing live-adapter port implementation, tab/document targeting, polling, durable operation claims |
| `src/test-support/browser-exchange/content.ts` | Fixed fixture selectors, one form submission, acknowledgement and completion detection |
| `src/test-support/browser-exchange/chrome.ts` | Small structural interface for the browser APIs used by the fixture |
| `src/test-support/browser-exchange/entry.content.ts` | Isolated content-script entrypoint; accepts messages only from this test extension's own pages |
| `src/test-support/browser-exchange/runner.ts` | Browser assertions through real Chrome messaging and the existing live contribution/target-tracker code |
| `src/test-support/browser-exchange/exchange.test.ts` | Protocol, journal, correlation, timeout, and synthetic DOM unit tests |
| `packages/browser-exchange-fixture/page.html` | Controlled composer page |
| `packages/browser-exchange-fixture/page.js` | Deterministic acceptance, partial response, unrelated stale response, and explicit completion marker |
| `packages/browser-exchange-fixture/run.mjs` | Static loopback fixture server, test-extension bundle/manifest generation, isolated Chromium launch and report capture |
| `docs/architecture/browser-message-exchange-fixture.md` | Procedure, verified results, and limitations |

The production manifest and entrypoints do not import these modules. The generated test manifest lives under `.output/browser-exchange-fixture/extension`. Its permissions (`tabs`, `storage`, `webNavigation`, loopback host access) belong only to this disposable test extension. Manifest loopback patterns cover ports; the adapter and content handler enforce the exact origin `http://127.0.0.1:43115` and only `/new` and `/conversation/<id>`.

The adapter uses the `chatgpt` participant slot to exercise the existing port and first-message tracker. This is a fixture label, not a claim of ChatGPT website functionality. The unused Claude setup slot is never invoked. No consumer website is opened, submitted to, or extracted from.

## Message lifecycle

1. The test runner opens a local fixture tab. Chrome's `webNavigation.getFrame` supplies its top-frame URL and browser-owned `documentId`. A read-only `probe` obtains the content script's per-document random `pageInstanceId`.
2. The existing `createLiveContributionProvider` verifies its fixture binding, takes its existing submission lock, and persists the existing first-message write-ahead target record.
3. The fixture adapter rechecks origin, path, conversation, and document. Before sending, it persists an `armed` journal claim under the stable engine operation ID.
4. `tabs.sendMessage(tabId, request, { documentId })` sends a typed `submit` request to that exact document. Requests contain no code or selectors. The content script additionally checks the page-instance token and expected conversation before touching the DOM.
5. The fixture content handler reserves the operation ID before side effects, fills only `form[data-thirdmind-fixture] textarea[name="prompt"]`, dispatches input, and calls `requestSubmit()`. The fixture emits an acknowledgement tagged with the operation ID and a generated submission ID. Only that acknowledgement produces a submission receipt.
6. The fixture creates an unrelated old response and a partial response. Bounded polling sends `response` requests with the same operation, submission, and page-instance IDs. Only the corresponding `[data-fixture-response]` element with `data-state="complete"` yields content. Pending text is not returned.
7. The adapter re-reads Chrome's document and URL, checks all correlation fields and the deadline, then marks the journal entry completed. The existing live contribution provider parses the response.
8. For `/new`, the fixture itself assigns a UUID and performs a same-document `history.pushState` transition. The existing `reconcileFirstMessage` checks the receipt, response, page-instance token, and independently observed conversation URL. The existing target tracker persists the resulting conversation binding with source `first-message`.

Wire channel: `thirdmind/fixture-exchange`, version `1`. Fixed request types: `probe`, `submit`, `response`. Reply states: `ready`, `accepted`, `pending`, `complete`, `refused`. Text is bounded to 32,000 characters. The fixture reads only its own matching completed response; no consumer page content is read or stored. The journal stores identifiers and state, not prompt/response text.

## Correlation, uncertainty, and duplicate prevention

- Chrome selects the tab and browser-owned document; echoed tab IDs are not trusted. The content script's independent page-instance token must also match. Receipts are bound to the exact target in the adapter.
- Operation and submission IDs must match both the acknowledged submission and the completed response. The final conversation ID must match Chrome's current fixture URL. A new-chat URL transition is accepted only on the same document and only when the response agrees.
- Timeout, cancellation after sending, malformed/mismatched response, tab loss, or document navigation returns `outcome: 'unknown'`. A late reply does not convert an expired operation to success. A timeout is never proof of non-delivery.
- A serialized `chrome.storage.local` journal claim is written before sending. An existing operation ID is never sent again, even if completed or the adapter was recreated. Any unresolved claim also blocks new operation IDs on that tab. The content handler independently deduplicates repeated requests for the lifetime of its document.
- Storage errors fail closed. An unresolved claim survives a runner/extension-context restart. Receipts are deliberately not reconstructed for replay; an abandoned operation stays unresolved. There is no automatic recovery/resubmission action.
- The journal has one owner in this fixture runner. Cross-process distributed locking, real service-worker suspension testing, journal retention, and a human recovery UI are not claimed. The existing production engine and target tracker retain their existing uncertainty/recovery behavior.

## Reproduce without npm or installation

From `C:\third-mind`, using the already installed Node dependencies and Chrome:

```powershell
node node_modules/vitest/vitest.mjs run src/test-support/browser-exchange/exchange.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/test-support/browser-exchange/*.ts packages/browser-exchange-fixture/page.js packages/browser-exchange-fixture/run.mjs
node packages/browser-exchange-fixture/run.mjs
```

Optional alternate Chromium executable:

```powershell
$env:THIRDMIND_CHROMIUM = 'C:/path/to/chromium.exe'
node packages/browser-exchange-fixture/run.mjs
```

The harness bundles with the project's existing Rolldown dependency. It serves only static fixture assets and receives a test report on loopback port 43115; it makes no provider/API calls and is not a product backend. A port conflict fails rather than connecting to another service. No npm command, dependency download, or production build is needed.

The harness launches a fresh headless Chromium profile under `.output/browser-exchange-fixture`, installs only the fixture extension using the [documented DevTools extension-testing interface](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked), and opens the extension runner. The debugging pipe and extension-debugging flag are local browser test instrumentation, not website endpoints or changes to provider authorization. DevTools installs the test extension and opens its runner; all tested exchange traffic uses the extension's actual Chrome messaging APIs. No page script is evaluated through DevTools.

The harness disables background timer throttling for deterministic short fixture timing. Production hidden-tab behavior is not inferred from this setting. Chromium must be allowed to start its normal sandboxed subprocesses; the restricted execution sandbox in this session required an approved external launch. No Chromium sandbox-disabling flag is used.

The browser exits after completion. Generated bundles, disposable profiles, and `.output/browser-exchange-fixture/report.json` remain in the workspace for inspection. Nonzero exit status means build, startup, timeout, or assertion failure; inspect the report and console output. The server shuts down after the run. It needs no API keys or backend account.

## Verified results

Verified in a real headless **Chrome/155.0.8059.39** on Windows during this iteration:

- A synthetic prompt traversed the existing live contribution provider, actual Chrome tab/document messaging, and isolated content script into the fixture composer.
- The completed response `Fixture response completed.` returned through the existing contribution port. The existing parser correctly treated the fixture's lack of structured assessment as insufficient evidence of convergence.
- The first-message transition produced a persisted identified-conversation binding on the same document.
- A duplicate operation after adapter recreation produced no second fixture submission; the fixture acknowledgement count remained exactly one.
- A saved-conversation exchange completed. Wrong-tab receipts and unrelated operation receipts were rejected. Partial and unrelated stale responses were not returned.
- A deliberately non-completing response timed out as uncertain, and its tab refused another operation. A same-URL document reload also remained uncertain.

The browser report contains 12 passing assertions, the returned contribution, the first-message binding, and durable journal metadata. Unit tests additionally exercise malformed envelopes and oversized payloads, concurrent claims, storage failure, wrong response operation/document/submission/conversation, stale targets, lost acknowledgements, and content-script deduplication.

## Still unavailable on consumer websites

No live ChatGPT or Claude submission/response acquisition has been implemented or verified here. Their existing authorization declarations and read-only diagnostics are unchanged. Composer selector matches prove presence only, not submission availability.

Provider integration still requires an authorized supported automation route; provider-specific acceptance and completion rules; correlation without fixture-only DOM identifiers; first-message conversation identity checks; handling real streaming, errors, cancellation, hidden-tab throttling, and navigation; integration with existing production linking/preflight and recovery UI; and tests against the actual supported environments. This fixture does not establish those capabilities or autonomously coordinate a real multi-provider debate.
