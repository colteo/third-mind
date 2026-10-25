import { createFixtureHandler } from './content';
import { fixtureChrome as chrome } from './chrome';
const handle = createFixtureHandler(document, () => location.href, crypto.randomUUID());
chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return;
  const result = handle(raw);
  if (result !== null) respond(result);
});
