import { describe, expect, it } from 'vitest';
import { parseDebateSetup } from './debate-setup';

const targets = {
  chatgpt: { provider: 'chatgpt', tabId: 1, conversationId: 'a', linkRevision: 2 },
  claude: { provider: 'claude', tabId: 2, conversationId: 'b', linkRevision: 3 },
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

  it.each<[unknown]>([
    [null],
    [{ mode: 'live' }],
    [{ mode: 'live', targets: { chatgpt: targets.chatgpt } }],
    [{ mode: 'live', targets: { ...targets, claude: { ...targets.claude, provider: 'chatgpt' } } }],
    [{ mode: 'remote', scenario: 'full-debate', pace: 'slow' }],
    [{ mode: 'simulation', scenario: 'unknown', pace: 'slow' }],
  ])('rejects malformed setups %#', (value) => {
    expect(parseDebateSetup(value)).toBeNull();
  });
});
