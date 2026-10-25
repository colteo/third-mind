import { useId } from 'react';
import {
  PHASE_TITLES,
  activeOperation,
  phaseForRound,
  providerParticipants,
  type Contribution,
  type DebateSession,
  type HumanIntervention,
  type Participant,
} from '../../domain';
import { formatTime, operationLabel } from '../format';

export function Timeline({ session }: { readonly session: DebateSession }) {
  const id = useId();
  const rounds = Array.from({ length: session.currentRound }, (_, index) => index + 1);
  const started = session.status.kind !== 'idle';

  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Debate timeline</h2>
      <p className="topic">
        <span className="muted">Topic: </span>
        {session.topic}
      </p>
      {session.constraints.length > 0 && (
        <div className="constraints">
          <span className="muted">Initial constraints:</span>
          <ul>
            {session.constraints.map((constraint) => (
              <li key={constraint}>{constraint}</li>
            ))}
          </ul>
        </div>
      )}
      {!started && <p className="muted">The debate has not started.</p>}
      {started &&
        rounds.map((round) => <RoundSection key={round} session={session} round={round} />)}
    </section>
  );
}

function RoundSection({ session, round }: { readonly session: DebateSession; readonly round: number }) {
  const id = useId();
  const phase = phaseForRound(round);
  const interventions = session.interventions.filter((i) => i.addedDuringRound === round);
  return (
    <section className="round" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="round-heading">
        Round {round} <span className="muted">· {PHASE_TITLES[phase]}</span>
      </h3>
      <ul className="contributions">
        {providerParticipants(session).map((participant) => (
          <li key={participant.id}>
            <ParticipantEntry session={session} round={round} participant={participant} />
          </li>
        ))}
      </ul>
      {interventions.map((intervention) => (
        <InterventionNote key={intervention.id} intervention={intervention} />
      ))}
    </section>
  );
}

function ParticipantEntry({
  session,
  round,
  participant,
}: {
  readonly session: DebateSession;
  readonly round: number;
  readonly participant: Participant;
}) {
  const operation = activeOperation(session, round, participant.id);
  const contribution =
    operation?.status === 'acknowledged'
      ? session.contributions.find((c) => c.id === operation.contributionId)
      : undefined;
  if (contribution !== undefined) {
    return <ContributionCard contribution={contribution} participant={participant} />;
  }
  const tone = operation?.status === 'failed' ? 'error' : operation?.status === 'uncertain' ? 'warning' : 'neutral';
  return (
    <div className={`waiting waiting-${tone}`}>
      <span className="participant-name">{participant.displayName}</span>
      <span>{operationLabel(operation)}</span>
    </div>
  );
}

function ContributionCard({
  contribution,
  participant,
}: {
  readonly contribution: Contribution;
  readonly participant: Participant;
}) {
  const id = useId();
  const { assessment } = contribution;
  return (
    <article className="contribution" aria-labelledby={`${id}-author`}>
      <header className="contribution-header">
        <h4 id={`${id}-author`} className="participant-name">
          {participant.displayName}
        </h4>
        <span className="badge">{contribution.origin === 'simulated' ? 'Simulated' : 'Live'}</span>
        <time className="muted" dateTime={contribution.timestamp}>
          {formatTime(contribution.timestamp)}
        </time>
      </header>
      <p className="contribution-body">{contribution.content}</p>
      {assessment.materialIssues.length > 0 && (
        <div className="assessment">
          <h5>Material issues raised</h5>
          <ul>
            {assessment.materialIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {assessment.materialIssues.length === 0 && (
        <p className="assessment assessment-clear">No material issues reported.</p>
      )}
    </article>
  );
}

function InterventionNote({ intervention }: { readonly intervention: HumanIntervention }) {
  return (
    <div className="intervention">
      <span className="participant-name">Human constraint</span>
      <span className="badge">
        {intervention.applicationStatus === 'applied' ? 'Applied' : 'Waiting for next request'}
      </span>
      <p>{intervention.content}</p>
      <time className="muted" dateTime={intervention.timestamp}>
        Added {formatTime(intervention.timestamp)}
      </time>
    </div>
  );
}
