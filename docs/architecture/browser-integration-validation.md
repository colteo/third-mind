# Browser conversation integration baseline — Prompt 012

Inspection date: 2026-10-25. Scope: existing linked ChatGPT and Claude browser tabs only.

## Evidence and implementation

Inspected `connection-coordinator.ts`, `connection-view.ts`, the connection domain model, `provider-content-script.ts`, both content entrypoints, `provider-transport.ts`, `provider-transport-protocol.ts`, `provider-pages.ts`, `conversation-urls.ts`, `live-preflight.ts`, `live-target.ts`, the session live-target store, consumer-site adapters, background host, runtime protocol, panel client/hook, and conversation connection UI. Read the legacy Doppia Mente `content.js` in the supplied Downloads directory without modifying it.

| Area | Actual implementation | Evidence limit |
| --- | --- | --- |
| Discovery and approval | Exact parsed origins, explicit human tab selection, revision checks, session links, fresh scans and lifecycle reconciliation | URL classification does not prove an account is signed in or a chat is empty |
| Empty chats | ChatGPT `/`; Claude `/new` and `/`; pending identity without a fabricated conversation ID | Claude root behavior and redirects need live testing; special/custom new-chat paths are intentionally not generalized |
| Saved chats | ChatGPT `/c/<uuid>` and `/g/g-.../c/<uuid>`; Claude `/chat/<uuid>` | Current site URL compatibility remains unverified |
| Content scripts | Isolated world, exact provider match patterns, top frame, document-idle listener; extension sender validation; fixed `inspect-page` operation | Already-open tabs may require reload after installation/update |
| Inspection | URL classification, document loading/visibility, boolean composer existence | `#prompt-textarea` and `div.ProseMirror[contenteditable="true"]` have no real-site verification in this run; existence does not prove visible, enabled, editable or submission-ready |
| Messaging | Three-second timeout, request correlation, URL reads before/after, navigation traces, per-script random page instance and validated page hello | Page instance is an application document token, not Chrome's native documentId; no durable document proof survives worker termination |
| Live lifecycle | Preflight, approved target verification, first-message write-ahead state, same-document conversation binding, unresolved submission recovery | Foundation only: installed consumer adapters refuse submission and response collection |
| Legacy | Broad editor/send/reply selectors, editor filling, clicking, snapshots, selection capture and streaming heuristics | Source demonstrates an attempted DOM implementation, not reliability, authorization, or correct reply attribution; none copied into ThirdMind |

The repository has separate Simulation and Browser Conversations modes. This read-only validation does not run a debate. The debate engine is unchanged.

## Developer diagnostic workflow

The existing Side Panel command remains `{ type: 'check-provider-page', provider: 'chatgpt' | 'claude' }`. It cannot select an arbitrary tab. The host obtains the approved tab from the reconciled link, probes it, refreshes links again, and discards the result if the slot revision or approved tab changed. No link or debate is changed by the diagnostic itself; normal link reconciliation may update lifecycle state.

The host now rejects this command unless `import.meta.env.DEV` is true. The button and result are also hidden in production. Existing live preflight checks remain independent of this developer workflow.

The `page-check` host response adds `linkRevision` and `checkedAt` to the existing `provider`, `tabId` and `result`. Its parser requires the new metadata. The content protocol remains version 1: `inspect-page` → `page-report`/`page-refused`, plus `page-hello`. No selectors, JavaScript, prompt text, private endpoints, or general-purpose operations were added.

Under each linked provider, **Check page connection (developer diagnostic)** shows:

- Provider-specific success/failure explanation and recovery guidance.
- Timestamp, approved tab ID, link revision.
- On success, exact provider origin, confirmed background messaging, document instance, loading state, and composer presence.
- A reminder that this is a snapshot and that automatic submission and reply acquisition are unavailable because no authorized browser route is configured.

A result from another tab/revision is hidden. Results are cleared when the panel loses its background connection. Results are panel memory only, never written to storage or logged. No conversation body or composer text is read. Existing tab-title/conversation-identifier display is unchanged. Same-URL reloads can leave an old timestamped snapshot visible until another check; the UI explicitly instructs rerunning after reload/navigation. A fresh probe, rather than a previous green result, is the evidence for the current document.

## Local verification commands

Use installed dependencies directly from `C:\third-mind`; no package installation or npm command is needed:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/extension/background-host.ts src/extension/protocol.ts src/extension/protocol.test.ts src/extension/browser-diagnostics.test.ts src/ui/use-debate-host.ts src/ui/components/ConversationConnections.tsx src/ui/components/ConversationConnections.test.ts
node node_modules/vitest/vitest.mjs run src/extension/browser-diagnostics.test.ts src/extension/provider-transport.test.ts src/extension/provider-transport-protocol.test.ts src/extension/protocol.test.ts src/infrastructure/provider-pages.test.ts src/application/connection-coordinator.test.ts src/application/live-target.test.ts src/ui/components/ConversationConnections.test.ts
node node_modules/wxt/bin/wxt.mjs build
```

These verify code contracts, lifecycle/race handling, rendering and compilation. They do not verify either live site's DOM.

Actual local results: TypeScript passed; lint passed for all changed TypeScript/TSX files; the focused suite passed 236 tests across eight files; production WXT build passed. Host regression tests cover approved empty-chat targeting, link changes during probing, and production rejection. UI regressions cover revision mismatch, identity evidence, unavailable capabilities, and production hiding. Generated production artifacts are in `.output/chrome-mv3`; they intentionally hide developer diagnostics.

## Chrome manual acceptance test

Start a development session with `node node_modules/wxt/bin/wxt.mjs`. WXT's development server is build tooling, not a provider backend. Use the Chrome instance WXT opens; alternatively load `.output/chrome-mv3-dev` through Chrome's Load unpacked control while that dev session runs. Open ThirdMind using its toolbar action. Sign in to providers normally. Reload provider tabs after loading/reloading the extension so their content scripts attach. Do not start a simulated debate for this procedure.

For every check, record only: Chrome version, extension build, timestamp, provider, case, tab ID, revision, page instance, document state, composer presence and diagnostic outcome. Do not copy page text, tab titles, account data or conversation bodies into evidence. Mark each row PASS, FAIL, or BLOCKED with a short non-content reason. Do not infer PASS from this document or from unit tests.

| Case | Actions | Expected evidence |
| --- | --- | --- |
| Empty ChatGPT | Open `https://chatgpt.com/`, leave composer untouched, Refresh in ThirdMind, explicitly select/link the new chat, run diagnostic | Pending identity; exact ChatGPT origin; same approved tab; new-chat report; document interactive/complete and composer present once loaded; no typing/submission |
| Existing ChatGPT | Open a saved `/c/<uuid>` chat, explicitly link it and run diagnostic | Saved identity; approved tab; active messaging; composer present if accessible; existing content unchanged |
| Empty Claude | Open `https://claude.ai/new`, leave composer untouched, select/link and run diagnostic; separately record whether root redirects | Pending identity; exact Claude origin; new-chat report and composer presence; no typing/submission |
| Existing Claude | Open a saved `/chat/<uuid>` chat, explicitly link it, run diagnostic | Saved identity; approved tab; active messaging; composer present if accessible; existing content unchanged |
| Reload, both providers | Record document token, reload linked tab at same URL, wait for load and rerun; also try a check during reload | New token after full reload; old in-flight answer rejected or connection/loading guidance; later fresh check succeeds if composer matches |
| Navigation, both providers | Navigate linked saved chat to a different conversation, new-chat page or off-provider page; Refresh; return afterward | Link stale, old diagnostic hidden, no silent reassignment; explicit relink/reconnect needed. Navigation during a probe must not produce a result attributed to the old approved link |
| Empty-to-saved lifecycle | In a separate optional fixture, send a harmless first message manually in the linked empty tab; do not automate it | Continuously observed URL transition may adopt saved identity; observation gap/duplicate existing conversation requires confirmation. This checks identity lifecycle only, not autonomous exchange |
| Tab closure, both providers | Close a linked tab; Refresh if needed | Disconnected state, diagnostic hidden, no retry against another tab. Reopening same saved conversation offers explicit reconnect; a closed empty chat cannot be silently recovered |
| Worker restart | Keep linked tabs, close worker DevTools, stop extension worker through `chrome://serviceworker-internals` (or the Chrome version's worker Stop control), reopen panel if needed, rerun diagnostic | Panel reconnects, links reconcile from session storage, previous diagnostic clears, fresh probe works without an old worker trace; no debate operation is replayed |
| Extension reload | Reload ThirdMind in `chrome://extensions`, then try diagnostic before and after reloading provider tabs | Missing receiver gets reload guidance; after provider reload, new script answers. Extension reload is distinct from worker restart and may clear session links |
| Missing composer | Test a signed-out or otherwise inaccessible provider chat without bypassing any challenge | Missing composer/loading explanation; messaging success alone never represents autonomous readiness |
| Production | Load `.output/chrome-mv3` from the production build separately | Developer diagnostic button/results absent; host diagnostic command rejected |

If Chrome's worker Stop control is unavailable, record BLOCKED rather than substituting extension Reload: they have different storage/content-script lifecycles. A transient loading/timeout failure followed by success should retain both outcomes in the evidence log.

**Actual live run status:** NOT RUN. The available computer-use inventory returned `apps: []` and `browsers: []`. No authenticated provider pages, extension panel, or Chrome worker controls were available. All real-site rows remain pending. No success is claimed from mocked page environments or static rendering tests.

## Integration decision and smallest next step

**Chrome capabilities:** the existing manifest/content scripts already allow narrow DOM inspection and top-frame tab messaging. Browser extensions can technically manipulate a permitted page's DOM and receive observations; that does not establish permission from the provider, reliable React/editor submission, or trustworthy response attribution. No additional generic framework is needed.

**Provider restrictions and authorized routes:** checked the primary terms on 2026-10-25. [OpenAI Europe Terms, Using our Services](https://openai.com/policies/eu-terms-of-use/) prohibit automatic/programmatic extraction of data or output and bypassing protections. [OpenAI general Terms](https://openai.com/policies/terms-of-use/) contain the corresponding restrictions outside the European scope. [Anthropic Consumer Terms, section 3](https://www.anthropic.com/legal/consumer-terms) restrict harvesting and automated/non-human access except via API keys or explicit permission. Consumer login and user consent to an extension do not establish that permission. API routes do not meet this product's no-key/no-paid-API requirements and were not pursued. These reviewed sources establish restrictions, not proof that no bespoke permission could ever be obtained.

**Unverified assumptions:** live URL/selector compatibility; root redirects; composer visibility/editability; supported handling of drafts and disabled controls; first-message transition attribution; identifying the reply to one particular submission; detecting final streaming completion, errors or limits; safe exactly-once behavior across worker loss. Current readiness proves only a response from the fixed inspector with a matching classified page and composer existence.

**Changes excluded:** porting legacy automatic reply extraction, enabling scripted Claude consumer access without explicit provider permission, CAPTCHA/protection bypass, private endpoints, cookie/token harvesting, or silently replacing linked conversations. None implemented.

**Next action now:** execute the manual matrix and capture non-content evidence, then make only provider-specific URL/composer-rule corrections justified by that evidence. This completes the browser baseline without pretending it enables debate.

**Smallest next implementation toward genuine exchange, conditional on a documented authorized route for both providers:** one fixed, provider-specific single-turn operation in the existing transport/adapters, tied to the approved tab/document/conversation and one operation ID, with submission acknowledgement, attributable completed response and no replay after an uncertain result. Validate one exchange in an approved empty and saved conversation before connecting it to the existing maximum-four-round runner. Authorization must cover both submission and automated response acquisition. Until that route or permission exists, autonomous consumer-browser debate is blocked under the stated restrictions; no permissible implementation step can manufacture it. No new architecture or engine change is required or proposed.
