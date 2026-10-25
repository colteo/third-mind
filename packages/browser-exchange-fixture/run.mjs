/** No npm invocation or dependency download. Uses the project's existing bundler. */
import { build } from 'rolldown';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, '.output/browser-exchange-fixture');
const extension = join(output, 'extension');
await mkdir(extension, { recursive: true });
for (const [entry, file] of [['entry.content', 'content.js'], ['runner', 'runner.js']]) {
  await build({ input: join(root, `src/test-support/browser-exchange/${entry}.ts`), output: { file: join(extension, file), format: 'iife' } });
}
await writeFile(join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'ThirdMind isolated browser exchange fixture', version: '0.0.1',
  permissions: ['tabs', 'webNavigation', 'storage'], host_permissions: ['http://127.0.0.1/*'],
  content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle', all_frames: false }],
}, null, 2));
await writeFile(join(extension, 'runner.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>ThirdMind browser exchange verification</title><h1>Browser exchange verification</h1><pre>Running...</pre><script src="runner.js"></script></html>');

let finish;
const completed = new Promise((resolveReport) => { finish = resolveReport; });
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/report') {
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 100000) { response.writeHead(413).end(); return; } }
    try {
      const report = JSON.parse(body);
      await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
      response.writeHead(200).end('Recorded');
      finish(report);
    } catch { response.writeHead(400).end(); }
    return;
  }
  if (request.method !== 'GET' || !(/^\/(new|conversation\/[a-zA-Z0-9_-]+)$/.test(request.url ?? '') || request.url === '/page.js')) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', request.url === '/page.js' ? 'text/javascript' : 'text/html');
  response.end(await readFile(join(import.meta.dirname, request.url === '/page.js' ? 'page.js' : 'page.html')));
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(43115, '127.0.0.1', resolveListen); });
const profile = await mkdtemp(join(output, 'profile-'));
const executable = process.env.THIRDMIND_CHROMIUM ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-background-timer-throttling',
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--disable-background-networking',
  `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
browser.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
// Minimal DevTools pipe client, used only to install this test extension and open its runner.
// No scripts are evaluated and no consumer pages are opened through DevTools.
let sequence = 0;
let incoming = '';
const pending = new Map();
browser.stdio[4].on('data', (chunk) => {
  incoming += chunk;
  let end;
  while ((end = incoming.indexOf('\0')) !== -1) {
    const message = JSON.parse(incoming.slice(0, end));
    incoming = incoming.slice(end + 1);
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
    }
  }
});
let startupFailure;
browser.on('error', (error) => {
  startupFailure = error;
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
  pending.clear();
});
function command(method, params = {}) {
  return new Promise((resolveCall, reject) => {
    if (startupFailure) { reject(startupFailure); return; }
    const id = ++sequence;
    const callTimer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}. ${stderr}`)); }, 10000);
    pending.set(id, { resolve: resolveCall, reject, timer: callTimer });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params })}\0`);
  });
}
let timer;
try {
  const version = await command('Browser.getVersion');
  console.log('Chromium:', version.product);
  const installed = await command('Extensions.loadUnpacked', { path: extension });
  await command('Target.createTarget', { url: `chrome-extension://${installed.id}/runner.html` });
  const report = await Promise.race([
    completed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Browser verification timed out. ${stderr}`)), 45000); browser.once('error', reject); browser.once('exit', (code) => reject(new Error(`Browser exited: ${code}. ${stderr}`))); }),
  ]);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  try { console.error('Browser targets:', await command('Target.getTargets')); } catch { /* Browser may have exited. */ }
  console.error(error); process.exitCode = 1;
}
finally { clearTimeout(timer); browser.kill(); server.close(); }
