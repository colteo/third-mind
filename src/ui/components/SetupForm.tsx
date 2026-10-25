import { useId, useState, type FormEvent } from 'react';
import { MAX_CONSTRAINT_LENGTH, MAX_CONSTRAINTS, MAX_TOPIC_LENGTH } from '../../domain';
import {
  DEFAULT_PACE_ID,
  DEFAULT_SCENARIO_ID,
  SIMULATION_PACES,
  SIMULATION_SCENARIOS,
  type SimulationPaceId,
  type SimulationScenarioId,
} from '../../infrastructure/simulator/scenarios';

export interface SetupValues {
  readonly topic: string;
  readonly constraints: readonly string[];
  readonly scenario: SimulationScenarioId;
  readonly pace: SimulationPaceId;
}

interface SetupFormProps {
  readonly onStart: (values: SetupValues) => void;
}

export type TopicAndConstraints =
  | { readonly ok: true; readonly topic: string; readonly constraints: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Validation shared by the simulated and the live setup forms. */
export function parseTopicAndConstraints(topic: string, constraintsText: string): TopicAndConstraints {
  const constraints = constraintsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (topic.trim().length === 0) {
    return { ok: false, error: 'Enter a debate topic.' };
  }
  if (constraints.length > MAX_CONSTRAINTS) {
    return { ok: false, error: `Enter at most ${MAX_CONSTRAINTS} constraints.` };
  }
  if (constraints.some((c) => c.length > MAX_CONSTRAINT_LENGTH)) {
    return { ok: false, error: `Each constraint must be at most ${MAX_CONSTRAINT_LENGTH} characters.` };
  }
  return { ok: true, topic: topic.trim(), constraints };
}

interface TopicFieldsProps {
  readonly id: string;
  readonly topic: string;
  readonly constraintsText: string;
  readonly error: string | null;
  readonly onTopicChange: (topic: string) => void;
  readonly onConstraintsChange: (text: string) => void;
}

export function TopicFields(props: TopicFieldsProps) {
  const { id, topic, constraintsText, error } = props;
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-topic`}>Debate topic</label>
        <textarea
          id={`${id}-topic`}
          rows={3}
          maxLength={MAX_TOPIC_LENGTH}
          value={topic}
          onChange={(e) => {
            props.onTopicChange(e.target.value);
          }}
          aria-invalid={error !== null && topic.trim().length === 0}
          aria-describedby={error !== null ? `${id}-error` : undefined}
          placeholder="Should our team migrate the billing service to a new database this quarter?"
        />
      </div>

      <div className="field">
        <label htmlFor={`${id}-constraints`}>
          Constraints <span className="muted">(optional, one per line)</span>
        </label>
        <textarea
          id={`${id}-constraints`}
          rows={3}
          value={constraintsText}
          onChange={(e) => {
            props.onConstraintsChange(e.target.value);
          }}
          placeholder="No downtime during business hours"
        />
      </div>
    </>
  );
}

export function SetupForm({ onStart }: SetupFormProps) {
  const id = useId();
  const [topic, setTopic] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const [scenario, setScenario] = useState<SimulationScenarioId>(DEFAULT_SCENARIO_ID);
  const [pace, setPace] = useState<SimulationPaceId>(DEFAULT_PACE_ID);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseTopicAndConstraints(topic, constraintsText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onStart({ topic: parsed.topic, constraints: parsed.constraints, scenario, pace });
  };

  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>New simulated debate</h2>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <TopicFields
          id={id}
          topic={topic}
          constraintsText={constraintsText}
          error={error}
          onTopicChange={setTopic}
          onConstraintsChange={setConstraintsText}
        />

        <fieldset className="field">
          <legend>Simulation scenario</legend>
          {SIMULATION_SCENARIOS.map((option) => (
            <label key={option.id} className="radio">
              <input
                type="radio"
                name={`${id}-scenario`}
                value={option.id}
                checked={scenario === option.id}
                onChange={() => {
                  setScenario(option.id);
                }}
              />
              <span>
                <span className="radio-label">{option.label}</span>
                <span className="radio-description">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="field">
          <legend>Simulated response pace</legend>
          {SIMULATION_PACES.map((option) => (
            <label key={option.id} className="radio">
              <input
                type="radio"
                name={`${id}-pace`}
                value={option.id}
                checked={pace === option.id}
                onChange={() => {
                  setPace(option.id);
                }}
              />
              <span>
                <span className="radio-label">{option.label}</span>
                <span className="radio-description">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {error !== null && (
          <p id={`${id}-error`} className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="button button-primary">
          Start debate
        </button>
      </form>
    </section>
  );
}
