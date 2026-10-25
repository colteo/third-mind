/**
 * Conversation links: which existing ChatGPT and Claude browser conversation
 * the human has associated with ThirdMind (Phase 2.1).
 *
 * This model is independent of the debate engine. It knows nothing about
 * Chrome: a browser tab is identified by an opaque number, and what a tab
 * shows is described by a `TabClassification` produced elsewhere (the URL
 * rules are infrastructure details). All functions are pure and return the
 * same object when nothing changed, so callers can detect changes by reference.
 *
 * A link records an association only. It does not read, send or automate anything.
 */

export const CONVERSATION_PROVIDERS = ['chatgpt', 'claude'] as const;

export type ConversationProviderId = (typeof CONVERSATION_PROVIDERS)[number];

/** Opaque browser tab identifier. Never treated as proof of conversation identity. */
export type BrowserTabId = number;

/** A conversation recognized from a URL. Identity is `provider` plus `conversationId`. */
export interface ConversationRef {
  readonly provider: ConversationProviderId;
  readonly conversationId: string;
  /** Normalized URL of the conversation, without query string or fragment. */
  readonly canonicalUrl: string;
}

/** What a URL shows, according to the configured provider rules. */
export type UrlClassification =
  | { readonly kind: 'conversation'; readonly conversation: ConversationRef }
  /** A supported provider page that is not a recognized conversation (home page, new chat, settings). */
  | { readonly kind: 'provider-page'; readonly provider: ConversationProviderId }
  | { readonly kind: 'unsupported' };

/** What a tab shows. `unavailable`: the tab exists, but its URL could not be read. */
export type TabClassification = UrlClassification | { readonly kind: 'unavailable' };

export interface ObservedTab {
  readonly tabId: BrowserTabId;
  /** Untrusted, display only. Never used to establish identity. */
  readonly title: string | null;
  readonly classification: TabClassification;
}

/**
 * What is known about a linked tab after looking at the browser:
 * - `present`: the tab exists and was classified;
 * - `missing`: a successful query confirmed that the tab no longer exists;
 * - `unknown`: the browser could not be queried, so nothing is confirmed.
 */
export type TabObservation =
  | { readonly kind: 'present'; readonly tab: ObservedTab }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' };

/**
 * State of a confirmed link.
 *
 * `unavailable` is temporary: the link is still believed valid and returns to
 * `linked` as soon as the tab is seen showing the same conversation again.
 * `stale` and `disconnected` are confirmed losses: they never return to
 * `linked` on their own. Only an explicit human reconnection restores them.
 */
export type ConnectionState =
  | { readonly kind: 'linked' }
  | { readonly kind: 'unavailable'; readonly reason: 'tab-unreadable' | 'tab-query-failed' }
  | { readonly kind: 'stale'; readonly reason: 'different-conversation' | 'left-conversation' }
  | { readonly kind: 'disconnected'; readonly reason: 'tab-closed' };

export interface ConversationLink {
  readonly provider: ConversationProviderId;
  readonly tabId: BrowserTabId;
  readonly conversationId: string;
  readonly canonicalUrl: string;
  readonly state: ConnectionState;
}

/**
 * One slot per provider. `revision` increases on every change to the slot, so
 * a client that acted on an outdated view can be detected and rejected.
 */
export interface ConnectionSlot {
  readonly revision: number;
  readonly link: ConversationLink | null;
}

export type ConnectionRegistry = Readonly<Record<ConversationProviderId, ConnectionSlot>>;

export const EMPTY_CONNECTION_REGISTRY: ConnectionRegistry = {
  chatgpt: { revision: 0, link: null },
  claude: { revision: 0, link: null },
};

export type ConnectionChange =
  | { readonly ok: true; readonly registry: ConnectionRegistry }
  | { readonly ok: false; readonly reason: string };

const LINKED: ConnectionState = { kind: 'linked' };

export function isConversationProviderId(value: unknown): value is ConversationProviderId {
  return CONVERSATION_PROVIDERS.some((provider) => provider === value);
}

export function isSameConversation(link: ConversationLink, conversation: ConversationRef): boolean {
  return link.provider === conversation.provider && link.conversationId === conversation.conversationId;
}

/** True when the tab currently shows the conversation of this link. Title and tab id alone never qualify. */
export function tabShowsLinkedConversation(link: ConversationLink, tab: ObservedTab): boolean {
  return tab.classification.kind === 'conversation' && isSameConversation(link, tab.classification.conversation);
}

// ---------------------------------------------------------------------------
// Lifecycle: reconciling links with what the browser shows
// ---------------------------------------------------------------------------

/** Applies one observation of the linked tab. Returns `link` itself when nothing changed. */
export function observeLink(link: ConversationLink, observation: TabObservation): ConversationLink {
  const next = nextState(link, observation);
  return next === link.state ? link : { ...link, state: next };
}

function nextState(link: ConversationLink, observation: TabObservation): ConnectionState {
  const { state } = link;
  // Confirmed losses are terminal until the human reconnects explicitly.
  if (state.kind === 'stale' || state.kind === 'disconnected') {
    return state;
  }
  switch (observation.kind) {
    case 'missing':
      return { kind: 'disconnected', reason: 'tab-closed' };
    case 'unknown':
      return state.kind === 'unavailable' && state.reason === 'tab-query-failed'
        ? state
        : { kind: 'unavailable', reason: 'tab-query-failed' };
    case 'present': {
      const { classification } = observation.tab;
      switch (classification.kind) {
        case 'conversation':
          if (!isSameConversation(link, classification.conversation)) {
            return { kind: 'stale', reason: 'different-conversation' };
          }
          return state.kind === 'linked' ? state : LINKED;
        case 'provider-page':
        case 'unsupported':
          return { kind: 'stale', reason: 'left-conversation' };
        case 'unavailable':
          return state.kind === 'unavailable' && state.reason === 'tab-unreadable'
            ? state
            : { kind: 'unavailable', reason: 'tab-unreadable' };
      }
    }
  }
}

/**
 * Reconciles every link with the browser. `observe` returns `undefined` when
 * there is no new information about a tab; that link is left unchanged.
 * Revisions increase only for slots that actually changed, so repeated or
 * duplicate observations are idempotent.
 */
export function reconcileRegistry(
  registry: ConnectionRegistry,
  observe: (tabId: BrowserTabId) => TabObservation | undefined,
): ConnectionRegistry {
  let result = registry;
  for (const provider of CONVERSATION_PROVIDERS) {
    const slot = registry[provider];
    if (slot.link === null) {
      continue;
    }
    const observation = observe(slot.link.tabId);
    if (observation === undefined) {
      continue;
    }
    const link = observeLink(slot.link, observation);
    if (link !== slot.link) {
      result = { ...result, [provider]: { revision: slot.revision + 1, link } };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Human commands
// ---------------------------------------------------------------------------

export interface LinkRequest {
  readonly provider: ConversationProviderId;
  /** Revision of the slot the client displayed. */
  readonly expectedRevision: number;
  /** Conversation the client displayed for the tab; it must still be shown there. */
  readonly conversationId: string;
  readonly tabId: BrowserTabId;
}

/**
 * Links (or replaces the link with) the conversation shown in a tab. `tab` is
 * a fresh observation of `request.tabId`, or `null` when the tab is gone.
 * The conversation is linked only if the tab still shows exactly the
 * conversation the human selected.
 */
export function linkConversation(
  registry: ConnectionRegistry,
  request: LinkRequest,
  tab: ObservedTab | null,
): ConnectionChange {
  const slot = registry[request.provider];
  if (slot.revision !== request.expectedRevision) {
    return outdated();
  }
  const conversation = verifyTab(request.provider, request.tabId, tab);
  if (typeof conversation === 'string') {
    return { ok: false, reason: conversation };
  }
  if (conversation.conversationId !== request.conversationId) {
    return {
      ok: false,
      reason: 'That tab now shows a different conversation. Review the refreshed list and select again.',
    };
  }
  return { ok: true, registry: withLink(registry, slot, request.tabId, conversation) };
}

export interface ReconnectRequest {
  readonly provider: ConversationProviderId;
  readonly expectedRevision: number;
  readonly tabId: BrowserTabId;
}

/**
 * Restores an existing link to a tab that shows the same conversation. The
 * tab may be the original tab or another one (for example, after the original
 * tab was closed and the conversation reopened). A matching tab id or title
 * is not enough: the recognized conversation identifier must match.
 */
export function reconnectConversation(
  registry: ConnectionRegistry,
  request: ReconnectRequest,
  tab: ObservedTab | null,
): ConnectionChange {
  const slot = registry[request.provider];
  if (slot.revision !== request.expectedRevision) {
    return outdated();
  }
  if (slot.link === null) {
    return { ok: false, reason: 'There is no connection to reconnect. Select a conversation instead.' };
  }
  const conversation = verifyTab(request.provider, request.tabId, tab);
  if (typeof conversation === 'string') {
    return { ok: false, reason: conversation };
  }
  if (!isSameConversation(slot.link, conversation)) {
    return {
      ok: false,
      reason: 'That tab does not show the previously linked conversation. Select it as a new conversation instead.',
    };
  }
  return { ok: true, registry: withLink(registry, slot, request.tabId, conversation) };
}

export interface DisconnectRequest {
  readonly provider: ConversationProviderId;
  readonly expectedRevision: number;
}

/** Removes the link. Disconnecting an empty slot succeeds without effect. */
export function disconnectConversation(registry: ConnectionRegistry, request: DisconnectRequest): ConnectionChange {
  const slot = registry[request.provider];
  if (slot.link === null) {
    return { ok: true, registry };
  }
  if (slot.revision !== request.expectedRevision) {
    return outdated();
  }
  return { ok: true, registry: { ...registry, [request.provider]: { revision: slot.revision + 1, link: null } } };
}

/** Returns the conversation the tab shows, or a rejection reason. */
function verifyTab(
  provider: ConversationProviderId,
  tabId: BrowserTabId,
  tab: ObservedTab | null,
): ConversationRef | string {
  if (tab === null || tab.tabId !== tabId) {
    return 'That tab is no longer open. Refresh the list and select again.';
  }
  const { classification } = tab;
  if (classification.kind !== 'conversation') {
    return 'That tab no longer shows a recognized conversation.';
  }
  if (classification.conversation.provider !== provider) {
    return 'That tab shows a conversation from a different provider.';
  }
  return classification.conversation;
}

function withLink(
  registry: ConnectionRegistry,
  slot: ConnectionSlot,
  tabId: BrowserTabId,
  conversation: ConversationRef,
): ConnectionRegistry {
  const current = slot.link;
  if (
    current !== null &&
    current.state.kind === 'linked' &&
    current.tabId === tabId &&
    isSameConversation(current, conversation)
  ) {
    return registry;
  }
  const link: ConversationLink = {
    provider: conversation.provider,
    tabId,
    conversationId: conversation.conversationId,
    canonicalUrl: conversation.canonicalUrl,
    state: LINKED,
  };
  return { ...registry, [conversation.provider]: { revision: slot.revision + 1, link } };
}

function outdated(): ConnectionChange {
  return {
    ok: false,
    reason: 'The connection changed since this view was shown. Review the refreshed list and try again.',
  };
}

// ---------------------------------------------------------------------------
// Validation of stored registries
// ---------------------------------------------------------------------------

/**
 * Strict structural validation of a registry read back from storage. Returns
 * a clean copy containing only the known fields, or `null` if anything is off.
 */
export function parseConnectionRegistry(value: unknown): ConnectionRegistry | null {
  if (!isRecord(value)) {
    return null;
  }
  const chatgpt = parseSlot(value.chatgpt, 'chatgpt');
  const claude = parseSlot(value.claude, 'claude');
  return chatgpt === null || claude === null ? null : { chatgpt, claude };
}

function parseSlot(value: unknown, provider: ConversationProviderId): ConnectionSlot | null {
  if (!isRecord(value) || !isRevision(value.revision)) {
    return null;
  }
  if (value.link === null) {
    return { revision: value.revision, link: null };
  }
  const link = parseLink(value.link, provider);
  return link === null ? null : { revision: value.revision, link };
}

function parseLink(value: unknown, provider: ConversationProviderId): ConversationLink | null {
  if (!isRecord(value) || value.provider !== provider || !isTabId(value.tabId)) {
    return null;
  }
  const { conversationId, canonicalUrl } = value;
  const state = parseState(value.state);
  if (typeof conversationId !== 'string' || conversationId.length === 0 || typeof canonicalUrl !== 'string') {
    return null;
  }
  return state === null ? null : { provider, tabId: value.tabId, conversationId, canonicalUrl, state };
}

function parseState(value: unknown): ConnectionState | null {
  if (!isRecord(value)) {
    return null;
  }
  const { kind, reason } = value;
  if (kind === 'linked') return LINKED;
  if (kind === 'unavailable' && (reason === 'tab-unreadable' || reason === 'tab-query-failed')) return { kind, reason };
  if (kind === 'stale' && (reason === 'different-conversation' || reason === 'left-conversation')) return { kind, reason };
  if (kind === 'disconnected' && reason === 'tab-closed') return { kind, reason };
  return null;
}

export function isTabId(value: unknown): value is BrowserTabId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
