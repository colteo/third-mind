import {
  decide,
  evolve,
  interventionIdsOf,
  providerParticipants,
  type ContributionRequest,
  type DebateCommand,
  type DebateConfiguration,
  type DebateEvent,
  type DebateSession,
  type EngineState,
  type OperationId,
  type Participant,
  type SessionId,
} from '../domain';
import type {
  CheckpointStore,
  Clock,
  ContributionProvider,
  IdGenerator,
  ProviderRegistry,
  ProviderResult,
} from '../ports';

export interface DebateRunnerDependencies<TSetup> {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly checkpoints: CheckpointStore<TSetup>;
  /** Creates the providers for a session. Called on start and after recovery. */
  readonly createProviders: (setup: TSetup) => ProviderRegistry;
  readonly reportError: (error: unknown) => void;
}

export interface StartDebateInput<TSetup> {
  readonly topic: string;
  readonly constraints: readonly string[];
  readonly participants: readonly Participant[];
  readonly configuration: DebateConfiguration;
  readonly setup: TSetup;
}

export interface RunnerSnapshot<TSetup> {
  readonly session: DebateSession | null;
  readonly setup: TSetup | null;
}

export type RunnerResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type SnapshotListener<TSetup> = (snapshot: RunnerSnapshot<TSetup>) => void;

export interface DebateRunner<TSetup> {
  /**
   * Restores a checkpointed session, if any. In-flight work from before the restart becomes uncertain.
   * Recovery never re-dispatches anything: the session stays paused until the human acts.
   */
  initialize(): Promise<void>;
  getSnapshot(): RunnerSnapshot<TSetup>;
  subscribe(listener: SnapshotListener<TSetup>): () => void;
  start(input: StartDebateInput<TSetup>): Promise<RunnerResult>;
  /*
   * Human actions. When `target` is given, the action is rejected unless it
   * refers to the current session. Clients pass the id of the session they
   * displayed, so a command issued from a stale view (for example, after
   * another panel reset the session and started a new one) never acts on a
   * different session.
   */
  pause(target?: SessionId): Promise<RunnerResult>;
  resume(target?: SessionId): Promise<RunnerResult>;
  addConstraint(content: string, target?: SessionId): Promise<RunnerResult>;
  /** Explicit human approval to re-issue an uncertain operation, accepting possible duplication. */
  reissueUncertainOperation(operationId: OperationId, target?: SessionId): Promise<RunnerResult>;
  /**
   * Discards the session, cancels in-flight provider calls where supported and clears the checkpoint.
   * Succeeds without effect when `target` names a session that has already been discarded.
   */
  reset(target?: SessionId): Promise<RunnerResult>;
  /** Resolves once no provider call is in flight and no work is queued. */
  whenIdle(): Promise<void>;
}

const OK: RunnerResult = { ok: true };
const MAX_DECISION_STEPS = 1000;

/**
 * Imperative shell around the pure debate engine.
 *
 * Responsibilities:
 * - serialize every state change (human actions and provider results);
 * - turn `decide` commands into events, stamping time and identifiers;
 * - persist a checkpoint after every applied event, and before any provider
 *   call is made (write-ahead), so a restart can distinguish "never sent" from
 *   "possibly sent";
 * - invoke providers and feed their results back as events.
 */
export function createDebateRunner<TSetup>(deps: DebateRunnerDependencies<TSetup>): DebateRunner<TSetup> {
  let session: EngineState = null;
  let setup: TSetup | null = null;
  let providers: ProviderRegistry = new Map();
  let initialized = false;
  const inFlight = new Map<OperationId, AbortController>();
  const pendingCalls = new Set<Promise<void>>();
  const listeners = new Set<SnapshotListener<TSetup>>();
  let tail: Promise<unknown> = Promise.resolve();

  /** Runs tasks strictly one after another, so events are applied in a single order. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  }

  function getSnapshot(): RunnerSnapshot<TSetup> {
    return { session, setup };
  }

  function notify(): void {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        deps.reportError(error);
      }
    }
  }

  async function persist(): Promise<void> {
    if (session === null || setup === null) {
      await deps.checkpoints.clear();
      return;
    }
    await deps.checkpoints.save({ version: 1, session, setup });
  }

  /** Applies one event; on success persists the new state and notifies listeners. */
  async function record(event: DebateEvent): Promise<RunnerResult> {
    const result = evolve(session, event);
    if (result.outcome === 'rejected') {
      return { ok: false, reason: result.reason };
    }
    if (result.outcome === 'applied') {
      session = result.state;
      await persist();
      notify();
    }
    return OK;
  }

  /** For events derived from `decide`: a rejection means the engine contradicts itself. */
  async function recordDecided(event: DebateEvent): Promise<void> {
    const result = await record(event);
    if (!result.ok) {
      throw new Error(`Engine invariant violated: ${event.type} was rejected: ${result.reason}`);
    }
  }

  async function drive(): Promise<void> {
    for (let step = 0; step < MAX_DECISION_STEPS; step += 1) {
      const commands = decide(session);
      if (commands.length === 0) {
        return;
      }
      for (const command of commands) {
        await execute(command);
      }
    }
    throw new Error('The debate engine did not settle.');
  }

  async function execute(command: DebateCommand): Promise<void> {
    const at = deps.clock.now();
    switch (command.type) {
      case 'RequestContribution':
        await recordDecided({ type: 'ContributionRequested', at, operation: command.operation });
        return;
      case 'DispatchContribution':
        // Write-ahead: the dispatch is persisted before the provider is called.
        await recordDecided({
          type: 'ContributionDispatched',
          at,
          operationId: command.operationId,
          interventionIds: interventionIdsOf(command.request),
        });
        callProvider(command.request);
        return;
      case 'AdvanceRound':
        await recordDecided({ type: 'RoundAdvanced', at, toRound: command.toRound });
        return;
      case 'CompleteDebate':
        await recordDecided({
          type: 'DebateCompleted',
          at,
          reason: command.reason,
          finalRound: command.finalRound,
        });
        return;
      case 'ConfirmPause':
        await recordDecided({ type: 'DebatePaused', at });
        return;
    }
  }

  function callProvider(request: ContributionRequest): void {
    const provider = providers.get(request.participantId);
    const controller = new AbortController();
    inFlight.set(request.operationId, controller);

    const call: Promise<void> = invokeProvider(provider, request, controller.signal)
      .then((result) =>
        serialized(async () => {
          inFlight.delete(request.operationId);
          if (controller.signal.aborted || session?.id !== request.sessionId) {
            return; // The session was reset; the result belongs to nobody.
          }
          const at = deps.clock.now();
          const event: DebateEvent = result.ok
            ? {
                type: 'ContributionReceived',
                at,
                operationId: request.operationId,
                contributionId: deps.ids.newId('contribution'),
                content: result.content,
                assessment: result.assessment,
                origin: provider?.origin ?? 'live',
              }
            : result.outcome === 'unknown'
              ? // Never treated as a failure and never retried: the request may have been acted on.
                { type: 'ContributionOutcomeUncertain', at, operationId: request.operationId, detail: result.error.message }
              : { type: 'ContributionFailed', at, operationId: request.operationId, error: result.error.message };
          const recorded = await record(event);
          if (!recorded.ok) {
            deps.reportError(new Error(`Result for ${request.operationId} was rejected: ${recorded.reason}`));
          }
          await drive();
        }),
      )
      .catch(deps.reportError)
      .finally(() => {
        pendingCalls.delete(call);
      });
    pendingCalls.add(call);
  }

  function staleTarget(target: SessionId | undefined): RunnerResult | null {
    if (target === undefined || session?.id === target) {
      return null;
    }
    return {
      ok: false,
      reason:
        session === null
          ? 'That debate session no longer exists. The panel has been updated with the current state.'
          : 'That command was meant for an earlier debate session and was ignored.',
    };
  }

  function humanAction(target: SessionId | undefined, createEvent: () => DebateEvent): Promise<RunnerResult> {
    return serialized(async () => {
      const stale = staleTarget(target);
      if (stale !== null) {
        return stale;
      }
      const result = await record(createEvent());
      if (result.ok) {
        await drive();
      }
      return result;
    });
  }

  return {
    initialize: () =>
      serialized(async () => {
        if (initialized) {
          return;
        }
        initialized = true;
        const checkpoint = await deps.checkpoints.load();
        if (checkpoint === null) {
          return;
        }
        session = checkpoint.session;
        setup = checkpoint.setup;
        providers = deps.createProviders(checkpoint.setup);
        await recordDecided({ type: 'RuntimeRecovered', at: deps.clock.now() });
      }),

    getSnapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start: (input) =>
      serialized(async () => {
        if (session !== null) {
          return { ok: false, reason: 'A session already exists. Reset it before starting a new debate.' };
        }
        const created = evolve(null, {
          type: 'SessionCreated',
          at: deps.clock.now(),
          sessionId: deps.ids.newId('session'),
          topic: input.topic,
          constraints: input.constraints,
          participants: input.participants,
          configuration: input.configuration,
        });
        if (created.outcome !== 'applied') {
          return { ok: false, reason: created.reason };
        }
        const sessionProviders = deps.createProviders(input.setup);
        const unbound = providerParticipants(created.state).find((p) => !sessionProviders.has(p.id));
        if (unbound !== undefined) {
          return { ok: false, reason: `No provider is registered for ${unbound.displayName}.` };
        }
        session = created.state;
        setup = input.setup;
        providers = sessionProviders;
        await persist();
        notify();
        await recordDecided({ type: 'DebateStarted', at: deps.clock.now() });
        await drive();
        return OK;
      }),

    pause: (target) => humanAction(target, () => ({ type: 'PauseRequested', at: deps.clock.now() })),

    resume: (target) => humanAction(target, () => ({ type: 'DebateResumed', at: deps.clock.now() })),

    addConstraint: (content, target) =>
      humanAction(target, () => ({
        type: 'HumanConstraintAdded',
        at: deps.clock.now(),
        interventionId: deps.ids.newId('intervention'),
        content,
      })),

    reissueUncertainOperation: (operationId, target) =>
      humanAction(target, () => ({ type: 'UncertainOperationReissued', at: deps.clock.now(), operationId })),

    reset: (target) =>
      serialized(async () => {
        if (target !== undefined && session === null) {
          return OK; // Already discarded, for example from another panel.
        }
        const stale = staleTarget(target);
        if (stale !== null) {
          return stale;
        }
        for (const controller of inFlight.values()) {
          controller.abort();
        }
        inFlight.clear();
        session = null;
        setup = null;
        providers = new Map();
        await deps.checkpoints.clear();
        notify();
        return OK;
      }),

    async whenIdle() {
      for (;;) {
        await tail;
        if (pendingCalls.size === 0) {
          return;
        }
        await Promise.allSettled([...pendingCalls]);
      }
    },
  };
}

async function invokeProvider(
  provider: ContributionProvider | undefined,
  request: ContributionRequest,
  signal: AbortSignal,
): Promise<ProviderResult> {
  if (provider === undefined) {
    return { ok: false, error: { message: `No provider is registered for participant "${request.participantId}".` } };
  }
  try {
    return await provider.requestContribution(request, { signal });
  } catch (error) {
    return { ok: false, error: { message: describeError(error) } };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'The provider failed without an error message.';
}
