import { EARLIEST_EARLY_STOP_ROUND } from './constants';
import { contributionsInRound, providerParticipants } from './queries';
import type { CompletionReason, DebateSession } from './types';

export type StoppingDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'complete'; readonly reason: CompletionReason };

/**
 * Conservative, deterministic stopping policy. Only meaningful once the
 * current round is complete.
 *
 * The debate completes when:
 * 1. the maximum number of rounds has been reached (always enforced), or
 * 2. the strategy is `adaptive`, the current round is at least
 *    `EARLIEST_EARLY_STOP_ROUND`, every provider participant's contribution in
 *    the current round reports zero material issues, and no human constraint
 *    is still waiting to be applied.
 *
 * The policy does not judge the quality of the reasoning. It only reads the
 * structured assessments the participants attached to their contributions.
 */
export function evaluateStopping(session: DebateSession): StoppingDecision {
  if (session.currentRound >= session.configuration.maximumRounds) {
    return { kind: 'complete', reason: 'maximum-rounds-reached' };
  }
  if (session.configuration.stoppingStrategy !== 'adaptive') {
    return { kind: 'continue' };
  }
  if (session.currentRound < EARLIEST_EARLY_STOP_ROUND) {
    return { kind: 'continue' };
  }
  if (session.interventions.some((intervention) => intervention.applicationStatus === 'pending')) {
    return { kind: 'continue' };
  }
  const roundContributions = contributionsInRound(session, session.currentRound);
  const everyProviderReportsNoIssues = providerParticipants(session).every((participant) => {
    const contribution = roundContributions.find((c) => c.participantId === participant.id);
    return contribution !== undefined && contribution.assessment.materialIssues.length === 0;
  });
  return everyProviderReportsNoIssues
    ? { kind: 'complete', reason: 'early-convergence' }
    : { kind: 'continue' };
}
