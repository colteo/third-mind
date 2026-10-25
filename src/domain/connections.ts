/**
 * Conversation links: which ChatGPT and Claude browser conversation the human
 * has associated with ThirdMind (Phase 2.1), including new, empty chats that
 * do not have a persistent conversation identifier yet (Phase 2.2A).
 *
 * This model is independent of the debate engine. It knows nothing about
 * Chrome: a browser tab is identified by an opaque number, and what a tab
 * shows is described by a `TabClassification` produced elsewhere (the URL
 * rules are infrastructure details). All functions are pure and return the
 * same object when nothing changed, so callers can detect changes by reference.
 *
 * A link has two independent parts:
 * - its conversation identity (`ConversationIdentity`): a saved conversation,
 *   a new chat that is still waiting for its identifier, or an identifier
 *   that was observed but still needs the human's confirmation;
 * - its tab association (`tabId` plus `ConnectionState`): whether the
 *   user-approved tab still shows what the link expects.
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
  /** Exact origin of the provider site, for example `https://chatgpt.com`. */
  readonly origin: string;
  readonly conversationId: string;
  /** Normalized URL of the conversation, without query string or fragment. */
  readonly canonicalUrl: string;
}

/** What a URL shows, according to the configured provider rules. */
export type UrlClassification =
  | { readonly kind: 'conversation'; readonly conversation: ConversationRef }
  /** A confirmed new-chat entry point. It has no conversation identifier until the first message is sent. */
  | { readonly kind: 'new-chat'; readonly provider: ConversationProviderId; readonly origin: string }
  /** Any other page of a supported provider (projects, settings, shared links, unknown paths). */
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

// ---------------------------------------------------------------------------
// Conversation identity
// ---------------------------------------------------------------------------

/**
 * How ThirdMind learned the identifier of a saved conversation:
 * - `selected`: the human selected a tab that already showed it;
 * - `new-chat`: the linked new chat's tab moved directly to it (see `observeLink`);
 * - `confirmed`: the human confirmed an identifier that could not be attributed automatically.
 */
export type IdentitySource = 'selected' | 'new-chat' | 'confirmed';

/**
 * Why an observed identifier needs the human's confirmation:
 * - `observation-gap`: ThirdMind did not see the tab continuously on the new
 *   chat (service worker restart, failed tab query, unreadable tab), so the
 *   conversation may have been opened by something else in between;
 * - `open-in-another-tab`: another tab shows the same conversation, so it may
 *   be an existing conversation rather than the new chat.
 */
export type ConfirmationReason = 'observation-gap' | 'open-in-another-tab';

export type ConversationIdentity =
  | {
      readonly kind: 'saved';
      readonly conversationId: string;
      readonly canonicalUrl: string;
      readonly source: IdentitySource;
    }
  /** A new chat without a persistent identifier. No identifier or URL is ever invented for it. */
  | { readonly kind: 'pending' }
  /** The new chat's tab now shows this conversation, but it could not be attributed to the new chat. */
  | {
      readonly kind: 'unconfirmed';
      readonly conversationId: string;
      readonly canonicalUrl: string;
      readonly reason: ConfirmationReason;
    };

/**
 * State of the tab association, relative to what the link expects the tab to
 * show (the saved conversation, the new chat, or the unconfirmed conversation).
 *
 * `unavailable` is temporary: the link is still believed valid and returns to
 * `linked` as soon as the tab is seen showing the expected page again.
 * `stale` and `disconnected` are confirmed losses: they never return to
 * `linked` on their own. Only an explicit human action restores them.
 */
export type ConnectionState =
  | { readonly kind: 'linked' }
  | { readonly kind: 'unavailable'; readonly reason: 'tab-unreadable' | 'tab-query-failed' }
  | { readonly kind: 'stale'; readonly reason: 'different-conversation' | 'left-conversation' }
  | { readonly kind: 'disconnected'; readonly reason: 'tab-closed' };

export interface ConversationLink {
  readonly provider: ConversationProviderId;
  /** Exact provider origin the link was approved for. A page on any other origin never satisfies it. */
  readonly origin: string;
  readonly tabId: BrowserTabId;
  readonly identity: ConversationIdentity;
  readonly state: ConnectionState;
}

/**
 * Combined status of a link, for display and for callers that need one
 * exhaustive switch. Derived from identity and tab state by `linkStatus`.
 */
export type LinkStatus =
  /** A saved conversation, shown in its tab. */
  | { readonly kind: 'linked' }
  /** A new chat, shown in its tab, waiting for its first message to be saved. */
  | { readonly kind: 'awaiting-identity' }
  /** The new chat's tab shows a conversation that the human must confirm. */
  | { readonly kind: 'confirmation-required'; readonly reason: ConfirmationReason }
  | Exclude<ConnectionState, { readonly kind: 'linked' }>;

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
const LINKED_STATUS: LinkStatus = { kind: 'linked' };
const AWAITING_IDENTITY: LinkStatus = { kind: 'awaiting-identity' };
const PENDING: ConversationIdentity = { kind: 'pending' };

export function isConversationProviderId(value: unknown): value is ConversationProviderId {
  return CONVERSATION_PROVIDERS.some((provider) => provider === value);
}

export function linkStatus(link: ConversationLink): LinkStatus {
  const { state, identity } = link;
  if (state.kind !== 'linked') {
    return state;
  }
  switch (identity.kind) {
    case 'saved':
      return LINKED_STATUS;
    case 'pending':
      return AWAITING_IDENTITY;
    case 'unconfirmed':
      return { kind: 'confirmation-required', reason: identity.reason };
  }
}

/** True when the link's identity is the saved conversation `conversation`. Pending and unconfirmed identities never qualify. */
export function isSameConversation(link: ConversationLink, conversation: ConversationRef): boolean {
  return (
    link.identity.kind === 'saved' &&
    link.provider === conversation.provider &&
    link.identity.conversationId === conversation.conversationId
  );
}

/**
 * True when the tab currently shows what the link expects: its conversation
 * (saved or unconfirmed), or a new chat of the same provider and origin for a
 * pending link. Title and tab id alone never qualify.
 */
export function tabShowsLinkTarget(link: ConversationLink, tab: ObservedTab): boolean {
  const { classification } = tab;
  const { identity } = link;
  switch (classification.kind) {
    case 'conversation': {
      const { conversation } = classification;
      return (
        identity.kind !== 'pending' &&
        conversation.provider === link.provider &&
        conversation.origin === link.origin &&
        conversation.conversationId === identity.conversationId
      );
    }
    case 'new-chat':
      return identity.kind === 'pending' && isNewChatOf(link.provider, link.origin, classification);
    case 'provider-page':
    case 'unsupported':
    case 'unavailable':
      return false;
  }
}

function isNewChatOf(
  provider: ConversationProviderId,
  origin: string,
  classification: Extract<TabClassification, { kind: 'new-chat' }>,
): boolean {
  return classification.provider === provider && classification.origin === origin;
}

// ---------------------------------------------------------------------------
// Lifecycle: reconciling links with what the browser shows
// ---------------------------------------------------------------------------

/**
 * What else is known when a tab is observed. Used only to decide whether a
 * pending new chat's transition to a saved conversation can be attributed to
 * that new chat.
 */
export interface ReconciliationContext {
  /**
   * Provider tabs seen by the previous successful scan in this runtime, or
   * `null` when there is none (first scan after a service worker start, or
   * after a failed tab query). `null` means continuity is not established.
   */
  readonly previousTabs: readonly ObservedTab[] | null;
  /** Provider tabs seen by the current scan. */
  readonly currentTabs: readonly ObservedTab[];
}

/** No continuity: every pending transition requires confirmation. */
export const NO_CONTINUITY: ReconciliationContext = { previousTabs: null, currentTabs: [] };

/**
 * Applies one observation of the linked tab. Returns `link` itself when nothing changed.
 *
 * For a pending new chat whose tab now shows a saved conversation of the same
 * provider and origin:
 * - if that conversation was already open in another tab at the previous
 *   scan, it existed before the new chat could have been saved: the link
 *   becomes `stale` and the conversation is never adopted;
 * - if the previous scan saw this same tab showing the new chat, the link is
 *   healthy and no other tab shows the conversation, the identifier is
 *   adopted (`saved`, source `new-chat`);
 * - otherwise the identifier is kept as `unconfirmed` until the human confirms it.
 *
 * A URL change is only evidence that the tab moved. It is never treated as
 * proof that a message was sent, by ThirdMind or anyone else.
 */
export function observeLink(
  link: ConversationLink,
  observation: TabObservation,
  context: ReconciliationContext = NO_CONTINUITY,
): ConversationLink {
  const { state } = link;
  // Confirmed losses are terminal until the human acts explicitly.
  if (state.kind === 'stale' || state.kind === 'disconnected') {
    return link;
  }
  switch (observation.kind) {
    case 'missing':
      return withState(link, { kind: 'disconnected', reason: 'tab-closed' });
    case 'unknown':
      return withState(link, { kind: 'unavailable', reason: 'tab-query-failed' });
    case 'present':
      return observePresentTab(link, observation.tab, context);
  }
}

function observePresentTab(link: ConversationLink, tab: ObservedTab, context: ReconciliationContext): ConversationLink {
  const { classification } = tab;
  switch (classification.kind) {
    case 'unavailable':
      return withState(link, { kind: 'unavailable', reason: 'tab-unreadable' });
    case 'provider-page':
    case 'unsupported':
      return withState(link, { kind: 'stale', reason: 'left-conversation' });
    case 'new-chat':
      // Only a pending link expects a new chat. Claude's `/` and `/new` are equivalent entry points.
      return link.identity.kind === 'pending' && isNewChatOf(link.provider, link.origin, classification)
        ? withState(link, LINKED)
        : withState(link, { kind: 'stale', reason: 'left-conversation' });
    case 'conversation': {
      const { conversation } = classification;
      const { identity } = link;
      if (conversation.provider !== link.provider || conversation.origin !== link.origin) {
        return withState(link, { kind: 'stale', reason: 'different-conversation' });
      }
      switch (identity.kind) {
        case 'saved':
        case 'unconfirmed':
          // An established identity is never replaced by another conversation.
          return identity.conversationId === conversation.conversationId
            ? withState(link, LINKED)
            : withState(link, { kind: 'stale', reason: 'different-conversation' });
        case 'pending':
          return resolvePendingIdentity(link, tab.tabId, conversation, context);
      }
    }
  }
}

function resolvePendingIdentity(
  link: ConversationLink,
  tabId: BrowserTabId,
  conversation: ConversationRef,
  context: ReconciliationContext,
): ConversationLink {
  const { previousTabs, currentTabs } = context;
  const { conversationId, canonicalUrl } = conversation;
  if (previousTabs !== null && showsConversationElsewhere(previousTabs, conversation, tabId)) {
    // Already open before this tab left the new chat: an existing, unrelated conversation.
    return withState(link, { kind: 'stale', reason: 'different-conversation' });
  }
  const previous = previousTabs?.find((tab) => tab.tabId === tabId);
  const continuous =
    link.state.kind === 'linked' &&
    previous !== undefined &&
    previous.classification.kind === 'new-chat' &&
    isNewChatOf(link.provider, link.origin, previous.classification);
  let reason: ConfirmationReason | null = null;
  if (!continuous) {
    reason = 'observation-gap';
  } else if (showsConversationElsewhere(currentTabs, conversation, tabId)) {
    reason = 'open-in-another-tab';
  }
  const identity: ConversationIdentity =
    reason === null
      ? { kind: 'saved', conversationId, canonicalUrl, source: 'new-chat' }
      : { kind: 'unconfirmed', conversationId, canonicalUrl, reason };
  return { ...link, identity, state: LINKED };
}

function showsConversationElsewhere(
  tabs: readonly ObservedTab[],
  conversation: ConversationRef,
  exceptTabId: BrowserTabId,
): boolean {
  return tabs.some(
    (tab) =>
      tab.tabId !== exceptTabId &&
      tab.classification.kind === 'conversation' &&
      tab.classification.conversation.provider === conversation.provider &&
      tab.classification.conversation.conversationId === conversation.conversationId,
  );
}

function withState(link: ConversationLink, state: ConnectionState): ConversationLink {
  return sameState(link.state, state) ? link : { ...link, state };
}

function sameState(a: ConnectionState, b: ConnectionState): boolean {
  return a.kind === b.kind && (a.kind === 'linked' || (b.kind !== 'linked' && a.reason === b.reason));
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
  context: ReconciliationContext = NO_CONTINUITY,
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
    const link = observeLink(slot.link, observation, context);
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
  const conversation = verifyConversationTab(request.provider, request.tabId, tab);
  if (typeof conversation === 'string') {
    return { ok: false, reason: conversation };
  }
  if (conversation.conversationId !== request.conversationId) {
    return {
      ok: false,
      reason: 'That tab now shows a different conversation. Review the refreshed list and select again.',
    };
  }
  return { ok: true, registry: withLink(registry, request.provider, savedLink(request.tabId, conversation, 'selected')) };
}

export interface NewChatLinkRequest {
  readonly provider: ConversationProviderId;
  readonly expectedRevision: number;
  readonly tabId: BrowserTabId;
}

/**
 * Links (or replaces the link with) a new, empty chat. The link has a pending
 * identity: no conversation identifier or URL exists yet, and none is
 * invented. It is linked only if the tab, at this moment, still shows a new
 * chat of the requested provider.
 */
export function linkNewChat(
  registry: ConnectionRegistry,
  request: NewChatLinkRequest,
  tab: ObservedTab | null,
): ConnectionChange {
  const slot = registry[request.provider];
  if (slot.revision !== request.expectedRevision) {
    return outdated();
  }
  if (tab === null || tab.tabId !== request.tabId) {
    return closedTab();
  }
  const { classification } = tab;
  if (classification.kind !== 'new-chat') {
    return {
      ok: false,
      reason:
        classification.kind === 'conversation'
          ? 'That tab no longer shows a new chat; it now shows a saved conversation. Review the refreshed list and select again.'
          : 'That tab no longer shows a new chat. Review the refreshed list and select again.',
    };
  }
  if (classification.provider !== request.provider) {
    return { ok: false, reason: 'That tab shows a new chat from a different provider.' };
  }
  return {
    ok: true,
    registry: withLink(registry, request.provider, {
      provider: request.provider,
      origin: classification.origin,
      tabId: request.tabId,
      identity: PENDING,
      state: LINKED,
    }),
  };
}

export interface ConfirmIdentityRequest {
  readonly provider: ConversationProviderId;
  readonly expectedRevision: number;
  /** The tab and conversation the client displayed; both must still match. */
  readonly tabId: BrowserTabId;
  readonly conversationId: string;
}

/**
 * Accepts an unconfirmed identifier as the identity of the linked new chat.
 * Only the original user-approved tab qualifies, and only while it still
 * shows exactly the conversation the human was asked about.
 */
export function confirmConversationIdentity(
  registry: ConnectionRegistry,
  request: ConfirmIdentityRequest,
  tab: ObservedTab | null,
): ConnectionChange {
  const slot = registry[request.provider];
  if (slot.revision !== request.expectedRevision) {
    return outdated();
  }
  const { link } = slot;
  if (link === null || link.identity.kind !== 'unconfirmed') {
    return { ok: false, reason: 'There is no conversation waiting for confirmation.' };
  }
  const { identity } = link;
  if (link.tabId !== request.tabId || identity.conversationId !== request.conversationId) {
    return outdated();
  }
  if (link.state.kind !== 'linked') {
    return {
      ok: false,
      reason: 'The linked tab no longer shows that conversation, so it cannot be confirmed.',
    };
  }
  const conversation = verifyConversationTab(request.provider, request.tabId, tab);
  if (typeof conversation === 'string') {
    return { ok: false, reason: conversation };
  }
  if (conversation.conversationId !== identity.conversationId || conversation.origin !== link.origin) {
    return {
      ok: false,
      reason: 'The linked tab no longer shows that conversation, so it cannot be confirmed.',
    };
  }
  return {
    ok: true,
    registry: withLink(registry, request.provider, {
      ...link,
      identity: {
        kind: 'saved',
        conversationId: identity.conversationId,
        canonicalUrl: identity.canonicalUrl,
        source: 'confirmed',
      },
      state: LINKED,
    }),
  };
}

export interface ReconnectRequest {
  readonly provider: ConversationProviderId;
  readonly expectedRevision: number;
  readonly tabId: BrowserTabId;
}

/**
 * Restores an existing link to a tab that shows the same saved conversation.
 * The tab may be the original tab or another one (for example, after the
 * original tab was closed and the conversation reopened). A matching tab id
 * or title is not enough: the recognized conversation identifier must match.
 *
 * A pending or unconfirmed new chat cannot be reconnected: without a
 * confirmed identifier there is nothing to recognize it by.
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
  const { link } = slot;
  if (link === null) {
    return { ok: false, reason: 'There is no connection to reconnect. Select a conversation instead.' };
  }
  if (link.identity.kind !== 'saved') {
    return {
      ok: false,
      reason: 'A new chat without a confirmed conversation cannot be reconnected. Link a conversation or a new chat instead.',
    };
  }
  const conversation = verifyConversationTab(request.provider, request.tabId, tab);
  if (typeof conversation === 'string') {
    return { ok: false, reason: conversation };
  }
  if (!isSameConversation(link, conversation)) {
    return {
      ok: false,
      reason: 'That tab does not show the previously linked conversation. Select it as a new conversation instead.',
    };
  }
  return {
    ok: true,
    registry: withLink(registry, request.provider, savedLink(request.tabId, conversation, link.identity.source)),
  };
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
function verifyConversationTab(
  provider: ConversationProviderId,
  tabId: BrowserTabId,
  tab: ObservedTab | null,
): ConversationRef | string {
  if (tab === null || tab.tabId !== tabId) {
    return closedTab().reason;
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

function savedLink(tabId: BrowserTabId, conversation: ConversationRef, source: IdentitySource): ConversationLink {
  return {
    provider: conversation.provider,
    origin: conversation.origin,
    tabId,
    identity: {
      kind: 'saved',
      conversationId: conversation.conversationId,
      canonicalUrl: conversation.canonicalUrl,
      source,
    },
    state: LINKED,
  };
}

/** Replaces the slot's link. Returns `registry` itself when the link would not change. */
function withLink(
  registry: ConnectionRegistry,
  provider: ConversationProviderId,
  link: ConversationLink,
): ConnectionRegistry {
  const slot = registry[provider];
  if (slot.link !== null && sameLink(slot.link, link)) {
    return registry;
  }
  return { ...registry, [provider]: { revision: slot.revision + 1, link } };
}

function sameLink(a: ConversationLink, b: ConversationLink): boolean {
  return (
    a.provider === b.provider &&
    a.origin === b.origin &&
    a.tabId === b.tabId &&
    sameState(a.state, b.state) &&
    sameIdentity(a.identity, b.identity)
  );
}

function sameIdentity(a: ConversationIdentity, b: ConversationIdentity): boolean {
  switch (a.kind) {
    case 'pending':
      return b.kind === 'pending';
    case 'saved':
      return b.kind === 'saved' && a.conversationId === b.conversationId && a.source === b.source;
    case 'unconfirmed':
      return b.kind === 'unconfirmed' && a.conversationId === b.conversationId && a.reason === b.reason;
  }
}

function outdated(): { readonly ok: false; readonly reason: string } {
  return {
    ok: false,
    reason: 'The connection changed since this view was shown. Review the refreshed list and try again.',
  };
}

function closedTab(): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason: 'That tab is no longer open. Refresh the list and select again.' };
}

// ---------------------------------------------------------------------------
// Validation of stored registries
// ---------------------------------------------------------------------------

/** Version of the stored connection schema. Version 2 added pending identities and origins (Phase 2.2A). */
export const CONNECTION_SCHEMA_VERSION = 2;

/** Longest conversation identifier accepted from storage or a client. Recognized identifiers are UUIDs (36 characters). */
export const MAX_CONVERSATION_ID_LENGTH = 128;

/**
 * Strict structural validation of a version 2 registry read back from
 * storage. Returns a clean copy containing only the known fields, or `null`
 * if anything is off.
 */
export function parseConnectionRegistry(value: unknown): ConnectionRegistry | null {
  return parseRegistry(value, parseLink);
}

/**
 * Migrates a version 1 registry (Phase 2.1: saved conversations only, no
 * origin). Each stored canonical URL is classified again with the current
 * rules; a link whose URL is no longer recognized as the same conversation
 * is dropped (its slot advances one revision) instead of being trusted.
 */
export function migrateConnectionRegistryV1(
  value: unknown,
  recognize: (url: string) => UrlClassification,
): ConnectionRegistry | null {
  return parseRegistry(value, (link, provider) => parseLinkV1(link, provider, recognize));
}

/** `undefined`: the stored link is well-formed but no longer valid and is dropped. */
type LinkParser = (value: unknown, provider: ConversationProviderId) => ConversationLink | null | undefined;

function parseRegistry(value: unknown, parse: LinkParser): ConnectionRegistry | null {
  if (!isRecord(value)) {
    return null;
  }
  const chatgpt = parseSlot(value.chatgpt, 'chatgpt', parse);
  const claude = parseSlot(value.claude, 'claude', parse);
  return chatgpt === null || claude === null ? null : { chatgpt, claude };
}

function parseSlot(value: unknown, provider: ConversationProviderId, parse: LinkParser): ConnectionSlot | null {
  if (!isRecord(value) || !isRevision(value.revision)) {
    return null;
  }
  if (value.link === null) {
    return { revision: value.revision, link: null };
  }
  const link = parse(value.link, provider);
  if (link === undefined) {
    return { revision: value.revision + 1, link: null };
  }
  return link === null ? null : { revision: value.revision, link };
}

function parseLink(value: unknown, provider: ConversationProviderId): ConversationLink | null {
  if (!isRecord(value) || value.provider !== provider || !isTabId(value.tabId) || !isNonEmptyString(value.origin)) {
    return null;
  }
  const identity = parseIdentity(value.identity);
  const state = parseState(value.state);
  return identity === null || state === null
    ? null
    : { provider, origin: value.origin, tabId: value.tabId, identity, state };
}

function parseIdentity(value: unknown): ConversationIdentity | null {
  if (!isRecord(value)) {
    return null;
  }
  const { kind, conversationId, canonicalUrl, source, reason } = value;
  if (kind === 'pending') {
    return PENDING;
  }
  if (!isConversationId(conversationId) || typeof canonicalUrl !== 'string') {
    return null;
  }
  if (kind === 'saved' && (source === 'selected' || source === 'new-chat' || source === 'confirmed')) {
    return { kind, conversationId, canonicalUrl, source };
  }
  if (kind === 'unconfirmed' && (reason === 'observation-gap' || reason === 'open-in-another-tab')) {
    return { kind, conversationId, canonicalUrl, reason };
  }
  return null;
}

function parseLinkV1(
  value: unknown,
  provider: ConversationProviderId,
  recognize: (url: string) => UrlClassification,
): ConversationLink | null | undefined {
  if (!isRecord(value) || value.provider !== provider || !isTabId(value.tabId)) {
    return null;
  }
  const { conversationId, canonicalUrl } = value;
  const state = parseState(value.state);
  if (!isConversationId(conversationId) || typeof canonicalUrl !== 'string' || state === null) {
    return null;
  }
  const classification = recognize(canonicalUrl);
  if (
    classification.kind !== 'conversation' ||
    classification.conversation.provider !== provider ||
    classification.conversation.conversationId !== conversationId
  ) {
    return undefined;
  }
  return { ...savedLink(value.tabId, classification.conversation, 'selected'), state };
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

export function isConversationId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= MAX_CONVERSATION_ID_LENGTH;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
