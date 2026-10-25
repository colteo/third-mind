import type { ConversationProviderId } from '../domain';

/**
 * Capabilities a provider needs before it can take part in a live debate.
 *
 * - `connection`: a linked saved conversation whose tab still shows it;
 * - `transport`: the provider page answers through ThirdMind's page transport
 *   and reports a loaded chat page with a message box;
 * - `submission`: the adapter can submit a debate message to that conversation;
 * - `responseAcquisition`: the adapter can obtain the provider's response;
 * - `authorization`: the adapter's route is authorized by the provider for
 *   automated interaction.
 *
 * The first four describe technical readiness; `authorization` is separate.
 * A page that answers a probe proves only that the page is reachable. It never
 * implies that messages can be submitted, or that doing so is permitted.
 */
export type CapabilityName = 'connection' | 'transport' | 'submission' | 'responseAcquisition' | 'authorization';

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'connection',
  'transport',
  'submission',
  'responseAcquisition',
  'authorization',
];

export const TECHNICAL_CAPABILITIES: readonly CapabilityName[] = [
  'connection',
  'transport',
  'submission',
  'responseAcquisition',
];

/**
 * Machine-readable reason a capability is unavailable. The panel shows
 * `message`; tests and callers switch on `code`.
 */
export type PreflightIssueCode =
  // connection
  | 'not-linked'
  | 'view-outdated'
  | 'identity-pending'
  | 'identity-unconfirmed'
  | 'link-stale'
  | 'link-disconnected'
  | 'link-unavailable'
  | 'target-changed'
  | 'tabs-unreadable'
  // transport
  | 'transport-unavailable'
  | 'content-script-unavailable'
  | 'page-not-ready'
  // adapter
  | 'no-adapter'
  | 'automation-not-authorized'
  | 'submission-unavailable'
  | 'response-unavailable'
  | 'adapter-error';

export interface PreflightIssue {
  readonly provider: ConversationProviderId;
  readonly capability: CapabilityName;
  readonly code: PreflightIssueCode;
  /** Actionable, provider-specific explanation. Never contains URLs, titles or page content. */
  readonly message: string;
}

export type CapabilityCheck =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly issue: PreflightIssue }
  /** Not evaluated because a capability it depends on is unavailable. */
  | { readonly status: 'not-checked'; readonly reason: string };

export type ProviderCapabilities = Readonly<Record<CapabilityName, CapabilityCheck>>;

export const AVAILABLE: CapabilityCheck = { status: 'available' };

export function isAvailable(check: CapabilityCheck): boolean {
  return check.status === 'available';
}

/** Every technical capability is available. Says nothing about authorization. */
export function isTechnicallyReady(capabilities: ProviderCapabilities): boolean {
  return TECHNICAL_CAPABILITIES.every((name) => isAvailable(capabilities[name]));
}

export function isAuthorized(capabilities: ProviderCapabilities): boolean {
  return isAvailable(capabilities.authorization);
}

/** A provider is ready for a live debate only when it is technically ready and authorized. */
export function isLiveReady(capabilities: ProviderCapabilities): boolean {
  return isTechnicallyReady(capabilities) && isAuthorized(capabilities);
}

export function issuesOf(capabilities: ProviderCapabilities): readonly PreflightIssue[] {
  return CAPABILITY_NAMES.flatMap((name) => {
    const check = capabilities[name];
    return check.status === 'unavailable' ? [check.issue] : [];
  });
}
