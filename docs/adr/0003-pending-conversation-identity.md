# ADR 0003: Pending conversation identity for new chats

- **Status:** Accepted
- **Scope:** Phase 2.2A (new chat linking and identity reconciliation)
- **Builds on:** [ADR 0002](0002-conversation-links-via-tabs-api.md)

## Context

ThirdMind will coordinate a debate between ChatGPT and Claude. The human must be able to start that debate in an existing conversation **or in a new, empty chat**. Phase 2.1 linked only saved conversations, recognized by the conversation identifier in the tab URL (`/c/<uuid>`, `/chat/<uuid>`). A new chat has no identifier until its first message is sent, so Phase 2.1 refused to link it.

Forces:

- A new chat's URL (`https://chatgpt.com/`, `https://claude.ai/new`) identifies the provider, not a conversation. Many tabs can show it at once.
- When the first message is sent, the provider moves the **same tab** to a saved-conversation URL. That is the only signal available without content scripts.
- The same URL change also happens when the human clicks an existing conversation in the provider's sidebar. The URL alone cannot tell the two apart.
- The MV3 service worker can be stopped at any time, and tab events are lost while it is.
- Phase 2.2A must not add permissions, content scripts or automation.

## Decision

1. **New-chat entry points are modeled explicitly.** `UrlClassification` gains a `new-chat` kind, produced only for confirmed entry points on the exact provider origin: ChatGPT `/`, Claude `/new` and `/`. Unsaved chat modes (`?temporary-chat`, `?incognito`) and every other path stay `provider-page` and cannot be linked.

2. **Identity and tab association are separate.** A `ConversationLink` has an `identity` and a tab association (`tabId` + `ConnectionState`), plus the expected provider `origin`:

   ```ts
   type ConversationIdentity =
     | { kind: 'saved'; conversationId; canonicalUrl; source: 'selected' | 'new-chat' | 'confirmed' }
     | { kind: 'pending' }
     | { kind: 'unconfirmed'; conversationId; canonicalUrl; reason: 'observation-gap' | 'open-in-another-tab' };
   ```

   A pending identity stores **no** conversation id and **no** URL. Nothing is invented for it. The combined status shown to the user (`linked`, `awaiting-identity`, `confirmation-required`, `unavailable`, `stale`, `disconnected`) is derived by one exhaustive function, `linkStatus`.

3. **Automatic resolution needs observed continuity.** A pending link adopts the conversation its tab now shows (`saved`, source `new-chat`) only if all of the following hold:
   - the conversation has the link's provider and exact origin;
   - the **previous successful scan in this runtime** saw the **same tab** showing a new chat of that provider, and the link was healthy (`linked`, not `unavailable`);
   - the conversation was **not** open in any other tab at the previous scan;
   - the conversation is **not** open in any other tab now.

4. **Otherwise ask, or refuse.**
   - The conversation was already open in another tab at the previous scan: it existed before the new chat could have been saved, so the link becomes `stale` (`different-conversation`) and nothing is adopted.
   - No continuity (first scan after a worker start, a failed tab query, an unreadable tab, or the previous scan did not show this tab on the new chat): `unconfirmed` with reason `observation-gap`.
   - The conversation appears in another tab at the same time: `unconfirmed` with reason `open-in-another-tab`.
   - Another provider, another origin, a non-chat provider page or an external site: `stale`.
   - Tab closed: `disconnected`.

   An `unconfirmed` identity is accepted only by an explicit `confirm-conversation-identity` command, for the **original tab**, the **same conversation id** the panel displayed, the current slot revision, and only if a fresh scan still shows that conversation in that tab.

5. **Established identities are never replaced.** A `saved` or `unconfirmed` link whose tab shows any other conversation becomes `stale`, as in Phase 2.1. `stale` and `disconnected` stay terminal.

6. **A pending new chat cannot be reconnected.** Without an identifier there is nothing to recognize it by in another tab. After its tab closes, the human links a conversation or a new chat again.

7. **Versioned storage.** The registry is stored as `{ version: 2, registry }` under `thirdmind.connections.v2`. A Phase 2.1 record (`thirdmind.connections.v1`) is migrated on load: each stored canonical URL is classified again with the current rules, links that no longer match are dropped, and the old key is removed on the next save.

8. **A URL change is never treated as proof that a message was sent.** The `new-chat` source records only that the tab moved directly from the linked new chat to the conversation while ThirdMind was watching.

## Consequences

**Positive**

- New chats are first-class link targets, and the common case (the human sends the first message in the linked tab while ThirdMind runs) resolves without any extra click.
- Gaps in observation, duplicates and pre-existing conversations never lead to a silent association.
- The model stays pure and testable without a browser. No permissions, content scripts or provider automation were added.

**Negative / accepted risk**

- **Sidebar navigation is indistinguishable from a first message.** If, while ThirdMind is watching, the human clicks an existing conversation in the linked new chat's sidebar, and that conversation is not open in any other tab, the URL transition looks exactly like the first message being sent. ThirdMind adopts it as the new chat's identity. The UI states that the conversation was "recorded from the linked new chat", and the human can disconnect it. Closing this gap needs a signal that tab metadata cannot provide (see Phase 2.2B below).
- Coalesced scans can miss intermediate URLs: if a tab moves new chat → A → B before one scan runs, only B is observed.
- The previous-scan memory is held in memory only, so every worker restart causes a confirmation for a new chat that was saved meanwhile. This is deliberate.

## Follow-up for Phase 2.2B

Superseded for live debates by [ADR 0005](0005-live-new-chat-lifecycle.md): a live first message is bound only through the correlation described there. The link model itself is unchanged.


When ThirdMind itself sends the first message through a content script, it can arm an explicit expectation ("this tab is about to leave the new chat because ThirdMind sent a message") and require that expectation for automatic resolution. Without it, the transition should be treated as `unconfirmed`. The `IdentitySource` and `ConfirmationReason` unions are the extension points for that.

## Alternatives considered

- **Always require confirmation.** Safest, but it makes the normal flow (send the first message, keep working) depend on a manual step. Rejected in favour of continuity-based resolution with explicit fallbacks.
- **Adopt every new-chat → conversation transition.** Rejected: it silently attaches to arbitrary conversations after worker restarts, tab id reuse or sidebar navigation to an already open conversation.
- **Use tab titles to tell new and existing conversations apart.** Rejected: titles are untrusted and provider-specific, and they change asynchronously.
- **`webNavigation` transition types.** Needs a new permission, and single-page-app history updates do not distinguish a sent message from a sidebar click either.
- **Store a synthetic identifier for the pending chat.** Rejected: it would look like a real conversation identifier and could leak into later phases as one.
