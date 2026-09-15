/* Minimal Chrome DevTools Protocol driver. No dependencies. */
const fs = require('fs');
const { spawn } = require('child_process');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Is a debuggable Chrome already listening? Reuse it rather than spawning
// another -- every spawn otherwise leaks a browser that outlives the test run,
// and a pile of them eventually wedges the debugging port.
async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  } catch (_) { return false; }
}

async function launch() {
  if (await alreadyRunning()) return null;

  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, '--window-size=1400,900',
    '--user-data-dir=' + __dirname + '/chrome-profile',
    '--force-device-scale-factor=2',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return proc;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }

  /* Open a page with the HTTP cache disabled.

     This matters more than it looks. The target is created on about:blank, the
     cache is turned off, and only then do we navigate -- otherwise Chrome serves
     the page and its scripts from cache and the suite happily tests code that
     was edited minutes ago. Reusing a long-lived browser between runs (which
     `launch` now does) makes that near-certain rather than occasional. */
  static async open(url) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await r.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const s = new Session(ws);
    s.targetId = target.id;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && s.pending.has(msg.id)) {
        const { resolve, reject } = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) s.events.push(msg);
    });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

    await s.send('Network.enable');
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });
    await s.send('Page.enable');
    await s.send('Page.navigate', { url });
    return s;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async shot(path, clip) {
    const params = { format: 'png', captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: 1 };
    const r = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  // Close this tab so repeated runs do not pile them up inside one browser.
  async close() {
    try { await fetch(`http://127.0.0.1:${PORT}/json/close/${this.targetId}`); } catch (_) {}
  }

  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(30);
    }
  }
}

// Close the browser this module may have started. run.sh calls the equivalent
// after the suite so nothing is left behind.
async function shutdown() {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close`); } catch (_) {}
}

module.exports = { launch, Session, sleep, shutdown, PORT };
