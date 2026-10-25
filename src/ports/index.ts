/**
 * Ports: the capabilities the application layer needs from the outside world.
 * Implementations live in `infrastructure` (simulators, in-memory stores) and
 * `extension` (Chrome-backed adapters).
 */
import type {
  BrowserTabId,
  OperationId,
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
      /**
       * What is known about the provider's side of the request:
       * - `failed` (the default): the provider certainly did not produce a
       *   contribution; the debate stops;
       * - `unknown`: the request may have been acted on (for example, a message
       *   was submitted and the response timed out). The operation becomes
       *   uncertain and is never retried without explicit human approval.
       */
      readonly outcome?: 'failed' | 'unknown';
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

// ---------------------------------------------------------------------------
// Live provider adapters (live debate execution foundation)
// ---------------------------------------------------------------------------

/**
 * Whether automated interaction through an adapter's route is permitted by
 * the provider. This is a declaration made by the adapter's author about a
 * documented, supported route (for example, an official API used under its
 * terms). Technical access to a page is never evidence of authorization.
 */
export type AutomationAuthorization =
  | { readonly kind: 'authorized'; readonly basis: string }
  | { readonly kind: 'not-authorized'; readonly reason: string };

export type AdapterCapability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly reason: string };

/** What an adapter can do for one target right now. Never inferred from a page probe. */
export interface LiveAdapterCapabilities {
  readonly submission: AdapterCapability;
  readonly responseAcquisition: AdapterCapability;
}

/** The verified conversation a live operation is aimed at. */
export interface LiveConversationTarget {
  readonly provider: ConversationProviderId;
  readonly tabId: BrowserTabId;
  /** Always a saved conversation: live operations are never aimed at a pending new chat. */
  readonly conversationId: string;
  /** Content script instance that answered the latest probe. It changes with every document load. */
  readonly pageInstanceId: string;
}

export interface LiveSubmission {
  /** Stable per session, round, participant and attempt. Adapters should use it as an idempotency key. */
  readonly operationId: OperationId;
  readonly text: string;
}

/** Proof that the adapter handed a message to the provider. */
export interface SubmissionReceipt {
  readonly operationId: OperationId;
  readonly conversationId: string;
  readonly pageInstanceId: string;
  /** Adapter-specific identifier of the submitted message. */
  readonly submissionId: string;
}

export interface LiveResponse {
  readonly operationId: OperationId;
  readonly conversationId: string;
  readonly pageInstanceId: string;
  readonly submissionId: string;
  readonly content: string;
}

/**
 * - `not-authorized`, `unsupported`: the route does not permit or support the operation;
 * - `target-changed`: the conversation or document is no longer the one the operation was aimed at;
 * - `busy`: another submission to the same conversation is in progress;
 * - `timeout`: no result in time (the outcome is always `unknown`);
 * - `provider-error`: the provider reported an error;
 * - `invalid-response`: the result was malformed or belonged to another operation;
 * - `transport-error`: any other failure to reach the provider.
 */
export type LiveFailureKind =
  | 'not-authorized'
  | 'unsupported'
  | 'target-changed'
  | 'busy'
  | 'timeout'
  | 'provider-error'
  | 'invalid-response'
  | 'transport-error';

/** As for `TransportFailure`, `outcome: 'unknown'` means the provider may have acted on the operation. */
export interface LiveFailure {
  readonly kind: LiveFailureKind;
  readonly outcome: 'not-performed' | 'unknown';
  readonly message: string;
}

export type SubmissionResult =
  | { readonly ok: true; readonly receipt: SubmissionReceipt }
  | { readonly ok: false; readonly failure: LiveFailure };

export type ResponseResult =
  | { readonly ok: true; readonly response: LiveResponse }
  | { readonly ok: false; readonly failure: LiveFailure };

export interface LiveCallOptions {
  readonly signal: AbortSignal;
}

/**
 * Provider-specific route for submitting a debate message to a linked
 * conversation and acquiring the provider's response. Implementations keep
 * browser and network details behind this port, must not throw, and must
 * only implement routes the provider has authorized for automated use.
 */
export interface LiveProviderAdapter {
  readonly provider: ConversationProviderId;
  readonly route: { readonly id: string; readonly label: string };
  readonly authorization: AutomationAuthorization;
  capabilities(target: LiveConversationTarget): Promise<LiveAdapterCapabilities>;
  /** Submits one message. Must not retry on its own: a retry of an uncertain submission is a human decision. */
  submit(target: LiveConversationTarget, submission: LiveSubmission, options: LiveCallOptions): Promise<SubmissionResult>;
  /** Waits for the provider's response to a submission. */
  awaitResponse(
    target: LiveConversationTarget,
    receipt: SubmissionReceipt,
    options: LiveCallOptions,
  ): Promise<ResponseResult>;
}

export type LiveAdapterRegistry = Readonly<Partial<Record<ConversationProviderId, LiveProviderAdapter>>>;
