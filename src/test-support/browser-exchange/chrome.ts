import type { FixtureFrame } from './adapter';
/** Small structural API surface; the fixture has its own manifest and profile. */
export interface FixtureChrome {
  runtime: { id: string; onMessage: { addListener(listener: (raw: unknown, sender: { id?: string; tab?: unknown; url?: string }, respond: (value: unknown) => void) => void): void } };
  tabs: {
    create(options: { url: string }): Promise<{ id: number }>;
    update(tabId: number, options: { url: string }): Promise<unknown>;
    reload(tabId: number): Promise<void>;
    remove(tabId: number): Promise<void>;
    sendMessage(tabId: number, message: unknown, options: { documentId: string }): Promise<unknown>;
  };
  webNavigation: { getFrame(options: { tabId: number; frameId: number }): Promise<FixtureFrame | null> };
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> } };
}
export const fixtureChrome = (globalThis as unknown as { chrome: FixtureChrome }).chrome;
