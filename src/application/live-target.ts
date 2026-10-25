import {
  CONVERSATION_PROVIDERS,
  isConversationId,
  type ConversationProviderId,
  type OperationId,
  type SessionId,
} from '../domain';
import type { LiveResponse, LiveTargetStore, SubmissionReceipt } from '../ports';
import {
  parseLiveTargetBinding,
  type LiveDebateSetup,
  type LiveTargetBinding,
  type NewChatBinding,
  type SavedConversationBinding,
} from './execution-mode';

/**
 * Where a live participant currently stands. A session starts with the
 * bindings of its setup; a new chat's binding changes exactly once, when its
 * first message is reconciled with the conversation the provider created.
 *
 * Lifecycle of a new-chat target:
 *
 * 1. `ready` with a `new-chat` binding: the approved new-chat document, verified before every operation;
 * 2. `first-message` (write-ahead, persisted before the submission): the first
 *    message is about to be, or may have been, submitted under `operationId`;
 * 3. the adapter reports the conversation its response belongs to, and the
 *    linked tab, still on the same document, shows that same conversation;
 * 4. `ready` with a `conversation` binding (source `first-message`): every later
 *    request goes to exactly that conversation.
 *
 * If step 3 does not hold, the state stays `first-message`: the identity is
 * unresolved and nothing more is sent to that participant until the human
 * resolves it (`resolveFirstMessage`). A `first-message` state found after a
 * service worker restart is unresolved too; it is never re-submitted.
 */
export type LiveTargetState =
  | { readonly kind: 'ready'; readonly binding: LiveTargetBinding }
  | { readonly kind: 'first-message'; readonly binding: NewChatBinding; readonly operationId: OperationId };

export type LiveTargetStates = Readonly<Record<ConversationProviderId, LiveTargetState>>;

/** Persisted for the current live session only. A record of another session is ignored. */
export interface LiveTargetRecord {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly targets: LiveTargetStates;
}

export function initialTargetStates(setup: LiveDebateSetup): LiveTargetStates {
  return {
    chatgpt: { kind: 'ready', binding: setup.targets.chatgpt },
    claude: { kind: 'ready', binding: setup.targets.claude },
  };
}

/** The conversation or new chat each state points at, for checks against the links. */
export function bindingsOf(states: LiveTargetStates): Readonly<Record<ConversationProviderId, LiveTargetBinding>> {
  return { chatgpt: states.chatgpt.binding, claude: states.claude.binding };
}

// ---------------------------------------------------------------------------
// Reconciliation of a first message (pure)
// ---------------------------------------------------------------------------

/**
 * What the linked tab of a new-chat binding shows after its first message,
 * read from a fresh link reconciliation and page probe:
 * - `new-chat`: still the linked new chat (the link's identity is pending);
 * - `conversation`: the same tab, on the same provider and origin, now shows
 *   this conversation, and the link adopted it (saved) or holds it for
 *   confirmation (unconfirmed). A move to a conversation that existed before,
 *   to another provider or origin, or a closed tab is never reported here;
 * - `invalid`: the target is gone or unrelated; `reason` says why.
 */
export type NewChatObservation =
  | { readonly kind: 'new-chat'; readonly pageInstanceId: string; readonly linkRevision: number }
  | {
      readonly kind: 'conversation';
      readonly conversationId: string;
      readonly pageInstanceId: string;
      readonly linkRevision: number;
    }
  | { readonly kind: 'invalid'; readonly reason: string };

export type FirstMessageReconciliation =
  | { readonly ok: true; readonly binding: SavedConversationBinding }
  | { readonly ok: false; readonly reason: string };

/**
 * Decides whether the first message of a new chat can be bound to a
 * persistent conversation. Every one of these must hold:
 *
 * - the receipt and the response belong to this operation, this submission and
 *   the approved document (`pageInstanceId`), and the receipt is a new-chat receipt;
 * - the linked tab is still on that same document: the transition was a
 *   same-document navigation, not a reload or another page;
 * - the tab now shows a conversation of the linked provider and origin;
 * - that conversation is exactly the one the adapter reported.
 *
 * Otherwise the identity is unresolved. The URL change on its own is expected
 * after the first message and is never treated as unrelated navigation, but it
 * is never sufficient either.
 */
export function reconcileFirstMessage(
  binding: NewChatBinding,
  operationId: OperationId,
  receipt: SubmissionReceipt,
  response: LiveResponse,
  observation: NewChatObservation,
): FirstMessageReconciliation {
  const unresolved = (reason: string): FirstMessageReconciliation => ({ ok: false, reason });
  if (
    receipt.kind !== 'new-chat' ||
    receipt.operationId !== operationId ||
    receipt.pageInstanceId !== binding.pageInstanceId ||
    response.operationId !== operationId ||
    response.submissionId !== receipt.submissionId ||
    response.pageInstanceId !== binding.pageInstanceId
  ) {
    return unresolved('The response did not belong to the first message sent to the linked new chat.');
  }
  if (!isConversationId(response.conversationId)) {
    return unresolved('The adapter did not report a valid conversation for the first message.');
  }
  switch (observation.kind) {
    case 'invalid':
      return unresolved(observation.reason);
    case 'new-chat':
      return unresolved('The linked tab still shows the new chat, so the conversation the first message created could not be observed.');
    case 'conversation':
      break;
  }
  if (observation.pageInstanceId !== binding.pageInstanceId) {
    return unresolved('The linked tab loaded another page after the first message, so the conversation it shows cannot be attributed to it.');
  }
  if (observation.conversationId !== response.conversationId) {
    return unresolved('The conversation shown in the linked tab differs from the one the response belongs to.');
  }
  return {
    ok: true,
    binding: {
      kind: 'conversation',
      provider: binding.provider,
      tabId: binding.tabId,
      conversationId: observation.conversationId,
      linkRevision: observation.linkRevision,
      source: 'first-message',
    },
  };
}

// ---------------------------------------------------------------------------
// Explicit recovery
// ---------------------------------------------------------------------------

/**
 * The human's decision about a first message whose identity is unresolved:
 * - `bind-conversation`: the first message created the conversation that the
 *   linked tab now shows; continue there;
 * - `keep-new-chat`: the linked tab still shows the new chat; it stays the
 *   target, and the next first message is sent there.
 *
 * Neither re-sends anything. Re-issuing the uncertain operation remains a
 * separate, explicit action that accepts possible duplication.
 */
export type FirstMessageResolution =
  | { readonly kind: 'bind-conversation'; readonly conversationId: string }
  | { readonly kind: 'keep-new-chat' };

export type TargetChange = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Pure: applies a resolution to an unresolved state, given a fresh observation of the linked tab. */
export function resolveFirstMessageState(
  state: LiveTargetState,
  resolution: FirstMessageResolution,
  observation: NewChatObservation,
): { readonly ok: true; readonly state: LiveTargetState } | { readonly ok: false; readonly reason: string } {
  if (state.kind !== 'first-message') {
    return { ok: false, reason: 'There is no first message waiting to be resolved.' };
  }
  const { binding } = state;
  if (observation.kind === 'invalid') {
    return { ok: false, reason: observation.reason };
  }
  switch (resolution.kind) {
    case 'bind-conversation':
      if (observation.kind !== 'conversation' || observation.conversationId !== resolution.conversationId) {
        return { ok: false, reason: 'The linked tab does not show that conversation.' };
      }
      return {
        ok: true,
        state: {
          kind: 'ready',
          binding: {
            kind: 'conversation',
            provider: binding.provider,
            tabId: binding.tabId,
            conversationId: observation.conversationId,
            linkRevision: observation.linkRevision,
            source: 'recovered',
          },
        },
      };
    case 'keep-new-chat':
      if (observation.kind !== 'new-chat') {
        return { ok: false, reason: 'The linked tab no longer shows the new chat.' };
      }
      return {
        ok: true,
        // The human approves the document the tab shows now.
        state: {
          kind: 'ready',
          binding: { ...binding, pageInstanceId: observation.pageInstanceId, linkRevision: observation.linkRevision },
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Tracker (persisted)
// ---------------------------------------------------------------------------

export interface SessionLiveTargets {
  current(provider: ConversationProviderId): Promise<LiveTargetState>;
  snapshot(): Promise<LiveTargetStates>;
  /**
   * Write-ahead record of a first message, persisted before anything is
   * submitted. Fails (and nothing may be sent) unless the participant is
   * still `ready` on exactly this new-chat binding.
   */
  armFirstMessage(binding: NewChatBinding, operationId: OperationId): Promise<TargetChange>;
  /** Binds the reconciled conversation. Fails unless the state is still the armed first message `operationId`. */
  bindFirstMessage(operationId: OperationId, binding: SavedConversationBinding): Promise<TargetChange>;
  /**
   * Withdraws the write-ahead record of `operationId` when the adapter reported
   * that the submission was certainly not performed. The new chat becomes the
   * target again. Never used when the outcome is unknown.
   */
  withdrawFirstMessage(provider: ConversationProviderId, operationId: OperationId): Promise<TargetChange>;
  /** Ends the in-progress mark of an armed first message. The state itself stays as it is. */
  settleFirstMessage(provider: ConversationProviderId): void;
  /** True while this runtime is processing the armed first message of `provider`. */
  isFirstMessageInProgress(provider: ConversationProviderId): boolean;
  /** Applies an explicit human resolution of an unresolved first message. */
  resolveFirstMessage(
    provider: ConversationProviderId,
    resolution: FirstMessageResolution,
    observe: (binding: NewChatBinding) => Promise<NewChatObservation>,
  ): Promise<TargetChange>;
}

export interface LiveTargetTracker {
  forSession(sessionId: SessionId, setup: LiveDebateSetup): SessionLiveTargets;
}

/**
 * Keeps the live target states of the current session in memory and writes
 * every change to `store` before reporting it, so a restarted service worker
 * finds the write-ahead record of a first message that may have been sent.
 * Changes are serialized: the two participants never overwrite each other.
 */
export function createLiveTargetTracker(store: LiveTargetStore<LiveTargetRecord>): LiveTargetTracker {
  let record: LiveTargetRecord | null = null;
  let loaded: Promise<void> | null = null;
  /** `${sessionId}:${provider}` of first messages being processed in this runtime. Never persisted. */
  const inProgress = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();

  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };

  const load = (): Promise<void> => {
    loaded ??= store.load().then(
      (stored) => {
        record = parseLiveTargetRecord(stored);
      },
      (error: unknown) => {
        // Retried by the next call. Until it succeeds, nothing is sent.
        loaded = null;
        throw error;
      },
    );
    return loaded;
  };

  return {
    forSession(sessionId, setup) {
      const key = (provider: ConversationProviderId): string => `${sessionId}:${provider}`;
      const states = async (): Promise<LiveTargetStates> => {
        await load();
        return record?.sessionId === sessionId ? record.targets : initialTargetStates(setup);
      };
      const write = async (provider: ConversationProviderId, state: LiveTargetState): Promise<void> => {
        const next: LiveTargetRecord = { version: 1, sessionId, targets: { ...(await states()), [provider]: state } };
        await store.save(next);
        record = next;
      };

      return {
        current: async (provider) => (await states())[provider],
        snapshot: states,
        armFirstMessage: (binding, operationId) =>
          serialized(async () => {
            const state = (await states())[binding.provider];
            if (state.kind !== 'ready' || !sameBinding(state.binding, binding)) {
              return { ok: false, reason: 'The live target changed before the first message was sent.' };
            }
            await write(binding.provider, { kind: 'first-message', binding, operationId });
            inProgress.add(key(binding.provider));
            return { ok: true };
          }),
        bindFirstMessage: (operationId, binding) =>
          serialized(async () => {
            const state = (await states())[binding.provider];
            if (state.kind !== 'first-message' || state.operationId !== operationId) {
              return { ok: false, reason: 'The first message was resolved in another way while it was in progress.' };
            }
            await write(binding.provider, { kind: 'ready', binding });
            return { ok: true };
          }),
        withdrawFirstMessage: (provider, operationId) =>
          serialized(async () => {
            const state = (await states())[provider];
            if (state.kind !== 'first-message' || state.operationId !== operationId) {
              return { ok: false, reason: 'There is no matching first message to withdraw.' };
            }
            await write(provider, { kind: 'ready', binding: state.binding });
            return { ok: true };
          }),
        settleFirstMessage(provider) {
          inProgress.delete(key(provider));
        },
        isFirstMessageInProgress: (provider) => inProgress.has(key(provider)),
        resolveFirstMessage: (provider, resolution, observe) =>
          serialized(async () => {
            if (inProgress.has(key(provider))) {
              return { ok: false, reason: 'The first message is still in progress. Wait until it completes.' };
            }
            const state = (await states())[provider];
            if (state.kind !== 'first-message') {
              return { ok: false, reason: 'There is no first message waiting to be resolved.' };
            }
            const resolved = resolveFirstMessageState(state, resolution, await observe(state.binding));
            if (!resolved.ok) {
              return resolved;
            }
            await write(provider, resolved.state);
            return { ok: true };
          }),
      };
    },
  };
}

function sameBinding(a: LiveTargetBinding, b: LiveTargetBinding): boolean {
  if (a.kind === 'new-chat') {
    return (
      b.kind === 'new-chat' &&
      a.provider === b.provider &&
      a.tabId === b.tabId &&
      a.origin === b.origin &&
      a.pageInstanceId === b.pageInstanceId
    );
  }
  return b.kind === 'conversation' && a.provider === b.provider && a.tabId === b.tabId && a.conversationId === b.conversationId;
}

/** Strict validation of a stored record. Anything malformed is discarded. */
export function parseLiveTargetRecord(value: unknown): LiveTargetRecord | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.sessionId !== 'string' || !isRecord(value.targets)) {
    return null;
  }
  const { targets } = value;
  const parsed: Partial<Record<ConversationProviderId, LiveTargetState>> = {};
  for (const provider of CONVERSATION_PROVIDERS) {
    const state = parseState(targets[provider], provider);
    if (state === null) {
      return null;
    }
    parsed[provider] = state;
  }
  const { chatgpt, claude } = parsed;
  return chatgpt === undefined || claude === undefined
    ? null
    : { version: 1, sessionId: value.sessionId, targets: { chatgpt, claude } };
}

function parseState(value: unknown, provider: ConversationProviderId): LiveTargetState | null {
  if (!isRecord(value)) {
    return null;
  }
  const binding = parseLiveTargetBinding(value.binding, provider);
  if (binding === null) {
    return null;
  }
  if (value.kind === 'ready') {
    return { kind: 'ready', binding };
  }
  if (value.kind === 'first-message' && binding.kind === 'new-chat' && typeof value.operationId === 'string' && value.operationId.length > 0) {
    return { kind: 'first-message', binding, operationId: value.operationId };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
