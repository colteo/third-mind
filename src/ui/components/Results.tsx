import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { buildConversationalSummary, buildDebateReport, type DebateReport } from '../../application';
import { PHASE_TITLES, type DebateSession } from '../../domain';

export type ResultView = 'report' | 'summary';

export const RESULT_VIEWS: readonly { readonly id: ResultView; readonly label: string }[] = [
  { id: 'report', label: 'Structured report' },
  { id: 'summary', label: 'Conversational summary' },
];

/** Results are shown once the debate has ended; a failed debate gets a report of what was recorded. */
export function hasResults(session: DebateSession): boolean {
  return session.status.kind === 'completed' || session.status.kind === 'failed';
}

/** Tab keyboard navigation (WAI-ARIA tabs pattern). Returns null for keys that do not navigate. */
export function nextResultView(current: ResultView, key: string): ResultView | null {
  const index = RESULT_VIEWS.findIndex((v) => v.id === current);
  let nextIndex: number;
  switch (key) {
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = RESULT_VIEWS.length - 1;
      break;
    case 'ArrowRight':
    case 'ArrowLeft':
      nextIndex = (index + (key === 'ArrowRight' ? 1 : -1) + RESULT_VIEWS.length) % RESULT_VIEWS.length;
      break;
    default:
      return null;
  }
  return RESULT_VIEWS[nextIndex]?.id ?? null;
}

export function ResultsPending() {
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Results</h2>
      <p className="muted">
        The structured report and the conversational summary become available here when the debate completes or
        stops.
      </p>
    </section>
  );
}

/** Stateful results card: remembers the selected view for as long as the session is shown. */
export function Results({ session }: { readonly session: DebateSession }) {
  const [view, setView] = useState<ResultView>('report');
  return <ResultsView session={session} view={view} onViewChange={setView} />;
}

interface ResultsViewProps {
  readonly session: DebateSession;
  readonly view: ResultView;
  readonly onViewChange: (view: ResultView) => void;
}

/** Both views are rendered from one report of the same session; only the selected one is visible. */
export function ResultsView({ session, view, onViewChange }: ResultsViewProps) {
  const id = useId();
  const tabRefs = useRef<Partial<Record<ResultView, HTMLButtonElement | null>>>({});
  const report = useMemo(() => buildDebateReport(session), [session]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextResultView(view, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    onViewChange(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Results</h2>
      <div className="tabs" role="tablist" aria-label="Result view">
        {RESULT_VIEWS.map((option) => (
          <button
            key={option.id}
            ref={(element) => {
              tabRefs.current[option.id] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${option.id}`}
            aria-selected={view === option.id}
            aria-controls={`${id}-panel-${option.id}`}
            tabIndex={view === option.id ? 0 : -1}
            className="tab"
            onClick={() => {
              onViewChange(option.id);
            }}
            onKeyDown={handleKeyDown}
          >
            {option.label}
          </button>
        ))}
      </div>
      {RESULT_VIEWS.map((option) => (
        <div
          key={option.id}
          role="tabpanel"
          id={`${id}-panel-${option.id}`}
          aria-labelledby={`${id}-tab-${option.id}`}
          hidden={view !== option.id}
          tabIndex={0}
          className="tabpanel"
        >
          {option.id === 'report' ? <StructuredReport report={report} /> : <ConversationalSummary report={report} />}
        </div>
      ))}
    </section>
  );
}

function SimulationNotice({ report }: { readonly report: DebateReport }) {
  if (report.origin !== 'simulated' && report.origin !== 'mixed') {
    return null;
  }
  return (
    <p className="notice notice-info">
      Simulated content. These results are scripted test data. They were not produced by GPT or Claude.
    </p>
  );
}

function StructuredReport({ report }: { readonly report: DebateReport }) {
  return (
    <div className="report">
      <SimulationNotice report={report} />

      <h3>Outcome</h3>
      <p>{report.outcome}</p>

      <h3>Final positions</h3>
      {report.positions.length === 0 ? (
        <p className="muted">No contributions were recorded.</p>
      ) : (
        <dl className="positions">
          {report.positions.map((position) => (
            <div key={position.participantId}>
              <dt>
                {position.displayName}{' '}
                <span className="muted">
                  (round {position.round}, {PHASE_TITLES[position.phase]})
                </span>
              </dt>
              <dd>{position.position}</dd>
            </div>
          ))}
        </dl>
      )}

      <h3>Shared agreements</h3>
      <StatementList items={report.sharedAgreements} empty="No agreement was stated by every participant." />

      <h3>Disagreements</h3>
      <AttributedList
        items={report.disagreements}
        empty="No participant reported a remaining material issue."
      />

      <h3>Unresolved questions</h3>
      <AttributedList items={report.unresolvedQuestions} empty="No open questions were reported." />

      {report.constraints.length > 0 && (
        <>
          <h3>Initial constraints</h3>
          <StatementList items={report.constraints} empty="" />
        </>
      )}

      {report.interventions.length > 0 && (
        <>
          <h3>Human interventions</h3>
          <ul>
            {report.interventions.map((intervention, index) => (
              <li key={index}>
                {intervention.content}{' '}
                <span className="muted">
                  (added during round {intervention.addedDuringRound};{' '}
                  {intervention.applicationStatus === 'applied'
                    ? `included in ${intervention.appliedToRequestCount} request${intervention.appliedToRequestCount === 1 ? '' : 's'}`
                    : 'never sent to a participant'}
                  )
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Rounds</h3>
      <table className="rounds-table">
        <thead>
          <tr>
            <th scope="col">Round</th>
            <th scope="col">Phase</th>
            <th scope="col">Contributions</th>
            <th scope="col">Material issues</th>
          </tr>
        </thead>
        <tbody>
          {report.rounds.map((round) => (
            <tr key={round.round}>
              <td>{round.round}</td>
              <td>{round.title}</td>
              <td>{round.contributionCount}</td>
              <td>{round.materialIssueCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConversationalSummary({ report }: { readonly report: DebateReport }) {
  const paragraphs = buildConversationalSummary(report);
  return (
    <div className="summary">
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

function StatementList({ items, empty }: { readonly items: readonly string[]; readonly empty: string }) {
  if (items.length === 0) {
    return <p className="muted">{empty}</p>;
  }
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function AttributedList({
  items,
  empty,
}: {
  readonly items: readonly { readonly raisedBy: string; readonly text: string }[];
  readonly empty: string;
}) {
  if (items.length === 0) {
    return <p className="muted">{empty}</p>;
  }
  return (
    <ul>
      {items.map((item) => (
        <li key={`${item.raisedBy}:${item.text}`}>
          <strong>{item.raisedBy}:</strong> {item.text}
        </li>
      ))}
    </ul>
  );
}
