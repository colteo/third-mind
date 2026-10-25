# Live debate execution (foundation)

## Execution modes

`ExecutionMode = 'simulation' | 'live'` (`src/application/execution-mode.ts`). The mode is stored in the checkpointed session setup (`src/extension/debate-setup.ts`), so a restored session gets the same kind of providers it started with. `createProviders` builds simulators for simulation sessions and `createLiveProviders` for live ones. A live session never falls back to simulation: if a provider has no authorized adapter, it gets no provider at all, and the runner refuses to start (or the operation fails after a restart).

## Capability model

`src/application/live-capabilities.ts`. Each provider has five capabilities: `connection`, `transport`, `submission`, `responseAcquisition` and `authorization`. Each one is `available`, `unavailable` (with a `PreflightIssue`: code and an actionable message) or `not-checked`.

- **Technical readiness** means the first four are available.
- **Authorization** is a separate declaration made by the adapter about its route.
- **Live-ready** means both.

Submission and response availability come only from `LiveProviderAdapter.capabilities()`. When a content script answers a probe, that is never taken to mean ThirdMind can submit messages.

## Preflight

`createLivePreflight` (`src/application/live-preflight.ts`) refreshes the links, then checks each provider in turn:

1. **Link.** A healthy link is a valid target in two forms: a saved conversation (`linked`) or a linked new chat before its first message (`awaiting-identity`). The missing conversation id of a new chat does not block. It rejects missing links, unconfirmed identities, and stale, disconnected or unverifiable links. It also rejects a panel whose link revisions are outdated, and, for an existing session, a link that no longer designates the session's current target.
2. **Page.** It probes the linked tab. The page must answer for the linked provider and show the linked conversation, or a new chat, with a message box. For a session, a new chat must still be the same document (page instance) that was approved.
3. **Adapter.** It asks the adapter for its authorization and for its capabilities for that exact target, saved conversation or new chat.

The side panel receives the result as a `live-readiness` message. `prepareLiveStart` only starts a session when the preflight is ready. `verifyLiveContinuation` runs before a live session resumes or re-issues an operation.

## Live targets

`LiveTargetBinding` (`src/application/execution-mode.ts`) is a discriminated union:

- `conversation`: provider, tab, persistent conversation id, and how it became the target (`linked`, `first-message` or `recovered`);
- `new-chat`: provider, approved tab, exact origin and the page instance observed by the preflight. It has no conversation id, and none is invented.

The adapter port mirrors it: `LiveConversationTarget` is `conversation | new-chat`, and a `SubmissionReceipt` is a `new-chat` receipt (no conversation id) for a first message. Live setups checkpointed before this change (bindings without `kind`) are read as saved conversations.

## First-message lifecycle of a new chat

`src/application/live-target.ts`. Each participant's current state is kept by a `LiveTargetTracker` and written to a `LiveTargetStore` (`chrome.storage.session`, key `thirdmind.live-targets.v1`) before it is acted on:

1. **Target.** `ready` with the `new-chat` binding. Before the first message, the link must still be pending, on the same tab and origin, and the page must be the same new-chat document.
2. **Dispatch once.** The runner checkpoints the operation (write-ahead, as before). The provider then persists `first-message` with the operation id, and only then submits. The operation id stays the idempotency key.
3. **Observe.** After the response, the provider reconciles the links and probes the tab (`LivePreflight.observeNewChat`). The same tab moving from the new chat to a conversation of the same provider and origin is the expected transition and is not treated as an unrelated navigation.
4. **Reconcile and bind** (`reconcileFirstMessage`). All of these must hold: the receipt is a `new-chat` receipt for this operation and document; the response belongs to this operation, submission and document; the tab is still on the same document (a same-document navigation, not a reload); the link is healthy and holds that conversation (saved, or unconfirmed for that same id); and it is exactly the conversation the adapter reported. Then the state becomes `ready` with a `conversation` binding (source `first-message`).
5. **Continue.** Every later request is verified against, and sent to, exactly that conversation.

If any condition fails, the response is discarded, the operation becomes uncertain, and the state stays `first-message`: the identity is **unresolved**. Nothing more is sent to that participant, and the continuation gate reports `identity-unresolved`. An unrelated conversation (one the link reconciliation marks `stale`), a closed tab, another provider's page, a reloaded document, a conflicting conversation id, or a tab still on the new chat all end here.

If the adapter reports the submission as certainly `not-performed`, the record is withdrawn and the new chat is the target again. An `unknown` outcome never withdraws it.

### Recovery

- **Restart.** A service worker restart during a first message leaves the operation `uncertain` (`runtime-restart`, unchanged) and the `first-message` record in session storage. Nothing is re-submitted: the provider and the continuation gate both refuse while the record exists.
- **Explicit resolution.** `resolveLiveFirstMessage` applies the human's decision against a fresh observation of the tab: `bind-conversation` (the tab shows the conversation the first message created; source `recovered`) or `keep-new-chat` (the tab still shows the new chat; its current document becomes the approved one). It is refused while the first message is still in progress, and it never sends anything. Re-issuing the uncertain operation remains a separate, explicit action that accepts possible duplication.
- The resolution is implemented and tested in the application layer. It is not yet exposed as a side-panel command, because no shipped adapter can reach this state.

## Adapter boundary

`LiveProviderAdapter` (`src/ports/index.ts`) has these members: `route`, `authorization`, `capabilities(target)`, `submit(target, {operationId, text})` and `awaitResponse(target, receipt)`. Adapters must not throw, must not retry, and report each failure as `not-performed` or `unknown`.

The shipped adapters (`src/infrastructure/live/consumer-site-adapters.ts`) cover `chatgpt.com` and `claude.ai`. They declare the route `not-authorized`, report submission and response acquisition as unavailable, and refuse every operation without touching the page. Being able to reach a page does not mean ThirdMind may automate it. Neither provider documents automated messaging on its consumer website as a route for third-party extensions.

## Operation safety

`createLiveContributionProvider` handles each operation as follows:

- **Write-ahead.** The runner checkpoints the operation id before dispatch (this was already the case). The operation id is passed to the adapter as an idempotency key.
- **Target check.** Before submitting, it re-verifies the target. If the target changed, nothing is sent and the operation fails.
- **Locking.** A per-target lock (per conversation, or per new-chat tab) prevents concurrent submissions.
- **Response validation.** A response is accepted only if its operation, submission, conversation and page instance all match. The tab must also still show the same document afterwards. Otherwise the response is discarded.
- **Uncertainty.** Timeouts, mismatched responses, navigations and adapter errors after submission return `outcome: 'unknown'`. The runner records them as the new `ContributionOutcomeUncertain` event: the operation becomes `uncertain` (cause `unknown-outcome`), the debate pauses with reason `uncertain-outcome`, and nothing is retried. Re-issuing the operation is an explicit human action.
- **Service-worker restarts** still produce `RuntimeRecovered`, which marks operations uncertain (cause `runtime-restart`) and never re-sends anything.

## Attaching an authorized integration

1. Implement `LiveProviderAdapter` for a route the provider documents and permits for automated use, such as an official API that the user explicitly opts into. Set `authorization: { kind: 'authorized', basis }`. Report real `capabilities` per target kind. Implement `submit` and `awaitResponse` so they return receipts and responses that carry the conversation id and the page instance (or route instance) id. For a `new-chat` target, submit the first message once, return a `new-chat` receipt, and report in the response the conversation id the provider assigned; an adapter that cannot do this reports submission as unavailable for new chats.
2. Replace `createConsumerSiteAdapters()` in `src/extension/background-host.ts` with it. Nothing else changes.
3. Any route that does not involve a tab still needs a linked conversation and a page probe under the current preflight. Making `transport` optional per route is the main design change such an adapter would require.

The tests (`live-preflight.test.ts`, `live-target.test.ts`, `live-debate.test.ts`) use deterministic fake adapters. They verify ThirdMind's own orchestration only; no real provider website has been tested.
