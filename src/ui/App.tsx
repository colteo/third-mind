import { useEffect, useState } from 'react';
import type { ConnectionsView, ExecutionMode, LinkRevisions } from '../application';
import { ConversationConnections } from './components/ConversationConnections';
import { DebateControls } from './components/DebateControls';
import { Header } from './components/Header';
import { LiveDebateSetup } from './components/LiveDebateSetup';
import { ModeSelector } from './components/ModeSelector';
import { ParticipantList } from './components/ParticipantList';
import { PhaseProgress } from './components/PhaseProgress';
import { Results, ResultsPending, hasResults } from './components/Results';
import { SetupForm } from './components/SetupForm';
import { Timeline } from './components/Timeline';
import { useDebateHost } from './use-debate-host';

function linkRevisions(view: ConnectionsView | null): LinkRevisions | null {
  const chatgpt = view?.providers.find((provider) => provider.provider === 'chatgpt');
  const claude = view?.providers.find((provider) => provider.provider === 'claude');
  return chatgpt === undefined || claude === undefined ? null : { chatgpt: chatgpt.revision, claude: claude.revision };
}

export function App() {
  const host = useDebateHost();
  const { snapshot, send, checkLiveReadiness } = host;
  const session = snapshot?.session ?? null;
  const [selectedMode, setSelectedMode] = useState<ExecutionMode>('simulation');
  const mode: ExecutionMode = session !== null ? (snapshot?.mode ?? 'simulation') : selectedMode;
  const revisions = linkRevisions(host.connections);
  const revisionKey = revisions === null ? null : `${revisions.chatgpt}:${revisions.claude}`;
  const choosingLive = snapshot !== null && session === null && selectedMode === 'live';

  // Re-run the preflight whenever live setup is shown, a link changes, or the panel reconnects.
  useEffect(() => {
    if (choosingLive && host.connection === 'connected' && revisionKey !== null) {
      checkLiveReadiness();
    }
  }, [choosingLive, host.connection, revisionKey, checkLiveReadiness]);

  return (
    <div className="app">
      <Header status={session?.status ?? null} connection={host.connection} mode={mode} />
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
            <ModeSelector mode={selectedMode} onChange={setSelectedMode} />
            {selectedMode === 'simulation' ? (
              <SetupForm
                onStart={(values) => {
                  send({ type: 'start', ...values });
                }}
              />
            ) : (
              <LiveDebateSetup
                readiness={host.liveReadiness}
                currentRevisions={revisions}
                onCheck={checkLiveReadiness}
                onStart={(values) => {
                  send({ type: 'start-live', ...values });
                }}
              />
            )}
            <ParticipantList
              participants={selectedMode === 'simulation' ? snapshot.participants : snapshot.liveParticipants}
            />
          </>
        )}

        {session !== null && (
          // Keyed by session: a new session never inherits local UI state (open forms, selected view).
          <div className="session" key={session.id}>
            <DebateControls
              session={session}
              mode={mode}
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

        {/* Links are tracked independently of the debate. Only a live session uses them, through the preflight. */}
        <ConversationConnections view={host.connections} pageChecks={host.pageChecks} onCommand={send} />
      </main>
      <footer className="footer muted">
        Preview. Simulated debates use local simulators. Live mode checks the linked conversations or new chats and the
        installed provider adapters; the ChatGPT and Claude websites have no authorized automation route, so ThirdMind does not
        read or send messages there and a live debate cannot start yet.
      </footer>
    </div>
  );
}
