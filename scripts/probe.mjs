/**
 * Headless verification probe.
 *
 * Launches Chrome with the DevTools protocol enabled, opens the viewer, then evaluates an
 * expression in page context and reports console messages. Written with Node's built-in
 * WebSocket so it needs no extra dependencies.
 *
 * Usage: node scripts/probe.mjs <url> [expressionFile]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
const expressionFile = process.argv[3];
if (!url) {
  console.error('usage: node scripts/probe.mjs <url> [expressionFile]');
  process.exit(1);
}

const CHROME = process.env.CHROME_BIN ?? 'google-chrome-stable';
const port = 9333 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ofd-probe-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,1000',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('DevTools endpoint did not come up');
}

async function main() {
  await waitForDevtools();

  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  });
  const target = await targetResponse.json();

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  const consoleMessages = [];
  const pageErrors = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push(
        `[${message.params.type}] ` +
          message.params.args
            .map((arg) => arg.value ?? arg.description ?? arg.type ?? '?')
            .join(' '),
      );
    }
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      messageId += 1;
      pending.set(messageId, { resolve, reject });
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');

  // Capture messages the app logs through its own console calls (warnings/errors are not
  // reported as Runtime.consoleAPICalled unless we intercept them before boot).
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const record = (level) => {
          const original = console[level];
          console[level] = (...args) => {
            try {
              window.__probeLogs = window.__probeLogs || [];
              window.__probeLogs.push(level + ': ' + args.map((a) => {
                if (a instanceof Error) return a.stack || a.message;
                if (typeof a === 'object') { try { return JSON.stringify(a).slice(0, 400); } catch { return String(a); } }
                return String(a);
              }).join(' '));
            } catch {}
            original.apply(console, args);
          };
        };
        ['warn', 'error', 'log'].forEach(record);
        window.__probeLogs = [];
      })();
    `,
  });

  await send('Page.navigate', { url });

  // Give the app time to load, parse and paint.
  const settleMs = Number(process.env.PROBE_SETTLE_MS ?? 9000);
  await sleep(settleMs);

  const expression = expressionFile
    ? fs.readFileSync(expressionFile, 'utf8')
    : `(() => {
        const canvases = [...document.querySelectorAll('canvas')].map((canvas) => {
          const ctx = canvas.getContext('2d');
          let painted = 0;
          let sample = 'n/a';
          try {
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < data.length; i += 4 * 97) {
              if (data[i + 3] > 0 && (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240)) painted += 1;
            }
            sample = data[0] + ',' + data[1] + ',' + data[2] + ',' + data[3];
          } catch (error) {
            sample = 'error: ' + error.message;
          }
          return { w: canvas.width, h: canvas.height, nonWhiteSamples: painted, firstPixel: sample };
        });
        return JSON.stringify({
          status: document.querySelector('.statusbar')?.textContent ?? null,
          thumbCount: document.querySelectorAll('.thumb').length,
          badges: document.querySelectorAll('.badge').length,
          canvases,
        }, null, 2);
      })()`;

  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log('=== PROBE RESULT ===');
  console.log(typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result, null, 2));
  if (result.exceptionDetails) {
    console.log('=== EVAL EXCEPTION ===');
    console.log(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  }
  console.log('=== CONSOLE ===');
  console.log(consoleMessages.slice(-40).join('\n') || '(none)');
  console.log('=== PAGE ERRORS ===');
  console.log(pageErrors.join('\n') || '(none)');

  // Optional screenshot for visual inspection.
  if (process.env.PROBE_SCREENSHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.PROBE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    console.log(`=== SCREENSHOT ${process.env.PROBE_SCREENSHOT} ===`);
  }

  socket.close();
}

try {
  await main();
} catch (error) {
  console.error('probe failed:', error);
  process.exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
}
