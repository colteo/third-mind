import {
  MAX_CONSTRAINT_LENGTH,
  MAX_CONSTRAINTS,
  MAX_SUPPORTED_ROUNDS,
  MAX_TOPIC_LENGTH,
  phaseForRound,
} from './constants';
import type {
  ContributionDispatched,
  ContributionFailed,
  ContributionReceived,
  ContributionRequested,
  DebateCompleted,
  DebateEvent,
  HumanConstraintAdded,
  RoundAdvanced,
  RuntimeRecovered,
  SessionCreated,
  UncertainOperationReissued,
} from './events';
import {
  activeOperation,
  canDispatchFurtherRequests,
  dispatchedOperations,
  findOperation,
  findParticipant,
  isCurrentRoundComplete,
  operationIdFor,
  operationsFor,
  uncertainOperations,
} from './queries';
import { evaluateStopping } from './stopping';
import type {
  Contribution,
  DebateSession,
  DebateStatus,
  EngineState,
  HumanIntervention,
  ProviderOperation,
  Timestamp,
} from './types';

/**
 * Result of applying one event.
 *
 * - `applied`: the event was valid and produced a new state.
 * - `ignored`: the event is a duplicate or refers to work that has already been
 *   settled or superseded. The state is unchanged. Re-delivering an event is
 *   therefore safe.
 * - `rejected`: the event violates a precondition. The state is unchanged.
 */
export type EvolveResult =
  | { readonly outcome: 'applied'; readonly state: DebateSession }
  | { readonly outcome: 'ignored'; readonly state: EngineState; readonly reason: string }
  | { readonly outcome: 'rejected'; readonly state: EngineState; readonly reason: string };

/** Pure state transition. Never mutates its inputs. */
export function evolve(state: EngineState, event: DebateEvent): EvolveResult {
  if (event.type === 'SessionCreated') {
    return onSessionCreated(state, event);
  }
  if (state === null) {
    return rejected(state, `${event.type} requires an existing session.`);
  }
  switch (event.type) {
    case 'DebateStarted':
      if (state.status.kind === 'idle') {
        return applied(state, event.at, { status: { kind: 'running' } });
      }
      return state.status.kind === 'running'
        ? ignored(state, 'The debate has already started.')
        : rejected(state, `Cannot start a debate that is ${state.status.kind}.`);
    case 'ContributionRequested':
      return onContributionRequested(state, event);
    case 'ContributionDispatched':
      return onContributionDispatched(state, event);
    case 'ContributionReceived':
      return onContributionReceived(state, event);
    case 'ContributionFailed':
      return onContributionFailed(state, event);
    case 'RoundAdvanced':
      return onRoundAdvanced(state, event);
    case 'PauseRequested':
      if (state.status.kind === 'running') {
        return applied(state, event.at, { status: { kind: 'pausing' } });
      }
      if (state.status.kind === 'pausing' || state.status.kind === 'paused') {
        return ignored(state, 'A pause has already been requested.');
      }
      return rejected(state, `Cannot pause a debate that is ${state.status.kind}.`);
    case 'DebatePaused':
      if (state.status.kind === 'paused') {
        return ignored(state, 'The debate is already paused.');
      }
      if (state.status.kind !== 'pausing') {
        return rejected(state, `Cannot confirm a pause while the debate is ${state.status.kind}.`);
      }
      if (dispatchedOperations(state).length > 0) {
        return rejected(state, 'Cannot confirm the pause while provider operations are still in flight.');
      }
      return applied(state, event.at, { status: { kind: 'paused', reason: 'human-request' } });
    case 'HumanConstraintAdded':
      return onHumanConstraintAdded(state, event);
    case 'DebateResumed':
      if (state.status.kind === 'running') {
        return ignored(state, 'The debate is already running.');
      }
      if (state.status.kind !== 'paused') {
        return rejected(state, `Cannot resume a debate that is ${state.status.kind}.`);
      }
      if (uncertainOperations(state).length > 0) {
        return rejected(
          state,
          'Cannot resume while operations are uncertain. Each uncertain operation must be reviewed first.',
        );
      }
      return applied(state, event.at, { status: { kind: 'running' } });
    case 'DebateCompleted':
      return onDebateCompleted(state, event);
    case 'RuntimeRecovered':
      return onRuntimeRecovered(state, event);
    case 'UncertainOperationReissued':
      return onUncertainOperationReissued(state, event);
  }
}

function onSessionCreated(state: EngineState, event: SessionCreated): EvolveResult {
  if (state !== null) {
    return state.id === event.sessionId
      ? ignored(state, 'The session has already been created.')
      : rejected(state, 'A session already exists. Reset it before creating a new one.');
  }

  const topic = event.topic.trim();
  if (topic.length === 0) {
    return rejected(state, 'The debate topic must not be empty.');
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    return rejected(state, `The debate topic must not exceed ${MAX_TOPIC_LENGTH} characters.`);
  }

  const constraints = event.constraints.map((c) => c.trim()).filter((c) => c.length > 0);
  if (constraints.length > MAX_CONSTRAINTS) {
    return rejected(state, `At most ${MAX_CONSTRAINTS} constraints are supported.`);
  }
  if (constraints.some((c) => c.length > MAX_CONSTRAINT_LENGTH)) {
    return rejected(state, `Each constraint must not exceed ${MAX_CONSTRAINT_LENGTH} characters.`);
  }

  const ids = new Set(event.participants.map((p) => p.id));
  if (ids.size !== event.participants.length) {
    return rejected(state, 'Participant identifiers must be unique.');
  }
  if (event.participants.filter((p) => p.providerType === 'human').length !== 1) {
    return rejected(state, 'A debate requires exactly one human participant.');
  }
  if (event.participants.filter((p) => p.providerType !== 'human').length < 2) {
    return rejected(state, 'A debate requires at least two provider participants.');
  }

  const { maximumRounds } = event.configuration;
  if (!Number.isInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > MAX_SUPPORTED_ROUNDS) {
    return rejected(state, `maximumRounds must be an integer between 1 and ${MAX_SUPPORTED_ROUNDS}.`);
  }

  return {
    outcome: 'applied',
    state: {
      id: event.sessionId,
      topic,
      constraints,
      participants: event.participants,
      configuration: event.configuration,
      currentRound: 1,
      phase: phaseForRound(1),
      status: { kind: 'idle' },
      contributions: [],
      interventions: [],
      operations: [],
      createdAt: event.at,
      updatedAt: event.at,
    },
  };
}

function onContributionRequested(state: DebateSession, event: ContributionRequested): EvolveResult {
  const { operation } = event;
  if (findOperation(state, operation.id) !== undefined) {
    return ignored(state, `Operation ${operation.id} has already been requested.`);
  }
  if (state.status.kind !== 'running') {
    return rejected(state, `Cannot request contributions while the debate is ${state.status.kind}.`);
  }
  if (operation.round !== state.currentRound) {
    return rejected(state, `Contributions can only be requested for the current round (${state.currentRound}).`);
  }
  const participant = findParticipant(state, operation.participantId);
  if (participant === undefined || participant.providerType === 'human') {
    return rejected(state, `${operation.participantId} is not a provider participant.`);
  }
  if (activeOperation(state, operation.round, operation.participantId) !== undefined) {
    return rejected(
      state,
      `${operation.participantId} already has an active operation in round ${operation.round}.`,
    );
  }
  const expectedAttempt = operationsFor(state, operation.round, operation.participantId).length + 1;
  const expectedId = operationIdFor(state.id, operation.round, operation.participantId, expectedAttempt);
  if (operation.attempt !== expectedAttempt || operation.id !== expectedId) {
    return rejected(state, `Expected operation ${expectedId} (attempt ${expectedAttempt}).`);
  }

  const pending: ProviderOperation = {
    id: operation.id,
    round: operation.round,
    phase: state.phase,
    participantId: operation.participantId,
    attempt: operation.attempt,
    requestedAt: event.at,
    status: 'pending',
  };
  return applied(state, event.at, { operations: [...state.operations, pending] });
}

function onContributionDispatched(state: DebateSession, event: ContributionDispatched): EvolveResult {
  const operation = findOperation(state, event.operationId);
  if (operation === undefined) {
    return rejected(state, `Unknown operation ${event.operationId}.`);
  }
  if (operation.status !== 'pending') {
    return ignored(state, `Operation ${operation.id} has already been dispatched.`);
  }
  if (state.status.kind !== 'running') {
    return rejected(state, `Cannot dispatch provider work while the debate is ${state.status.kind}.`);
  }
  const unknownIntervention = event.interventionIds.find(
    (id) => !state.interventions.some((intervention) => intervention.id === id),
  );
  if (unknownIntervention !== undefined) {
    return rejected(state, `Unknown intervention ${unknownIntervention}.`);
  }

  const dispatched: ProviderOperation = {
    ...operation,
    status: 'dispatched',
    dispatchedAt: event.at,
    interventionIds: event.interventionIds,
  };
  const interventions = state.interventions.map((intervention): HumanIntervention =>
    event.interventionIds.includes(intervention.id)
      ? {
          ...intervention,
          applicationStatus: 'applied',
          appliedToOperationIds: [...intervention.appliedToOperationIds, operation.id],
        }
      : intervention,
  );
  return applied(state, event.at, {
    operations: replaceOperation(state, dispatched),
    interventions,
  });
}

function onContributionReceived(state: DebateSession, event: ContributionReceived): EvolveResult {
  const operation = findOperation(state, event.operationId);
  if (operation === undefined) {
    return rejected(state, `Unknown operation ${event.operationId}.`);
  }
  switch (operation.status) {
    case 'pending':
      return rejected(state, `Operation ${operation.id} was never dispatched.`);
    case 'acknowledged':
      return ignored(state, `A result for operation ${operation.id} has already been recorded.`);
    case 'failed':
      return ignored(state, `Operation ${operation.id} has already failed; the late result is discarded.`);
    case 'superseded':
      return ignored(state, `Operation ${operation.id} was superseded; the late result is discarded.`);
    case 'dispatched':
    case 'uncertain': {
      if (state.contributions.some((c) => c.id === event.contributionId)) {
        return rejected(state, `Contribution ${event.contributionId} already exists.`);
      }
      const contribution: Contribution = {
        id: event.contributionId,
        round: operation.round,
        phase: operation.phase,
        participantId: operation.participantId,
        operationId: operation.id,
        content: event.content,
        assessment: event.assessment,
        origin: event.origin,
        timestamp: event.at,
      };
      const acknowledged: ProviderOperation = {
        id: operation.id,
        round: operation.round,
        phase: operation.phase,
        participantId: operation.participantId,
        attempt: operation.attempt,
        requestedAt: operation.requestedAt,
        dispatchedAt: operation.dispatchedAt,
        interventionIds: operation.interventionIds,
        status: 'acknowledged',
        settledAt: event.at,
        contributionId: event.contributionId,
      };
      return applied(state, event.at, {
        operations: replaceOperation(state, acknowledged),
        contributions: [...state.contributions, contribution],
      });
    }
  }
}

function onContributionFailed(state: DebateSession, event: ContributionFailed): EvolveResult {
  const operation = findOperation(state, event.operationId);
  if (operation === undefined) {
    return rejected(state, `Unknown operation ${event.operationId}.`);
  }
  switch (operation.status) {
    case 'pending':
      return rejected(state, `Operation ${operation.id} was never dispatched.`);
    case 'failed':
      return ignored(state, `Operation ${operation.id} has already failed.`);
    case 'acknowledged':
      return ignored(state, `Operation ${operation.id} has already succeeded; the failure report is discarded.`);
    case 'superseded':
      return ignored(state, `Operation ${operation.id} was superseded; the failure report is discarded.`);
    case 'dispatched':
    case 'uncertain': {
      const failed: ProviderOperation = {
        id: operation.id,
        round: operation.round,
        phase: operation.phase,
        participantId: operation.participantId,
        attempt: operation.attempt,
        requestedAt: operation.requestedAt,
        dispatchedAt: operation.dispatchedAt,
        interventionIds: operation.interventionIds,
        status: 'failed',
        settledAt: event.at,
        error: event.error,
      };
      // The first failure determines the session failure; later ones are only recorded.
      const status: DebateStatus =
        state.status.kind === 'failed'
          ? state.status
          : {
              kind: 'failed',
              operationId: operation.id,
              participantId: operation.participantId,
              error: event.error,
            };
      return applied(state, event.at, { operations: replaceOperation(state, failed), status });
    }
  }
}

function onRoundAdvanced(state: DebateSession, event: RoundAdvanced): EvolveResult {
  if (event.toRound === state.currentRound && state.status.kind === 'running') {
    return ignored(state, `Round ${event.toRound} is already the current round.`);
  }
  if (state.status.kind !== 'running') {
    return rejected(state, `Cannot advance rounds while the debate is ${state.status.kind}.`);
  }
  if (event.toRound !== state.currentRound + 1) {
    return rejected(state, `Rounds advance one at a time; expected round ${state.currentRound + 1}.`);
  }
  if (event.toRound > state.configuration.maximumRounds) {
    return rejected(state, `The debate is limited to ${state.configuration.maximumRounds} rounds.`);
  }
  if (!isCurrentRoundComplete(state)) {
    return rejected(state, `Round ${state.currentRound} still awaits contributions.`);
  }
  if (evaluateStopping(state).kind !== 'continue') {
    return rejected(state, 'The stopping policy requires the debate to complete instead of advancing.');
  }
  return applied(state, event.at, { currentRound: event.toRound, phase: phaseForRound(event.toRound) });
}

function onDebateCompleted(state: DebateSession, event: DebateCompleted): EvolveResult {
  if (state.status.kind === 'completed') {
    return ignored(state, 'The debate has already completed.');
  }
  if (state.status.kind !== 'running') {
    return rejected(state, `Cannot complete a debate that is ${state.status.kind}.`);
  }
  if (event.finalRound !== state.currentRound) {
    return rejected(state, `The final round must be the current round (${state.currentRound}).`);
  }
  if (!isCurrentRoundComplete(state)) {
    return rejected(state, `Round ${state.currentRound} still awaits contributions.`);
  }
  const decision = evaluateStopping(state);
  if (decision.kind !== 'complete' || decision.reason !== event.reason) {
    return rejected(state, `The stopping policy does not support completion with reason "${event.reason}".`);
  }
  return applied(state, event.at, {
    status: { kind: 'completed', reason: event.reason, finalRound: event.finalRound },
  });
}

function onRuntimeRecovered(state: DebateSession, event: RuntimeRecovered): EvolveResult {
  const operations = state.operations.map((operation): ProviderOperation =>
    operation.status === 'dispatched'
      ? { ...operation, status: 'uncertain', detectedAt: event.at }
      : operation,
  );
  const status: DebateStatus =
    state.status.kind === 'running' || state.status.kind === 'pausing'
      ? { kind: 'paused', reason: 'runtime-restart' }
      : state.status;
  return applied(state, event.at, { operations, status });
}

function onUncertainOperationReissued(
  state: DebateSession,
  event: UncertainOperationReissued,
): EvolveResult {
  const operation = findOperation(state, event.operationId);
  if (operation === undefined) {
    return rejected(state, `Unknown operation ${event.operationId}.`);
  }
  if (operation.status === 'superseded') {
    return ignored(state, `Operation ${operation.id} has already been superseded.`);
  }
  if (operation.status !== 'uncertain') {
    return rejected(state, `Only uncertain operations can be re-issued; ${operation.id} is ${operation.status}.`);
  }
  if (state.status.kind !== 'paused') {
    return rejected(state, 'Uncertain operations can only be re-issued while the debate is paused.');
  }
  const superseded: ProviderOperation = {
    id: operation.id,
    round: operation.round,
    phase: operation.phase,
    participantId: operation.participantId,
    attempt: operation.attempt,
    requestedAt: operation.requestedAt,
    dispatchedAt: operation.dispatchedAt,
    interventionIds: operation.interventionIds,
    status: 'superseded',
    supersededAt: event.at,
  };
  return applied(state, event.at, { operations: replaceOperation(state, superseded) });
}

function onHumanConstraintAdded(state: DebateSession, event: HumanConstraintAdded): EvolveResult {
  if (state.interventions.some((intervention) => intervention.id === event.interventionId)) {
    return ignored(state, `Intervention ${event.interventionId} has already been recorded.`);
  }
  if (!state.configuration.allowHumanIntervention) {
    return rejected(state, 'Human intervention is disabled for this debate.');
  }
  if (state.status.kind !== 'paused') {
    return rejected(state, 'Constraints can only be added while the debate is paused.');
  }
  if (!canDispatchFurtherRequests(state)) {
    return rejected(
      state,
      'Every round has finished, so a new constraint could not reach any participant. Resume to complete the debate.',
    );
  }
  const content = event.content.trim();
  if (content.length === 0) {
    return rejected(state, 'The constraint must not be empty.');
  }
  if (content.length > MAX_CONSTRAINT_LENGTH) {
    return rejected(state, `The constraint must not exceed ${MAX_CONSTRAINT_LENGTH} characters.`);
  }
  const intervention: HumanIntervention = {
    id: event.interventionId,
    content,
    timestamp: event.at,
    addedDuringRound: state.currentRound,
    applicationStatus: 'pending',
    appliedToOperationIds: [],
  };
  return applied(state, event.at, { interventions: [...state.interventions, intervention] });
}

function replaceOperation(state: DebateSession, updated: ProviderOperation): readonly ProviderOperation[] {
  return state.operations.map((operation) => (operation.id === updated.id ? updated : operation));
}

type SessionChanges = Partial<
  Pick<
    DebateSession,
    'status' | 'currentRound' | 'phase' | 'contributions' | 'interventions' | 'operations'
  >
>;

function applied(state: DebateSession, at: Timestamp, changes: SessionChanges): EvolveResult {
  return { outcome: 'applied', state: { ...state, ...changes, updatedAt: at } };
}

function ignored(state: EngineState, reason: string): EvolveResult {
  return { outcome: 'ignored', state, reason };
}

function rejected(state: EngineState, reason: string): EvolveResult {
  return { outcome: 'rejected', state, reason };
}
