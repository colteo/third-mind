import {
  CONVERSATION_PROVIDERS,
  linkStatus,
  type BrowserTabId,
  type ConnectionSlot,
  type ConversationProviderId,
  type Timestamp,
} from '../domain';
import type {
  Clock,
  LiveAdapterCapabilities,
  LiveAdapterRegistry,
  LiveConversationTarget,
  LiveProviderAdapter,
  ProviderPageTransport,
  ProviderProbeResult,
} from '../ports';
import type { ConnectionsSnapshot, TabDiscovery } from './connection-coordinator';
import type { BindingSource, LiveTargetBinding, NewChatBinding } from './execution-mode';
import {
  AVAILABLE,
  isAuthorized,
  isLiveReady,
  isTechnicallyReady,
  issuesOf,
  type CapabilityCheck,
  type CapabilityName,
  type PreflightIssue,
  type PreflightIssueCode,
  type ProviderCapabilities,
} from './live-capabilities';
import type { LiveTargetStates, NewChatObservation } from './live-target';

export interface LivePreflightDependencies {
  /** The connection coordinator. Links are reconciled with a fresh tab scan before every check. */
  readonly connections: {
    refresh(): Promise<void>;
    getSnapshot(): ConnectionsSnapshot;
  };
  readonly transport: ProviderPageTransport;
  readonly adapters: LiveAdapterRegistry;
  readonly clock: Clock;
}

export type LinkRevisions = Readonly<Record<ConversationProviderId, number>>;

export interface LivePreflightRequest {
  /** Slot revisions the panel displayed. A mismatch means the command came from an outdated view. */
  readonly expectedRevisions?: LinkRevisions;
  /**
   * For an existing live session: where each participant is bound now. A saved
   * conversation must still be linked and shown; a new chat must still be the
   * same approved document; an unresolved first message blocks the participant.
   */
  readonly expectedTargets?: LiveTargetStates;
}

/**
 * What the link of a provider designates as its live target, independently of
 * whether its page answered. Lets the panel tell a saved conversation from a new chat.
 */
export type PreflightTarget =
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'new-chat' };

export interface ProviderPreflight {
  readonly provider: ConversationProviderId;
  /** The adapter's route, or `null` when no adapter is installed for the provider. */
  readonly route: { readonly id: string; readonly label: string } | null;
  readonly capabilities: ProviderCapabilities;
  readonly technicallyReady: boolean;
  readonly authorized: boolean;
  readonly ready: boolean;
  /** The link's live target, when the connection is available. */
  readonly target: PreflightTarget | null;
  /**
   * The binding a live debate would use. For a saved conversation it is set
   * when the connection is available; for a new chat only once its page
   * answered, because the binding records the observed document.
   */
  readonly binding: LiveTargetBinding | null;
  readonly issues: readonly PreflightIssue[];
}

export interface LivePreflightResult {
  readonly checkedAt: Timestamp;
  /** Both providers are technically ready and authorized. */
  readonly ready: boolean;
  /** Slot revisions the check was made against; sent back with Start Live Debate. */
  readonly revisions: LinkRevisions;
  readonly providers: readonly ProviderPreflight[];
  readonly issues: readonly PreflightIssue[];
}

export type TargetVerification =
  | { readonly ok: true; readonly target: LiveConversationTarget }
  | { readonly ok: false; readonly issue: PreflightIssue };

export interface LivePreflight {
  /** Checks every capability of both providers. Never throws. */
  run(request?: LivePreflightRequest): Promise<LivePreflightResult>;
  /**
   * Re-verifies one binding immediately before a live operation: the link must
   * still be healthy and point at the same tab and conversation (or the same
   * new chat), and the page must answer and show it. A new chat must still be
   * the same document.
   */
  verifyTarget(binding: LiveTargetBinding): Promise<TargetVerification>;
  /**
   * After the first message to a new chat: reports what the linked tab shows
   * now. The expected transition (the same tab moving from the new chat to a
   * conversation of the same provider and origin) is reported, not rejected.
   */
  observeNewChat(binding: NewChatBinding): Promise<NewChatObservation>;
}

/**
 * Live debate preflight. Read-only: it never changes a link, never contacts a
 * provider except through the page probe and the adapters' own capability
 * reports, and never submits anything.
 */
export function createLivePreflight(deps: LivePreflightDependencies): LivePreflight {
  const snapshot = async (): Promise<ConnectionsSnapshot> => {
    await deps.connections.refresh();
    return deps.connections.getSnapshot();
  };

  const probe = async (tabId: BrowserTabId, provider: ConversationProviderId): Promise<ProviderProbeResult> => {
    try {
      return await deps.transport.probe(tabId, provider);
    } catch {
      return { ok: false, failure: { kind: 'transport-error', outcome: 'unknown' } };
    }
  };

  const checkTransport = async (
    linked: LinkedTarget,
    expectedPageInstanceId: string | undefined,
  ): Promise<{ check: CapabilityCheck; target: LiveConversationTarget | null }> => {
    const result = await probe(linked.tabId, linked.provider);
    const issue = transportIssue(linked, result, expectedPageInstanceId);
    if (issue !== null || !result.ok) {
      return { check: unavailable(issue ?? fallbackTransportIssue(linked.provider)), target: null };
    }
    const { pageInstanceId } = result.status;
    const { provider, tabId } = linked;
    return {
      check: AVAILABLE,
      target:
        linked.kind === 'conversation'
          ? { kind: 'conversation', provider, tabId, conversationId: linked.conversationId, pageInstanceId }
          : { kind: 'new-chat', provider, tabId, origin: linked.origin, pageInstanceId },
    };
  };

  const checkProvider = async (
    provider: ConversationProviderId,
    current: ConnectionsSnapshot,
    request: LivePreflightRequest,
  ): Promise<ProviderPreflight> => {
    const adapter = deps.adapters[provider];
    const expected = request.expectedTargets?.[provider];
    const connection =
      expected?.kind === 'first-message'
        ? unresolvedFirstMessage(provider)
        : evaluateConnection(
            provider,
            current.registry[provider],
            current.discovery,
            request.expectedRevisions?.[provider],
            expected?.binding,
          );
    const linked = connection.ok ? connection.target : null;

    let transport: CapabilityCheck = notChecked('Checked once the conversation link is available.');
    let target: LiveConversationTarget | null = null;
    if (linked !== null) {
      const expectedPage = expected?.binding.kind === 'new-chat' ? expected.binding.pageInstanceId : undefined;
      ({ check: transport, target } = await checkTransport(linked, expectedPage));
    }

    const { submission, responseAcquisition } = await checkAdapter(provider, adapter, target);
    const capabilities: ProviderCapabilities = {
      connection: connection.ok ? AVAILABLE : unavailable(connection.issue),
      transport,
      submission,
      responseAcquisition,
      authorization: authorizationCheck(provider, adapter),
    };
    return {
      provider,
      route: adapter === undefined ? null : { id: adapter.route.id, label: adapter.route.label },
      capabilities,
      technicallyReady: isTechnicallyReady(capabilities),
      authorized: isAuthorized(capabilities),
      ready: isLiveReady(capabilities),
      target: linked === null ? null : preflightTarget(linked),
      binding: linked === null ? null : bindingOf(linked, target),
      issues: issuesOf(capabilities),
    };
  };

  return {
    async run(request = {}) {
      const current = await snapshot();
      const providers = await Promise.all(
        CONVERSATION_PROVIDERS.map((provider) => checkProvider(provider, current, request)),
      );
      return {
        checkedAt: deps.clock.now(),
        ready: providers.every((provider) => provider.ready),
        revisions: { chatgpt: current.registry.chatgpt.revision, claude: current.registry.claude.revision },
        providers,
        issues: providers.flatMap((provider) => provider.issues),
      };
    },

    async verifyTarget(binding) {
      const current = await snapshot();
      const connection = evaluateConnection(
        binding.provider,
        current.registry[binding.provider],
        current.discovery,
        undefined,
        binding,
      );
      if (!connection.ok) {
        return { ok: false, issue: connection.issue };
      }
      const expectedPage = binding.kind === 'new-chat' ? binding.pageInstanceId : undefined;
      const { check, target } = await checkTransport(connection.target, expectedPage);
      if (check.status === 'unavailable') {
        return { ok: false, issue: check.issue };
      }
      return target === null ? { ok: false, issue: fallbackTransportIssue(binding.provider) } : { ok: true, target };
    },

    async observeNewChat(binding) {
      const current = await snapshot();
      return observeNewChatTab(binding, current, (tabId) => probe(tabId, binding.provider));
    },
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * What a healthy link designates: a saved conversation, or an approved new
 * chat that has not received its first message. A new chat has no
 * conversation identifier; its document is identified by the page probe.
 */
export type LinkedTarget =
  | {
      readonly kind: 'conversation';
      readonly provider: ConversationProviderId;
      readonly tabId: BrowserTabId;
      readonly conversationId: string;
      readonly linkRevision: number;
      readonly source: BindingSource;
    }
  | {
      readonly kind: 'new-chat';
      readonly provider: ConversationProviderId;
      readonly tabId: BrowserTabId;
      readonly origin: string;
      readonly linkRevision: number;
    };

export type ConnectionEvaluation =
  | { readonly ok: true; readonly target: LinkedTarget }
  | { readonly ok: false; readonly issue: PreflightIssue };

/**
 * Pure check of one provider's link. A live debate can target a saved
 * conversation shown in its linked tab, or a linked new chat shown in its tab
 * (status `awaiting-identity`): the missing conversation identifier is
 * expected there and does not block. Unconfirmed identities, stale,
 * disconnected and unverifiable links are rejected.
 *
 * With `expectedTarget` (an existing session), the link must still designate
 * exactly that target. A conversation bound from a new chat's first message,
 * or by the human during recovery, is also accepted while the link still asks
 * for confirmation of that same conversation: the binding was made on
 * stronger evidence than the link's own tab observation.
 */
export function evaluateConnection(
  provider: ConversationProviderId,
  slot: ConnectionSlot,
  discovery: TabDiscovery,
  expectedRevision: number | undefined,
  expectedTarget: LiveTargetBinding | undefined,
): ConnectionEvaluation {
  const label = providerName(provider);
  const fail = (code: PreflightIssueCode, message: string): ConnectionEvaluation => ({
    ok: false,
    issue: { provider, capability: 'connection', code, message },
  });
  const targetChanged = (): ConnectionEvaluation =>
    fail(
      'target-changed',
      expectedTarget?.kind === 'new-chat'
        ? `The ${label} link no longer points at the new chat this debate was started with. A live debate cannot move to another chat or conversation; start a new debate.`
        : `The ${label} link now points at a different tab or conversation than the one this debate is bound to. A live debate cannot move to another conversation; reconnect the original one or start a new debate.`,
    );

  if (expectedRevision !== undefined && expectedRevision !== slot.revision) {
    return fail(
      'view-outdated',
      `The ${label} link changed after this panel last showed it. Review the updated readiness and start again.`,
    );
  }
  if (discovery.status !== 'ready') {
    return fail(
      'tabs-unreadable',
      `ThirdMind could not list the open tabs, so the ${label} link could not be verified. Click Refresh under Linked conversations and try again.`,
    );
  }
  const { link } = slot;
  if (link === null) {
    return expectedTarget === undefined
      ? fail(
          'not-linked',
          `Nothing is linked for ${label}. Link a saved ${label} conversation or a new ${label} chat under Linked conversations.`,
        )
      : fail(
          'target-changed',
          `The ${label} conversation or new chat this debate is bound to is no longer linked. A live debate cannot move to another conversation; reconnect it or start a new debate.`,
        );
  }
  if (expectedTarget !== undefined && expectedTarget.tabId !== link.tabId) {
    return targetChanged();
  }
  const status = linkStatus(link);
  switch (status.kind) {
    case 'linked':
    case 'awaiting-identity':
      break;
    case 'confirmation-required':
      if (
        expectedTarget?.kind === 'conversation' &&
        expectedTarget.source !== 'linked' &&
        link.identity.kind === 'unconfirmed' &&
        link.identity.conversationId === expectedTarget.conversationId
      ) {
        break;
      }
      return fail(
        'identity-unconfirmed',
        `The conversation in the linked ${label} tab has not been confirmed. Confirm it under Linked conversations, or link another conversation or new chat.`,
      );
    case 'stale':
      return fail(
        'link-stale',
        `The linked ${label} tab no longer shows the linked conversation or new chat. Reconnect it under Linked conversations, or link another one.`,
      );
    case 'disconnected':
      return fail(
        'link-disconnected',
        `The linked ${label} tab was closed. Reopen the conversation and reconnect it, or link another conversation or new chat, under Linked conversations.`,
      );
    case 'unavailable':
      return fail(
        'link-unavailable',
        `ThirdMind cannot currently verify the linked ${label} tab. Click Refresh under Linked conversations and try again.`,
      );
  }

  const { identity } = link;
  if (identity.kind === 'pending') {
    if (expectedTarget !== undefined && (expectedTarget.kind !== 'new-chat' || expectedTarget.origin !== link.origin)) {
      return targetChanged();
    }
    return {
      ok: true,
      target: { kind: 'new-chat', provider, tabId: link.tabId, origin: link.origin, linkRevision: slot.revision },
    };
  }
  if (
    expectedTarget !== undefined &&
    (expectedTarget.kind !== 'conversation' || expectedTarget.conversationId !== identity.conversationId)
  ) {
    return targetChanged();
  }
  return {
    ok: true,
    target: {
      kind: 'conversation',
      provider,
      tabId: link.tabId,
      conversationId: identity.conversationId,
      linkRevision: slot.revision,
      source: expectedTarget?.kind === 'conversation' ? expectedTarget.source : 'linked',
    },
  };
}

function unresolvedFirstMessage(provider: ConversationProviderId): ConnectionEvaluation {
  const label = providerName(provider);
  return {
    ok: false,
    issue: {
      provider,
      capability: 'connection',
      code: 'identity-unresolved',
      message: `The first message of this debate may have been sent to the linked new ${label} chat, but ThirdMind could not establish which conversation it created. Nothing more is sent to ${label} until you resolve it: continue in the conversation the linked tab now shows, or keep the new chat if it shows no message.`,
    },
  };
}

function preflightTarget(linked: LinkedTarget): PreflightTarget {
  return linked.kind === 'conversation'
    ? { kind: 'conversation', conversationId: linked.conversationId }
    : { kind: 'new-chat' };
}

function bindingOf(linked: LinkedTarget, target: LiveConversationTarget | null): LiveTargetBinding | null {
  if (linked.kind === 'conversation') {
    const { provider, tabId, conversationId, linkRevision, source } = linked;
    return { kind: 'conversation', provider, tabId, conversationId, linkRevision, source };
  }
  return target?.kind === 'new-chat'
    ? {
        kind: 'new-chat',
        provider: linked.provider,
        tabId: linked.tabId,
        origin: linked.origin,
        pageInstanceId: target.pageInstanceId,
        linkRevision: linked.linkRevision,
      }
    : null;
}

// ---------------------------------------------------------------------------
// New chat after its first message
// ---------------------------------------------------------------------------

/**
 * Reads what the linked tab of a new-chat binding shows, from a fresh link
 * reconciliation and a page probe. The link's own reconciliation
 * (`observeLink`) already decides whether the tab's move to a conversation is
 * plausible for this new chat: a conversation that was open elsewhere before,
 * another provider or origin, a non-chat page or a closed tab makes the link
 * stale or disconnected, which invalidates the target here.
 */
export async function observeNewChatTab(
  binding: NewChatBinding,
  current: ConnectionsSnapshot,
  probe: (tabId: BrowserTabId) => Promise<ProviderProbeResult>,
): Promise<NewChatObservation> {
  const label = providerName(binding.provider);
  const invalid = (reason: string): NewChatObservation => ({ kind: 'invalid', reason });
  if (current.discovery.status !== 'ready') {
    return invalid(`ThirdMind could not list the open tabs, so the linked ${label} tab could not be observed.`);
  }
  const slot = current.registry[binding.provider];
  const { link } = slot;
  if (link === null || link.tabId !== binding.tabId || link.origin !== binding.origin) {
    return invalid(`The ${label} link no longer points at the new chat this debate was started with.`);
  }
  switch (linkStatus(link).kind) {
    case 'linked':
    case 'awaiting-identity':
    case 'confirmation-required':
      break;
    case 'stale':
      return invalid(`The linked ${label} tab moved to an unrelated page or conversation.`);
    case 'disconnected':
      return invalid(`The linked ${label} tab was closed.`);
    case 'unavailable':
      return invalid(`ThirdMind cannot currently verify the linked ${label} tab.`);
  }
  const result = await probe(binding.tabId);
  if (!result.ok) {
    return invalid(`The linked ${label} page could not be reached.`);
  }
  const { status } = result;
  if (status.provider !== binding.provider || status.tabId !== binding.tabId) {
    return invalid(`The linked tab does not show a ${label} page.`);
  }
  const { identity } = link;
  if (identity.kind === 'pending') {
    return status.page.kind === 'new-chat'
      ? { kind: 'new-chat', pageInstanceId: status.pageInstanceId, linkRevision: slot.revision }
      : invalid(`The linked ${label} tab and its page disagree about what they show.`);
  }
  if (status.page.kind !== 'conversation' || status.page.conversationId !== identity.conversationId) {
    return invalid(`The linked ${label} tab and its page disagree about which conversation they show.`);
  }
  return {
    kind: 'conversation',
    conversationId: identity.conversationId,
    pageInstanceId: status.pageInstanceId,
    linkRevision: slot.revision,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function transportIssue(
  linked: LinkedTarget,
  probe: ProviderProbeResult,
  expectedPageInstanceId: string | undefined,
): PreflightIssue | null {
  const { provider } = linked;
  const label = providerName(provider);
  const issue = (code: PreflightIssueCode, message: string): PreflightIssue => ({
    provider,
    capability: 'transport',
    code,
    message,
  });
  if (!probe.ok) {
    switch (probe.failure.kind) {
      case 'content-script-unavailable':
        return issue(
          'content-script-unavailable',
          `ThirdMind's page connection is not active in the linked ${label} tab. Reload that tab (tabs opened before ThirdMind was installed, updated or reloaded need a reload) and check again.`,
        );
      case 'timeout':
        return issue('transport-unavailable', `The linked ${label} page did not answer in time. Check again.`);
      case 'navigated':
        return issue(
          'transport-unavailable',
          `The linked ${label} tab navigated or reloaded during the check. Check again.`,
        );
      case 'tab-closed':
        return issue('transport-unavailable', `The linked ${label} tab was closed.`);
      case 'tab-unreadable':
        return issue('transport-unavailable', `The address of the linked ${label} tab could not be read.`);
      case 'unsupported-page':
      case 'wrong-provider':
        return issue('transport-unavailable', `The linked tab does not show a ${label} page.`);
      case 'invalid-response':
        return issue(
          'transport-unavailable',
          `The linked ${label} page sent an answer that ThirdMind did not accept. Reload the tab and check again.`,
        );
      case 'transport-unavailable':
        return issue('transport-unavailable', `This browser does not allow ThirdMind to message the ${label} tab.`);
      case 'transport-error':
        return issue('transport-unavailable', `The linked ${label} page could not be reached. Check again.`);
    }
  }
  const { status } = probe;
  if (status.provider !== provider || status.tabId !== linked.tabId) {
    return issue('transport-unavailable', `The linked tab does not show a ${label} page.`);
  }
  // The page classifies its own URL; it must show exactly the linked conversation or new chat.
  if (linked.kind === 'conversation') {
    if (status.page.kind !== 'conversation' || status.page.conversationId !== linked.conversationId) {
      return issue(
        'target-changed',
        `The linked ${label} page no longer shows the linked conversation. Reconnect it under Linked conversations.`,
      );
    }
  } else {
    if (status.page.kind !== 'new-chat') {
      return issue(
        'target-changed',
        `The linked ${label} page no longer shows the linked new chat. Link it again under Linked conversations.`,
      );
    }
    if (expectedPageInstanceId !== undefined && status.pageInstanceId !== expectedPageInstanceId) {
      return issue(
        'target-changed',
        `The linked new ${label} chat was reloaded or replaced since this debate started, so it is no longer the page that was approved.`,
      );
    }
  }
  switch (status.readiness) {
    case 'ready':
      return null;
    case 'loading':
      return issue('page-not-ready', `The linked ${label} page is still loading. Check again in a moment.`);
    case 'composer-missing':
      return issue(
        'page-not-ready',
        `No message box was found on the linked ${label} page. Sign in to ${label}, wait for the page to load, and check again.`,
      );
    case 'not-a-chat-page':
      return issue('page-not-ready', `The linked ${label} tab does not show a chat page.`);
  }
}

function fallbackTransportIssue(provider: ConversationProviderId): PreflightIssue {
  return {
    provider,
    capability: 'transport',
    code: 'transport-unavailable',
    message: `The linked ${providerName(provider)} page could not be reached. Check again.`,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function authorizationCheck(provider: ConversationProviderId, adapter: LiveProviderAdapter | undefined): CapabilityCheck {
  if (adapter === undefined) {
    return unavailable(noAdapterIssue(provider, 'authorization'));
  }
  const { authorization } = adapter;
  return authorization.kind === 'authorized'
    ? AVAILABLE
    : unavailable({ provider, capability: 'authorization', code: 'automation-not-authorized', message: authorization.reason });
}

/**
 * Submission and response capabilities come only from the adapter's own
 * report for a verified target, saved conversation or new chat alike. A page
 * that answered the probe is not enough.
 */
async function checkAdapter(
  provider: ConversationProviderId,
  adapter: LiveProviderAdapter | undefined,
  target: LiveConversationTarget | null,
): Promise<{ submission: CapabilityCheck; responseAcquisition: CapabilityCheck }> {
  if (adapter === undefined) {
    return {
      submission: unavailable(noAdapterIssue(provider, 'submission')),
      responseAcquisition: unavailable(noAdapterIssue(provider, 'responseAcquisition')),
    };
  }
  if (target === null) {
    const pending = notChecked('Checked once the conversation and its page are ready.');
    return { submission: pending, responseAcquisition: pending };
  }
  let reported: LiveAdapterCapabilities;
  try {
    reported = await adapter.capabilities(target);
  } catch {
    const message = `The ${providerName(provider)} adapter (${adapter.route.label}) could not report its capabilities.`;
    return {
      submission: unavailable({ provider, capability: 'submission', code: 'adapter-error', message }),
      responseAcquisition: unavailable({ provider, capability: 'responseAcquisition', code: 'adapter-error', message }),
    };
  }
  return {
    submission:
      reported.submission.status === 'available'
        ? AVAILABLE
        : unavailable({
            provider,
            capability: 'submission',
            code: 'submission-unavailable',
            message: reported.submission.reason,
          }),
    responseAcquisition:
      reported.responseAcquisition.status === 'available'
        ? AVAILABLE
        : unavailable({
            provider,
            capability: 'responseAcquisition',
            code: 'response-unavailable',
            message: reported.responseAcquisition.reason,
          }),
  };
}

function noAdapterIssue(provider: ConversationProviderId, capability: CapabilityName): PreflightIssue {
  const label = providerName(provider);
  return {
    provider,
    capability,
    code: 'no-adapter',
    message: `No live adapter is installed for ${label}, so ThirdMind cannot exchange messages with it.`,
  };
}

// ---------------------------------------------------------------------------

function unavailable(issue: PreflightIssue): CapabilityCheck {
  return { status: 'unavailable', issue };
}

function notChecked(reason: string): CapabilityCheck {
  return { status: 'not-checked', reason };
}

export function providerName(provider: ConversationProviderId): string {
  return provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
}

/** Joins the issues of a failed preflight into one rejection reason. */
export function describePreflightFailure(result: LivePreflightResult, action: 'start' | 'continue' = 'start'): string {
  const summary = `The live debate cannot ${action}`;
  return result.issues.length === 0
    ? `${summary}.`
    : `${summary}: ${result.issues.map((issue) => issue.message).join(' ')}`;
}
