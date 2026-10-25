/**
 * Ports: the capabilities the application layer needs from the outside world.
 * Implementations live in `infrastructure` (simulators, in-memory stores) and
 * `extension` (Chrome-backed adapters).
 */
import type {
  BrowserTabId,
  ConnectionRegistry,
  ContributionOrigin,
  ContributionRequest,
  ConversationProviderId,
  ConvergenceAssessment,
  DebateSession,
  ParticipantId,
  Timestamp,
  UrlClassification,
} from '../domain';

// ---------------------------------------------------------------------------
// Contribution providers
// ---------------------------------------------------------------------------

export type ProviderResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly assessment: ConvergenceAssessment;
    }
  | {
      readonly ok: false;
      readonly error: { readonly message: string };
    };

export interface ProviderCallOptions {
  /**
   * Aborted when the application no longer needs the result (for example, the
   * session was reset). Providers that cannot cancel may ignore it; see
   * `supportsCancellation`.
   */
  readonly signal: AbortSignal;
}

/**
 * Produces contributions for one participant.
 *
 * Providers must not assume exactly-once invocation. `request.operationId` is
 * stable for a given session, round, participant and attempt, so providers
 * that support idempotency keys should pass it through.
 */
export interface ContributionProvider {
  readonly participantId: ParticipantId;
  /** Recorded on every contribution so simulated output is never presented as live. */
  readonly origin: ContributionOrigin;
  readonly supportsCancellation: boolean;
  requestContribution(request: ContributionRequest, options: ProviderCallOptions): Promise<ProviderResult>;
}

export type ProviderRegistry = ReadonlyMap<ParticipantId, ContributionProvider>;

// ---------------------------------------------------------------------------
// Operational checkpoints
// ---------------------------------------------------------------------------

/**
 * Minimal state needed to continue a session after the runtime restarts.
 * `setup` is opaque to the application layer; the composition root uses it to
 * recreate providers (for example, the selected simulation scenario).
 */
export interface DebateCheckpoint<TSetup> {
  readonly version: 1;
  readonly session: DebateSession;
  readonly setup: TSetup;
}

export interface CheckpointStore<TSetup> {
  load(): Promise<DebateCheckpoint<TSetup> | null>;
  save(checkpoint: DebateCheckpoint<TSetup>): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Time and identity
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Timestamp;
}

export interface IdGenerator {
  /** Returns a new unique identifier, for example `session-<uuid>`. */
  newId(prefix: string): string;
}

// ---------------------------------------------------------------------------
// Conversation links (Phase 2.1)
// ---------------------------------------------------------------------------

/** Browser-neutral view of one open tab. URL and title are untrusted. */
export interface BrowserTabInfo {
  readonly tabId: BrowserTabId;
  /** `null` when the browser did not expose the URL (for example, missing permission). */
  readonly url: string | null;
  readonly title: string | null;
}

export type TabQueryResult =
  | { readonly ok: true; readonly tabs: readonly BrowserTabInfo[] }
  | { readonly ok: false; readonly reason: string; readonly cause?: unknown };

/** Lists the open browser tabs. Implementations must not throw; failures are returned. */
export interface TabSource {
  listTabs(): Promise<TabQueryResult>;
}

/**
 * Classifies a URL according to the configured provider URL rules. Rules are
 * an infrastructure detail: they change when providers change their sites.
 */
export interface ConversationRecognizer {
  recognize(url: string): UrlClassification;
}

/** Minimal connection metadata. Never contains conversation content or tab titles. */
export interface ConnectionStore {
  load(): Promise<ConnectionRegistry | null>;
  save(registry: ConnectionRegistry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider page transport (Phase 2.2B foundation)
// ---------------------------------------------------------------------------

/** What a provider page shows, as classified by the page itself from its own URL. */
export type ProviderPageKind =
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'new-chat' }
  /** A page of the provider that is neither a conversation nor a new chat. */
  | { readonly kind: 'provider-page' };

/**
 * Non-sensitive readiness information reported by a provider page. It never
 * contains conversation content, titles, user names or any text from the page.
 */
export interface ProviderPageReport {
  readonly provider: ConversationProviderId;
  readonly page: ProviderPageKind;
  /** `document.readyState`. */
  readonly documentState: 'loading' | 'interactive' | 'complete';
  /** `document.visibilityState`: whether the tab is the visible tab of its window. */
  readonly visibility: 'visible' | 'hidden';
  /** Whether the provider's message box element exists. Only its presence is checked, never its contents. */
  readonly composer: 'present' | 'absent';
}

/**
 * Summary of a report:
 * - `ready`: a conversation or new chat whose message box exists;
 * - `loading`: the document is still loading;
 * - `composer-missing`: a chat page without a message box (signed out, still
 *   rendering, an error page, or the provider changed its page structure);
 * - `not-a-chat-page`: any other page of the provider.
 */
export type ProviderPageReadiness = 'ready' | 'loading' | 'composer-missing' | 'not-a-chat-page';

export interface ProviderPageStatus extends ProviderPageReport {
  readonly tabId: BrowserTabId;
  /** Random id of the content script instance. It changes with every document load in the tab. */
  readonly pageInstanceId: string;
  readonly readiness: ProviderPageReadiness;
}

/**
 * Why a transport operation did not produce a result:
 * - `transport-unavailable`: the browser does not expose the APIs the transport needs;
 * - `tab-closed`: the tab does not exist (any more);
 * - `tab-unreadable`: the tab's URL could not be read;
 * - `unsupported-page`: the tab does not show a supported provider origin;
 * - `wrong-provider`: the tab shows the other provider;
 * - `content-script-unavailable`: no ThirdMind content script answers in the tab;
 * - `navigated`: the tab navigated or reloaded while the operation was in progress, so any answer is stale;
 * - `timeout`: no answer arrived in time;
 * - `invalid-response`: the answer was malformed or did not belong to the request;
 * - `transport-error`: any other messaging error.
 */
export type TransportFailureKind =
  | 'transport-unavailable'
  | 'tab-closed'
  | 'tab-unreadable'
  | 'unsupported-page'
  | 'wrong-provider'
  | 'content-script-unavailable'
  | 'navigated'
  | 'timeout'
  | 'invalid-response'
  | 'transport-error';

/**
 * `outcome` states what is known about the page's side of the operation:
 * - `not-performed`: the page certainly did not act on it (it was never
 *   delivered, or the page refused it);
 * - `unknown`: the page may have received and acted on it. A timeout is
 *   always `unknown`: it never proves that the operation failed.
 */
export interface TransportFailure {
  readonly kind: TransportFailureKind;
  readonly outcome: 'not-performed' | 'unknown';
}

export type ProviderProbeResult =
  | { readonly ok: true; readonly status: ProviderPageStatus }
  | { readonly ok: false; readonly failure: TransportFailure };

/**
 * Provider-neutral boundary to the provider pages open in browser tabs.
 * Implementations validate the tab before and after every operation and must
 * not throw; failures are returned.
 *
 * This iteration only reads readiness. It does not read conversations or submit prompts.
 */
export interface ProviderPageTransport {
  probe(tabId: BrowserTabId, provider: ConversationProviderId): Promise<ProviderProbeResult>;
}
