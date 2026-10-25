/**
 * Test fixtures and a synchronous driver for the pure engine. Test-only code;
 * excluded from coverage.
 */
import {
  DEFAULT_CONFIGURATION,
  HUMAN_PARTICIPANT,
  decide,
  evolve,
  interventionIdsOf,
  type ContributionRequest,
  type ConvergenceAssessment,
  type DebateCommand,
  type DebateConfiguration,
  type DebateEvent,
  type DebateSession,
  type EngineState,
  type Participant,
  type SessionCreated,
} from '../domain';

export const SESSION_ID = 'session-test';

export const PARTICIPANTS: readonly Participant[] = [
  HUMAN_PARTICIPANT,
  { id: 'gpt', displayName: 'GPT Simulator', providerType: 'gpt-simulator' },
  { id: 'claude', displayName: 'Claude Simulator', providerType: 'claude-simulator' },
];

/** Deterministic, obviously synthetic timestamps: 2000-01-01T00:00:00Z plus `n` seconds. */
export function at(n: number): string {
  return new Date(Date.UTC(2000, 0, 1, 0, 0, 0) + n * 1000).toISOString();
}

export function createTestClock(): { now(): string } {
  let tick = 0;
  return {
    now: () => {
      tick += 1;
      return at(tick);
    },
  };
}

export function createTestIds(): { newId(prefix: string): string } {
  let counter = 0;
  return {
    newId: (prefix) => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

export function createdEvent(overrides: Partial<SessionCreated> = {}): SessionCreated {
  return {
    type: 'SessionCreated',
    at: at(0),
    sessionId: SESSION_ID,
    topic: 'Should the team adopt a four-day work week?',
    constraints: ['Customer support coverage must not drop'],
    participants: PARTICIPANTS,
    configuration: DEFAULT_CONFIGURATION,
    ...overrides,
  };
}

/** Applies an event and fails the test unless it was applied. */
export function applyOk(state: EngineState, event: DebateEvent): DebateSession {
  const result = evolve(state, event);
  if (result.outcome !== 'applied') {
    throw new Error(`Expected ${event.type} to be applied but it was ${result.outcome}: ${result.reason}`);
  }
  return result.state;
}

export function applyAllOk(state: EngineState, events: readonly DebateEvent[]): DebateSession {
  let current = state;
  for (const event of events) {
    current = applyOk(current, event);
  }
  if (current === null) {
    throw new Error('No session after applying events.');
  }
  return current;
}

export function startedSession(configuration: Partial<DebateConfiguration> = {}): DebateSession {
  return applyAllOk(null, [
    createdEvent({ configuration: { ...DEFAULT_CONFIGURATION, ...configuration } }),
    { type: 'DebateStarted', at: at(1) },
  ]);
}

export function assessment(materialIssues: readonly string[] = []): ConvergenceAssessment {
  return { materialIssues, openQuestions: [], agreements: [] };
}

export const WITH_ISSUES = assessment(['An issue remains.']);
export const NO_ISSUES = assessment();

export type Responder = (request: ContributionRequest) => ConvergenceAssessment | { readonly fail: string };

export interface ShellOptions {
  /** Called for every dispatched request, in order. */
  readonly onDispatch?: (request: ContributionRequest) => void;
  readonly maxSteps?: number;
}

/**
 * Synchronous stand-in for the application runner: executes `decide`
 * commands and answers every dispatch immediately via `respond`, until the
 * engine has nothing more to do.
 */
export function settle(session: DebateSession, respond: Responder, options: ShellOptions = {}): DebateSession {
  let state = session;
  let clock = 1000;
  let contributionCounter = 0;
  const maxSteps = options.maxSteps ?? 200;
  for (let step = 0; step < maxSteps; step += 1) {
    const commands = decide(state);
    if (commands.length === 0) {
      return state;
    }
    for (const command of commands) {
      clock += 1;
      state = applyOk(state, commandToEvent(command, at(clock)));
      if (command.type === 'DispatchContribution') {
        options.onDispatch?.(command.request);
        const answer = respond(command.request);
        clock += 1;
        contributionCounter += 1;
        state = applyOk(
          state,
          'fail' in answer
            ? { type: 'ContributionFailed', at: at(clock), operationId: command.operationId, error: answer.fail }
            : {
                type: 'ContributionReceived',
                at: at(clock),
                operationId: command.operationId,
                contributionId: `contribution-${contributionCounter}`,
                content: `Position: ${command.request.participantId} in round ${command.request.round}`,
                assessment: answer,
                origin: 'simulated',
              },
        );
      }
    }
  }
  throw new Error('The engine did not settle.');
}

/** Executes `decide` commands without answering dispatches (operations stay in flight). */
export function step(session: DebateSession, timestamp: string): { state: DebateSession; commands: readonly DebateCommand[] } {
  const commands = decide(session);
  let state = session;
  for (const command of commands) {
    state = applyOk(state, commandToEvent(command, timestamp));
  }
  return { state, commands };
}

export function commandToEvent(command: DebateCommand, timestamp: string): DebateEvent {
  switch (command.type) {
    case 'RequestContribution':
      return { type: 'ContributionRequested', at: timestamp, operation: command.operation };
    case 'DispatchContribution':
      return {
        type: 'ContributionDispatched',
        at: timestamp,
        operationId: command.operationId,
        interventionIds: interventionIdsOf(command.request),
      };
    case 'AdvanceRound':
      return { type: 'RoundAdvanced', at: timestamp, toRound: command.toRound };
    case 'CompleteDebate':
      return { type: 'DebateCompleted', at: timestamp, reason: command.reason, finalRound: command.finalRound };
    case 'ConfirmPause':
      return { type: 'DebatePaused', at: timestamp };
  }
}

export function received(operationId: string, timestamp: string, contributionId: string, content = 'Position: test'): DebateEvent {
  return {
    type: 'ContributionReceived',
    at: timestamp,
    operationId,
    contributionId,
    content,
    assessment: WITH_ISSUES,
    origin: 'simulated',
  };
}
