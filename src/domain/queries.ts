import type {
  Contribution,
  DebateSession,
  OperationId,
  Participant,
  ParticipantId,
  ProviderOperation,
  SessionId,
} from './types';

/**
 * Stable, deterministic operation identifier. The same session, round,
 * participant and attempt always produce the same identifier, so it can be
 * used as an idempotency key by providers that support one.
 */
export function operationIdFor(
  sessionId: SessionId,
  round: number,
  participantId: ParticipantId,
  attempt: number,
): OperationId {
  return `${sessionId}:round-${round}:${participantId}:attempt-${attempt}`;
}

/** Participants that are expected to contribute every round (everyone except the human). */
export function providerParticipants(session: DebateSession): readonly Participant[] {
  return session.participants.filter((participant) => participant.providerType !== 'human');
}

export function findParticipant(
  session: DebateSession,
  participantId: ParticipantId,
): Participant | undefined {
  return session.participants.find((participant) => participant.id === participantId);
}

export function findOperation(
  session: DebateSession,
  operationId: OperationId,
): ProviderOperation | undefined {
  return session.operations.find((operation) => operation.id === operationId);
}

export function operationsFor(
  session: DebateSession,
  round: number,
  participantId: ParticipantId,
): readonly ProviderOperation[] {
  return session.operations.filter(
    (operation) => operation.round === round && operation.participantId === participantId,
  );
}

/** The latest operation for a participant in a round that has not been superseded. */
export function activeOperation(
  session: DebateSession,
  round: number,
  participantId: ParticipantId,
): ProviderOperation | undefined {
  return operationsFor(session, round, participantId).find(
    (operation) => operation.status !== 'superseded',
  );
}

export function contributionsInRound(session: DebateSession, round: number): readonly Contribution[] {
  return session.contributions.filter((contribution) => contribution.round === round);
}

/** True when every provider participant has an acknowledged contribution in the current round. */
export function isCurrentRoundComplete(session: DebateSession): boolean {
  return providerParticipants(session).every(
    (participant) =>
      activeOperation(session, session.currentRound, participant.id)?.status === 'acknowledged',
  );
}

/**
 * True while at least one more provider request can still be dispatched in
 * this session. False once the final permitted round is complete: resuming
 * would complete the debate, so nothing added afterwards could reach a
 * participant. (After an earlier round a pending constraint keeps the debate
 * going, see `evaluateStopping`.)
 */
export function canDispatchFurtherRequests(session: DebateSession): boolean {
  return !(session.currentRound >= session.configuration.maximumRounds && isCurrentRoundComplete(session));
}

export function dispatchedOperations(session: DebateSession): readonly ProviderOperation[] {
  return session.operations.filter((operation) => operation.status === 'dispatched');
}

export function uncertainOperations(session: DebateSession): readonly ProviderOperation[] {
  return session.operations.filter((operation) => operation.status === 'uncertain');
}

export interface AvailableActions {
  readonly start: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly addConstraint: boolean;
  readonly reissueUncertainOperation: boolean;
  readonly reset: boolean;
}

/**
 * Which human actions are valid for the given state. Mirrors the preconditions
 * enforced by `evolve`, so a UI can render only controls that will succeed.
 */
export function availableActions(session: DebateSession | null): AvailableActions {
  if (session === null) {
    return {
      start: true,
      pause: false,
      resume: false,
      addConstraint: false,
      reissueUncertainOperation: false,
      reset: false,
    };
  }
  const paused = session.status.kind === 'paused';
  const hasUncertain = uncertainOperations(session).length > 0;
  return {
    start: session.status.kind === 'idle',
    pause: session.status.kind === 'running',
    resume: paused && !hasUncertain,
    addConstraint: paused && session.configuration.allowHumanIntervention && canDispatchFurtherRequests(session),
    reissueUncertainOperation: paused && hasUncertain,
    reset: true,
  };
}
