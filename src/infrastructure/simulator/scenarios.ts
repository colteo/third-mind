/**
 * Catalogue of deterministic simulation scenarios. Pure data, safe to import
 * from the UI for labels and descriptions.
 */
export type SimulationScenarioId = 'full-debate' | 'early-convergence' | 'provider-failure';

export interface SimulationScenario {
  readonly id: SimulationScenarioId;
  readonly label: string;
  readonly description: string;
}

export const SIMULATION_SCENARIOS: readonly SimulationScenario[] = [
  {
    id: 'full-debate',
    label: 'Full debate',
    description:
      'All four rounds run. One simulated participant still reports a material issue at the end.',
  },
  {
    id: 'early-convergence',
    label: 'Early convergence',
    description:
      'Both simulated participants report no material issues after Refinement, so the debate stops after round 3.',
  },
  {
    id: 'provider-failure',
    label: 'Provider failure',
    description: 'The Claude simulator fails during Cross-Examination, which stops the debate.',
  },
];

export const DEFAULT_SCENARIO_ID: SimulationScenarioId = 'full-debate';

export function isSimulationScenarioId(value: unknown): value is SimulationScenarioId {
  return SIMULATION_SCENARIOS.some((scenario) => scenario.id === value);
}

/**
 * Artificial latency of the simulated providers. Affects the mock providers
 * only; the engine and runner never wait on purpose.
 */
export type SimulationPaceId = 'standard' | 'slow';

export interface SimulationPace {
  readonly id: SimulationPaceId;
  readonly label: string;
  readonly description: string;
  readonly gptDelayMs: number;
  readonly claudeDelayMs: number;
}

export const SIMULATION_PACES: readonly SimulationPace[] = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'About 1.5 seconds per round.',
    gptDelayMs: 900,
    claudeDelayMs: 1400,
  },
  {
    id: 'slow',
    label: 'Slow',
    description: 'About 6 seconds per round. Leaves time to pause and add constraints when testing.',
    gptDelayMs: 4000,
    claudeDelayMs: 6000,
  },
];

export const DEFAULT_PACE_ID: SimulationPaceId = 'standard';

export function isSimulationPaceId(value: unknown): value is SimulationPaceId {
  return SIMULATION_PACES.some((pace) => pace.id === value);
}

export function simulationPace(id: SimulationPaceId): SimulationPace {
  const pace = SIMULATION_PACES.find((candidate) => candidate.id === id);
  if (pace === undefined) {
    throw new RangeError(`Unknown simulation pace "${id}".`);
  }
  return pace;
}

/** Composition-root setup persisted in checkpoints so providers can be recreated after a restart. */
export interface SimulationSetup {
  readonly scenario: SimulationScenarioId;
  readonly pace: SimulationPaceId;
}

export function isSimulationSetup(value: unknown): value is SimulationSetup {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scenario' in value &&
    isSimulationScenarioId(value.scenario) &&
    'pace' in value &&
    isSimulationPaceId(value.pace)
  );
}
