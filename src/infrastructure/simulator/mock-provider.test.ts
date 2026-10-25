import { describe, expect, it, vi } from 'vitest';
import { buildContributionRequest, decide, type ContributionRequest } from '../../domain';
import { applyAllOk, at, received, startedSession, step } from '../../test-support/fixtures';
import { createSimulatedProvider, createSimulatedProviders, delaysForPace, simulateContribution } from './mock-provider';
import { isSimulationSetup } from './scenarios';
import { PERSONA_SCRIPTS } from './scripts';

function roundOneRequest(participantId: 'gpt' | 'claude'): ContributionRequest {
  const requested = step(startedSession(), at(2)).state;
  const operation = requested.operations.find((o) => o.participantId === participantId);
  if (operation === undefined) throw new Error('missing operation');
  return buildContributionRequest(requested, operation);
}

function roundTwoRequest(participantId: 'gpt' | 'claude', withIntervention = false): ContributionRequest {
  const inFlight = step(step(startedSession(), at(2)).state, at(3)).state;
  const [gptOp, claudeOp] = inFlight.operations;
  let state = applyAllOk(inFlight, [
    received(gptOp?.id ?? '', at(4), 'c-1', 'Position: Incremental view'),
    received(claudeOp?.id ?? '', at(5), 'c-2', 'Position: Cautious view'),
  ]);
  if (withIntervention) {
    state = applyAllOk(state, [
      { type: 'PauseRequested', at: at(6) },
      { type: 'DebatePaused', at: at(7) },
      { type: 'HumanConstraintAdded', at: at(8), interventionId: 'i-1', content: 'Avoid new hires' },
      { type: 'DebateResumed', at: at(9) },
    ]);
  }
  state = step(state, at(10)).state; // advance to round 2
  state = step(state, at(11)).state; // register round 2 operations
  const dispatch = decide(state).find(
    (c) => c.type === 'DispatchContribution' && c.request.participantId === participantId,
  );
  if (dispatch?.type !== 'DispatchContribution') throw new Error('missing dispatch');
  return dispatch.request;
}

describe('simulated providers', () => {
  it('are deterministic', () => {
    const request = roundOneRequest('gpt');
    expect(simulateContribution(PERSONA_SCRIPTS.gpt, 'full-debate', request)).toEqual(
      simulateContribution(PERSONA_SCRIPTS.gpt, 'full-debate', request),
    );
  });

  it('produce distinguishable viewpoints that are labelled as simulated', () => {
    const gpt = simulateContribution(PERSONA_SCRIPTS.gpt, 'full-debate', roundOneRequest('gpt'));
    const claude = simulateContribution(PERSONA_SCRIPTS.claude, 'full-debate', roundOneRequest('claude'));
    if (!gpt.ok || !claude.ok) throw new Error('expected success');

    expect(gpt.content).not.toEqual(claude.content);
    expect(gpt.content).toContain('incrementally');
    expect(claude.content).toContain('failure modes');
    expect(gpt.content).toContain('This is not a response from GPT.');
    expect(claude.content).toContain('This is not a response from Claude.');
  });

  it('support every phase', () => {
    for (const script of Object.values(PERSONA_SCRIPTS)) {
      for (const phase of ['independent-analysis', 'cross-examination', 'refinement', 'convergence'] as const) {
        const result = simulateContribution(script, 'full-debate', { ...roundOneRequest('gpt'), phase });
        expect(result.ok).toBe(true);
      }
    }
  });

  it('respond to the other participant during cross-examination', () => {
    const result = simulateContribution(PERSONA_SCRIPTS.gpt, 'full-debate', roundTwoRequest('gpt'));
    if (!result.ok) throw new Error('expected success');
    expect(result.content).toContain('Responding to Claude Simulator: “Cautious view”');
  });

  it('respect supplied constraints, including human interventions', () => {
    const result = simulateContribution(PERSONA_SCRIPTS.claude, 'full-debate', roundTwoRequest('claude', true));
    if (!result.ok) throw new Error('expected success');

    expect(result.content).toContain('Customer support coverage must not drop');
    expect(result.content).toContain('“Avoid new hires” (added by the human during the debate)');
    expect(result.assessment.agreements).toContain('Respect the human constraint: “Avoid new hires”.');
  });

  it('simulate a failure where the scenario scripts one', () => {
    const result = simulateContribution(PERSONA_SCRIPTS.claude, 'provider-failure', roundTwoRequest('claude'));
    expect(result.ok).toBe(false);
    expect(simulateContribution(PERSONA_SCRIPTS.gpt, 'provider-failure', roundTwoRequest('gpt')).ok).toBe(true);
  });

  it('report converged assessments after refinement only in the early-convergence scenario', () => {
    const refinement = { ...roundOneRequest('gpt'), phase: 'refinement' as const, round: 3 };
    const early = simulateContribution(PERSONA_SCRIPTS.gpt, 'early-convergence', refinement);
    const full = simulateContribution(PERSONA_SCRIPTS.gpt, 'full-debate', refinement);
    if (!early.ok || !full.ok) throw new Error('expected success');
    expect(early.assessment.materialIssues).toEqual([]);
    expect(full.assessment.materialIssues.length).toBeGreaterThan(0);
  });

  it('hold each response for the delay of the selected pace, and only then answer', async () => {
    vi.useFakeTimers();
    try {
      const slow = delaysForPace('slow');
      expect(slow.gptDelayMs).toBeGreaterThan(delaysForPace('standard').gptDelayMs);
      const provider = createSimulatedProviders('full-debate', slow).get('gpt');
      if (provider === undefined) throw new Error('missing provider');

      let settled = false;
      const pending = provider
        .requestContribution(roundOneRequest('gpt'), { signal: new AbortController().signal })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(slow.gptDelayMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only accept setups that name both a known scenario and a known pace', () => {
    expect(isSimulationSetup({ scenario: 'full-debate', pace: 'slow' })).toBe(true);
    expect(isSimulationSetup({ scenario: 'full-debate' })).toBe(false);
    expect(isSimulationSetup({ scenario: 'full-debate', pace: 'instant' })).toBe(false);
  });

  it('honour cancellation during the artificial delay', async () => {
    const provider = createSimulatedProvider({ persona: 'gpt', scenario: 'full-debate', delayMs: 10_000 });
    const controller = new AbortController();
    const pending = provider.requestContribution(roundOneRequest('gpt'), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
  });
});
