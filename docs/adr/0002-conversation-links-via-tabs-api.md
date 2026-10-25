# ADR 0002: Conversation links through the Tabs API, separate from the debate

- **Status:** Accepted. Decision 1 ("no content scripts") is amended by [ADR 0004](0004-provider-content-script-boundary.md), which adds readiness-only content scripts for the two provider origins; tab discovery and linking still use only the Tabs API.
- **Scope:** Phase 2.1 (conversation linking)

## Context

Later phases will let ThirdMind exchange messages with existing ChatGPT and Claude conversations. The first step is to let the human say *which* open conversations ThirdMind should work with, without yet reading or sending anything. This must not weaken the validated simulation mode, and it must not grant the extension more access than this step needs.

Forces:

- Existing conversations are opened by the user before ThirdMind is involved, so discovery must see tabs the extension did not create.
- The MV3 service worker can be suspended at any time, and tab events are lost while it is.
- Tab ids are not conversation identities: a tab can navigate to another conversation, and titles are user-controlled.
- Provider URL formats change independently of ThirdMind.

## Decision

1. **`tabs` permission, no host permissions.** Tab discovery uses `chrome.tabs.query` and the `tabs.on*` events. No content scripts, host permissions, `cookies`, `history` or `webRequest`.
2. **A separate connection model.** `src/domain/connections.ts` holds a pure model (links, states, transitions, commands). It is independent of the debate engine and is not routed into it.
3. **URL rules are infrastructure.** `src/infrastructure/conversation-urls.ts` holds exact-origin, anchored-path rules behind the `ConversationRecognizer` port.
4. **Identity is the conversation id.** A link is valid only while its tab shows the same provider and conversation id. Confirmed losses (`stale`, `disconnected`) are only restored by explicit human reconnection; temporary uncertainty (`unavailable`) recovers automatically.
5. **Reconcile, do not trust events alone.** Links are reconciled with a fresh tab scan on worker start, on every panel connection, and on demand.
6. **Revisions per provider slot.** Commands carry the revision the panel displayed, so stale panels cannot overwrite newer state.
7. **Session-only, minimal persistence.** Links are stored in `chrome.storage.session` under their own key, without titles or content.

## Consequences

**Positive**

- Simulation mode is untouched, and links can be tested entirely in Node with mocked tab sources.
- Provider URL changes are isolated to one infrastructure file.
- No access to provider page content exists yet, so there is no content to leak.

**Negative**

- The `tabs` permission is shown to users as access to browsing history, which is broader than the two provider sites. This is mitigated by discarding unrelated tabs immediately, but the permission itself cannot be narrowed.
- Links do not survive extension reloads or browser restarts.

## Alternatives considered

- **`activeTab`:** cannot list other open tabs; rejected.
- **Host permissions for the two provider origins:** would expose the same URLs without `tabs`, but also grant script injection and network access. Deferred to the phase that actually needs page access.
- **`storage.local`:** would make links survive browser restarts, but tab ids do not, and it would create a persistent record of which conversations the user opened. Rejected.
