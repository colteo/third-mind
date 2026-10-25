import { expect, it } from 'vitest';
import { isSidePanelSender } from './side-panel-sender';
it('only the extension side panel can issue commands, never content scripts or webpages', () => {
  const id = 'a'.repeat(32);
  const panelUrl = `chrome-extension://${id}/sidepanel.html`;
  expect(isSidePanelSender({ id, url: panelUrl }, id, panelUrl)).toBe(true);
  expect(isSidePanelSender({ id, url: 'https://chatgpt.com/', tab: { id: 1 } }, id, panelUrl)).toBe(false);
  expect(isSidePanelSender({ id, url: panelUrl, tab: { id: 1 } }, id, panelUrl)).toBe(false);
  expect(isSidePanelSender({ id, url: 'https://evil.example' }, id, panelUrl)).toBe(false);
  expect(isSidePanelSender({ id: 'another', url: panelUrl }, id, panelUrl)).toBe(false);
});
