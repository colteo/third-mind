import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIGURATION,
  availableActions,
  operationIdFor,
  type ContributionRequest,
  type DebateSession,
} from '../domain';
import { createMemoryCheckpointStore } from '../infrastructure/memory-checkpoint-store';
import {
  SIMULATION_PARTICIPANTS,
  createSimulatedProviders,
  type SimulationScenarioId,
  type SimulationSetup,
} from '../infrastructure/simulator';
import type { ContributionProvider, ProviderRegistry, ProviderResult } from '../ports';
import { createTestClock, createTestIds, WITH_ISSUES } from '../test-support/fixtures';
import { createDebateRunner, type StartDebateInput } from './debate-runner';

interface PendingCall {
  readonly request: ContributionRequest;
  readonly signal: AbortSignal;
  readonly resolve: (result: ProviderResult) => void;
}

/** Provider whose calls stay in flight until the test resolves them. */
function controllableProviders(onCall?: (request: ContributionRequest) => void): {
  registry: ProviderRegistry;
  calls: PendingCall[];
} {
  const calls: PendingCall[] = [];
  const make = (participantId: string): ContributionProvider => ({
    participantId,
    origin: 'simulated',
    supportsCancellation: true,
    requestContribution: (request, { signal }) =>
      new Promise<ProviderResult>((resolve) => {
        onCall?.(request);
        calls.push({ request, signal, resolve });
      }),
  });
  return { registry: new Map([['gpt', make('gpt')], ['claude', make('claude')]]), calls };
}

function answer(call: PendingCall | undefined, content = `Position: ${call?.request.participantId ?? ''}`): void {
  if (call === undefined) throw new Error('No such call');
  call.resolve({ ok: true, content, assessment: WITH_ISSUES });
}

/** Lets queued promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function startInput(scenario: SimulationScenarioId = 'full-debate'): StartDebateInput<SimulationSetup> {
  return {
    topic: 'Should we rewrite the reporting module?',
    constraints: ['Keep the current API'],
    participants: SIMULATION_PARTICIPANTS,
    configuration: DEFAULT_CONFIGURATION,
    setup: { scenario, pace: 'standard' },
  };
}

function setupRunner(registry: (setup: SimulationSetup) => ProviderRegistry) {
  const checkpoints = createMemoryCheckpointStore<SimulationSetup>();
  const errors: unknown[] = [];
  const runner = createDebateRunner<SimulationSetup>({
    clock: createTestClock(),
    ids: createTestIds(),
    checkpoints,
    createProviders: registry,
    reportError: (error) => errors.push(error),
  });
  return { runner, checkpoints, errors };
}

function sessionOf(runner: { getSnapshot(): { session: DebateSession | null } }): DebateSession {
  const { session } = runner.getSnapshot();
  if (session === null) throw new Error('Expected a session');
  return session;
}

const instantSimulators = (setup: SimulationSetup) =>
  createSimulatedProviders(setup.scenario, { gptDelayMs: 0, claudeDelayMs: 0 });

describe('debate runner with the simulator', () => {
  it('runs a full simulated debate to completion and checkpoints the result', async () => {
    const { runner, checkpoints, errors } = setupRunner(instantSimulators);

    expect(await runner.start(startInput('full-debate'))).toEqual({ ok: true });
    await runner.whenIdle();

    const session = sessionOf(runner);
    expect(session.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
    expect(session.contributions).toHaveLength(8);
    expect(session.contributions.every((c) => c.origin === 'simulated')).toBe(true);
    expect(checkpoints.peek()?.session).toEqual(session);
    expect(errors).toEqual([]);
  });

  it('stops early in the early-convergence scenario', async () => {
    const { runner } = setupRunner(instantSimulators);
    await runner.start(startInput('early-convergence'));
    await runner.whenIdle();

    expect(sessionOf(runner).status).toEqual({ kind: 'completed', reason: 'early-convergence', finalRound: 3 });
  });

  it('reports a provider failure', async () => {
    const { runner } = setupRunner(instantSimulators);
    await runner.start(startInput('provider-failure'));
    await runner.whenIdle();

    const { status } = sessionOf(runner);
    expect(status.kind).toBe('failed');
    if (status.kind === 'failed') {
      expect(status.participantId).toBe('claude');
      expect(status.error).toContain('Simulated failure');
    }
    expect(sessionOf(runner).currentRound).toBe(2);
  });

  it('rejects invalid starts without creating a session', async () => {
    const { runner } = setupRunner(instantSimulators);
    const result = await runner.start({ ...startInput(), topic: '   ' });
    expect(result.ok).toBe(false);
    expect(runner.getSnapshot().session).toBeNull();
  });

  it('rejects a second start while a session exists', async () => {
    const { runner } = setupRunner(instantSimulators);
    await runner.start(startInput());
    expect((await runner.start(startInput())).ok).toBe(false);
  });
});

describe('debate runner: pause, constraints and resume', () => {
  it('waits for in-flight work, pauses, and applies a new constraint to subsequent requests', async () => {
    const { registry, calls } = controllableProviders();
    const { runner } = setupRunner(() => registry);

    await runner.start(startInput());
    expect(calls.map((c) => c.request.participantId)).toEqual(['gpt', 'claude']);

    await runner.pause();
    expect(sessionOf(runner).status).toEqual({ kind: 'pausing' });

    answer(calls[0]);
    answer(calls[1]);
    await flush();
    expect(sessionOf(runner).status).toEqual({ kind: 'paused', reason: 'human-request' });
    expect(calls).toHaveLength(2); // nothing new was scheduled while pausing

    expect((await runner.addConstraint('Finish within two sprints')).ok).toBe(true);
    expect((await runner.resume()).ok).toBe(true);

    expect(calls).toHaveLength(4);
    for (const call of calls.slice(2)) {
      expect(call.request.round).toBe(2);
      expect(call.request.prompt).toContain('Finish within two sprints');
    }
    expect(sessionOf(runner).interventions[0]?.applicationStatus).toBe('applied');
  });

  it('rejects a constraint while the debate is running', async () => {
    const { registry } = controllableProviders();
    const { runner } = setupRunner(() => registry);
    await runner.start(startInput());

    const result = await runner.addConstraint('Too early');
    expect(result.ok).toBe(false);
  });
});

describe('debate runner: side-effect safety and recovery', () => {
  it('persists the dispatch before calling the provider (write-ahead)', async () => {
    const checkpoints = createMemoryCheckpointStore<SimulationSetup>();
    const statusesAtCallTime: string[] = [];
    const { registry } = controllableProviders((request) => {
      const operation = checkpoints.peek()?.session.operations.find((o) => o.id === request.operationId);
      statusesAtCallTime.push(operation?.status ?? 'missing');
    });
    const runner = createDebateRunner<SimulationSetup>({
      clock: createTestClock(),
      ids: createTestIds(),
      checkpoints,
      createProviders: () => registry,
      reportError: () => undefined,
    });

    await runner.start(startInput());
    expect(statusesAtCallTime).toEqual(['dispatched', 'dispatched']);
  });

  it('restores a checkpoint after a restart, marks in-flight work uncertain and never replays it automatically', async () => {
    const first = controllableProviders();
    const { runner: original, checkpoints } = setupRunner(() => first.registry);
    await original.start(startInput());
    expect(first.calls).toHaveLength(2);

    // Simulate a service worker restart: a new runner over the same checkpoint store.
    const second = controllableProviders();
    const restarted = createDebateRunner<SimulationSetup>({
      clock: createTestClock(),
      ids: createTestIds(),
      checkpoints,
      createProviders: () => second.registry,
      reportError: () => undefined,
    });
    await restarted.initialize();

    const session = sessionOf(restarted);
    expect(session.status).toEqual({ kind: 'paused', reason: 'runtime-restart' });
    expect(session.operations.map((o) => o.status)).toEqual(['uncertain', 'uncertain']);
    expect(second.calls).toHaveLength(0);
    expect((await restarted.resume()).ok).toBe(false);

    const sessionId = session.id;
    await restarted.reissueUncertainOperation(operationIdFor(sessionId, 1, 'gpt', 1));
    await restarted.reissueUncertainOperation(operationIdFor(sessionId, 1, 'claude', 1));
    expect((await restarted.resume()).ok).toBe(true);

    expect(second.calls.map((c) => c.request.operationId)).toEqual([
      operationIdFor(sessionId, 1, 'gpt', 2),
      operationIdFor(sessionId, 1, 'claude', 2),
    ]);
  });

  it('reset cancels in-flight calls, clears the checkpoint and ignores late results', async () => {
    const { registry, calls } = controllableProviders();
    const { runner, checkpoints, errors } = setupRunner(() => registry);
    await runner.start(startInput());

    await runner.reset();
    expect(runner.getSnapshot()).toEqual({ session: null, setup: null });
    expect(checkpoints.peek()).toBeNull();
    expect(calls.every((c) => c.signal.aborted)).toBe(true);

    answer(calls[0]);
    await flush();
    expect(runner.getSnapshot().session).toBeNull();
    expect(errors).toEqual([]);
  });

  it('notifies subscribers of every applied change', async () => {
    const { runner } = setupRunner(instantSimulators);
    const statuses: string[] = [];
    runner.subscribe((snapshot) => {
      if (snapshot.session !== null) statuses.push(snapshot.session.status.kind);
    });
    await runner.start(startInput());
    await runner.whenIdle();

    expect(statuses[0]).toBe('idle');
    expect(statuses).toContain('running');
    expect(statuses.at(-1)).toBe('completed');
  });
});

/** Answers every call that has not been answered yet and lets the runner react. */
async function answerOutstanding(calls: readonly PendingCall[], answered: Set<PendingCall>): Promise<void> {
  for (const call of calls) {
    if (!answered.has(call)) {
      answered.add(call);
      answer(call);
    }
  }
  await flush();
}

describe('debate runner: interactive pause, constraint and resume', () => {
  it('pauses while a response is still in flight without starting another round, then resumes with the constraint', async () => {
    const { registry, calls } = controllableProviders();
    const { runner, errors } = setupRunner(() => registry);
    const answered = new Set<PendingCall>();
    await runner.start(startInput());

    // GPT has answered round 1; Claude is still in flight when the human presses Pause.
    const gptRoundOne = calls[0];
    if (gptRoundOne === undefined) throw new Error('missing call');
    answered.add(gptRoundOne);
    answer(gptRoundOne);
    await flush();
    expect((await runner.pause()).ok).toBe(true);
    expect((await runner.pause()).ok).toBe(true); // a duplicate click is harmless
    expect(sessionOf(runner).status).toEqual({ kind: 'pausing' });

    await answerOutstanding(calls, answered);
    const paused = sessionOf(runner);
    expect(paused.status).toEqual({ kind: 'paused', reason: 'human-request' });
    expect(paused.currentRound).toBe(1);
    expect(paused.contributions).toHaveLength(2); // the in-flight result was reconciled, not dropped
    expect(calls).toHaveLength(2); // and it did not trigger round 2

    expect((await runner.addConstraint('Finish within two sprints')).ok).toBe(true);
    expect((await runner.resume()).ok).toBe(true);
    expect((await runner.resume()).ok).toBe(true); // a duplicate resume dispatches nothing extra
    expect(calls).toHaveLength(4);

    // Run the remaining rounds to completion.
    while (sessionOf(runner).status.kind === 'running') {
      await answerOutstanding(calls, answered);
    }
    const done = sessionOf(runner);
    expect(done.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });

    // Every request after the resume carried the constraint, for both providers.
    const later = calls.slice(2);
    expect(later).toHaveLength(6);
    expect(later.every((c) => c.request.prompt.includes('Finish within two sprints'))).toBe(true);
    expect(new Set(later.map((c) => c.request.participantId))).toEqual(new Set(['gpt', 'claude']));
    expect(done.interventions[0]?.appliedToOperationIds).toEqual(later.map((c) => c.request.operationId));

    // Exactly one contribution per provider and round; no operation was dispatched twice.
    expect(done.contributions).toHaveLength(8);
    expect(new Set(done.contributions.map((c) => `${c.round}:${c.participantId}`)).size).toBe(8);
    expect(new Set(calls.map((c) => c.request.operationId)).size).toBe(calls.length);
    expect(done.operations.every((o) => o.status === 'acknowledged')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('refuses a constraint after pausing in the final round, and completes on resume', async () => {
    const { registry, calls } = controllableProviders();
    const { runner } = setupRunner(() => registry);
    const answered = new Set<PendingCall>();
    await runner.start(startInput());
    while (sessionOf(runner).currentRound < 4) {
      await answerOutstanding(calls, answered);
    }

    await runner.pause();
    await answerOutstanding(calls, answered);
    expect(sessionOf(runner).status).toEqual({ kind: 'paused', reason: 'human-request' });
    expect(availableActions(sessionOf(runner)).addConstraint).toBe(false);

    const result = await runner.addConstraint('Too late to matter');
    expect(result.ok).toBe(false);
    expect(sessionOf(runner).interventions).toEqual([]);

    expect((await runner.resume()).ok).toBe(true);
    expect(sessionOf(runner).status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
    expect(calls).toHaveLength(8);
  });

  it('keeps a paused session, and its constraint, across a service worker restart', async () => {
    const first = controllableProviders();
    const { runner, checkpoints } = setupRunner(() => first.registry);
    await runner.start(startInput());
    await runner.pause();
    await answerOutstanding(first.calls, new Set());
    await runner.addConstraint('Keep the current team size');

    const second = controllableProviders();
    const restarted = createDebateRunner<SimulationSetup>({
      clock: createTestClock(),
      ids: createTestIds(),
      checkpoints,
      createProviders: () => second.registry,
      reportError: () => undefined,
    });
    await restarted.initialize();

    const session = sessionOf(restarted);
    // Nothing was in flight, so the human pause stands and nothing needs review.
    expect(session.status).toEqual({ kind: 'paused', reason: 'human-request' });
    expect(session.interventions.map((i) => i.applicationStatus)).toEqual(['pending']);
    expect(availableActions(session).resume).toBe(true);
    expect(second.calls).toHaveLength(0);

    expect((await restarted.resume()).ok).toBe(true);
    expect(second.calls.map((c) => c.request.round)).toEqual([2, 2]);
    expect(second.calls.every((c) => c.request.prompt.includes('Keep the current team size'))).toBe(true);
  });
});

describe('debate runner: reset and new sessions', () => {
  it('resets a completed debate and starts a fresh one', async () => {
    const { runner, checkpoints, errors } = setupRunner(instantSimulators);
    await runner.start(startInput());
    await runner.whenIdle();
    const first = sessionOf(runner);
    expect(first.status.kind).toBe('completed');

    expect(await runner.reset(first.id)).toEqual({ ok: true });
    expect(runner.getSnapshot()).toEqual({ session: null, setup: null });
    expect(checkpoints.peek()).toBeNull();

    expect(await runner.start({ ...startInput('early-convergence'), topic: 'A second question' })).toEqual({ ok: true });
    await runner.whenIdle();
    const second = sessionOf(runner);
    expect(second.id).not.toBe(first.id);
    expect(second.topic).toBe('A second question');
    expect(second.status).toEqual({ kind: 'completed', reason: 'early-convergence', finalRound: 3 });
    expect(second.contributions.every((c) => c.operationId.startsWith(`${second.id}:`))).toBe(true);
    expect(checkpoints.peek()?.session.id).toBe(second.id);
    expect(errors).toEqual([]);
  });

  it('resets while pausing, and late results from the old session never reach the new one', async () => {
    // These providers ignore cancellation, so the old calls really do resolve after the reset.
    const { registry, calls } = controllableProviders();
    const { runner, errors } = setupRunner(() => registry);
    await runner.start(startInput());
    const obsolete = sessionOf(runner);
    await runner.pause();
    expect(sessionOf(runner).status.kind).toBe('pausing');

    await runner.reset(obsolete.id);
    await runner.start({ ...startInput(), constraints: [] });
    const fresh = sessionOf(runner);
    expect(calls).toHaveLength(4);

    // The obsolete session's in-flight calls now complete.
    answer(calls[0]);
    answer(calls[1]);
    await flush();
    const afterLate = sessionOf(runner);
    expect(afterLate.id).toBe(fresh.id);
    expect(afterLate.status).toEqual({ kind: 'running' });
    expect(afterLate.contributions).toEqual([]);
    expect(afterLate.operations.every((o) => o.id.startsWith(`${fresh.id}:`))).toBe(true);
    expect(afterLate.operations.map((o) => o.status)).toEqual(['dispatched', 'dispatched']);

    // The new session's own results are recorded normally.
    answer(calls[2]);
    answer(calls[3]);
    await flush();
    expect(sessionOf(runner).currentRound).toBe(2);
    expect(sessionOf(runner).contributions.map((c) => c.operationId)).toEqual([
      operationIdFor(fresh.id, 1, 'gpt', 1),
      operationIdFor(fresh.id, 1, 'claude', 1),
    ]);
    expect(errors).toEqual([]);
  });

  it('ignores commands addressed to an obsolete session', async () => {
    const { registry } = controllableProviders();
    const { runner } = setupRunner(() => registry);
    await runner.start(startInput());
    const obsolete = sessionOf(runner).id;
    await runner.reset(obsolete);
    await runner.start(startInput());
    const current = sessionOf(runner).id;

    expect((await runner.pause(obsolete)).ok).toBe(false);
    expect((await runner.addConstraint('x', obsolete)).ok).toBe(false);
    expect((await runner.reset(obsolete)).ok).toBe(false); // must not discard the newer session
    expect(sessionOf(runner).id).toBe(current);
    expect(sessionOf(runner).status).toEqual({ kind: 'running' });

    expect((await runner.pause(current)).ok).toBe(true);
    expect(sessionOf(runner).status).toEqual({ kind: 'pausing' });
  });

  it('treats a repeated reset of the same session as already done', async () => {
    const { runner } = setupRunner(instantSimulators);
    await runner.start(startInput());
    const id = sessionOf(runner).id;
    expect((await runner.reset(id)).ok).toBe(true);
    expect((await runner.reset(id)).ok).toBe(true);
    expect(runner.getSnapshot().session).toBeNull();
  });
});

describe('debate runner: side panel reconnection', () => {
  it('keeps running while no panel is listening, and a reopened panel sees the current state', async () => {
    const { registry, calls } = controllableProviders();
    const { runner, checkpoints } = setupRunner(() => registry);
    const seen: string[] = [];
    const unsubscribe = runner.subscribe((snapshot) => {
      if (snapshot.session !== null) seen.push(`${snapshot.session.currentRound}:${snapshot.session.status.kind}`);
    });
    await runner.start(startInput());
    unsubscribe(); // panel closed

    answer(calls[0]);
    answer(calls[1]);
    await flush();
    expect(seen.at(-1)).toBe('1:running'); // the closed panel heard nothing further

    // A reopened panel is sent getSnapshot(); it matches the persisted state.
    const reopened = sessionOf(runner);
    expect(reopened.currentRound).toBe(2);
    expect(reopened.contributions).toHaveLength(2);
    expect(checkpoints.peek()?.session).toEqual(reopened);
    expect(calls).toHaveLength(4);
  });
});
