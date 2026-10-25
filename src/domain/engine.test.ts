import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIGURATION,
  availableActions,
  canDispatchFurtherRequests,
  decide,
  evaluateStopping,
  evolve,
  operationIdFor,
  type ContributionRequest,
  type DebateEvent,
  type DebateSession,
} from './index';
import {
  NO_ISSUES,
  PARTICIPANTS,
  SESSION_ID,
  WITH_ISSUES,
  applyAllOk,
  applyOk,
  at,
  createdEvent,
  received,
  settle,
  startedSession,
  step,
} from '../test-support/fixtures';

const GPT_R1 = operationIdFor(SESSION_ID, 1, 'gpt', 1);
const CLAUDE_R1 = operationIdFor(SESSION_ID, 1, 'claude', 1);

/** Started session with both round-1 operations dispatched and awaiting results. */
function roundOneInFlight(): DebateSession {
  const requested = step(startedSession(), at(2)).state;
  return step(requested, at(3)).state;
}

function roundOneComplete(): DebateSession {
  return applyAllOk(roundOneInFlight(), [
    received(GPT_R1, at(4), 'c-gpt-1', 'Position: GPT independent view'),
    received(CLAUDE_R1, at(5), 'c-claude-1', 'Position: Claude independent view'),
  ]);
}

function pausedAfterRoundOne(): DebateSession {
  return applyAllOk(roundOneComplete(), [
    { type: 'PauseRequested', at: at(6) },
    { type: 'DebatePaused', at: at(7) },
  ]);
}

describe('session initialization', () => {
  it('creates an idle, serializable session at round 1 (independent analysis)', () => {
    const result = evolve(null, createdEvent());

    expect(result.outcome).toBe('applied');
    const session = result.state;
    expect(session).toMatchObject({
      id: SESSION_ID,
      topic: 'Should the team adopt a four-day work week?',
      constraints: ['Customer support coverage must not drop'],
      currentRound: 1,
      phase: 'independent-analysis',
      status: { kind: 'idle' },
      contributions: [],
      interventions: [],
      operations: [],
      configuration: { maximumRounds: 4, stoppingStrategy: 'adaptive', allowHumanIntervention: true },
      createdAt: at(0),
      updatedAt: at(0),
    });
    expect(session?.participants.map((p) => p.displayName)).toEqual(['Human', 'GPT Simulator', 'Claude Simulator']);
    expect(JSON.parse(JSON.stringify(session))).toEqual(session);
    expect(decide(session)).toEqual([]);
  });

  it('normalizes the topic and drops blank constraints', () => {
    const session = applyOk(null, createdEvent({ topic: '  A topic  ', constraints: [' keep it short ', '   '] }));
    expect(session.topic).toBe('A topic');
    expect(session.constraints).toEqual(['keep it short']);
  });

  it.each([
    ['an empty topic', createdEvent({ topic: '   ' })],
    ['more than four rounds', createdEvent({ configuration: { ...DEFAULT_CONFIGURATION, maximumRounds: 5 } })],
    ['zero rounds', createdEvent({ configuration: { ...DEFAULT_CONFIGURATION, maximumRounds: 0 } })],
    ['a fractional round count', createdEvent({ configuration: { ...DEFAULT_CONFIGURATION, maximumRounds: 2.5 } })],
    ['no human participant', createdEvent({ participants: PARTICIPANTS.slice(1) })],
    ['a single provider participant', createdEvent({ participants: PARTICIPANTS.slice(0, 2) })],
    ['duplicate participant ids', createdEvent({
        participants: [...PARTICIPANTS, { id: 'gpt', displayName: 'Duplicate', providerType: 'gpt-simulator' }],
      })],
  ])('rejects a session with %s', (_label, event) => {
    expect(evolve(null, event).outcome).toBe('rejected');
  });

  it('rejects every other event before a session exists', () => {
    const result = evolve(null, { type: 'DebateStarted', at: at(1) });
    expect(result.outcome).toBe('rejected');
    expect(result.state).toBeNull();
  });
});

describe('start transition', () => {
  it('moves an idle session to running and requests round 1 from every provider participant', () => {
    const session = startedSession();

    expect(session.status).toEqual({ kind: 'running' });
    expect(decide(session)).toEqual([
      { type: 'RequestContribution', operation: { id: GPT_R1, round: 1, participantId: 'gpt', attempt: 1 } },
      { type: 'RequestContribution', operation: { id: CLAUDE_R1, round: 1, participantId: 'claude', attempt: 1 } },
    ]);
  });

  it('never requests a contribution from the human participant', () => {
    const commands = decide(startedSession());
    expect(commands.some((c) => c.type === 'RequestContribution' && c.operation.participantId === 'human')).toBe(false);
  });

  it('ignores a duplicate start', () => {
    expect(evolve(startedSession(), { type: 'DebateStarted', at: at(9) }).outcome).toBe('ignored');
  });
});

describe('round 1: independent contributions', () => {
  it('dispatches both providers concurrently, without exposing either analysis to the other', () => {
    const requested = step(startedSession(), at(2)).state;
    const commands = decide(requested);

    expect(commands.map((c) => c.type)).toEqual(['DispatchContribution', 'DispatchContribution']);
    for (const command of commands) {
      if (command.type !== 'DispatchContribution') throw new Error('unexpected command');
      expect(command.request.phase).toBe('independent-analysis');
      expect(command.request.priorContributions).toEqual([]);
      expect(command.request.prompt).toContain('independently');
    }

    const inFlight = step(requested, at(3)).state;
    expect(inFlight.operations.map((o) => o.status)).toEqual(['dispatched', 'dispatched']);
  });

  it('keeps the second analysis independent even when the first one has already arrived', () => {
    const requested = step(startedSession(), at(2)).state;
    // Dispatch only GPT, let it answer, then dispatch Claude.
    const [gptDispatch] = decide(requested);
    if (gptDispatch?.type !== 'DispatchContribution') throw new Error('expected a dispatch');
    let state = applyOk(requested, {
      type: 'ContributionDispatched',
      at: at(3),
      operationId: gptDispatch.operationId,
      interventionIds: [],
    });
    state = applyOk(state, received(GPT_R1, at(4), 'c-gpt-1', 'Position: GPT secret view'));

    const claudeDispatch = decide(state).find((c) => c.type === 'DispatchContribution');
    if (claudeDispatch?.type !== 'DispatchContribution') throw new Error('expected a dispatch');
    expect(claudeDispatch.request.participantId).toBe('claude');
    expect(claudeDispatch.request.priorContributions).toEqual([]);
    expect(claudeDispatch.request.prompt).not.toContain('GPT secret view');
  });
});

describe('dependencies between rounds', () => {
  it('does not start cross-examination until every independent contribution is available', () => {
    const partial = applyOk(roundOneInFlight(), received(GPT_R1, at(4), 'c-gpt-1'));

    expect(decide(partial)).toEqual([]);
    expect(evolve(partial, { type: 'RoundAdvanced', at: at(5), toRound: 2 }).outcome).toBe('rejected');
    expect(evolve(partial, { type: 'DebateCompleted', at: at(5), reason: 'maximum-rounds-reached', finalRound: 1 }).outcome).toBe(
      'rejected',
    );
  });

  it('advances one round and gives round 2 requests the round 1 contributions', () => {
    const complete = roundOneComplete();
    expect(decide(complete)).toEqual([{ type: 'AdvanceRound', toRound: 2 }]);

    const roundTwo = applyOk(complete, { type: 'RoundAdvanced', at: at(6), toRound: 2 });
    expect(roundTwo.currentRound).toBe(2);
    expect(roundTwo.phase).toBe('cross-examination');

    const requested = step(roundTwo, at(7)).state;
    const dispatches = decide(requested);
    for (const command of dispatches) {
      if (command.type !== 'DispatchContribution') throw new Error('unexpected command');
      expect(command.request.priorContributions.map((p) => p.content)).toEqual([
        'Position: GPT independent view',
        'Position: Claude independent view',
      ]);
    }
  });

  it('counts a round once per stage, not once per provider response', () => {
    const complete = roundOneComplete();
    expect(complete.contributions).toHaveLength(2);
    expect(complete.currentRound).toBe(1);
  });
});

describe('maximum round enforcement', () => {
  it('completes after four rounds when material issues never disappear', () => {
    const done = settle(startedSession(), () => WITH_ISSUES);

    expect(done.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
    expect(done.currentRound).toBe(4);
    expect(done.contributions).toHaveLength(8);
    expect(Math.max(...done.operations.map((o) => o.round))).toBe(4);
    expect(decide(done)).toEqual([]);
  });

  it('refuses to advance beyond the configured maximum', () => {
    const done = settle(startedSession(), () => WITH_ISSUES);
    const forcedRunning: DebateSession = { ...done, status: { kind: 'running' } };

    expect(evolve(forcedRunning, { type: 'RoundAdvanced', at: at(9999), toRound: 5 }).outcome).toBe('rejected');
    expect(decide(forcedRunning)).toEqual([{ type: 'CompleteDebate', reason: 'maximum-rounds-reached', finalRound: 4 }]);
  });

  it('honours a smaller configured maximum', () => {
    const done = settle(startedSession({ maximumRounds: 2 }), () => WITH_ISSUES);
    expect(done.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 2 });
    expect(done.phase).toBe('cross-examination');
  });

  it('runs every round under the fixed strategy even without material issues', () => {
    const done = settle(startedSession({ stoppingStrategy: 'fixed' }), () => NO_ISSUES);
    expect(done.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
  });
});

describe('pause transition', () => {
  it('stops scheduling new work and confirms the pause only after in-flight work settles', () => {
    const pausing = applyOk(roundOneInFlight(), { type: 'PauseRequested', at: at(4) });
    expect(pausing.status).toEqual({ kind: 'pausing' });
    expect(decide(pausing)).toEqual([]);
    expect(evolve(pausing, { type: 'DebatePaused', at: at(5) }).outcome).toBe('rejected');

    const settled = applyAllOk(pausing, [received(GPT_R1, at(5), 'c-1'), received(CLAUDE_R1, at(6), 'c-2')]);
    expect(settled.contributions).toHaveLength(2);
    // The round is complete, but no new round is started while pausing.
    expect(decide(settled)).toEqual([{ type: 'ConfirmPause' }]);

    const paused = applyOk(settled, { type: 'DebatePaused', at: at(7) });
    expect(paused.status).toEqual({ kind: 'paused', reason: 'human-request' });
    expect(paused.currentRound).toBe(1);
    expect(decide(paused)).toEqual([]);
  });

  it('does not dispatch registered-but-unsent operations while pausing', () => {
    const requested = step(startedSession(), at(2)).state;
    const pausing = applyOk(requested, { type: 'PauseRequested', at: at(3) });

    expect(decide(pausing)).toEqual([{ type: 'ConfirmPause' }]);
    expect(
      evolve(pausing, { type: 'ContributionDispatched', at: at(4), operationId: GPT_R1, interventionIds: [] }).outcome,
    ).toBe('rejected');
  });
});

describe('human constraints', () => {
  it('records a constraint while paused as pending', () => {
    const paused = pausedAfterRoundOne();
    const next = applyOk(paused, {
      type: 'HumanConstraintAdded',
      at: at(8),
      interventionId: 'i-1',
      content: '  Budget must stay flat  ',
    });

    expect(next.interventions).toEqual([
      {
        id: 'i-1',
        content: 'Budget must stay flat',
        timestamp: at(8),
        addedDuringRound: 1,
        applicationStatus: 'pending',
        appliedToOperationIds: [],
      },
    ]);
    expect(next.status).toEqual({ kind: 'paused', reason: 'human-request' });
  });

  it('rejects constraints while running, empty constraints, and constraints when intervention is disabled', () => {
    const constraint = (content: string): DebateEvent => ({
      type: 'HumanConstraintAdded',
      at: at(8),
      interventionId: 'i-1',
      content,
    });
    expect(evolve(roundOneInFlight(), constraint('x')).outcome).toBe('rejected');
    expect(evolve(pausedAfterRoundOne(), constraint('   ')).outcome).toBe('rejected');

    const disabled: DebateSession = {
      ...pausedAfterRoundOne(),
      configuration: { ...DEFAULT_CONFIGURATION, allowHumanIntervention: false },
    };
    expect(evolve(disabled, constraint('x')).outcome).toBe('rejected');
  });

  it('rejects a constraint once the final round is complete, because no request could carry it', () => {
    // Pause requested while the only permitted round is in flight; it settles before the pause is confirmed.
    const inFlight = step(step(startedSession({ maximumRounds: 1 }), at(2)).state, at(3)).state;
    const paused = applyAllOk(inFlight, [
      { type: 'PauseRequested', at: at(4) },
      received(GPT_R1, at(5), 'c-1'),
      received(CLAUDE_R1, at(6), 'c-2'),
      { type: 'DebatePaused', at: at(7) },
    ]);

    expect(canDispatchFurtherRequests(paused)).toBe(false);
    expect(availableActions(paused).addConstraint).toBe(false);
    expect(availableActions(paused).resume).toBe(true);
    const result = evolve(paused, { type: 'HumanConstraintAdded', at: at(8), interventionId: 'i-1', content: 'x' });
    expect(result.outcome).toBe('rejected');
    expect(result.state).toBe(paused);

    const resumed = applyOk(paused, { type: 'DebateResumed', at: at(9) });
    expect(decide(resumed)).toEqual([{ type: 'CompleteDebate', reason: 'maximum-rounds-reached', finalRound: 1 }]);
  });

  it('accepts a constraint after an earlier round even when the participants had converged', () => {
    // Round 2 settles with no material issues while pausing: without the constraint the debate would stop early.
    const roundTwoInFlight = step(
      step(applyOk(roundOneComplete(), { type: 'RoundAdvanced', at: at(6), toRound: 2 }), at(7)).state,
      at(8),
    ).state;
    const converged = (operationId: string, n: number): DebateEvent => ({
      type: 'ContributionReceived',
      at: at(n),
      operationId,
      contributionId: `c-${n}`,
      content: 'Position: converged',
      assessment: NO_ISSUES,
      origin: 'simulated',
    });
    const paused = applyAllOk(roundTwoInFlight, [
      { type: 'PauseRequested', at: at(9) },
      converged(operationIdFor(SESSION_ID, 2, 'gpt', 1), 10),
      converged(operationIdFor(SESSION_ID, 2, 'claude', 1), 11),
      { type: 'DebatePaused', at: at(12) },
    ]);

    expect(availableActions(paused).addConstraint).toBe(true);
    const constrained = applyAllOk(paused, [
      { type: 'HumanConstraintAdded', at: at(13), interventionId: 'i-1', content: 'Keep costs flat' },
      { type: 'DebateResumed', at: at(14) },
    ]);
    expect(decide(constrained)).toEqual([{ type: 'AdvanceRound', toRound: 3 }]);
  });
});

describe('resume transition', () => {
  it('returns a paused debate to running and continues from the same round', () => {
    const resumed = applyOk(pausedAfterRoundOne(), { type: 'DebateResumed', at: at(8) });

    expect(resumed.status).toEqual({ kind: 'running' });
    expect(resumed.currentRound).toBe(1);
    expect(decide(resumed)).toEqual([{ type: 'AdvanceRound', toRound: 2 }]);
  });

  it('ignores a resume while running and rejects a resume of an idle session', () => {
    expect(evolve(startedSession(), { type: 'DebateResumed', at: at(8) }).outcome).toBe('ignored');
    expect(evolve(applyOk(null, createdEvent()), { type: 'DebateResumed', at: at(8) }).outcome).toBe('rejected');
  });
});

describe('constraint propagation', () => {
  it('includes constraints added while paused in every subsequent request', () => {
    const paused = applyOk(pausedAfterRoundOne(), {
      type: 'HumanConstraintAdded',
      at: at(8),
      interventionId: 'i-1',
      content: 'Budget must stay flat',
    });
    const resumed = applyOk(paused, { type: 'DebateResumed', at: at(9) });

    const dispatched: ContributionRequest[] = [];
    const done = settle(resumed, () => WITH_ISSUES, { onDispatch: (request) => dispatched.push(request) });

    expect(dispatched).toHaveLength(6); // rounds 2-4, two providers each
    for (const request of dispatched) {
      expect(request.constraints).toContainEqual({
        source: 'human-intervention',
        interventionId: 'i-1',
        text: 'Budget must stay flat',
      });
      expect(request.constraints).toContainEqual({ source: 'session', text: 'Customer support coverage must not drop' });
      expect(request.prompt).toContain('Budget must stay flat');
    }
    const [intervention] = done.interventions;
    expect(intervention?.applicationStatus).toBe('applied');
    expect(intervention?.appliedToOperationIds).toHaveLength(6);
  });

  it('includes a constraint in requests that were registered before the pause but not yet sent', () => {
    const requested = step(startedSession(), at(2)).state;
    const paused = applyAllOk(requested, [
      { type: 'PauseRequested', at: at(3) },
      { type: 'DebatePaused', at: at(4) },
      { type: 'HumanConstraintAdded', at: at(5), interventionId: 'i-1', content: 'Use plain language' },
      { type: 'DebateResumed', at: at(6) },
    ]);

    const dispatches = decide(paused);
    expect(dispatches).toHaveLength(2);
    for (const command of dispatches) {
      if (command.type !== 'DispatchContribution') throw new Error('unexpected command');
      expect(command.request.round).toBe(1);
      expect(command.request.prompt).toContain('Use plain language');
    }
  });
});

describe('successful completion', () => {
  it('runs all four phases in order and completes', () => {
    const phases: string[] = [];
    const done = settle(startedSession(), (request) => (request.round < 4 ? WITH_ISSUES : NO_ISSUES), {
      onDispatch: (request) => phases.push(request.phase),
    });

    expect([...new Set(phases)]).toEqual(['independent-analysis', 'cross-examination', 'refinement', 'convergence']);
    expect(done.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
    expect(done.operations.every((o) => o.status === 'acknowledged')).toBe(true);
    expect(evolve(done, { type: 'DebateCompleted', at: at(9999), reason: 'maximum-rounds-reached', finalRound: 4 }).outcome).toBe(
      'ignored',
    );
  });
});

describe('adaptive early stopping', () => {
  it('stops early when every participant reports no material issues after cross-examination', () => {
    const done = settle(startedSession(), (request) => (request.round >= 2 ? NO_ISSUES : WITH_ISSUES));
    expect(done.status).toEqual({ kind: 'completed', reason: 'early-convergence', finalRound: 2 });
    expect(done.contributions).toHaveLength(4);
  });

  it('never stops after round 1, even if no issues are reported', () => {
    const done = settle(startedSession(), () => NO_ISSUES);
    // Round 1 reported no issues, yet the engine still ran cross-examination.
    expect(done.status).toEqual({ kind: 'completed', reason: 'early-convergence', finalRound: 2 });
  });

  it('continues while any participant still reports a material issue', () => {
    const done = settle(startedSession(), (request) =>
      request.participantId === 'claude' && request.round < 4 ? WITH_ISSUES : NO_ISSUES,
    );
    expect(done.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
  });

  it('does not stop early while a human constraint has not yet been applied', () => {
    const roundTwoComplete = settle(startedSession({ maximumRounds: 2 }), (r) => (r.round === 2 ? NO_ISSUES : WITH_ISSUES));
    const candidate: DebateSession = {
      ...roundTwoComplete,
      status: { kind: 'running' },
      configuration: DEFAULT_CONFIGURATION,
      interventions: [
        {
          id: 'i-1',
          content: 'Late constraint',
          timestamp: at(50),
          addedDuringRound: 2,
          applicationStatus: 'pending',
          appliedToOperationIds: [],
        },
      ],
    };
    expect(evaluateStopping(candidate)).toEqual({ kind: 'continue' });
    expect(decide(candidate)).toEqual([{ type: 'AdvanceRound', toRound: 3 }]);
  });

  it('rejects a completion that the structured assessments do not support', () => {
    const advanced = applyOk(roundOneComplete(), { type: 'RoundAdvanced', at: at(6), toRound: 2 });
    const inFlight = step(step(advanced, at(7)).state, at(8)).state;
    const roundTwo = applyAllOk(inFlight, [
      received(operationIdFor(SESSION_ID, 2, 'gpt', 1), at(9), 'c-gpt-2'),
      received(operationIdFor(SESSION_ID, 2, 'claude', 1), at(10), 'c-claude-2'),
    ]);
    expect(decide(roundTwo)).toEqual([{ type: 'AdvanceRound', toRound: 3 }]);
    expect(
      evolve(roundTwo, { type: 'DebateCompleted', at: at(999), reason: 'early-convergence', finalRound: 2 }).outcome,
    ).toBe('rejected');
  });
});

describe('provider failure', () => {
  it('fails the session, stops scheduling, and still reconciles the other in-flight result', () => {
    const failed = applyOk(roundOneInFlight(), {
      type: 'ContributionFailed',
      at: at(4),
      operationId: CLAUDE_R1,
      error: 'Simulated outage',
    });

    expect(failed.status).toEqual({
      kind: 'failed',
      operationId: CLAUDE_R1,
      participantId: 'claude',
      error: 'Simulated outage',
    });
    expect(decide(failed)).toEqual([]);

    const reconciled = applyOk(failed, received(GPT_R1, at(5), 'c-gpt-1'));
    expect(reconciled.contributions).toHaveLength(1);
    expect(reconciled.status.kind).toBe('failed');
    expect(decide(reconciled)).toEqual([]);

    expect(evolve(reconciled, { type: 'DebateResumed', at: at(6) }).outcome).toBe('rejected');
    expect(evolve(reconciled, { type: 'PauseRequested', at: at(6) }).outcome).toBe('rejected');
  });
});

describe('duplicate event handling', () => {
  it('treats re-delivered events as no-ops', () => {
    const inFlight = roundOneInFlight();
    const once = applyOk(inFlight, received(GPT_R1, at(4), 'c-gpt-1'));
    const twice = evolve(once, received(GPT_R1, at(5), 'c-gpt-1-again'));

    expect(twice.outcome).toBe('ignored');
    expect(twice.state).toBe(once);
    expect(once.contributions).toHaveLength(1);

    expect(evolve(once, { type: 'ContributionFailed', at: at(5), operationId: GPT_R1, error: 'late' }).outcome).toBe(
      'ignored',
    );
    expect(
      evolve(inFlight, { type: 'ContributionDispatched', at: at(5), operationId: GPT_R1, interventionIds: [] }).outcome,
    ).toBe('ignored');
    expect(
      evolve(inFlight, {
        type: 'ContributionRequested',
        at: at(5),
        operation: { id: GPT_R1, round: 1, participantId: 'gpt', attempt: 1 },
      }).outcome,
    ).toBe('ignored');

    const pausing = applyOk(inFlight, { type: 'PauseRequested', at: at(5) });
    expect(evolve(pausing, { type: 'PauseRequested', at: at(6) }).outcome).toBe('ignored');

    const withConstraint = applyOk(pausedAfterRoundOne(), {
      type: 'HumanConstraintAdded',
      at: at(8),
      interventionId: 'i-1',
      content: 'Once',
    });
    const duplicate = evolve(withConstraint, {
      type: 'HumanConstraintAdded',
      at: at(9),
      interventionId: 'i-1',
      content: 'Once',
    });
    expect(duplicate.outcome).toBe('ignored');
    expect(withConstraint.interventions).toHaveLength(1);
  });
});

describe('invalid state transitions', () => {
  const idle = (): DebateSession => applyOk(null, createdEvent());

  it.each<[string, () => DebateSession, DebateEvent]>([
    ['pausing an idle session', idle, { type: 'PauseRequested', at: at(9) }],
    ['confirming a pause that was never requested', startedSession, { type: 'DebatePaused', at: at(9) }],
    ['requesting work while idle', idle, {
      type: 'ContributionRequested',
      at: at(9),
      operation: { id: GPT_R1, round: 1, participantId: 'gpt', attempt: 1 },
    }],
    ['requesting work for a future round', startedSession, {
      type: 'ContributionRequested',
      at: at(9),
      operation: { id: operationIdFor(SESSION_ID, 2, 'gpt', 1), round: 2, participantId: 'gpt', attempt: 1 },
    }],
    ['requesting work from the human', startedSession, {
      type: 'ContributionRequested',
      at: at(9),
      operation: { id: operationIdFor(SESSION_ID, 1, 'human', 1), round: 1, participantId: 'human', attempt: 1 },
    }],
    ['requesting with a non-deterministic operation id', startedSession, {
      type: 'ContributionRequested',
      at: at(9),
      operation: { id: 'random-id', round: 1, participantId: 'gpt', attempt: 1 },
    }],
    ['receiving a result for an unknown operation', startedSession, received('unknown', at(9), 'c-x')],
    ['receiving a result for an operation that was never dispatched', () => step(startedSession(), at(2)).state,
      received(GPT_R1, at(9), 'c-x')],
    ['skipping a round', roundOneComplete, { type: 'RoundAdvanced', at: at(9), toRound: 3 }],
    ['completing a debate that is not running', idle, {
      type: 'DebateCompleted',
      at: at(9),
      reason: 'maximum-rounds-reached',
      finalRound: 1,
    }],
    ['creating a second session', startedSession, createdEvent({ sessionId: 'another-session' })],
    ['re-issuing an operation that is not uncertain', roundOneInFlight, {
      type: 'UncertainOperationReissued',
      at: at(9),
      operationId: GPT_R1,
    }],
  ])('rejects %s and leaves the state unchanged', (_label, makeState, event) => {
    const state = makeState();
    const result = evolve(state, event);
    expect(result.outcome).toBe('rejected');
    expect(result.state).toBe(state);
  });
});

describe('uncertain operation recovery', () => {
  function recovered(): DebateSession {
    return applyOk(roundOneInFlight(), { type: 'RuntimeRecovered', at: at(10) });
  }

  it('marks dispatched operations as uncertain and pauses without replaying them', () => {
    const state = recovered();

    expect(state.operations.map((o) => o.status)).toEqual(['uncertain', 'uncertain']);
    expect(state.status).toEqual({ kind: 'paused', reason: 'runtime-restart' });
    expect(decide(state)).toEqual([]);
    expect(evolve(state, { type: 'DebateResumed', at: at(11) }).outcome).toBe('rejected');
  });

  it('accepts a late result for an uncertain operation', () => {
    const state = applyOk(recovered(), received(GPT_R1, at(11), 'c-gpt-late'));
    expect(state.operations.find((o) => o.id === GPT_R1)?.status).toBe('acknowledged');
    expect(state.contributions).toHaveLength(1);
  });

  it('re-issues only with explicit approval, as a new attempt with a new stable id', () => {
    const reconciled = applyOk(recovered(), received(GPT_R1, at(11), 'c-gpt-late'));
    const reissued = applyOk(reconciled, { type: 'UncertainOperationReissued', at: at(12), operationId: CLAUDE_R1 });
    expect(reissued.operations.find((o) => o.id === CLAUDE_R1)?.status).toBe('superseded');

    const resumed = applyOk(reissued, { type: 'DebateResumed', at: at(13) });
    expect(decide(resumed)).toEqual([
      {
        type: 'RequestContribution',
        operation: { id: operationIdFor(SESSION_ID, 1, 'claude', 2), round: 1, participantId: 'claude', attempt: 2 },
      },
    ]);

    // A late result for the superseded attempt is discarded, so it cannot double-count.
    const late = evolve(resumed, received(CLAUDE_R1, at(14), 'c-claude-late'));
    expect(late.outcome).toBe('ignored');

    const done = settle(resumed, () => WITH_ISSUES);
    expect(done.status.kind).toBe('completed');
    expect(done.contributions.filter((c) => c.round === 1)).toHaveLength(2);
  });

  it('keeps never-sent operations pending so they can be dispatched safely after resume', () => {
    const requested = step(startedSession(), at(2)).state;
    const state = applyOk(requested, { type: 'RuntimeRecovered', at: at(3) });

    expect(state.operations.map((o) => o.status)).toEqual(['pending', 'pending']);
    const resumed = applyOk(state, { type: 'DebateResumed', at: at(4) });
    expect(decide(resumed).map((c) => c.type)).toEqual(['DispatchContribution', 'DispatchContribution']);
  });
});
