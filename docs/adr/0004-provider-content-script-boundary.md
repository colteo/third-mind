# ADR 0004: Provider content scripts and the page transport security boundary

- **Status:** Accepted
- **Scope:** Phase 2.2B foundation (live provider transport, readiness only)
- **Amends:** [ADR 0002](0002-conversation-links-via-tabs-api.md), decision 1 ("no content scripts")

## Context

ThirdMind's goal is an autonomous, multi-round debate between ChatGPT and Claude that uses the human's own browser conversations, without mandatory paid APIs. Exchanging messages with those conversations requires code that runs inside the provider pages. Before any message is read or sent, the extension needs a channel to those pages whose security properties and failure modes are understood and tested.

Forces:

- Provider pages hold the user's private conversations and an authenticated session. Anything that runs there is highly trusted by the user and highly exposed to the page.
- The MV3 service worker can stop at any time; content scripts keep running. Either side can disappear independently.
- Tabs navigate and reload, and providers are single-page apps whose URL changes without a new document. An answer can describe a page that is no longer shown.
- Content scripts declared in the manifest are not injected into tabs that were already open when the extension was installed, updated or reloaded.
- A delivery timeout says nothing about whether the page acted on a message. Later phases will send prompts, where acting twice or concluding "failed" falsely both matter.
- The providers' pages change without notice.

## Decision

1. **Two static, narrowly matched content scripts.** `src/entrypoints/chatgpt.content.ts` matches only `https://chatgpt.com/*` and `src/entrypoints/claude.content.ts` only `https://claude.ai/*`. They run in the isolated world, in the top frame only (`all_frames` is false), at `document_idle`.
2. **No new permissions.** No `host_permissions`, `scripting`, `webNavigation`, `webRequest`, `cookies` or `<all_urls>`. The worker reaches the scripts with `tabs.sendMessage`, which needs no permission. The only new install-time capability is the content scripts' own match patterns.
3. **A closed set of operations.** The wire protocol (`src/extension/provider-transport-protocol.ts`) defines exactly one request, `inspect-page`, and one announcement, `page-hello`. No message carries code, selectors, URLs or text, and no code path evaluates received data. The side panel can only ask the host to check *the provider's linked tab* (`check-provider-page` names a provider, not a tab), so it cannot aim the transport at arbitrary tabs or pass anything to a page.
4. **Read only non-sensitive facts.** The content script reports the page kind (from its own URL, via the same exact-origin rules as tab discovery), `document.readyState`, `document.visibilityState` and whether the provider's message box element exists. It never reads element contents, titles, conversation text or user data, never types, clicks or submits, and never makes network requests.
5. **Validate both ends of every message.**
   - Content script: answers only senders with this extension's id, no tab (not a content script) and an extension origin; it refuses requests for the other provider and refuses to report when its own URL is not on the expected exact origin.
   - Worker: accepts `page-hello` only from this extension's content script in the top frame (`frameId` 0) of a tab whose URL classifies as the claimed provider and whose Chrome-reported `origin` matches that URL. One-off messages are never answered.
   - Every message is parsed from `unknown` and rebuilt field by field; extra fields are dropped.
6. **Validate the tab before and after every operation.** Before sending, the worker reads the tab and checks that it shows the expected provider's exact origin; otherwise nothing is sent. After the answer, it re-reads the tab and rejects the answer if the tab closed, its URL changed, a navigation was observed, a new document announced itself, or the page's own classification disagrees with the tab URL. Answers must echo a fresh request id.
7. **Report what is known about the outcome.** Every failure carries `outcome: 'not-performed' | 'unknown'`. Only failures that prove the page did not act (nothing was sent, no receiver, the page refused) are `not-performed`. A timeout is always `unknown`. Unrecognized Chrome errors are `unknown`.
8. **Keep the transport diagnostic and separate.** A page check never changes a link, the debate or a checkpoint. Transport state (navigation traces) is in memory only and is rebuilt after a worker restart.

## Consequences

**Positive**

- The channel that later phases will use for real message exchange exists and is tested against navigation, tab closure, missing scripts, worker restarts, forged senders and timeouts, before any user content flows through it.
- The extension still cannot read or change any site other than the two provider origins, and cannot inject code on demand.
- Provider page structure lives in one configuration file (`src/infrastructure/provider-pages.ts`), like the URL rules.

**Negative**

- Chrome now shows an install-time warning for the provider sites (*"Read and change your data on chatgpt.com and claude.ai"*), and existing installs are disabled until the user accepts it. This is broader than what the scripts do today, but it cannot be narrowed: any content script carries this warning.
- Tabs that were open before installation, update or reload have no content script until they are reloaded. Without `scripting` and host permissions the extension cannot fix that itself; the panel tells the user to reload the tab.
- The composer selectors are unverified against the real sites and will break when the providers change their pages. A broken selector reports `composer-missing`; it never makes a page look ready.
- `sender.origin` is used when Chrome provides it; otherwise the URL classification alone decides.
- Chrome reports messaging failures only as error strings, which the worker classifies by pattern. A changed string falls back to `transport-error` with an unknown outcome.

## Alternatives considered

- **Programmatic injection (`scripting` + host permissions).** Would handle tabs opened before installation, but adds the ability to inject arbitrary code at any time and a broader permission. Rejected for this iteration; it can be reconsidered as an *optional* permission requested at runtime.
- **`<all_urls>` or wildcard subdomains.** Unnecessary and much broader. Rejected.
- **Main-world scripts.** Would share the page's JavaScript environment, letting the page tamper with ThirdMind's code. Rejected.
- **Long-lived ports from content scripts.** Would keep the worker alive and detect disconnects, but every reconnect after a worker restart becomes state to reconcile, and ports would keep the worker running indefinitely. One-off messages with per-request validation are simpler. May be revisited for streaming answers.
- **Targeting documents with `documentId`.** Chrome can address one document directly, but learning its id needs `webNavigation` or a stored hello, which is lost on worker restart. The traces, URL re-checks and page instance ids give the same protection without a new permission.
- **Private provider endpoints or APIs.** Out of scope by product rule: no paid APIs are required and no undocumented endpoints are used.
