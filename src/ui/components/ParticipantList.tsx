import { useId } from 'react';
import type { Participant } from '../../domain';

interface ParticipantListProps {
  readonly participants: readonly Participant[];
}

const ROLE_DESCRIPTIONS: Readonly<Record<Participant['providerType'], string>> = {
  human: 'Sets the question and constraints; can pause and intervene',
  'gpt-simulator': 'Deterministic stand-in for GPT. Not connected to ChatGPT',
  'claude-simulator': 'Deterministic stand-in for Claude. Not connected to Claude',
  'chatgpt-live': 'The linked ChatGPT conversation, through the ChatGPT live adapter',
  'claude-live': 'The linked Claude conversation, through the Claude live adapter',
};

function originBadge(providerType: Participant['providerType']): string | null {
  switch (providerType) {
    case 'human':
      return null;
    case 'gpt-simulator':
    case 'claude-simulator':
      return 'Simulated';
    case 'chatgpt-live':
    case 'claude-live':
      return 'Live';
  }
}

export function ParticipantList({ participants }: ParticipantListProps) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Participants</h2>
      <ul className="participants">
        {participants.map((participant) => {
          const badge = originBadge(participant.providerType);
          return (
            <li key={participant.id} className="participant">
              <span className="participant-name">
                {participant.displayName}
                {badge !== null && <span className="badge">{badge}</span>}
              </span>
              <span className="participant-role">{ROLE_DESCRIPTIONS[participant.providerType]}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
