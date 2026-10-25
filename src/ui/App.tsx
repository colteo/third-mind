import { ConversationConnections } from './components/ConversationConnections';
import { DebateControls } from './components/DebateControls';
import { Header } from './components/Header';
import { ParticipantList } from './components/ParticipantList';
import { PhaseProgress } from './components/PhaseProgress';
import { Results, ResultsPending, hasResults } from './components/Results';
import { SetupForm } from './components/SetupForm';
import { Timeline } from './components/Timeline';
import { useDebateHost } from './use-debate-host';

export function App() {
  const host = useDebateHost();
  const { snapshot, send } = host;
  const session = snapshot?.session ?? null;

  return (
    <div className="app">
      <Header status={session?.status ?? null} connection={host.connection} />
      <main className="content">
        {host.notice !== null && (
          <div className="notice notice-error" role="alert">
            <span>{host.notice}</span>
            <button type="button" className="button button-quiet" onClick={host.dismissNotice}>
              Dismiss
            </button>
          </div>
        )}

        {snapshot === null && <p className="muted">Connecting to the ThirdMind background service…</p>}

        {snapshot !== null && session === null && (
          <>
            <SetupForm
              onStart={(values) => {
                send({ type: 'start', ...values });
              }}
            />
            <ParticipantList participants={snapshot.participants} />
          </>
        )}

        {session !== null && (
          // Keyed by session: a new session never inherits local UI state (open forms, selected view).
          <div className="session" key={session.id}>
            <DebateControls
              session={session}
              pace={snapshot?.pace ?? null}
              onPause={() => {
                send({ type: 'pause', sessionId: session.id });
              }}
              onResume={() => {
                send({ type: 'resume', sessionId: session.id });
              }}
              onAddConstraint={(content) => {
                send({ type: 'add-constraint', sessionId: session.id, content });
              }}
              onReissue={(operationId) => {
                send({ type: 'reissue-operation', sessionId: session.id, operationId });
              }}
              onReset={() => {
                send({ type: 'reset', sessionId: session.id });
              }}
            />
            {session.status.kind === 'failed' && (
              <div className="notice notice-error" role="alert">
                The debate stopped because a participant failed: {session.status.error} Use Start a new debate to
                begin again.
              </div>
            )}
            <PhaseProgress session={session} />
            {hasResults(session) ? <Results session={session} /> : <ResultsPending />}
            <Timeline session={session} />
            <ParticipantList participants={session.participants} />
          </div>
        )}

        {/* Independent of the simulated debate above: links are tracked separately and never used by the debate. */}
        <ConversationConnections view={host.connections} pageChecks={host.pageChecks} onCommand={send} />
      </main>
      <footer className="footer muted">
        Preview. Debate responses come from local simulators. Linked conversations are only associated by tab; a page
        check reads only whether the page is ready. ThirdMind does not read or send messages in ChatGPT or Claude.
      </footer>
    </div>
  );
}
