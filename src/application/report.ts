import {
  PHASE_TITLES,
  findParticipant,
  providerParticipants,
  type Contribution,
  type ContributionOrigin,
  type DebatePhase,
  type DebateSession,
  type DebateStatus,
  type InterventionApplicationStatus,
  type ParticipantId,
} from '../domain';

export interface ParticipantPosition {
  readonly participantId: ParticipantId;
  readonly displayName: string;
  readonly round: number;
  readonly phase: DebatePhase;
  readonly position: string;
  readonly origin: ContributionOrigin;
}

export interface AttributedStatement {
  readonly raisedBy: string;
  readonly text: string;
}

export interface RoundSummary {
  readonly round: number;
  readonly phase: DebatePhase;
  readonly title: string;
  readonly contributionCount: number;
  readonly materialIssueCount: number;
}

export interface InterventionSummary {
  readonly content: string;
  readonly addedDuringRound: number;
  readonly applicationStatus: InterventionApplicationStatus;
  readonly appliedToRequestCount: number;
}

/**
 * Read model derived from a session. Built from the participants' structured
 * assessments only; it does not interpret or score the content.
 */
export interface DebateReport {
  readonly topic: string;
  readonly origin: ContributionOrigin | 'mixed' | 'none';
  readonly status: DebateStatus;
  readonly roundsCompleted: number;
  readonly maximumRounds: number;
  readonly outcome: string;
  readonly constraints: readonly string[];
  readonly interventions: readonly InterventionSummary[];
  readonly positions: readonly ParticipantPosition[];
  /** Agreements stated by every provider participant in their latest contribution. */
  readonly sharedAgreements: readonly string[];
  /** Material issues still reported in each participant's latest contribution. */
  readonly disagreements: readonly AttributedStatement[];
  readonly unresolvedQuestions: readonly AttributedStatement[];
  readonly rounds: readonly RoundSummary[];
}

export function buildDebateReport(session: DebateSession): DebateReport {
  const providers = providerParticipants(session);
  const latest = providers.flatMap((participant) => {
    const contribution = latestContribution(session.contributions, participant.id);
    return contribution === undefined ? [] : [{ participant, contribution }];
  });

  const positions = latest.map(({ participant, contribution }) => ({
    participantId: participant.id,
    displayName: participant.displayName,
    round: contribution.round,
    phase: contribution.phase,
    position: extractPosition(contribution.content),
    origin: contribution.origin,
  }));

  const sharedAgreements =
    latest.length === providers.length && latest.length > 0
      ? unique(latest[0]?.contribution.assessment.agreements ?? []).filter((statement) =>
          latest.every(({ contribution }) => contribution.assessment.agreements.includes(statement)),
        )
      : [];

  const disagreements = latest.flatMap(({ participant, contribution }) =>
    contribution.assessment.materialIssues.map((text) => ({ raisedBy: participant.displayName, text })),
  );
  const unresolvedQuestions = latest.flatMap(({ participant, contribution }) =>
    contribution.assessment.openQuestions.map((text) => ({ raisedBy: participant.displayName, text })),
  );

  const roundNumbers = unique(session.contributions.map((c) => c.round)).sort((a, b) => a - b);
  const rounds = roundNumbers.map((round): RoundSummary => {
    const inRound = session.contributions.filter((c) => c.round === round);
    const phase = inRound[0]?.phase ?? session.phase;
    return {
      round,
      phase,
      title: PHASE_TITLES[phase],
      contributionCount: inRound.length,
      materialIssueCount: inRound.reduce((sum, c) => sum + c.assessment.materialIssues.length, 0),
    };
  });

  const roundsCompleted = roundNumbers.filter((round) =>
    providers.every((p) => session.contributions.some((c) => c.round === round && c.participantId === p.id)),
  ).length;

  return {
    topic: session.topic,
    origin: summarizeOrigin(session.contributions),
    status: session.status,
    roundsCompleted,
    maximumRounds: session.configuration.maximumRounds,
    outcome: describeOutcome(session, disagreements.length),
    constraints: session.constraints,
    interventions: session.interventions.map((intervention) => ({
      content: intervention.content,
      addedDuringRound: intervention.addedDuringRound,
      applicationStatus: intervention.applicationStatus,
      appliedToRequestCount: intervention.appliedToOperationIds.length,
    })),
    positions,
    sharedAgreements,
    disagreements,
    unresolvedQuestions,
    rounds,
  };
}

/** Prose rendering of a report, one string per paragraph. */
export function buildConversationalSummary(report: DebateReport): readonly string[] {
  const names = report.positions.map((p) => p.displayName);
  const paragraphs: string[] = [];

  const roundsText = report.roundsCompleted === 1 ? '1 round' : `${report.roundsCompleted} rounds`;
  paragraphs.push(
    names.length > 0
      ? `${joinNames(names)} debated “${report.topic}” over ${roundsText}. ${report.outcome}`
      : `No contributions have been recorded for “${report.topic}” yet.`,
  );

  if (report.origin === 'simulated' || report.origin === 'mixed') {
    paragraphs.push(
      'Every simulated contribution is scripted test data produced inside ThirdMind. It does not come from GPT or Claude and should not be read as their opinion.',
    );
  }

  for (const position of report.positions) {
    paragraphs.push(`${position.displayName} ended in round ${position.round} with this position: ${position.position}`);
  }

  paragraphs.push(
    report.sharedAgreements.length > 0
      ? `They agree on the following: ${report.sharedAgreements.join(' ')}`
      : 'No point of agreement was stated by every participant.',
  );

  if (report.disagreements.length > 0) {
    paragraphs.push(
      `They have not resolved everything. ${report.disagreements
        .map((d) => `${d.raisedBy} still considers this a material issue: ${d.text}`)
        .join(' ')}`,
    );
  } else {
    paragraphs.push('No participant reported a remaining material issue in their latest contribution.');
  }

  if (report.unresolvedQuestions.length > 0) {
    paragraphs.push(
      `Questions that are still open: ${report.unresolvedQuestions.map((q) => `${q.text} (raised by ${q.raisedBy})`).join(' ')}`,
    );
  }

  if (report.interventions.length > 0) {
    const pending = report.interventions.filter((i) => i.applicationStatus === 'pending').length;
    paragraphs.push(
      `You added ${report.interventions.length === 1 ? 'one constraint' : `${report.interventions.length} constraints`} during the debate.` +
        (pending > 0
          ? ` ${pending === 1 ? 'One was' : `${pending} were`} added after the last request and never reached a participant.`
          : ' Every one of them was included in later requests.'),
    );
  }

  return paragraphs;
}

function describeOutcome(session: DebateSession, remainingIssues: number): string {
  const { status } = session;
  const max = session.configuration.maximumRounds;
  switch (status.kind) {
    case 'completed':
      if (status.reason === 'early-convergence') {
        return `The debate finished early, after round ${status.finalRound} of ${max}, because every participant reported no remaining material issues.`;
      }
      return remainingIssues > 0
        ? `The debate reached the maximum of ${max} rounds with ${remainingIssues === 1 ? 'one material issue' : `${remainingIssues} material issues`} still unresolved.`
        : `The debate reached the maximum of ${max} rounds.`;
    case 'failed': {
      const name = findParticipant(session, status.participantId)?.displayName ?? status.participantId;
      return `The debate stopped in round ${session.currentRound} because ${name} failed: ${status.error}`;
    }
    default:
      return `The debate is still in progress: round ${session.currentRound} of ${max} (${PHASE_TITLES[session.phase]}).`;
  }
}

function latestContribution(
  contributions: readonly Contribution[],
  participantId: ParticipantId,
): Contribution | undefined {
  let latest: Contribution | undefined;
  for (const contribution of contributions) {
    if (contribution.participantId === participantId && (latest === undefined || contribution.round >= latest.round)) {
      latest = contribution;
    }
  }
  return latest;
}

const POSITION_PREFIX = 'Position:';

function extractPosition(content: string): string {
  const lines = content.split('\n').map((line) => line.trim());
  const marked = lines.find((line) => line.startsWith(POSITION_PREFIX));
  if (marked !== undefined) {
    return marked.slice(POSITION_PREFIX.length).trim();
  }
  const first = lines.find((line) => line.length > 0) ?? '';
  return first.length > 280 ? `${first.slice(0, 277)}...` : first;
}

function summarizeOrigin(contributions: readonly Contribution[]): DebateReport['origin'] {
  const origins = unique(contributions.map((c) => c.origin));
  if (origins.length === 0) {
    return 'none';
  }
  return origins.length === 1 && origins[0] !== undefined ? origins[0] : 'mixed';
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join('');
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
