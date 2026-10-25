import type { DebateCommand } from './commands';
import {
  activeOperation,
  dispatchedOperations,
  isCurrentRoundComplete,
  operationIdFor,
  operationsFor,
  providerParticipants,
} from './queries';
import { buildContributionRequest } from './requests';
import { evaluateStopping } from './stopping';
import type { EngineState } from './types';

/**
 * Pure decision function: given the current state, which commands should the
 * shell execute next? Returns an empty list when the engine is waiting (for
 * provider results, for the human, or because the session is terminal).
 *
 * Within a round, every provider participant is requested concurrently. A new
 * round is only started once every provider contribution of the current
 * round has been acknowledged.
 */
export function decide(state: EngineState): readonly DebateCommand[] {
  if (state === null) {
    return [];
  }

  switch (state.status.kind) {
    case 'idle':
    case 'paused':
    case 'completed':
    case 'failed':
      return [];
    case 'pausing':
      // No new work while pausing; confirm once in-flight work has settled.
      return dispatchedOperations(state).length === 0 ? [{ type: 'ConfirmPause' }] : [];
    case 'running':
      break;
  }

  const round = state.currentRound;
  const work: DebateCommand[] = [];
  for (const participant of providerParticipants(state)) {
    const operation = activeOperation(state, round, participant.id);
    if (operation === undefined) {
      const attempt = operationsFor(state, round, participant.id).length + 1;
      work.push({
        type: 'RequestContribution',
        operation: {
          id: operationIdFor(state.id, round, participant.id, attempt),
          round,
          participantId: participant.id,
          attempt,
        },
      });
    } else if (operation.status === 'pending') {
      work.push({
        type: 'DispatchContribution',
        operationId: operation.id,
        request: buildContributionRequest(state, operation),
      });
    }
  }
  if (work.length > 0) {
    return work;
  }

  if (!isCurrentRoundComplete(state)) {
    return []; // Waiting for dispatched operations.
  }

  const stopping = evaluateStopping(state);
  return stopping.kind === 'complete'
    ? [{ type: 'CompleteDebate', reason: stopping.reason, finalRound: round }]
    : [{ type: 'AdvanceRound', toRound: round + 1 }];
}
