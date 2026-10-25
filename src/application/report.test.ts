import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIGURATION } from '../domain';
import { createMemoryCheckpointStore } from '../infrastructure/memory-checkpoint-store';
import {
  SHARED_AGREEMENTS,
  SIMULATION_PARTICIPANTS,
  createSimulatedProviders,
  type SimulationScenarioId,
  type SimulationSetup,
} from '../infrastructure/simulator';
import { createTestClock, createTestIds } from '../test-support/fixtures';
import { createDebateRunner } from './debate-runner';
import { buildConversationalSummary, buildDebateReport } from './report';

async function simulatedSession(scenario: SimulationScenarioId) {
  const runner = createDebateRunner<SimulationSetup>({
    clock: createTestClock(),
    ids: createTestIds(),
    checkpoints: createMemoryCheckpointStore(),
    createProviders: (setup) => createSimulatedProviders(setup.scenario, { gptDelayMs: 0, claudeDelayMs: 0 }),
    reportError: (error) => {
      throw error;
    },
  });
  await runner.start({
    topic: 'Should we move to a monorepo?',
    constraints: [],
    participants: SIMULATION_PARTICIPANTS,
    configuration: DEFAULT_CONFIGURATION,
    setup: { scenario, pace: 'standard' },
  });
  await runner.whenIdle();
  const { session } = runner.getSnapshot();
  if (session === null) throw new Error('expected a session');
  return session;
}

describe('debate report', () => {
  it('makes remaining disagreements and unresolved questions explicit', async () => {
    const report = buildDebateReport(await simulatedSession('full-debate'));

    expect(report.origin).toBe('simulated');
    expect(report.roundsCompleted).toBe(4);
    expect(report.disagreements).toEqual([
      { raisedBy: 'Claude Simulator', text: 'The evidence threshold for full adoption remains disputed.' },
    ]);
    expect(report.unresolvedQuestions.map((q) => q.raisedBy)).toEqual(['GPT Simulator', 'Claude Simulator']);
    expect(report.sharedAgreements).toEqual([SHARED_AGREEMENTS.pilot, SHARED_AGREEMENTS.gates, SHARED_AGREEMENTS.review]);
    expect(report.positions.map((p) => p.round)).toEqual([4, 4]);
    expect(report.outcome).toContain('one material issue still unresolved');
  });

  it('explains an early stop', async () => {
    const report = buildDebateReport(await simulatedSession('early-convergence'));
    expect(report.roundsCompleted).toBe(3);
    expect(report.disagreements).toEqual([]);
    expect(report.outcome).toContain('finished early, after round 3 of 4');
  });

  it('explains a failure', async () => {
    const report = buildDebateReport(await simulatedSession('provider-failure'));
    expect(report.outcome).toContain('Claude Simulator failed');
  });

  it('states in the conversational summary that the content is simulated', async () => {
    const paragraphs = buildConversationalSummary(buildDebateReport(await simulatedSession('full-debate')));
    expect(paragraphs.join(' ')).toContain('does not come from GPT or Claude');
    expect(paragraphs.join(' ')).toContain('Claude Simulator still considers this a material issue');
  });
});
