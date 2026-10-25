import { useId } from 'react';
import { DEBATE_PHASES, PHASE_TITLES, isCurrentRoundComplete, type DebateSession } from '../../domain';

type StepState = 'completed' | 'current' | 'upcoming' | 'skipped';

const STEP_STATE_LABELS: Readonly<Record<StepState, string>> = {
  completed: 'completed',
  current: 'in progress',
  upcoming: 'not started',
  skipped: 'skipped after early convergence',
};

function stepState(session: DebateSession, round: number): StepState {
  const { status, currentRound } = session;
  if (status.kind === 'completed') {
    return round <= status.finalRound ? 'completed' : 'skipped';
  }
  if (round < currentRound) {
    return 'completed';
  }
  if (round === currentRound) {
    return isCurrentRoundComplete(session) ? 'completed' : 'current';
  }
  return 'upcoming';
}

export function PhaseProgress({ session }: { readonly session: DebateSession }) {
  const id = useId();
  const rounds = DEBATE_PHASES.slice(0, session.configuration.maximumRounds);
  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Progress</h2>
      <p className="progress-summary">
        Round {session.currentRound} of {session.configuration.maximumRounds}: {PHASE_TITLES[session.phase]}
      </p>
      <ol className="steps">
        {rounds.map((phase, index) => {
          const round = index + 1;
          const state = stepState(session, round);
          return (
            <li key={phase} className={`step step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="step-index" aria-hidden="true">
                {state === 'completed' ? '✓' : round}
              </span>
              <span className="step-title">{PHASE_TITLES[phase]}</span>
              <span className="visually-hidden">: {STEP_STATE_LABELS[state]}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
