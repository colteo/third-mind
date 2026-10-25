import { useId, useState, type FormEvent } from 'react';
import type { ExecutionMode } from '../../application';
import {
  MAX_CONSTRAINT_LENGTH,
  PHASE_TITLES,
  availableActions,
  canDispatchFurtherRequests,
  findParticipant,
  uncertainOperations,
  type DebateSession,
  type OperationId,
} from '../../domain';
import { simulationPace, type SimulationPaceId } from '../../infrastructure/simulator/scenarios';
import { statusLabel, uncertaintyReason } from '../format';

interface DebateControlsProps {
  readonly session: DebateSession;
  readonly mode: ExecutionMode;
  readonly pace: SimulationPaceId | null;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onAddConstraint: (content: string) => void;
  readonly onReissue: (operationId: OperationId) => void;
  readonly onReset: () => void;
}

export function DebateControls(props: DebateControlsProps) {
  const { session, mode, pace } = props;
  const id = useId();
  const actions = availableActions(session);
  const uncertain = uncertainOperations(session);
  const { status } = session;
  const ended = status.kind === 'completed' || status.kind === 'failed';

  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Controls</h2>

      <p className="control-status">
        <span className={`status status-${status.kind}`}>{statusLabel(status, 'connected')}</span>
        <span className="muted">
          Round {session.currentRound} of {session.configuration.maximumRounds}
          {mode === 'live'
            ? ' · live responses from the linked conversations'
            : pace !== null && ` · simulated responses, ${simulationPace(pace).label.toLowerCase()} pace`}
        </span>
      </p>

      {status.kind === 'running' && (
        <p className="hint">Pause stops new requests. Responses already in flight are still recorded.</p>
      )}
      {status.kind === 'pausing' && (
        <p className="hint">
          Pausing. No new requests are sent; waiting for in-flight {mode !== 'simulation' ? '' : 'simulated '}responses to
          arrive.
        </p>
      )}
      {status.kind === 'paused' && status.reason === 'runtime-restart' && (
        <p className="hint">
          The background service restarted and the debate was restored from its checkpoint. It stays paused until you
          resume it.
        </p>
      )}
      {status.kind === 'paused' && status.reason === 'uncertain-outcome' && (
        <p className="hint">
          The debate paused because a participant could not confirm whether a request was acted on. Review the request
          below; nothing is sent again without your approval.
        </p>
      )}
      {mode === 'live' && status.kind === 'paused' && (
        <p className="hint">
          Before a live debate resumes or a request is sent again, ThirdMind checks that both participants are still
          bound to the same conversation (or, before its first message, the same new chat), that no first message is
          waiting to be matched to a conversation, and that every live capability is still available.
        </p>
      )}
      {status.kind === 'paused' && actions.addConstraint && (
        <p className="hint">You can add constraints now. They are included in every request sent after you resume.</p>
      )}
      {status.kind === 'paused' && !canDispatchFurtherRequests(session) && (
        <p className="hint">
          The final round has already finished, so a new constraint could not reach any participant. Resume to see the
          results.
        </p>
      )}

      {uncertain.length > 0 && (
        <div className="uncertain" role="group" aria-labelledby={`${id}-uncertain`}>
          <h3 id={`${id}-uncertain`}>Requests with unknown outcome</h3>
          <p className="hint">
            ThirdMind cannot tell whether the participant received these requests, so it does not resend them
            automatically. Requesting again may produce a duplicate message for a real provider.
          </p>
          <ul className="uncertain-list">
            {uncertain.map((operation) => (
              <li key={operation.id}>
                <span>
                  {findParticipant(session, operation.participantId)?.displayName ?? operation.participantId}, round{' '}
                  {operation.round} ({PHASE_TITLES[operation.phase]}): {uncertaintyReason(operation)}
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    props.onReissue(operation.id);
                  }}
                >
                  Request again
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="button-row">
        {actions.pause && (
          <button type="button" className="button" onClick={props.onPause}>
            Pause
          </button>
        )}
        {actions.resume && (
          <button type="button" className="button button-primary" onClick={props.onResume}>
            Resume
          </button>
        )}
        <ResetControl ended={ended} onReset={props.onReset} />
      </div>

      {actions.addConstraint && <ConstraintForm onAdd={props.onAddConstraint} />}
    </section>
  );
}

function ConstraintForm({ onAdd }: { readonly onAdd: (content: string) => void }) {
  const id = useId();
  const [content, setContent] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return;
    }
    onAdd(trimmed);
    setContent('');
  };

  return (
    <form className="form constraint-form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor={`${id}-constraint`}>Add a constraint</label>
        <textarea
          id={`${id}-constraint`}
          rows={2}
          maxLength={MAX_CONSTRAINT_LENGTH}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
          }}
          placeholder="The budget must not exceed the current quarter's allocation"
        />
      </div>
      <button type="submit" className="button" disabled={content.trim().length === 0}>
        Add constraint
      </button>
    </form>
  );
}

/**
 * Reset discards the session and returns to setup. Once the debate has ended
 * this is how a new debate is started, so the control is labelled and styled
 * for that; during a debate it stays a quiet, confirmed action.
 */
function ResetControl({ ended, onReset }: { readonly ended: boolean; readonly onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className={ended ? 'button button-primary' : 'button button-quiet'}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {ended ? 'Start a new debate' : 'Reset session'}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label="Confirm reset">
      <span>{ended ? 'Discard these results and start over?' : 'Stop and discard this debate?'}</span>
      <button
        type="button"
        className="button button-danger"
        onClick={() => {
          setConfirming(false);
          onReset();
        }}
      >
        Discard
      </button>
      <button
        type="button"
        className="button button-quiet"
        autoFocus
        onClick={() => {
          setConfirming(false);
        }}
      >
        Cancel
      </button>
    </span>
  );
}
