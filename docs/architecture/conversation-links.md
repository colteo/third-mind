# Conversation links (Phase 2.1 and 2.2A)

The side panel lets the human **associate** one ChatGPT tab and one Claude tab with ThirdMind. Each tab can show an existing, saved conversation (Phase 2.1) or a **new, empty chat** that does not have a conversation identifier yet (Phase 2.2A). It is conversation linking only:

- ThirdMind reads the **URL and title of open tabs** through Chrome's Tabs API.
- It does **not** read conversation contents, inject scripts, send messages, or automate either website.
- The simulated debate does **not** use linked conversations. The debate engine, its checkpoint and its mock providers are unchanged.

A linked conversation is not an active provider integration, and the interface never describes it as one.

Design decisions: [ADR 0002](../adr/0002-conversation-links-via-tabs-api.md) (tabs, separate model) and [ADR 0003](../adr/0003-pending-conversation-identity.md) (pending identities).

## Components and dependency direction

| Responsibility                         | Module                                                    | Layer          |
| -------------------------------------- | --------------------------------------------------------- | -------------- |
| Connection model, identity reconciliation, storage validation and migration | `src/domain/connections.ts` | domain (pure) |
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

Rules live in `PROVIDER_URL_RULES` (`src/infrastructure/conversation-urls.ts`). The URL is parsed with the WHATWG `URL` parser. The **origin must be exactly equal** to the rule's origin, and the **path must match an anchored pattern**. Query strings and fragments are ignored, except for the unsaved-chat parameters below. No substring matching is used.

| Provider | Origin                | Saved conversation paths                             | New-chat entry points | Not a new chat (unsaved modes) |
| -------- | --------------------- | ---------------------------------------------------- | --------------------- | ------------------------------ |
| ChatGPT  | `https://chatgpt.com` | `/c/<uuid>`; `/g/g-<slug>/c/<uuid>` (custom GPT or project) | `/`            | `?temporary-chat=…`            |
| Claude   | `https://claude.ai`   | `/chat/<uuid>`                                       | `/new`, `/new/`, `/`  | `?incognito…`                  |

`<uuid>` is the 8-4-4-4-12 hexadecimal form. The canonical URL of a saved conversation is the origin plus the matched path with a lowercase id. Conversation identity is **provider + lowercase conversation id**. A new chat has no identity and no canonical URL.

Classification of a tab:

| Classification   | Meaning                                                                           | Linkable |
| ---------------- | --------------------------------------------------------------------------------- | -------- |
| `conversation`   | Supported origin and a recognized saved-conversation path                         | yes, as a saved conversation |
| `new-chat`       | Supported origin and a confirmed new-chat entry point                             | yes, as a pending new chat |
| `provider-page`  | Supported origin, any other path (projects, settings, share links, GPT pages, unknown paths, temporary or incognito chats) | no |
| `unsupported`    | Any other URL, including `http:`, other ports, `www.` and lookalike hosts, URLs with credentials, URLs over 2048 characters | no |
| `unavailable`    | The tab exists but Chrome did not expose its URL                                  | no       |

Unknown provider paths stay `provider-page` until they are modeled explicitly. In particular, new chats inside a ChatGPT custom GPT or project (`/g/…`) are not recognized as new chats yet.

**Verification status of the new-chat rules.** ChatGPT `/` and Claude `/new` are the pages the providers' own **New chat** buttons open, as observed at the time of writing; neither provider documents its URL scheme. Claude `/` is accepted because, for signed-in users, it shows the same new-chat page; this was observed manually and is not guaranteed. A link created on a root page that never starts a chat (for example, a signed-out landing page) simply stays pending. Whether temporary or incognito chats ever receive a saved-conversation URL is unverified, so they are excluded.

## Connection model

```ts
type ConversationIdentity =
  | { kind: 'saved'; conversationId: string; canonicalUrl: string; source: 'selected' | 'new-chat' | 'confirmed' }
  | { kind: 'pending' } // a new chat: no identifier, no URL
  | { kind: 'unconfirmed'; conversationId: string; canonicalUrl: string; reason: 'observation-gap' | 'open-in-another-tab' };

// State of the tab association, relative to what the link expects the tab to show.
type ConnectionState =
  | { kind: 'linked' }
  | { kind: 'unavailable'; reason: 'tab-unreadable' | 'tab-query-failed' }
  | { kind: 'stale'; reason: 'different-conversation' | 'left-conversation' }
  | { kind: 'disconnected'; reason: 'tab-closed' };

interface ConversationLink {
  provider: 'chatgpt' | 'claude';
  origin: string; // exact provider origin the link was approved for
  tabId: number; // the user-approved tab
  identity: ConversationIdentity;
  state: ConnectionState;
}

// One slot per provider; `revision` increases on every change of the slot.
type ConnectionRegistry = Record<'chatgpt' | 'claude', { revision: number; link: ConversationLink | null }>;
```

Conversation identity and tab association are separate: the identity says *which conversation* the link means; the tab association says *whether the approved tab still shows it*. What the tab is expected to show depends on the identity: the saved or unconfirmed conversation, or a new chat of the same provider and origin for a pending link.

The panel shows one combined status, derived exhaustively by `linkStatus(link)`:

| Status                  | Identity     | Tab state      | Label                               |
| ----------------------- | ------------ | -------------- | ----------------------------------- |
| `linked`                | saved        | linked         | Linked                              |
| `awaiting-identity`     | pending      | linked         | New chat — pending first message    |
| `confirmation-required` | unconfirmed  | linked         | Confirmation required               |
| `unavailable`           | any          | unavailable    | Unavailable                         |
| `stale`                 | any          | stale          | Stale                               |
| `disconnected`          | any          | disconnected   | Disconnected                        |

**Available** is a property of a *candidate* (an open tab that is not linked), not of a link. The side panel lists saved-conversation candidates (`available`, `linked` or `reconnectable`) and new-chat candidates (`available` or `linked`) separately.

### State transitions of a saved or unconfirmed link

| Current state             | Observation of the linked tab                     | Next state                         |
| ------------------------- | ------------------------------------------------- | ---------------------------------- |
| linked / unavailable      | shows the same conversation                       | linked                             |
| linked / unavailable      | shows a different conversation (same provider or not) | stale (`different-conversation`) |
| linked / unavailable      | shows a new chat, a provider page or an unsupported page | stale (`left-conversation`) |
| linked / unavailable      | exists, URL unreadable                            | unavailable (`tab-unreadable`)     |
| linked / unavailable      | tab query failed (nothing confirmed)              | unavailable (`tab-query-failed`)   |
| linked / unavailable      | a successful query or `tabs.onRemoved` confirms the tab is gone | disconnected (`tab-closed`) |
| stale / disconnected      | anything                                          | unchanged                          |

An established identity is never replaced: a different conversation always makes the link stale.

### Identity reconciliation of a pending new chat

| Observation of the linked tab | Condition | Result |
| --- | --- | --- |
| a new chat of the same provider and origin (including Claude `/` ↔ `/new`) | — | stays pending; `unavailable` recovers to linked |
| a saved conversation of the same provider and origin | it was already open in **another** tab at the previous scan | stale (`different-conversation`); nothing adopted |
| | the previous scan in this runtime saw **this tab** on the new chat, the link was `linked`, and no other tab shows the conversation now | **saved**, source `new-chat`; state linked |
| | the same, but another tab shows the conversation now | unconfirmed (`open-in-another-tab`) |
| | no continuity: first scan after a worker start, the link was `unavailable`, or the previous scan did not show this tab on the new chat | unconfirmed (`observation-gap`) |
| a conversation of another provider or another origin | — | stale (`different-conversation`) |
| a non-chat provider page, another provider's new chat, or an external site | — | stale (`left-conversation`) |
| unreadable / query failed / tab gone | — | unavailable / unavailable / disconnected |

"Previous scan" is the coordinator's in-memory record of the provider tabs seen by the last **successful** scan. It is `null` after a worker start and after a failed scan, so continuity has to be re-established by observing the tab on the new chat again.

The resolved link keeps the same tab, provider, origin and slot; only its identity changes and the slot revision advances once. There is never a second connection.

A URL change is only evidence that the tab moved. It is never treated as proof that a message was sent, by ThirdMind or anyone else. See [ADR 0003](../adr/0003-pending-conversation-identity.md#consequences) for the residual risk (sidebar navigation to a conversation that is not open elsewhere looks the same as the first message).

Transitions are pure (`observeLink`, `reconcileRegistry`) and return the same object when nothing changes, so duplicate events and repeated scans are idempotent and do not advance revisions.

## Lifecycle

### Discovery

`TabSource.listTabs()` calls `chrome.tabs.query({})`. The coordinator classifies every tab, keeps only provider tabs (`conversation`, `new-chat` and `provider-page`) with a sanitized title, and counts `unavailable` tabs. URLs and titles of unrelated tabs are dropped immediately. They are never stored, logged or sent anywhere.

Tab titles are untrusted: control characters and bidirectional overrides are removed, whitespace is collapsed, and the length is capped at 200 characters. They are rendered as React text, never as HTML, and are never used to establish identity.

### Selection and confirmation

1. The panel lists saved conversations and new chats per provider, in two clearly labelled groups. Nothing is preselected, not even a single candidate.
2. The human selects one and clicks **Link selected conversation** or **Link selected new chat**.
3. The panel sends `link-conversation` (provider, tab id, the conversation id it displayed, `expectedRevision`) or `link-new-chat` (provider, tab id, `expectedRevision`). The panel never sends URLs.
4. The coordinator rescans the tabs, then links only if the slot revision is unchanged **and** the tab, at that moment, still shows exactly that conversation, or still shows a new chat of that provider. A new-chat tab that already moved to a saved conversation is rejected.

### Identity confirmation

When a pending link becomes `confirmation-required`, the panel explains why and offers **Confirm this conversation**. It sends `confirm-conversation-identity` with the provider, the linked tab id, the conversation id it displayed and `expectedRevision`. The coordinator rescans and accepts only if the link is still unconfirmed for that same tab and conversation, the slot revision is unchanged, and the tab still shows that conversation. The identity then becomes `saved` with source `confirmed`. **Disconnect** is the way to decline.

### Disconnection

**Disconnect** (`disconnect-conversation`) removes the link from the slot, whatever its identity. Disconnecting an empty slot succeeds without effect.

### Tab events

`watchTabEvents` registers, synchronously at worker start:

| Event                 | Effect                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `tabs.onCreated`      | rescan if the new tab is on a supported provider site                                   |
| `tabs.onUpdated`      | rescan if `url`, `title`, `status` or `discarded` changed and the tab is tracked or on a provider site |
| `tabs.onRemoved`      | a link on that tab becomes `disconnected`; the tab leaves the candidate lists           |
| `tabs.onReplaced`     | the replaced tab is treated as removed, then a rescan runs                              |

Rescans are coalesced: several events that arrive before a scan starts trigger only one scan. All work runs through one serialized queue, so events, scans and commands never interleave.

### Reconciliation (worker restart and panel reconnection)

Chrome may suspend the service worker, and tab events that happen meanwhile are lost. The coordinator therefore reconciles stored links with a fresh scan:

- on every service worker start (`initialize`: load links, then scan);
- on every side panel connection (each panel open or reconnect triggers a scan);
- when the human clicks **Refresh**.

The first scan after a start has no previous scan, so a pending new chat whose tab now shows a saved conversation becomes `confirmation-required`, never `linked`. A pending link whose tab still shows the new chat stays pending, and continuity resumes from that scan.

### Reconnection

When a link with a **saved** identity is `stale`, `disconnected` or `unavailable`, every open tab that shows the **same conversation id** is offered as `reconnectable`, with an explicit **Reconnect** button. `reconnect-conversation` succeeds only if the tab, at that moment, shows the linked conversation. The same tab id alone, or a matching title, is never accepted as proof of identity. A different conversation can be linked through the normal selection list instead.

A **pending** or **unconfirmed** link cannot be reconnected: there is no confirmed identifier to recognize it by. After closing the tab of a pending new chat, a reopened provider tab is listed as an ordinary candidate, and the human links it explicitly.

### Stale clients

Every command that changes a slot carries `expectedRevision`. The coordinator rejects it if the slot has changed since the panel rendered it (for example, another panel linked a different conversation, the tab closed, or the new chat's identity was resolved). Confirmation also checks the tab id and conversation id the panel displayed. The host then sends a `command-rejected` notice and a fresh view.

## Persistence

Links are stored in `chrome.storage.session` under `thirdmind.connections.v2` as `{ version: 2, registry }`, separate from the debate checkpoint (`thirdmind.checkpoint.v1`). Each link stores only: provider, expected origin, tab id, identity (`pending`, or a conversation id and canonical conversation URL plus how it was learned or why it is unconfirmed), connection state, and the slot revision. No titles and no conversation content. A pending new chat stores no conversation id and no URL.

**Migration.** A Phase 2.1 record under `thirdmind.connections.v1` is migrated when no version 2 record exists: each stored canonical URL is classified again with the current rules; a link that still matches becomes a `saved` identity (source `selected`) with its tab, state and revision; a link that no longer matches is dropped and its slot revision advances. The old key is removed on the next save. A record with an unknown version or an invalid shape is discarded. In practice Chrome clears `storage.session` on extension updates, so migration is a safety net rather than a common path.

| Event                               | Links survive? | Why                                                                 |
| ----------------------------------- | -------------- | ------------------------------------------------------------------- |
| Side panel closed and reopened      | yes            | Links live in the service worker and in `storage.session`           |
| Service worker suspended/restarted  | yes            | `storage.session` survives; links are re-verified against open tabs |
| Extension reloaded or updated       | **no**         | Chrome clears `storage.session`                                     |
| Browser restarted                   | **no**         | `storage.session` is in memory only; tab ids are new anyway         |

If writing to storage fails, the in-memory state remains authoritative until the worker stops, and the error is logged without URLs or titles.

## Permission: `tabs`

Phase 2.1 added the `tabs` permission. Phase 2.2A adds **no** permission. Chrome describes `tabs` to users as *"Read your browsing history"*, because it exposes the URL and title of **every** open tab to the extension.

Why it is needed: discovering *existing* conversations and new chats means reading the URL of tabs the user opened before interacting with ThirdMind. The alternatives do not cover that:

- `activeTab` grants access only to the current tab, and only after a user gesture on the extension. It cannot list other open conversations, and the access ends when the tab navigates.
- Host permissions for `https://chatgpt.com/*` and `https://claude.ai/*` would also reveal those tabs' URLs, but they additionally grant script injection and network access to the provider sites. That is broader in capability and is deliberately deferred until a phase that needs it.

Mitigations: unrelated tabs are classified in memory and discarded at once; only provider tabs are kept, and only their sanitized titles; no URL or title is logged or transmitted; persisted data is minimal and session-only. No host permissions, `cookies`, `history`, `webNavigation`, `webRequest` or private provider endpoints are used.

Link discovery and the link state still rely only on `tabs`. The content scripts added in the Phase 2.2B foundation do not take part in linking: a page check never creates, changes or confirms a link, and conversation identity still comes from the tab URL reported by Chrome. See [provider-transport.md](provider-transport.md) and [ADR 0004](../adr/0004-provider-content-script-boundary.md).

## Limitations

- Classification depends on the providers' current URL formats. A change on their side makes conversations or new chats appear as provider pages until the rules are updated.
- **Automatic identity resolution cannot tell the first message from sidebar navigation.** If the linked new chat's tab opens an existing conversation from the provider's sidebar while ThirdMind is watching, and that conversation is not open in any other tab, ThirdMind records it as the new chat's conversation. The panel labels the conversation as "recorded from the linked new chat", and the human can disconnect it. Phase 2.2B is expected to close this gap (see ADR 0003).
- Several navigations between two scans are seen as one: only the final URL is observed.
- New chats inside ChatGPT custom GPTs or projects, temporary chats and Claude incognito chats are not offered as new chats.
- Claude's site root (`/`) is accepted as a new-chat entry point on the basis of manual observation only.
- Incognito browser windows are not visible unless the user allows ThirdMind in incognito, which is not tested.
- Tabs in other Chrome profiles are not visible.
- A link only proves that a tab showed a given URL when last checked. It does not prove that the user is signed in, that the conversation still exists, that the page loaded successfully, or that any message was sent.
- Real Chrome behaviour (events, suspension, permission prompts, real provider redirects) is verified manually; automated tests use mocked Chrome APIs and do not require provider accounts.
