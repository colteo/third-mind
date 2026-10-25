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
