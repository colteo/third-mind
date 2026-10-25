import type { DebateConfiguration, DebatePhase, Participant } from './types';

/** The four logical debate stages, in order. Round `n` uses `DEBATE_PHASES[n - 1]`. */
export const DEBATE_PHASES: readonly DebatePhase[] = [
  'independent-analysis',
  'cross-examination',
  'refinement',
  'convergence',
];

export const MAX_SUPPORTED_ROUNDS = DEBATE_PHASES.length;

export const PHASE_TITLES: Readonly<Record<DebatePhase, string>> = {
  'independent-analysis': 'Independent Analysis',
  'cross-examination': 'Cross-Examination',
  refinement: 'Refinement',
  convergence: 'Convergence',
};

/**
 * Early stopping is never considered before this round. Round 1 consists of
 * independent analyses that have not yet been examined by anyone else, so an
 * empty issue list there carries no evidence of convergence.
 */
export const EARLIEST_EARLY_STOP_ROUND = 2;

export const DEFAULT_CONFIGURATION: DebateConfiguration = {
  maximumRounds: 4,
  stoppingStrategy: 'adaptive',
  allowHumanIntervention: true,
};

export const HUMAN_PARTICIPANT: Participant = {
  id: 'human',
  displayName: 'Human',
  providerType: 'human',
};

export const MAX_TOPIC_LENGTH = 2000;
export const MAX_CONSTRAINT_LENGTH = 1000;
export const MAX_CONSTRAINTS = 20;

export function phaseForRound(round: number): DebatePhase {
  const phase = DEBATE_PHASES[round - 1];
  if (phase === undefined) {
    throw new RangeError(`Round ${round} is outside the supported range 1-${MAX_SUPPORTED_ROUNDS}.`);
  }
  return phase;
}
