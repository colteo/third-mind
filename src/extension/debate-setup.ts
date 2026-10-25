import { parseLiveDebateSetup, type LiveDebateSetup } from '../application';
import { isSimulationSetup, type SimulationSetup } from '../infrastructure/simulator';

/**
 * Setup checkpointed with every session. The mode is part of it, so a
 * restored session recreates exactly the kind of providers it started with:
 * a live session is never restored with simulators, or the other way round.
 */
export type SimulationDebateSetup = { readonly mode: 'simulation' } & SimulationSetup;

export type DebateSetup = SimulationDebateSetup | LiveDebateSetup;

/**
 * Reads a checkpointed setup. Simulation setups written before execution
 * modes existed have no `mode` field and are read as simulation setups.
 * Anything else, including a `mode` that is neither mode, is rejected.
 */
export function parseDebateSetup(value: unknown): DebateSetup | null {
  const live = parseLiveDebateSetup(value);
  if (live !== null) {
    return live;
  }
  if (!isSimulationSetup(value)) {
    return null;
  }
  const mode = (value as { readonly mode?: unknown }).mode;
  return mode === undefined || mode === 'simulation'
    ? { mode: 'simulation', scenario: value.scenario, pace: value.pace }
    : null;
}
