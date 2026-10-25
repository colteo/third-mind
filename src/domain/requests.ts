import { PHASE_TITLES } from './constants';
import { findParticipant } from './queries';
import type {
  ConvergenceAssessment,
  DebatePhase,
  DebateSession,
  InterventionId,
  OperationId,
  ParticipantId,
  ProviderOperation,
  SessionId,
} from './types';

export type RequestConstraint =
  | { readonly source: 'session'; readonly text: string }
  | { readonly source: 'human-intervention'; readonly interventionId: InterventionId; readonly text: string };

export interface PriorContribution {
  readonly participantId: ParticipantId;
  readonly displayName: string;
  readonly round: number;
  readonly phase: DebatePhase;
  readonly content: string;
  readonly assessment: ConvergenceAssessment;
}

/**
 * Everything a provider needs to produce one contribution. Contains both
 * structured fields (for adapters that want them) and a rendered prompt (for
 * adapters that send plain text).
 */
export interface ContributionRequest {
  readonly operationId: OperationId;
  readonly sessionId: SessionId;
  readonly participantId: ParticipantId;
  readonly round: number;
  readonly maximumRounds: number;
  readonly phase: DebatePhase;
  readonly topic: string;
  readonly constraints: readonly RequestConstraint[];
  readonly priorContributions: readonly PriorContribution[];
  readonly instructions: string;
  readonly prompt: string;
}

const PHASE_INSTRUCTIONS: Readonly<Record<DebatePhase, string>> = {
  'independent-analysis':
    'Analyse the topic independently. You have not seen any other participant\'s view; do not speculate about one.',
  'cross-examination':
    'Critically examine the other participants\' independent analyses. Identify unsupported claims, flawed reasoning and material issues.',
  refinement:
    'Revise your position in light of the cross-examination. State explicitly which criticisms you accept and which you reject, and why.',
  convergence:
    'Produce your final position. State what the participants agree on, and make every remaining disagreement and unresolved question explicit.',
};

const ASSESSMENT_INSTRUCTIONS =
  'End with a structured assessment that lists: material issues that remain unresolved, open questions, and points of agreement.';

/**
 * Builds the request for a pending operation from the current session state.
 *
 * Called at dispatch time, not at registration time, so that human constraints
 * added while the debate was paused are included in every request dispatched
 * afterwards.
 *
 * Round 1 requests never include other participants' contributions, which
 * keeps the independent analyses independent.
 */
export function buildContributionRequest(
  session: DebateSession,
  operation: ProviderOperation,
): ContributionRequest {
  const participant = findParticipant(session, operation.participantId);
  const displayName = participant?.displayName ?? operation.participantId;

  const constraints: RequestConstraint[] = [
    ...session.constraints.map((text): RequestConstraint => ({ source: 'session', text })),
    ...session.interventions.map(
      (intervention): RequestConstraint => ({
        source: 'human-intervention',
        interventionId: intervention.id,
        text: intervention.content,
      }),
    ),
  ];

  const priorContributions: PriorContribution[] = session.contributions
    .filter((contribution) => contribution.round < operation.round)
    .map((contribution) => ({
      participantId: contribution.participantId,
      displayName: findParticipant(session, contribution.participantId)?.displayName ?? contribution.participantId,
      round: contribution.round,
      phase: contribution.phase,
      content: contribution.content,
      assessment: contribution.assessment,
    }));

  const instructions = `${PHASE_INSTRUCTIONS[operation.phase]} ${ASSESSMENT_INSTRUCTIONS}`;

  return {
    operationId: operation.id,
    sessionId: session.id,
    participantId: operation.participantId,
    round: operation.round,
    maximumRounds: session.configuration.maximumRounds,
    phase: operation.phase,
    topic: session.topic,
    constraints,
    priorContributions,
    instructions,
    prompt: renderPrompt({
      displayName,
      round: operation.round,
      maximumRounds: session.configuration.maximumRounds,
      phase: operation.phase,
      topic: session.topic,
      constraints,
      priorContributions,
      instructions,
    }),
  };
}

/** Human-intervention constraint identifiers carried by a request. */
export function interventionIdsOf(request: ContributionRequest): readonly InterventionId[] {
  return request.constraints.flatMap((constraint) =>
    constraint.source === 'human-intervention' ? [constraint.interventionId] : [],
  );
}

interface PromptParts {
  readonly displayName: string;
  readonly round: number;
  readonly maximumRounds: number;
  readonly phase: DebatePhase;
  readonly topic: string;
  readonly constraints: readonly RequestConstraint[];
  readonly priorContributions: readonly PriorContribution[];
  readonly instructions: string;
}

function renderPrompt(parts: PromptParts): string {
  const sessionConstraints = parts.constraints.filter((c) => c.source === 'session');
  const humanConstraints = parts.constraints.filter((c) => c.source === 'human-intervention');

  const lines: string[] = [
    `You are participating in a structured ThirdMind debate as ${parts.displayName}.`,
    `Round ${parts.round} of ${parts.maximumRounds}: ${PHASE_TITLES[parts.phase]}.`,
    '',
    `Topic: ${parts.topic}`,
  ];

  if (sessionConstraints.length > 0) {
    lines.push('', 'Constraints (must be respected):', ...sessionConstraints.map((c) => `- ${c.text}`));
  }
  if (humanConstraints.length > 0) {
    lines.push(
      '',
      'Constraints added by the human during the debate (must be respected):',
      ...humanConstraints.map((c) => `- ${c.text}`),
    );
  }
  for (const prior of parts.priorContributions) {
    lines.push('', `--- ${prior.displayName}, round ${prior.round} (${PHASE_TITLES[prior.phase]}) ---`, prior.content);
  }
  lines.push('', `Instructions: ${parts.instructions}`);
  return lines.join('\n');
}
