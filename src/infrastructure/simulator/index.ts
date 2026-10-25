/**
 * Deterministic provider simulator for Phase 1. Temporary infrastructure: it
 * implements the provider port and can be replaced by live adapters without
 * changing the domain or application layers.
 */
export {
  DEFAULT_SIMULATED_DELAYS,
  SIMULATION_PARTICIPANTS,
  createSimulatedProvider,
  createSimulatedProviders,
  delaysForPace,
  simulateContribution,
  type SimulatedProviderOptions,
  type SimulatedProvidersOptions,
} from './mock-provider';
export {
  DEFAULT_PACE_ID,
  DEFAULT_SCENARIO_ID,
  SIMULATION_PACES,
  SIMULATION_SCENARIOS,
  isSimulationPaceId,
  isSimulationScenarioId,
  isSimulationSetup,
  simulationPace,
  type SimulationPace,
  type SimulationPaceId,
  type SimulationScenario,
  type SimulationScenarioId,
  type SimulationSetup,
} from './scenarios';
export { PERSONA_SCRIPTS, SHARED_AGREEMENTS, type PersonaScript, type SimulatedPersonaId } from './scripts';
