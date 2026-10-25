const form = document.querySelector('form');
let count = 0;
form.addEventListener('submit', (event) => {
  event.preventDefault();
  count += 1;
  document.querySelector('#count').textContent = String(count);
  const { operationId, submissionId } = form.dataset;
  const ack = document.createElement('span');
  ack.dataset.fixtureAck = '';
  ack.dataset.operationId = operationId;
  ack.dataset.submissionId = submissionId;
  document.querySelector('#responses').append(ack);
  if (location.pathname === '/new') history.pushState({}, '', `/conversation/${crypto.randomUUID()}`);
  const stale = document.createElement('article');
  Object.assign(stale.dataset, { fixtureResponse: '', operationId: 'old-operation', submissionId: 'old-submission', state: 'complete' });
  stale.textContent = 'Unrelated older response';
  const response = document.createElement('article');
  Object.assign(response.dataset, { fixtureResponse: '', operationId, submissionId, state: 'streaming' });
  response.textContent = 'Partial response';
  document.querySelector('#responses').append(stale, response);
  if (location.pathname === '/conversation/hang') return;
  setTimeout(() => {
    response.textContent = 'Fixture response completed.';
    response.dataset.state = 'complete';
  }, 120);
});
