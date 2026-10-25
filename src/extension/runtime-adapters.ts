import type { Clock, IdGenerator } from '../ports';

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const randomIds: IdGenerator = {
  newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
};
