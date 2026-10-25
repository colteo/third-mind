import { describe, expect, it } from 'vitest';
import { parseDebateSetup } from './debate-setup';

const targets = {
  chatgpt: { kind: 'conversation', provider: 'chatgpt', tabId: 1, conversationId: 'a', linkRevision: 2, source: 'linked' },
  claude: {
    kind: 'new-chat',
    provider: 'claude',
    tabId: 2,
    origin: 'https://claude.ai',
    pageInstanceId: 'page-1',
    linkRevision: 3,
  },
};

describe('checkpointed debate setup', () => {
  it('reads simulation setups written before execution modes existed', () => {
    expect(parseDebateSetup({ scenario: 'full-debate', pace: 'slow' })).toEqual({
      mode: 'simulation',
      scenario: 'full-debate',
      pace: 'slow',
    });
  });

  it('reads current simulation and live setups', () => {
    expect(parseDebateSetup({ mode: 'simulation', scenario: 'early-convergence', pace: 'standard' })).toEqual({
      mode: 'simulation',
      scenario: 'early-convergence',
      pace: 'standard',
    });
    expect(parseDebateSetup({ mode: 'live', targets })).toEqual({ mode: 'live', targets });
  });

  it('reads live setups written before new chats could be live targets as saved conversations', () => {
    const legacy = { provider: 'chatgpt', tabId: 1, conversationId: 'a', linkRevision: 2 };
    expect(parseDebateSetup({ mode: 'live', targets: { ...targets, chatgpt: legacy } })).toEqual({
      mode: 'live',
      targets: { ...targets, chatgpt: { ...legacy, kind: 'conversation', source: 'linked' } },
    });
  });

  it.each<[unknown]>([
    [null],
    [{ mode: 'live' }],
    [{ mode: 'live', targets: { chatgpt: targets.chatgpt } }],
    [{ mode: 'live', targets: { ...targets, claude: { ...targets.claude, provider: 'chatgpt' } } }],
    // A new chat is never stored without the document it was approved for, and never with an invented id.
    [{ mode: 'live', targets: { ...targets, claude: { ...targets.claude, pageInstanceId: undefined } } }],
    [{ mode: 'live', targets: { ...targets, claude: { ...targets.claude, kind: 'pending' } } }],
    [{ mode: 'remote', scenario: 'full-debate', pace: 'slow' }],
    [{ mode: 'simulation', scenario: 'unknown', pace: 'slow' }],
  ])('rejects malformed setups %#', (value) => {
    expect(parseDebateSetup(value)).toBeNull();
  });
});
