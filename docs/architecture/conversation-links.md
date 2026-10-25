# Conversation links (Phase 2.1)

Phase 2.1 lets the human **associate** one open ChatGPT conversation and one open Claude conversation with ThirdMind. It is conversation linking only:

- ThirdMind reads the **URL and title of open tabs** through Chrome's Tabs API.
- It does **not** read conversation contents, inject scripts, send messages, or automate either website.
- The simulated debate does **not** use linked conversations. The debate engine, its checkpoint and its mock providers are unchanged.

A linked conversation is not an active provider integration, and the interface never describes it as one.

## Components and dependency direction

| Responsibility                         | Module                                                    | Layer          |
| -------------------------------------- | --------------------------------------------------------- | -------------- |
| Connection model and state transitions | `src/domain/connections.ts`                               | domain (pure)  |
| Ports: `TabSource`, `ConversationRecognizer`, `ConnectionStore` | `src/ports/index.ts`             | ports          |
| Provider URL recognition (rules)       | `src/infrastructure/conversation-urls.ts`                 | infrastructure |
| In-memory connection store (tests)     | `src/infrastructure/memory-connection-store.ts`           | infrastructure |
| Connection coordination and reconciliation | `src/application/connection-coordinator.ts`           | application    |
| Side panel read model                  | `src/application/connection-view.ts`                      | application    |
| Tab discovery and tab events (Chrome)  | `src/extension/chrome-tabs.ts`                            | extension      |
| `storage.session` connection store     | `src/extension/session-connection-store.ts`               | extension      |
| Messages and routing                   | `src/extension/protocol.ts`, `src/extension/background-host.ts` | extension |
| Side panel UI                          | `src/ui/components/ConversationConnections.tsx`           | ui             |

```text
ui ──► extension ──► application ──► ports ──► domain
            │                                    ▲
            └──────► infrastructure ─────────────┘
```

The domain sees a tab only as an opaque number (`BrowserTabId`) plus a `TabClassification`. No Chrome type crosses into `domain`, `ports` or `application`. The URL rules are infrastructure configuration, injected into the coordinator through the `ConversationRecognizer` port. Nothing in the connection modules imports the debate engine, and the debate engine does not import them.

## Supported provider URL patterns

Rules live in `PROVIDER_URL_RULES` (`src/infrastructure/conversation-urls.ts`). The URL is parsed with the WHATWG `URL` parser. The **origin must be exactly equal** to the rule's origin, and the **path must match an anchored pattern**. Query strings and fragments are ignored. No substring matching is used.

| Provider | Origin                | Conversation paths                                   | Canonical URL                          |
| -------- | --------------------- | ---------------------------------------------------- | -------------------------------------- |
| ChatGPT  | `https://chatgpt.com` | `/c/<uuid>`; `/g/g-<slug>/c/<uuid>` (custom GPT or project) | origin + matched path, lowercase id |
| Claude   | `https://claude.ai`   | `/chat/<uuid>`                                       | origin + matched path, lowercase id    |

`<uuid>` is the 8-4-4-4-12 hexadecimal form. Conversation identity is **provider + lowercase conversation id**.

Classification of a tab:

| Classification   | Meaning                                                                           | Linkable |
| ---------------- | --------------------------------------------------------------------------------- | -------- |
| `conversation`   | Supported origin and a recognized conversation path                               | yes      |
| `provider-page`  | Supported origin, but no recognized conversation (home, new chat, project, share link, settings) | no |
| `unsupported`    | Any other URL, including `http:`, other ports, lookalike hosts, URLs with credentials, URLs over 2048 characters | no |
| `unavailable`    | The tab exists but Chrome did not expose its URL                                  | no       |

Not supported: `chat.openai.com`, `www.` variants, shared conversation links (`/share/…`), temporary chats, and any future URL format. When a provider changes its URLs, only `PROVIDER_URL_RULES` and its tests need to change.

## Connection model

```ts
type ConnectionState =
  | { kind: 'linked' }
  | { kind: 'unavailable'; reason: 'tab-unreadable' | 'tab-query-failed' }
  | { kind: 'stale'; reason: 'different-conversation' | 'left-conversation' }
  | { kind: 'disconnected'; reason: 'tab-closed' };

interface ConversationLink {
  provider: 'chatgpt' | 'claude';
  tabId: number;
  conversationId: string;
  canonicalUrl: string;
  state: ConnectionState;
}

// One slot per provider; `revision` increases on every change of the slot.
type ConnectionRegistry = Record<'chatgpt' | 'claude', { revision: number; link: ConversationLink | null }>;
```

**Available** is a property of a *candidate* (an open conversation that is not linked), not of a link. The side panel shows each candidate as `available`, `linked` or `reconnectable`.

### State transitions

| Current state             | Observation of the linked tab                     | Next state                         |
| ------------------------- | ------------------------------------------------- | ---------------------------------- |
| linked / unavailable      | shows the same conversation                       | linked                             |
| linked / unavailable      | shows a different conversation (same provider or not) | stale (`different-conversation`) |
| linked / unavailable      | shows a provider page or an unsupported page      | stale (`left-conversation`)        |
| linked / unavailable      | exists, URL unreadable                            | unavailable (`tab-unreadable`)     |
| linked / unavailable      | tab query failed (nothing confirmed)              | unavailable (`tab-query-failed`)   |
| linked / unavailable      | a successful query or `tabs.onRemoved` confirms the tab is gone | disconnected (`tab-closed`) |
| stale / disconnected      | anything                                          | unchanged                          |

`unavailable` is **temporary**: it returns to `linked` automatically once the same tab is seen with the same conversation. `stale` and `disconnected` are **confirmed losses**: they never return to `linked` on their own, not even if the same tab later shows the original conversation again. Only an explicit reconnection restores them.

Transitions are pure (`observeLink`, `reconcileRegistry`) and return the same object when nothing changes, so duplicate events and repeated scans are idempotent and do not advance revisions.

## Lifecycle

### Discovery

`TabSource.listTabs()` calls `chrome.tabs.query({})`. The coordinator classifies every tab, keeps only provider tabs (`conversation` and `provider-page`) with a sanitized title, and counts `unavailable` tabs. URLs and titles of unrelated tabs are dropped immediately. They are never stored, logged or sent anywhere.

Tab titles are untrusted: control characters and bidirectional overrides are removed, whitespace is collapsed, and the length is capped at 200 characters. They are rendered as React text, never as HTML, and are never used to establish identity.

### Selection and confirmation

1. The panel lists candidates per provider. Nothing is preselected, not even a single candidate.
2. The human selects a candidate and clicks **Link selected conversation**.
3. The panel sends `link-conversation` with the provider, tab id, the conversation id it displayed, and the slot `expectedRevision`.
4. The coordinator rescans the tabs, then links only if the slot revision is unchanged **and** the tab still shows exactly that conversation. A tab that navigated in the meantime is rejected.

### Disconnection

**Disconnect** (`disconnect-conversation`) removes the link from the slot. Disconnecting an empty slot succeeds without effect.

### Tab events

`watchTabEvents` registers, synchronously at worker start:

| Event                 | Effect                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `tabs.onCreated`      | rescan if the new tab is on a supported provider site                                   |
| `tabs.onUpdated`      | rescan if `url`, `title`, `status` or `discarded` changed and the tab is tracked or on a provider site |
| `tabs.onRemoved`      | a link on that tab becomes `disconnected`; the tab leaves the candidate list            |
| `tabs.onReplaced`     | the replaced tab is treated as removed, then a rescan runs                              |

Rescans are coalesced: several events that arrive before a scan starts trigger only one scan. All work runs through one serialized queue, so events, scans and commands never interleave.

### Reconciliation (worker restart and panel reconnection)

Chrome may suspend the service worker, and tab events that happen meanwhile are lost. The coordinator therefore reconciles stored links with a fresh scan:

- on every service worker start (`initialize`: load links, then scan);
- on every side panel connection (each panel open or reconnect triggers a scan);
- when the human clicks **Refresh**.

### Reconnection

When a link is `stale`, `disconnected` or `unavailable`, every open tab that shows the **same conversation id** is offered as `reconnectable`, with an explicit **Reconnect** button. `reconnect-conversation` succeeds only if the tab, at that moment, shows the linked conversation. The same tab id alone, or a matching title, is never accepted as proof of identity. A different conversation can be linked through the normal selection list instead.

### Stale clients

Every command that changes a slot carries `expectedRevision`. The coordinator rejects it if the slot has changed since the panel rendered it (for example, another panel linked a different conversation, or the tab closed). The host then sends a `command-rejected` notice and a fresh view.

## Persistence

Links are stored in `chrome.storage.session` under `thirdmind.connections.v1`, separate from the debate checkpoint (`thirdmind.checkpoint.v1`). Each link stores only: provider, tab id, conversation id, canonical conversation URL, connection state, and the slot revision. No titles and no conversation content.

| Event                               | Links survive? | Why                                                                 |
| ----------------------------------- | -------------- | ------------------------------------------------------------------- |
| Side panel closed and reopened      | yes            | Links live in the service worker and in `storage.session`           |
| Service worker suspended/restarted  | yes            | `storage.session` survives; links are re-verified against open tabs |
| Extension reloaded or updated       | **no**         | Chrome clears `storage.session`                                     |
| Browser restarted                   | **no**         | `storage.session` is in memory only; tab ids are new anyway         |

If writing to storage fails, the in-memory state remains authoritative until the worker stops, and the error is logged without URLs or titles.

## Permission: `tabs`

Phase 2.1 adds the `tabs` permission. Chrome describes it to users as *"Read your browsing history"*, because it exposes the URL and title of **every** open tab to the extension.

Why it is needed: discovering *existing* conversations means reading the URL of tabs the user opened before interacting with ThirdMind. The alternatives do not cover that:

- `activeTab` grants access only to the current tab, and only after a user gesture on the extension. It cannot list other open conversations, and the access ends when the tab navigates.
- Host permissions for `https://chatgpt.com/*` and `https://claude.ai/*` would also reveal those tabs' URLs, but they additionally grant script injection and network access to the provider sites. That is broader in capability and is deliberately deferred until a phase that needs it.

Mitigations: unrelated tabs are classified in memory and discarded at once; only provider tabs are kept, and only their sanitized titles; no URL or title is logged or transmitted; persisted data is minimal and session-only. No host permissions, content scripts, `cookies`, `history`, `webRequest` or private provider endpoints are used.

## Limitations

- Classification depends on the providers' current URL formats. A change on their side makes conversations appear as provider pages until the rules are updated.
- A brand-new ChatGPT or Claude chat has no conversation URL until the first message is sent, so it cannot be linked before that.
- Incognito tabs are not visible unless the user allows ThirdMind in incognito, which is not tested.
- Tabs in other Chrome profiles are not visible.
- A link only proves that a tab showed a given conversation URL when last checked. It does not prove that the user is signed in, that the conversation still exists, or that the page loaded successfully.
- Real Chrome behaviour (events, suspension, permission prompts) is verified manually; automated tests use mocked Chrome APIs.
