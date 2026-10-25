# ADR 0005: Live debates in linked new chats

- **Status:** Accepted
- **Scope:** Live execution (new-chat lifecycle)
- **Builds on:** [ADR 0003](0003-pending-conversation-identity.md), [docs/architecture/live-execution.md](../architecture/live-execution.md)

## Context

ADR 0003 made linked new chats (`awaiting-identity`) first-class link targets. The live preflight later required a saved conversation id again, so a live debate could not start in a new chat, although the human had explicitly approved it.

A new chat has no persistent id until its first message is saved. After that message, the provider moves the same tab to the new conversation's URL. The same URL change also results from a sidebar click (ADR 0003), so a URL change alone cannot identify the conversation.

## Decision

1. **Two target kinds.** `LiveTargetBinding` and `LiveConversationTarget` are `conversation | new-chat` unions. A `new-chat` binding records provider, approved tab, exact origin and the observed page instance (document). It never carries a conversation id.
2. **Preflight accepts healthy new chats.** `awaiting-identity` passes the connection check. The page must answer for the same provider and show a new chat. For a session, it must be the same document. Unconfirmed, stale, disconnected and unverifiable links stay blocked. Adapters report capabilities per target kind.
3. **Write-ahead first message.** A persisted `first-message` record (operation id plus binding) is written before the first submission, in addition to the runner's checkpoint.
4. **Binding needs correlation.** The conversation is bound only when all of these agree: the pending operation (receipt and response), the approved tab and its link (which must hold that conversation and not be stale), the document lifecycle (same page instance, so a same-document navigation), and the conversation the adapter reported.
5. **Unresolved stays unresolved.** Otherwise, and after any restart, the record stays, the operation is uncertain, and nothing more is sent to that participant until the human explicitly resolves it (`bind-conversation` or `keep-new-chat`, both checked against a fresh observation). Nothing is retried automatically.

## Consequences

- The expected new-chat-to-conversation transition is recognized, while a move to an unrelated conversation still invalidates the target.
- A conversation bound from a first message is accepted while the link itself still asks for confirmation of the same id (observation gap), because the live correlation is stronger evidence than the tab scan.
- One more small record lives in `chrome.storage.session`. It contains tab ids, conversation ids and page instance ids only.
- The shipped consumer-site adapters still report submission, response acquisition and authorization as unavailable, so no live debate can start in this build.
- The recovery command is not yet exposed in the side panel.
