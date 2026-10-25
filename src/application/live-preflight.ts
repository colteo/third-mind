import {
  CONVERSATION_PROVIDERS,
  linkStatus,
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
import type { LiveTargetBinding, LiveTargetBindings } from './execution-mode';
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
  /** For an existing live session: the targets it was started with. They must not have changed. */
  readonly expectedTargets?: LiveTargetBindings;
}

export interface ProviderPreflight {
  readonly provider: ConversationProviderId;
  /** The adapter's route, or `null` when no adapter is installed for the provider. */
  readonly route: { readonly id: string; readonly label: string } | null;
  readonly capabilities: ProviderCapabilities;
  readonly technicallyReady: boolean;
  readonly authorized: boolean;
  readonly ready: boolean;
  /** The linked conversation, when the connection is available. */
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
   * Re-verifies one bound conversation immediately before a live operation:
   * the link must still be healthy and point at the same tab and conversation,
   * and the page must answer and show that conversation.
   */
  verifyTarget(binding: LiveTargetBinding): Promise<TargetVerification>;
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

  const checkTransport = async (
    binding: LiveTargetBinding,
  ): Promise<{ check: CapabilityCheck; target: LiveConversationTarget | null }> => {
    let probe: ProviderProbeResult;
    try {
      probe = await deps.transport.probe(binding.tabId, binding.provider);
    } catch {
      probe = { ok: false, failure: { kind: 'transport-error', outcome: 'unknown' } };
    }
    const issue = transportIssue(binding, probe);
    if (issue !== null || !probe.ok) {
      return { check: unavailable(issue ?? fallbackTransportIssue(binding.provider)), target: null };
    }
    return {
      check: AVAILABLE,
      target: {
        provider: binding.provider,
        tabId: binding.tabId,
        conversationId: binding.conversationId,
        pageInstanceId: probe.status.pageInstanceId,
      },
    };
  };

  const checkProvider = async (
    provider: ConversationProviderId,
    current: ConnectionsSnapshot,
    request: LivePreflightRequest,
  ): Promise<ProviderPreflight> => {
    const adapter = deps.adapters[provider];
    const connection = evaluateConnection(
      provider,
      current.registry[provider],
      current.discovery,
      request.expectedRevisions?.[provider],
      request.expectedTargets?.[provider],
    );
    const binding = connection.ok ? connection.binding : null;

    let transport: CapabilityCheck = notChecked('Checked once the conversation link is available.');
    let target: LiveConversationTarget | null = null;
    if (binding !== null) {
      ({ check: transport, target } = await checkTransport(binding));
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
      binding,
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
      const { check, target } = await checkTransport(connection.binding);
      if (check.status === 'unavailable') {
        return { ok: false, issue: check.issue };
      }
      return target === null ? { ok: false, issue: fallbackTransportIssue(binding.provider) } : { ok: true, target };
    },
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export type ConnectionEvaluation =
  | { readonly ok: true; readonly binding: LiveTargetBinding }
  | { readonly ok: false; readonly issue: PreflightIssue };

/**
 * Pure check of one provider's link. A live debate needs a saved
 * conversation shown in its linked tab: pending and unconfirmed new chats,
 * stale, disconnected and unverifiable links are all rejected.
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
      ? fail('not-linked', `No ${label} conversation is linked. Link a saved ${label} conversation under Linked conversations.`)
      : fail(
          'target-changed',
          `The ${label} conversation this debate was started with is no longer linked. A live debate cannot move to another conversation; reconnect it or start a new debate.`,
        );
  }
  const status = linkStatus(link);
  switch (status.kind) {
    case 'linked':
      break;
    case 'awaiting-identity':
      return fail(
        'identity-pending',
        `The linked ${label} tab is a new chat that has no saved conversation yet. A live debate must be bound to a saved conversation so every response can be matched to it. Link a saved ${label} conversation instead.`,
      );
    case 'confirmation-required':
      return fail(
        'identity-unconfirmed',
        `The conversation in the linked ${label} tab has not been confirmed. Confirm it under Linked conversations, or link another saved conversation.`,
      );
    case 'stale':
      return fail(
        'link-stale',
        `The linked ${label} tab no longer shows the linked conversation. Reconnect it under Linked conversations, or link another conversation.`,
      );
    case 'disconnected':
      return fail(
        'link-disconnected',
        `The linked ${label} tab was closed. Reopen the conversation and reconnect it under Linked conversations.`,
      );
    case 'unavailable':
      return fail(
        'link-unavailable',
        `ThirdMind cannot currently verify the linked ${label} tab. Click Refresh under Linked conversations and try again.`,
      );
  }
  if (link.identity.kind !== 'saved') {
    // Unreachable: `linkStatus` reports every other identity above.
    return fail('identity-pending', `The linked ${label} conversation has no saved identity.`);
  }
  const binding: LiveTargetBinding = {
    provider,
    tabId: link.tabId,
    conversationId: link.identity.conversationId,
    linkRevision: slot.revision,
  };
  if (
    expectedTarget !== undefined &&
    (expectedTarget.tabId !== binding.tabId || expectedTarget.conversationId !== binding.conversationId)
  ) {
    return fail(
      'target-changed',
      `The ${label} link now points at a different tab or conversation than the one this debate was started with. A live debate cannot move to another conversation; reconnect the original one or start a new debate.`,
    );
  }
  return { ok: true, binding };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function transportIssue(binding: LiveTargetBinding, probe: ProviderProbeResult): PreflightIssue | null {
  const { provider } = binding;
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
  // The page classifies its own URL; it must show exactly the bound conversation.
  if (status.page.kind !== 'conversation' || status.page.conversationId !== binding.conversationId) {
    return issue(
      'target-changed',
      `The linked ${label} page no longer shows the linked conversation. Reconnect it under Linked conversations.`,
    );
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
 * report for a verified target. A page that answered the probe is not enough.
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
