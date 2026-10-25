import { useId, useState, type FormEvent } from 'react';
import {
  CAPABILITY_NAMES,
  type CapabilityCheck,
  type CapabilityName,
  type LinkRevisions,
  type LivePreflightResult,
  type PreflightTarget,
  type ProviderPreflight,
} from '../../application';
import { providerLabel, shortConversationId } from '../format';
import { TopicFields, parseTopicAndConstraints } from './SetupForm';

export interface LiveStartValues {
  readonly topic: string;
  readonly constraints: readonly string[];
  readonly expectedRevisions: LinkRevisions;
}

interface LiveDebateSetupProps {
  /** Latest preflight result, or `null` before the first one arrived. */
  readonly readiness: LivePreflightResult | null;
  /** Link revisions of the connections view the panel currently shows; `null` before it arrived. */
  readonly currentRevisions: LinkRevisions | null;
  readonly onCheck: () => void;
  readonly onStart: (values: LiveStartValues) => void;
}

/**
 * - `checking`: no preflight result yet, or the result was made against links
 *   that have changed since (the panel requests a new check);
 * - `ready`: the latest preflight, for the links shown, reports every capability available;
 * - `blocked`: at least one required capability is unavailable.
 */
export type LiveStartState = 'checking' | 'ready' | 'blocked';

export function liveStartState(readiness: LivePreflightResult | null, current: LinkRevisions | null): LiveStartState {
  if (readiness === null || current === null) {
    return 'checking';
  }
  if (readiness.revisions.chatgpt !== current.chatgpt || readiness.revisions.claude !== current.claude) {
    return 'checking';
  }
  return readiness.ready ? 'ready' : 'blocked';
}

export const CAPABILITY_LABELS: Readonly<Record<CapabilityName, string>> = {
  connection: 'Linked conversation or new chat',
  transport: 'Page connection',
  submission: 'Message submission',
  responseAcquisition: 'Response acquisition',
  authorization: 'Authorized automation route',
};

/**
 * How the panel describes a provider's live target. A new chat is a valid
 * target: its conversation is created by the debate's first message.
 */
export function targetDescription(target: PreflightTarget | null): string {
  if (target === null) {
    return 'none available';
  }
  return target.kind === 'conversation'
    ? `saved conversation ${shortConversationId(target.conversationId)}`
    : "new chat (the debate's first message creates the conversation, which ThirdMind then binds)";
}

function readinessBadge(provider: ProviderPreflight): string {
  if (!provider.ready) {
    return 'Not ready';
  }
  return provider.target?.kind === 'new-chat' ? 'Ready: new chat' : 'Ready: saved conversation';
}

function checkLabel(check: CapabilityCheck): string {
  switch (check.status) {
    case 'available':
      return 'Available';
    case 'unavailable':
      return 'Unavailable';
    case 'not-checked':
      return 'Not checked';
  }
}

function checkDetail(check: CapabilityCheck): string | null {
  switch (check.status) {
    case 'available':
      return null;
    case 'unavailable':
      return check.issue.message;
    case 'not-checked':
      return check.reason;
  }
}

/**
 * Live debate setup. The Start Live Debate control exists only while the
 * latest preflight, made against the links this panel shows, reports both
 * providers technically ready and authorized. Otherwise the panel explains
 * every missing capability instead. The host checks everything again when
 * the command arrives.
 */
export function LiveDebateSetup({ readiness, currentRevisions, onCheck, onStart }: LiveDebateSetupProps) {
  const id = useId();
  const [topic, setTopic] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const state = liveStartState(readiness, currentRevisions);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state !== 'ready' || readiness === null) {
      return;
    }
    const parsed = parseTopicAndConstraints(topic, constraintsText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onStart({ topic: parsed.topic, constraints: parsed.constraints, expectedRevisions: readiness.revisions });
  };

  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <div className="card-heading">
        <h2 id={`${id}-heading`}>New live debate</h2>
        <button type="button" className="button" onClick={onCheck}>
          Check again
        </button>
      </div>
      <p className="hint">
        A live debate runs between the linked ChatGPT and Claude targets without manual copying. Each target can be a
        saved conversation or a new chat: a new chat receives the debate&rsquo;s first message, and ThirdMind binds
        the conversation it creates. It starts only when both providers are technically ready <em>and</em> reached
        through an authorized automation route. Reaching a provider page is not the same as being permitted to
        automate it.
      </p>

      {state === 'checking' && <p className="muted">Checking live readiness…</p>}

      {readiness !== null && (
        <div className="live-providers">
          {readiness.providers.map((provider) => (
            <ProviderReadiness key={provider.provider} provider={provider} />
          ))}
        </div>
      )}

      {state === 'blocked' && readiness !== null && (
        <div className="notice notice-warning live-blockers" role="status">
          <p className="live-blockers-title">A live debate cannot start:</p>
          <ul>
            {readiness.issues.map((issue) => (
              <li key={`${issue.provider}-${issue.capability}`}>
                <strong>
                  {providerLabel(issue.provider)}, {CAPABILITY_LABELS[issue.capability].toLowerCase()}:
                </strong>{' '}
                {issue.message}
              </li>
            ))}
          </ul>
          <p className="hint">Simulation mode stays available and is not affected.</p>
        </div>
      )}

      {state === 'ready' && (
        <form className="form" onSubmit={handleSubmit} noValidate>
          <TopicFields
            id={id}
            topic={topic}
            constraintsText={constraintsText}
            error={error}
            onTopicChange={setTopic}
            onConstraintsChange={setConstraintsText}
          />
          {error !== null && (
            <p id={`${id}-error`} className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button-primary">
            Start Live Debate
          </button>
        </form>
      )}
    </section>
  );
}

function ProviderReadiness({ provider }: { readonly provider: ProviderPreflight }) {
  const label = providerLabel(provider.provider);
  return (
    <div className="live-provider">
      <h3>
        {label}{' '}
        <span className={provider.ready ? 'badge badge-ready' : 'badge'}>{readinessBadge(provider)}</span>
      </h3>
      <p className="muted">Target: {targetDescription(provider.target)}</p>
      <p className="muted">
        Route: {provider.route?.label ?? 'no live adapter installed'} · Technical readiness:{' '}
        {provider.technicallyReady ? 'yes' : 'no'} · Authorization: {provider.authorized ? 'yes' : 'no'}
      </p>
      <ul className="capabilities">
        {CAPABILITY_NAMES.map((name) => {
          const check = provider.capabilities[name];
          const detail = checkDetail(check);
          return (
            <li key={name} className={`capability capability-${check.status}`}>
              <span className="capability-name">{CAPABILITY_LABELS[name]}</span>
              <span className="capability-status">{checkLabel(check)}</span>
              {detail !== null && <span className="capability-detail">{detail}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
