import { describe, expect, it } from 'vitest';
import { applyOk, at, received, startedSession, step } from '../test-support/fixtures';
import { evolve } from './evolve';
import { availableActions, decide, type DebateSession } from './index';

/** Round 1 with both operations dispatched. */
function dispatchedRound(): { session: DebateSession; gpt: string; claude: string } {
  let { state } = step(startedSession(), at(2));
  ({ state } = step(state, at(3)));
  const [gpt, claude] = state.operations.map((operation) => operation.id);
  if (gpt === undefined || claude === undefined) throw new Error('Expected two operations');
  return { session: state, gpt, claude };
}

describe('ContributionOutcomeUncertain', () => {
  it('marks the operation uncertain and pauses once nothing else is in flight', () => {
    const { session, gpt, claude } = dispatchedRound();
    let state = applyOk(session, received(claude, at(4), 'contribution-1'));
    state = applyOk(state, { type: 'ContributionOutcomeUncertain', at: at(5), operationId: gpt, detail: 'Timed out.' });
    expect(state.operations.find((operation) => operation.id === gpt)).toMatchObject({
      status: 'uncertain',
      cause: 'unknown-outcome',
      detail: 'Timed out.',
      detectedAt: at(5),
    });
    expect(state.status).toEqual({ kind: 'paused', reason: 'uncertain-outcome' });
    expect(decide(state)).toEqual([]);
    expect(availableActions(state)).toMatchObject({ resume: false, reissueUncertainOperation: true });
  });

  it('keeps pausing while another operation is in flight, then confirms the pause with the uncertainty reason', () => {
    const { session, gpt, claude } = dispatchedRound();
    let state = applyOk(session, { type: 'ContributionOutcomeUncertain', at: at(4), operationId: gpt, detail: 'x' });
    expect(state.status).toEqual({ kind: 'pausing' });
    expect(decide(state)).toEqual([]);
    state = applyOk(state, received(claude, at(5), 'contribution-1'));
    expect(decide(state)).toEqual([{ type: 'ConfirmPause' }]);
    state = applyOk(state, { type: 'DebatePaused', at: at(6) });
    expect(state.status).toEqual({ kind: 'paused', reason: 'uncertain-outcome' });
  });

  it('is idempotent and never overrides a settled operation', () => {
    const { session, gpt, claude } = dispatchedRound();
    const uncertain = applyOk(session, { type: 'ContributionOutcomeUncertain', at: at(4), operationId: gpt, detail: 'x' });
    expect(evolve(uncertain, { type: 'ContributionOutcomeUncertain', at: at(5), operationId: gpt, detail: 'x' }).outcome).toBe(
      'ignored',
    );
    const acknowledged = applyOk(session, received(claude, at(4), 'contribution-1'));
    expect(
      evolve(acknowledged, { type: 'ContributionOutcomeUncertain', at: at(5), operationId: claude, detail: 'x' }).outcome,
    ).toBe('ignored');
    expect(evolve(session, { type: 'ContributionOutcomeUncertain', at: at(5), operationId: 'nope', detail: 'x' }).outcome).toBe(
      'rejected',
    );
  });

  it('still accepts a late result for the uncertain operation', () => {
    const { session, gpt } = dispatchedRound();
    const uncertain = applyOk(session, { type: 'ContributionOutcomeUncertain', at: at(4), operationId: gpt, detail: 'x' });
    const late = applyOk(uncertain, received(gpt, at(5), 'contribution-9'));
    expect(late.operations.find((operation) => operation.id === gpt)?.status).toBe('acknowledged');
  });

  it('records the cause of a restart', () => {
    const { session } = dispatchedRound();
    const recovered = applyOk(session, { type: 'RuntimeRecovered', at: at(4) });
    expect(recovered.operations.every((operation) => operation.status === 'uncertain' && operation.cause === 'runtime-restart')).toBe(
      true,
    );
  });
});
