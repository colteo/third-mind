import type {
  CompletionReason,
  ContributionId,
  ContributionOrigin,
  ConvergenceAssessment,
  DebateConfiguration,
  InterventionId,
  OperationId,
  Participant,
  ParticipantId,
  SessionId,
  Timestamp,
} from './types';

/**
 * Facts recorded by the debate engine. Every event carries the time at which
 * it happened (`at`); identifiers are supplied by the caller.
 *
 * Preconditions and effects of each event are documented in
 * `docs/architecture/debate-engine.md` and enforced by `evolve`.
 */
export type DebateEvent =
  | SessionCreated
  | DebateStarted
  | ContributionRequested
  | ContributionDispatched
  | ContributionReceived
  | ContributionFailed
  | ContributionOutcomeUncertain
  | RoundAdvanced
  | PauseRequested
  | DebatePaused
  | HumanConstraintAdded
  | DebateResumed
  | DebateCompleted
  | RuntimeRecovered
  | UncertainOperationReissued;

export type DebateEventType = DebateEvent['type'];

export interface SessionCreated {
  readonly type: 'SessionCreated';
  readonly at: Timestamp;
  readonly sessionId: SessionId;
  readonly topic: string;
  readonly constraints: readonly string[];
  readonly participants: readonly Participant[];
  readonly configuration: DebateConfiguration;
}

export interface DebateStarted {
  readonly type: 'DebateStarted';
  readonly at: Timestamp;
}

/** A provider contribution has been registered (as `pending`) but not yet sent. */
export interface ContributionRequested {
  readonly type: 'ContributionRequested';
  readonly at: Timestamp;
  readonly operation: OperationDescriptor;
}

export interface OperationDescriptor {
  readonly id: OperationId;
  readonly round: number;
  readonly participantId: ParticipantId;
  readonly attempt: number;
}

/** A pending operation is about to be handed to its provider (write-ahead record). */
export interface ContributionDispatched {
  readonly type: 'ContributionDispatched';
  readonly at: Timestamp;
  readonly operationId: OperationId;
  readonly interventionIds: readonly InterventionId[];
}

export interface ContributionReceived {
  readonly type: 'ContributionReceived';
  readonly at: Timestamp;
  readonly operationId: OperationId;
  readonly contributionId: ContributionId;
  readonly content: string;
  readonly assessment: ConvergenceAssessment;
  readonly origin: ContributionOrigin;
}

export interface ContributionFailed {
  readonly type: 'ContributionFailed';
  readonly at: Timestamp;
  readonly operationId: OperationId;
  readonly error: string;
}

/**
 * The provider could not tell whether a dispatched request was acted on (for
 * example, it timed out after submitting a message). The operation becomes
 * `uncertain`; it is never retried automatically, and the debate pauses for
 * the human to review it.
 */
export interface ContributionOutcomeUncertain {
  readonly type: 'ContributionOutcomeUncertain';
  readonly at: Timestamp;
  readonly operationId: OperationId;
  readonly detail: string;
}

export interface RoundAdvanced {
  readonly type: 'RoundAdvanced';
  readonly at: Timestamp;
  readonly toRound: number;
}

export interface PauseRequested {
  readonly type: 'PauseRequested';
  readonly at: Timestamp;
}

export interface DebatePaused {
  readonly type: 'DebatePaused';
  readonly at: Timestamp;
}

export interface HumanConstraintAdded {
  readonly type: 'HumanConstraintAdded';
  readonly at: Timestamp;
  readonly interventionId: InterventionId;
  readonly content: string;
}

export interface DebateResumed {
  readonly type: 'DebateResumed';
  readonly at: Timestamp;
}

export interface DebateCompleted {
  readonly type: 'DebateCompleted';
  readonly at: Timestamp;
  readonly reason: CompletionReason;
  readonly finalRound: number;
}

/**
 * The hosting runtime restarted (for example, the MV3 service worker was
 * terminated) and the session was restored from a checkpoint. In-memory
 * provider calls did not survive.
 */
export interface RuntimeRecovered {
  readonly type: 'RuntimeRecovered';
  readonly at: Timestamp;
}

/**
 * A human explicitly approved re-issuing an uncertain operation, accepting
 * that the provider may receive the request twice.
 */
export interface UncertainOperationReissued {
  readonly type: 'UncertainOperationReissued';
  readonly at: Timestamp;
  readonly operationId: OperationId;
}
