import { CHANNEL, MAX_TEXT, fixtureConversation, parseRequest, type FixtureReply } from './protocol';

/** Only installed by the isolated fixture manifest. Never imported by provider entrypoints. */
export function createFixtureHandler(document: Document, href: () => string, pageInstanceId: string) {
  const handled = new Map<string, { text: string; submissionId: string; accepted: boolean }>();
  return (raw: unknown): FixtureReply | null => {
    const request = parseRequest(raw);
    const conversationId = fixtureConversation(href());
    if (request === null || conversationId === false) return null;
    const reply: FixtureReply = { channel: CHANNEL, version: 1, pageInstanceId, operationId: '', submissionId: '', state: 'ready', conversationId, content: '', acceptedCount: document.querySelectorAll('[data-fixture-ack]').length };
    if (request.type === 'probe') return reply;
    reply.operationId = request.operationId;
    if (request.pageInstanceId !== pageInstanceId) return { ...reply, state: 'refused' };
    if (request.type === 'submit') {
      const previous = handled.get(request.operationId);
      if (previous !== undefined) return { ...reply, submissionId: previous.submissionId, state: previous.accepted && previous.text === request.text ? 'accepted' : 'refused' };
      if (request.conversationId !== conversationId) return { ...reply, state: 'refused' };
      const form = document.querySelector<HTMLFormElement>('form[data-thirdmind-fixture]');
      const composer = form?.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
      if (!form || !composer) return { ...reply, state: 'refused' };
      const submissionId = crypto.randomUUID();
      // Reserve before the first DOM side effect, including a throwing submit handler.
      const reservation = { text: request.text, submissionId, accepted: false };
      handled.set(request.operationId, reservation);
      form.dataset.operationId = request.operationId;
      form.dataset.submissionId = submissionId;
      composer.value = request.text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      const accepted = Array.from(document.querySelectorAll<HTMLElement>('[data-fixture-ack]')).some(
        (node) => node.dataset.operationId === request.operationId && node.dataset.submissionId === submissionId,
      );
      reservation.accepted = accepted;
      return { ...reply, submissionId, state: accepted ? 'accepted' : 'refused', acceptedCount: document.querySelectorAll('[data-fixture-ack]').length };
    }
    reply.submissionId = request.submissionId;
    const previous = handled.get(request.operationId);
    if (previous?.submissionId !== request.submissionId) return { ...reply, state: 'refused' };
    const response = Array.from(document.querySelectorAll<HTMLElement>('[data-fixture-response]')).find(
      (node) => node.dataset.operationId === request.operationId && node.dataset.submissionId === request.submissionId,
    );
    if (!response || response.dataset.state !== 'complete') return { ...reply, state: 'pending' };
    const content = response.textContent ?? '';
    if (content.length === 0 || content.length > MAX_TEXT) return { ...reply, state: 'refused' };
    return { ...reply, state: 'complete', content };
  };
}
