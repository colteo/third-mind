import { useId } from 'react';
import type { ExecutionMode } from '../../application';

interface ModeSelectorProps {
  readonly mode: ExecutionMode;
  readonly onChange: (mode: ExecutionMode) => void;
}

const MODES: readonly { readonly id: ExecutionMode; readonly label: string; readonly description: string }[] = [
  {
    id: 'simulation',
    label: 'Simulation',
    description: 'Deterministic local simulators. Always available; no AI service is contacted.',
  },
  {
    id: 'live',
    label: 'Browser Conversations',
    description: 'Linked website conversations. Automated execution is currently unavailable.',
  },
];

/** Chooses the execution mode of the next debate. A running session's mode never changes. */
export function ModeSelector({ mode, onChange }: ModeSelectorProps) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Execution mode</h2>
      <fieldset className="field">
        <legend className="visually-hidden">Execution mode</legend>
        {MODES.map((option) => (
          <label key={option.id} className="radio">
            <input
              type="radio"
              name={`${id}-mode`}
              value={option.id}
              checked={mode === option.id}
              onChange={() => {
                onChange(option.id);
              }}
            />
            <span>
              <span className="radio-label">{option.label}</span>
              <span className="radio-description">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
