/**
 * Live orchestration with deterministic fake adapters. These tests verify
 * ThirdMind's own logic (preflight gating, write-ahead dispatch, uncertainty,
 * recovery, stale-response rejection). They do not, and cannot, show that any
 * real provider website works: no real provider is involved.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIGURATION, type ContributionRequest, type DebateSession } from '../domain';
import { createConsumerSiteAdapters } from '../infrastructure/live/consumer-site-adapters';
import { createMemoryCheckpointStore } from '../infrastructure/memory-checkpoint-store';
import { createSimulatedProviders, type SimulationSetup } from '../infrastructure/simulator';
import type { DebateCheckpoint, LiveAdapterRegistry, ProviderRegistry } from '../ports';
import { createTestClock, createTestIds } from '../test-support/fixtures';
import {
  CHATGPT_CONVERSATION,
  CHATGPT_TAB,
  assessmentBlock,
  createFakeLiveAdapter,
  createFakeTransport,
  linkedConnections,
  type FakeAdapterOptions,
} from '../test-support/live-fakes';
import { createDebateRunner } from './debate-runner';
import { LIVE_PARTICIPANTS, type LiveDebateSetup } from './execution-mode';
import { createLiveContributionProvider, createLiveProviders, createSubmissionLocks } from './live-contribution-provider';
import { prepareLiveStart, verifyLiveContinuation } from './live-debate';
import { createLivePreflight } from './live-preflight';
import { ASSESSMENT_FENCE } from './live-response';

type TestSetup = LiveDebateSetup | ({ readonly mode: 'simulation' } & SimulationSetup);

interface HarnessOptions {
  readonly chatgpt?: FakeAdapterOptions;
  readonly claude?: FakeAdapterOptions;
  readonly adapters?: LiveAdapterRegistry;
  readonly responseTimeoutMs?: number;
  readonly checkpoint?: DebateCheckpoint<TestSetup>;
}

function harness(options: HarnessOptions = {}) {
  const connections = linkedConnections();
  const transport = createFakeTransport();
  const chatgpt = createFakeLiveAdapter('chatgpt', options.chatgpt);
  const claude = createFakeLiveAdapter('claude', options.claude);
  const adapters = options.adapters ?? { chatgpt: chatgpt.adapter, claude: claude.adapter };
  const clock = createTestClock();
  const preflight = createLivePreflight({ connections, transport, adapters, clock });
  const locks = createSubmissionLocks();
  const checkpoints = createMemoryCheckpointStore<TestSetup>();
  if (options.checkpoint !== undefined) {
    void checkpoints.save(options.checkpoint);
  }
  const created: TestSetup['mode'][] = [];
  const errors: unknown[] = [];
  const runner = createDebateRunner<TestSetup>({
    clock,
    ids: createTestIds(),
    checkpoints,
    createProviders: (setup): ProviderRegistry => {
      created.push(setup.mode);
      return setup.mode === 'simulation'
        ? createSimulatedProviders(setup.scenario, { gptDelayMs: 0, claudeDelayMs: 0 })
        : createLiveProviders(setup, {
            adapters,
            verifyTarget: (binding) => preflight.verifyTarget(binding),
            locks,
            ...(options.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: options.responseTimeoutMs }),
          });
    },
    reportError: (error) => errors.push(error),
  });

  const startLive = async () => {
    const readiness = await preflight.run();
    const gate = await prepareLiveStart(preflight, readiness.revisions);
    if (!gate.ok) {
      return gate;
    }
    return runner.start({
      topic: 'Should the team adopt trunk-based development?',
      constraints: ['Keep releases weekly'],
      participants: LIVE_PARTICIPANTS,
      configuration: DEFAULT_CONFIGURATION,
      setup: gate.setup,
    });
  };

  return { runner, preflight, connections, transport, chatgpt, claude, checkpoints, created, errors, startLive };
}

function sessionOf(runner: { getSnapshot(): { session: DebateSession | null } }): DebateSession {
  const { session } = runner.getSnapshot();
  if (session === null) throw new Error('Expected a session');
  return session;
}

const withIssues = (text: string) => `${text}\n${assessmentBlock(['An issue remains.'])}`;

function request(overrides: Partial<ContributionRequest> = {}): ContributionRequest {
  return {
    operationId: 'session-1:round-1:gpt:attempt-1',
    sessionId: 'session-1',
    participantId: 'gpt',
    round: 1,
    maximumRounds: 4,
    phase: 'independent-analysis',
    topic: 'T',
    constraints: [],
    priorContributions: [],
    instructions: 'I',
    prompt: 'Prompt',
    ...overrides,
  };
}

describe('live debate orchestration (fake adapters)', () => {
  it('runs a complete multi-round live debate without any manual step', async () => {
    const behave = (_s: unknown, index: number) =>
      index < 3 ? { answer: withIssues(`Round ${index + 1} view.`) } : { answer: `Final view.\n${assessmentBlock()}` };
    const h = harness({ chatgpt: { behave }, claude: { behave } });

    expect(await h.startLive()).toEqual({ ok: true });
    await h.runner.whenIdle();

    const session = sessionOf(h.runner);
    expect(session.status).toEqual({ kind: 'completed', reason: 'maximum-rounds-reached', finalRound: 4 });
    expect(session.contributions).toHaveLength(8);
    expect(session.contributions.every((contribution) => contribution.origin === 'live')).toBe(true);
    // The assessment block is parsed and removed from the stored content.
    expect(session.contributions.every((contribution) => !contribution.content.includes(ASSESSMENT_FENCE))).toBe(true);
    expect(session.contributions.at(-1)?.assessment.materialIssues).toEqual([]);
    // Exactly one submission per operation, each carrying its operation id and the assessment format.
    expect(h.chatgpt.submissions).toHaveLength(4);
    expect(h.claude.submissions).toHaveLength(4);
    const operationIds = session.operations.map((operation) => operation.id);
    expect(h.chatgpt.submissions.map((s) => s.submission.operationId).every((id) => operationIds.includes(id))).toBe(true);
    expect(h.chatgpt.submissions.every((s) => s.submission.text.includes(ASSESSMENT_FENCE))).toBe(true);
    expect(h.chatgpt.submissions.every((s) => s.target.conversationId === CHATGPT_CONVERSATION)).toBe(true);
    expect(h.created).toEqual(['live']);
    expect(h.errors).toEqual([]);
  });

  it('keeps simulation fully operational on the same runner', async () => {
    const h = harness();
    await h.runner.start({
      topic: 'Simulated topic',
      constraints: [],
      participants: LIVE_PARTICIPANTS,
      configuration: DEFAULT_CONFIGURATION,
      setup: { mode: 'simulation', scenario: 'early-convergence', pace: 'standard' },
    });
    await h.runner.whenIdle();
    const session = sessionOf(h.runner);
    expect(session.status).toMatchObject({ kind: 'completed', reason: 'early-convergence' });
    expect(session.contributions.every((contribution) => contribution.origin === 'simulated')).toBe(true);
    expect(h.chatgpt.submissions).toHaveLength(0);
  });

  it('does not start when preflight reports a missing capability', async () => {
    const h = harness();
    h.connections.unlink('claude');
    const result = await h.startLive();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('No Claude conversation is linked');
    }
    expect(h.runner.getSnapshot().session).toBeNull();
    expect(h.chatgpt.submissions).toHaveLength(0);
    expect(h.created).toEqual([]);
  });

  it('rejects a start command from a stale side panel', async () => {
    const h = harness();
    const shown = await h.preflight.run();
    h.connections.link('chatgpt'); // The link changed after the panel showed it.
    const gate = await prepareLiveStart(h.preflight, shown.revisions);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toContain('changed after this panel last showed it');
      expect(gate.preflight.issues.map((issue) => issue.code)).toEqual(['view-outdated']);
    }
  });

  it('never falls back to simulation when live adapters are unsupported', async () => {
    const h = harness({ adapters: createConsumerSiteAdapters() });
    const gate = await h.startLive();
    expect(gate.ok).toBe(false);

    // Even if a caller bypassed the preflight, no simulator is substituted: the runner refuses to start.
    const bypass = await h.runner.start({
      topic: 'T',
      constraints: [],
      participants: LIVE_PARTICIPANTS,
      configuration: DEFAULT_CONFIGURATION,
      setup: {
        mode: 'live',
        targets: {
          chatgpt: { provider: 'chatgpt', tabId: CHATGPT_TAB, conversationId: CHATGPT_CONVERSATION, linkRevision: 1 },
          claude: { provider: 'claude', tabId: 22, conversationId: 'c', linkRevision: 1 },
        },
      },
    });
    expect(bypass).toEqual({ ok: false, reason: 'No provider is registered for ChatGPT.' });
    expect(h.runner.getSnapshot().session).toBeNull();
    expect(h.created).toEqual(['live']);
  });

  it('stops the debate when a provider certainly failed', async () => {
    const h = harness({
      claude: {
        behave: (_s, index) =>
          index === 0
            ? { answer: withIssues('First.') }
            : { submitFailure: { kind: 'provider-error', outcome: 'not-performed', message: 'The provider refused the message.' } },
      },
      chatgpt: { behave: () => ({ answer: withIssues('View.') }) },
    });
    await h.startLive();
    await h.runner.whenIdle();
    const { status } = sessionOf(h.runner);
    expect(status).toMatchObject({ kind: 'failed', participantId: 'claude', error: 'Claude: The provider refused the message.' });
  });

  it('treats a response timeout as uncertain, never retries it, and re-issues only on explicit approval', async () => {
    let hang = true;
    const h = harness({
      responseTimeoutMs: 10,
      chatgpt: { behave: () => (hang ? 'hang' : { answer: withIssues('Recovered.') }) },
      claude: { behave: () => ({ answer: withIssues('View.') }) },
    });
    await h.startLive();
    await h.runner.whenIdle();

    let session = sessionOf(h.runner);
    const gpt = session.operations.find((operation) => operation.participantId === 'gpt');
    expect(gpt).toMatchObject({ status: 'uncertain', cause: 'unknown-outcome' });
    expect(gpt?.status === 'uncertain' && gpt.detail).toContain('may have been delivered');
    expect(session.status).toEqual({ kind: 'paused', reason: 'uncertain-outcome' });
    expect(h.chatgpt.submissions).toHaveLength(1);

    // Resuming is refused while the outcome is unknown; nothing is resent.
    expect((await h.runner.resume(session.id)).ok).toBe(false);
    await h.runner.whenIdle();
    expect(h.chatgpt.submissions).toHaveLength(1);

    // Explicit human approval, after a fresh continuation preflight.
    hang = false;
    const setup = h.runner.getSnapshot().setup;
    expect(setup?.mode).toBe('live');
    if (setup?.mode === 'live') {
      expect((await verifyLiveContinuation(h.preflight, setup)).ok).toBe(true);
    }
    expect(await h.runner.reissueUncertainOperation(gpt!.id, session.id)).toEqual({ ok: true });
    expect(await h.runner.resume(session.id)).toEqual({ ok: true });
    await h.runner.whenIdle();
    session = sessionOf(h.runner);
    expect(h.chatgpt.submissions).toHaveLength(5);
    expect(h.chatgpt.submissions[1]?.submission.operationId).toMatch(/:gpt:attempt-2$/);
    expect(session.status.kind).toBe('completed');
  });

  it.each(['conversation', 'page', 'submission', 'operation'] as const)(
    'rejects a response that belongs to another %s',
    async (mismatch) => {
      const h = harness({
        chatgpt: { behave: () => ({ mismatch }) },
        claude: { behave: () => ({ answer: withIssues('View.') }) },
      });
      await h.startLive();
      await h.runner.whenIdle();
      const session = sessionOf(h.runner);
      expect(session.contributions.some((contribution) => contribution.participantId === 'gpt')).toBe(false);
      expect(session.operations.find((operation) => operation.participantId === 'gpt')?.status).toBe('uncertain');
      expect(session.status).toEqual({ kind: 'paused', reason: 'uncertain-outcome' });
    },
  );

  it('discards a response when the tab navigated or reloaded while it was awaited', async () => {
    const h = harness({
      chatgpt: {
        behave: () => ({ answer: withIssues('Stale answer.') }),
        onSubmitted: () => {
          h.transport.reload(CHATGPT_TAB, 'chatgpt', CHATGPT_CONVERSATION, 'page-chatgpt-reloaded');
        },
      },
      claude: { behave: () => ({ answer: withIssues('View.') }) },
    });
    await h.startLive();
    await h.runner.whenIdle();
    const gpt = sessionOf(h.runner).operations.find((operation) => operation.participantId === 'gpt');
    expect(gpt).toMatchObject({ status: 'uncertain', cause: 'unknown-outcome' });
    expect(gpt?.status === 'uncertain' && gpt.detail).toContain('tab changed');
  });

  it('records the dispatch before submitting and recovers after a service worker restart without resending', async () => {
    const first = harness({ responseTimeoutMs: 60_000, chatgpt: { behave: () => 'hang' }, claude: { behave: () => 'hang' } });
    await first.startLive();
    // Let both submissions happen; responses never arrive.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const checkpoint = first.checkpoints.peek();
    expect(checkpoint?.session.operations.map((operation) => operation.status)).toEqual(['dispatched', 'dispatched']);
    expect(first.chatgpt.submissions).toHaveLength(1);
    // Stop the old runner's pending calls (its checkpoint has already been copied above).
    await first.runner.reset();

    // A new worker starts from the checkpoint; the old one is gone together with its in-flight calls.
    const second = harness({ checkpoint: checkpoint!, chatgpt: { behave: () => ({ answer: withIssues('x') }) } });
    await second.runner.initialize();
    await second.runner.whenIdle();
    const session = sessionOf(second.runner);
    expect(session.status).toEqual({ kind: 'paused', reason: 'runtime-restart' });
    expect(session.operations.every((operation) => operation.status === 'uncertain' && operation.cause === 'runtime-restart')).toBe(true);
    expect(second.created).toEqual(['live']);
    expect(second.chatgpt.submissions).toHaveLength(0);
    expect(second.claude.submissions).toHaveLength(0);
    expect((await second.runner.resume(session.id)).ok).toBe(false);

    // Continuing requires the same conversations as before.
    second.connections.link('chatgpt', {
      identity: { kind: 'saved', conversationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', canonicalUrl: 'x', source: 'selected' },
    });
    const setup = second.runner.getSnapshot().setup;
    if (setup?.mode !== 'live') throw new Error('Expected a live setup');
    const gate = await verifyLiveContinuation(second.preflight, setup);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toMatch(/^The live debate cannot continue: /);
    }
  });
});

describe('live contribution provider', () => {
  function provider(options: FakeAdapterOptions = {}, verify = true) {
    const fake = createFakeLiveAdapter('chatgpt', options);
    const transport = createFakeTransport();
    const target = { provider: 'chatgpt' as const, tabId: CHATGPT_TAB, conversationId: CHATGPT_CONVERSATION, pageInstanceId: 'page-chatgpt-1' };
    const live = createLiveContributionProvider({
      participantId: 'gpt',
      adapter: fake.adapter,
      binding: { provider: 'chatgpt', tabId: CHATGPT_TAB, conversationId: CHATGPT_CONVERSATION, linkRevision: 1 },
      verifyTarget: () =>
        Promise.resolve(
          verify
            ? { ok: true as const, target }
            : {
                ok: false as const,
                issue: { provider: 'chatgpt' as const, capability: 'connection' as const, code: 'link-stale' as const, message: 'The link is stale.' },
              },
        ),
      locks: createSubmissionLocks(),
      responseTimeoutMs: 50,
    });
    return { live, fake, transport };
  }

  it('sends nothing when the target changed before submission', async () => {
    const { live, fake } = provider({}, false);
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: { message: 'Nothing was sent to ChatGPT. The link is stale.' }, outcome: 'failed' });
    expect(fake.submissions).toHaveLength(0);
  });

  it('prevents concurrent submissions to the same conversation', async () => {
    const { live, fake } = provider({ behave: () => 'hang' });
    const controller = new AbortController();
    const first = live.requestContribution(request(), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await live.requestContribution(request({ operationId: 'other' }), { signal: new AbortController().signal });
    expect(second).toMatchObject({ ok: false, outcome: 'failed' });
    expect(second.ok === false && second.error.message).toContain('still in progress');
    expect(fake.submissions).toHaveLength(1);
    controller.abort();
    expect(await first).toMatchObject({ ok: false, outcome: 'unknown' });
    // The lock is released once the first call settled.
    const third = await live.requestContribution(request({ operationId: 'third' }), { signal: new AbortController().signal });
    expect(third.ok === false && third.error.message).not.toContain('still in progress');
  });

  it('reports an uncertain submission as unknown, not as a failure', async () => {
    const { live } = provider({
      behave: () => ({ submitFailure: { kind: 'transport-error', outcome: 'unknown', message: 'The connection dropped.' } }),
    });
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: { message: 'ChatGPT: The connection dropped.' }, outcome: 'unknown' });
  });

  it('refuses to act through an unauthorized route', async () => {
    const { live, fake } = provider({ authorization: { kind: 'not-authorized', reason: 'Not permitted.' } });
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: { message: 'Not permitted.' }, outcome: 'failed' });
    expect(fake.submissions).toHaveLength(0);
  });

  it('records a missing structured assessment as a material issue, so it never ends the debate early', async () => {
    const { live } = provider({ behave: () => ({ answer: 'An answer without an assessment.' }) });
    const result = await live.requestContribution(request(), { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: true, content: 'An answer without an assessment.' });
    expect(result.ok && result.assessment.materialIssues).toHaveLength(1);
  });
});
