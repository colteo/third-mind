/**
 * Core domain types for a ThirdMind debate session.
 *
 * Every type in this module is plain, serializable data: no classes, functions,
 * Dates, Maps or Sets. A session can be round-tripped through JSON (for example
 * into an operational checkpoint) without loss.
 */

/** ISO-8601 timestamp. Always supplied by the caller; the domain never reads a clock. */
export type Timestamp = string;

export type SessionId = string;
export type ParticipantId = string;
export type OperationId = string;
export type ContributionId = string;
export type InterventionId = string;

/**
 * How a participant is bound to the outside world.
 *
 * - `gpt-simulator`, `claude-simulator`: deterministic local simulators;
 * - `chatgpt-live`, `claude-live`: a linked ChatGPT or Claude conversation,
 *   reached through a live provider adapter. Only used in live mode.
 */
export type ProviderType = 'human' | 'gpt-simulator' | 'claude-simulator' | 'chatgpt-live' | 'claude-live';

export interface Participant {
  readonly id: ParticipantId;
  readonly displayName: string;
  readonly providerType: ProviderType;
}

export type DebatePhase =
  | 'independent-analysis'
  | 'cross-examination'
  | 'refinement'
  | 'convergence';

/**
 * - `adaptive`: the debate may finish before `maximumRounds` when a structured
 *   assessment reports that no material issues remain.
 * - `fixed`: the debate always runs exactly `maximumRounds` rounds.
 */
export type StoppingStrategy = 'adaptive' | 'fixed';

export interface DebateConfiguration {
  readonly maximumRounds: number;
  readonly stoppingStrategy: StoppingStrategy;
  readonly allowHumanIntervention: boolean;
}

/**
 * Structured self-assessment attached to every provider contribution.
 *
 * The stopping policy only reads `materialIssues`. Open questions and
 * agreements are reported to the human but never stop or extend the debate.
 */
export interface ConvergenceAssessment {
  readonly materialIssues: readonly string[];
  readonly openQuestions: readonly string[];
  readonly agreements: readonly string[];
}

/** Whether a contribution came from a simulator or a real provider. */
export type ContributionOrigin = 'simulated' | 'live';

export interface Contribution {
  readonly id: ContributionId;
  readonly round: number;
  readonly phase: DebatePhase;
  readonly participantId: ParticipantId;
  readonly operationId: OperationId;
  readonly content: string;
  readonly assessment: ConvergenceAssessment;
  readonly origin: ContributionOrigin;
  readonly timestamp: Timestamp;
}

/**
 * - `pending`: recorded, not yet included in any dispatched provider request.
 * - `applied`: included in at least one dispatched provider request.
 */
export type InterventionApplicationStatus = 'pending' | 'applied';

export interface HumanIntervention {
  readonly id: InterventionId;
  readonly content: string;
  readonly timestamp: Timestamp;
  /** The round that was current when the human added the constraint. */
  readonly addedDuringRound: number;
  readonly applicationStatus: InterventionApplicationStatus;
  /** Provider operations whose request included this constraint. */
  readonly appliedToOperationIds: readonly OperationId[];
}

/**
 * Lifecycle of a single outgoing provider request.
 *
 * - `pending`: recorded, not yet handed to a provider. Safe to dispatch.
 * - `dispatched`: handed to a provider; a result is expected.
 * - `acknowledged`: a result was received and recorded as a contribution.
 * - `failed`: the provider reported a failure.
 * - `uncertain`: the provider may or may not have received or processed it:
 *   the runtime restarted while the operation was dispatched, or the provider
 *   reported an unknown outcome (for example, a timeout after submission).
 * - `superseded`: a human explicitly approved re-issuing an uncertain
 *   operation; a later attempt replaces it and late results are discarded.
 */
export type OperationStatus =
  | 'pending'
  | 'dispatched'
  | 'acknowledged'
  | 'failed'
  | 'uncertain'
  | 'superseded';

interface OperationBase {
  readonly id: OperationId;
  readonly round: number;
  readonly phase: DebatePhase;
  readonly participantId: ParticipantId;
  /** 1-based attempt counter for this participant in this round. */
  readonly attempt: number;
  readonly requestedAt: Timestamp;
}

interface DispatchDetails {
  readonly dispatchedAt: Timestamp;
  /** Human interventions that were part of the dispatched request. */
  readonly interventionIds: readonly InterventionId[];
}

export type ProviderOperation =
  | (OperationBase & { readonly status: 'pending' })
  | (OperationBase & DispatchDetails & { readonly status: 'dispatched' })
  | (OperationBase &
      DispatchDetails & {
        readonly status: 'acknowledged';
        readonly settledAt: Timestamp;
        readonly contributionId: ContributionId;
      })
  | (OperationBase &
      DispatchDetails & {
        readonly status: 'failed';
        readonly settledAt: Timestamp;
        readonly error: string;
      })
  | (OperationBase &
      DispatchDetails & {
        readonly status: 'uncertain';
        readonly detectedAt: Timestamp;
        /** Absent in checkpoints written before live mode existed; those are always `runtime-restart`. */
        readonly cause?: UncertaintyCause;
        /** Provider-supplied explanation for an `unknown-outcome`. */
        readonly detail?: string;
      })
  | (OperationBase & DispatchDetails & { readonly status: 'superseded'; readonly supersededAt: Timestamp });

/**
 * Why an operation became uncertain:
 * - `runtime-restart`: the runtime restarted while it was dispatched;
 * - `unknown-outcome`: the provider reported that it cannot tell whether the
 *   request was acted on (for example, a timeout after submission).
 */
export type UncertaintyCause = 'runtime-restart' | 'unknown-outcome';

export type PauseReason = 'human-request' | 'runtime-restart' | 'uncertain-outcome';

export type CompletionReason = 'early-convergence' | 'maximum-rounds-reached';

export type DebateStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  /** A pause was requested; no new work is scheduled while in-flight work settles. */
  | { readonly kind: 'pausing' }
  | { readonly kind: 'paused'; readonly reason: PauseReason }
  | { readonly kind: 'completed'; readonly reason: CompletionReason; readonly finalRound: number }
  | {
      readonly kind: 'failed';
      readonly operationId: OperationId;
      readonly participantId: ParticipantId;
      readonly error: string;
    };

export type DebateStatusKind = DebateStatus['kind'];

export interface DebateSession {
  readonly id: SessionId;
  readonly topic: string;
  /** Constraints supplied when the session was created. */
  readonly constraints: readonly string[];
  readonly participants: readonly Participant[];
  readonly configuration: DebateConfiguration;
  /** 1-based. Always within [1, configuration.maximumRounds]. */
  readonly currentRound: number;
  /** Always the phase that corresponds to `currentRound`. */
  readonly phase: DebatePhase;
  readonly status: DebateStatus;
  readonly contributions: readonly Contribution[];
  readonly interventions: readonly HumanIntervention[];
  readonly operations: readonly ProviderOperation[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** The engine state. `null` means no session has been created yet. */
export type EngineState = DebateSession | null;
