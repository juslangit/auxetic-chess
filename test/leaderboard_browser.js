/* The start screen and the shared leaderboard, through the real page.

   The live leaderboard is never touched: the page's `leaderboard` is swapped
   for a stand-in server that keeps its data in memory but follows the real
   rules -- names claimed by PIN, five wrong PINs lock a name, a win is saved
   only if server/replay.js confirms it, and the same game counts once.
   The winning game itself is a real one, played by the engine in node. */
const { launch, Session, sleep } = require('./cdp.js');
const fs = require('fs');
const H = __dirname + '/../js/', S = __dirname + '/../server/';
const { seed } = require('./repeatable.js');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(54)}${extra}`); };

// ---- a real game in which White mates, from the standard start with the twist on ----
seed(+process.env.TEST_SEED || 1);
const E = new Function(fs.readFileSync(H + 'chess.js', 'utf8') + '\n' + fs.readFileSync(H + 'ai.js', 'utf8') + '\n' +
  fs.readFileSync(S + 'replay.js', 'utf8') + '\n; return {Chess, AI, encodeMove, WHITE};')();
function whiteMates() {
  for (let t = 0; t < 30; t++) {
    const g = new E.Chess(); g.twist = true; g.stopsPerGame = 3; g.reset();
    const w = new E.AI(g), b = new E.AI(g), moves = [];
    let over = null;
    while (moves.length < 300 && !(over = g.gameOver())) {
      const r = g.turn === E.WHITE ? w.think(1) : b.think(0);
      moves.push(E.encodeMove(r.move)); g.make(r.move); g.pushRepetition();
    }
    if (over && over.type === 'checkmate' && over.winner === E.WHITE) return moves;
  }
  throw new Error('no White mate found');
}
const WIN = whiteMates();

// The stand-in server, installed into the page.
const FAKE = `
  window.fake = (() => {
    const players = new Map(), seen = new Set(), standings = [new Map(), new Map(), new Map(), new Map()];
    const api = { offline: false, calls: [], configured: true };
    const down = () => { if (api.offline) throw new Error('offline'); };
    const check = (rawName, pin) => {
      const name = cleanName(rawName), key = name.toLowerCase();
      if (!/^[0-9]{4}$/.test(pin)) return { status: 'bad-pin' };
      const p = players.get(key);
      if (!p) { players.set(key, { name, pin, fails: 0, until: 0 }); return { status: 'claimed', name }; }
      if (p.until > Date.now()) return { status: 'locked', until: new Date(p.until).toISOString() };
      if (p.pin === pin) { p.fails = 0; return { status: 'ok', name: p.name }; }
      if (++p.fails >= 5) { p.fails = 0; p.until = Date.now() + 15 * 60000; return { status: 'locked', until: new Date(p.until).toISOString() }; }
      return { status: 'wrong-pin', tries_left: 5 - p.fails };
    };
    const sorted = (level) => [...standings[level].values()].sort((a, b) => b.wins - a.wins || a.at - b.at);
    api.top = async (level, limit = 10) => { down(); return sorted(level).slice(0, limit).map((r) => ({ name: r.name, wins: r.wins })); };
    api.checkPlayer = async (name, pin) => { down(); api.calls.push('check'); return check(name, String(pin)); };
    api.submitWin = async ({ name, pin, level, side, moves }) => {
      down(); api.calls.push('win');
      const p = check(name, String(pin));
      if (p.status !== 'ok' && p.status !== 'claimed') return p;
      const r = replayWin({ moves, side });
      if (!r.ok) return { status: 'rejected', reason: r.reason };
      const key = p.name.toLowerCase(), dup = key + level + moves.join(' ');
      if (seen.has(dup)) return { status: 'duplicate' };
      seen.add(dup);
      const row = standings[level].get(key) || { name: p.name, wins: 0, at: 0 };
      row.wins++; row.at = performance.now(); standings[level].set(key, row);
      return { status: 'saved', name: p.name, wins: row.wins, rank: sorted(level).indexOf(row) + 1 };
    };
    return api;
  })();
  leaderboard = window.fake;
  refreshMenu();`;

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(1200);
  fs.mkdirSync(__dirname + '/shots', { recursive: true });
  const errs = () => s.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
                             .map(e => e.params.entry.text)
                             // The real leaderboard is asked once on load, before the stand-in goes in.
                             .filter((t) => !/supabase|Failed to load resource/i.test(t));
  const json = async (expr) => JSON.parse(await s.eval(`JSON.stringify(${expr})`));
  const shown = (id) => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
  const text = (id) => `document.getElementById('${id}').textContent`;
  const click = (id) => s.eval(`document.getElementById('${id}').click()`);
  const key = async (k, extra = {}) => {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, ...extra });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, ...extra });
  };
  const type = async (str) => { for (const ch of str) await key(ch); };
  const fill = async (id, value) => { await s.eval(`document.getElementById('${id}').value = ''; document.getElementById('${id}').focus()`); await type(value); };
  const pickLevel = (n) => s.eval(`document.querySelector('#level-pick [data-level="${n}"]').click()`);
  const pickSide = (side) => s.eval(`document.querySelector('#side-pick [data-side="${side}"]').click()`);
  const waitFor = async (expr, ms = 5000) => { for (let i = 0; i < ms / 100; i++) { if (await s.eval(expr)) return true; await sleep(100); } return false; };

  await s.eval(`localStorage.clear(); location.reload()`);
  await sleep(1500);
  await s.eval(FAKE);
  await sleep(200);

  // ---- 1. the start screen, online and offline ----
  const open = await json(`{ menu: ${shown('menu')}, status: ${text('lb-status')}, empty: ${text('menu-lb-table')},
    pin: ${shown('pin')}, bloomed: Math.abs(view.theta - THETA_OPEN) < 1e-6 }`);
  ok(open.menu && open.bloomed && open.pin, 'opens on the start screen, with a PIN box');
  ok(/^Online/.test(open.status) && /No wins at Strong yet/.test(open.empty), 'says the leaderboard is online, and empty', open.status);
  await s.eval(`fake.offline = true; refreshMenu()`); await sleep(200);
  const off = await json(`{ status: ${text('lb-status')}, table: ${text('menu-lb-table')} }`);
  ok(/^Offline - you can still play/.test(off.status) && /offline/.test(off.table), 'and says so when it is offline', off.status);
  await s.eval(`fake.offline = false; refreshMenu()`); await sleep(200);
  await s.shot(__dirname + '/shots/start-screen.png');

  // ---- 2. name and PIN are both needed ----
  await click('start'); await sleep(200);
  ok(/Enter a username/.test(await s.eval(text('name-hint'))) && await s.eval(shown('menu')), 'no name: does not start');
  await fill('name', 'Luqman');
  await click('start'); await sleep(200);
  ok(/Enter a 4-digit PIN/.test(await s.eval(text('name-hint'))) && await s.eval(shown('menu')), 'no PIN: does not start');
  await fill('pin', '12a3');
  ok((await s.eval(`document.getElementById('pin').value`)) === '123', 'the PIN box only takes digits');
  ok((await json(`fake.calls`)).length === 0, 'nothing is sent until both are filled in');

  // ---- 3. typing does not trigger the board's shortcuts ----
  await fill('name', 'fu');
  ok((await s.eval(`view.flipped`)) === false, '"f" and "u" type letters in the name box');
  await key('n', { modifiers: 4 }); await sleep(200);
  ok(await s.eval(shown('menu')), 'Cmd+N does not start a game from the menu');

  // ---- 4. a new name is claimed, and the choices reach the game ----
  await fill('name', 'Luqman');
  await fill('pin', '1234');
  await pickLevel(1); await pickSide('black');
  await key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await waitFor(`!(${shown('menu')})`);
  const started = await json(`{ settings, flipped: view.flipped, meta: ${text('pc-meta')}, rank: ${text('pc-rank')}, calls: fake.calls }`);
  ok(started.settings.level === 1 && started.settings.side === 1 && started.flipped && started.settings.online,
     'Enter starts: Club, Black, board turned round, online', started.meta);
  ok(started.rank === 'Ranked - name claimed. Remember your PIN' && started.calls.join() === 'check',
     'a new name is claimed by its PIN', started.rank);
  await sleep(2400);

  // ---- 5. Menu mid-game keeps the PIN for this visit ----
  await click('menu-btn'); await sleep(200);
  const mid = await json(`{ resume: ${shown('resume')}, name: document.getElementById('name').value, pin: document.getElementById('pin').value }`);
  ok(mid.resume && mid.name === 'Luqman' && mid.pin === '1234', 'Menu mid-game: back button, name and PIN still filled');

  // ---- 6. a wrong PIN, and the lock ----
  await fill('pin', '9999');
  await click('start');
  await waitFor(`/Wrong PIN/.test(${text('name-hint')})`);
  const wrong = await json(`{ hint: ${text('name-hint')}, menu: ${shown('menu')}, pin: document.getElementById('pin').value }`);
  ok(wrong.menu && wrong.hint === 'Wrong PIN for Luqman. 4 tries left before a 15-minute lock.' && wrong.pin === '',
     'a wrong PIN stays on the menu and says how many tries are left', wrong.hint);
  await s.eval(`fake.checkPlayer('Aiman', '1111')`);                // someone else's name
  await fill('name', 'aiman');
  for (let i = 0; i < 5; i++) { await fill('pin', '0000'); await click('start'); await sleep(150); }
  const locked = await s.eval(text('name-hint'));
  ok(/^Too many wrong PINs for aiman\. Try again in 15 minutes\.$/.test(locked), 'five wrong PINs lock the name', locked);
  await fill('pin', '1111'); await click('start'); await sleep(200);
  ok(/Too many wrong PINs/.test(await s.eval(text('name-hint'))) && await s.eval(shown('menu')), 'even the right PIN waits out the lock');

  // Plays a finished game straight into the position before its last move, then
  // plays the last move through the page, the way a click would.
  const playGame = async (moves) => {
    await s.eval(`(() => {
      const moves = ${JSON.stringify(moves)};
      for (const code of moves.slice(0, -1)) {
        const m = game.legalMoves().find((x) => encodeMove(x) === code);
        game.make(m); game.pushRepetition();
        game.moveLog.push({ san: code, move: m, twisted: !!game.history[game.history.length - 1].twisted, stopUsed: code.endsWith('s') });
      }
      view.setTwistAngle(0); view.setThetaManual(0);
      refreshMoveList(); refreshCaptured(); refreshStatus();
      applyMove(game.legalMoves().find((x) => encodeMove(x) === moves[moves.length - 1]));
    })()`);
  };
  const startAs = async (name, pin, level, side) => {
    await s.eval(`openMenu(false)`);
    await fill('name', name); await fill('pin', pin);
    await pickLevel(level); await pickSide(side);
    await click('start');
    await waitFor(`!(${shown('menu')})`);
    await sleep(2400);
  };
  const card = async () => { await waitFor(`${shown('mate')} && !/^Saving/.test(${text('mate-rank')})`, 6000);
    return json(`{ line: ${text('mate-rank')}, rank: ${text('pc-rank')} }`); };

  // ---- 7. a real win is checked and saved ----
  await startAs('Luqman', '1234', 0, 'white');
  await playGame(WIN);
  const saved = await card();
  ok(saved.line === 'Luqman: 1 win at Casual - #1', 'a real win is replayed by the server and saved', `${WIN.length} plies: ${saved.line}`);
  ok(saved.rank === 'Win saved to the Casual leaderboard', 'the side panel confirms it', saved.rank);
  await s.shot(__dirname + '/shots/ranked-win.png');

  // ---- 8. the same game again counts once ----
  await click('new-game'); await sleep(2400);
  await playGame(WIN);
  const dup = await card();
  ok(dup.line === 'Already counted - the same winning game only counts once' && dup.rank === 'This win was not saved',
     'the same winning game does not count twice', dup.line);

  // ---- 9. a win the server cannot confirm ----
  await click('new-game'); await sleep(2400);
  await s.eval(`game.twist = false; game.loadFEN('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    game.moveLog = []; view.setTwistAngle(0); refreshStatus();
    applyMove(game.legalMoves().find((x) => encodeMove(x) === 'a1a8'));`);
  const rej = await card();
  ok(rej.line === 'Not saved - the server could not confirm this win', 'a set-up position is not a win the server accepts', rej.line);

  // ---- 10. offline at the moment of the win ----
  await click('new-game'); await sleep(2400);
  await s.eval(`fake.offline = true`);
  await playGame(WIN);
  const lost = await card();
  ok(lost.line === 'Not saved - the leaderboard is offline', 'offline when you win: says the win was not saved', lost.line);
  await s.eval(`fake.offline = false`);

  // ---- 11. offline when you start: plays, unranked, sends nothing ----
  await s.eval(`fake.offline = true`);
  const before = (await json(`fake.calls`)).length;
  await startAs('Luqman', '1234', 0, 'white');
  const unr = await json(`{ rank: ${text('pc-rank')}, online: settings.online }`);
  ok(!unr.online && unr.rank === 'Not ranked - the leaderboard was offline when you started', 'offline at Start: the game still starts, unranked', unr.rank);
  await s.eval(`fake.offline = false`);
  await playGame(WIN);
  await waitFor(shown('mate'), 3000);
  const unrLine = await s.eval(text('mate-rank'));
  ok(unrLine === 'Not ranked - the leaderboard was offline' && (await json(`fake.calls`)).length === before,
     'and its win is not sent', unrLine);

  // ---- 12. Undo, and two players, send nothing ----
  await startAs('Luqman', '1234', 0, 'white');
  await s.eval(`{ const m = game.legalMoves().find((x) => encodeMove(x) === 'e2e4'); applyMove(m); }`);
  await waitFor(`game.moveLog.length >= 2 && view.isSolid && !thinking`, 8000);
  await click('undo'); await sleep(300);
  ok(/^Practice/.test(await s.eval(text('pc-rank'))), 'Undo turns the game into practice');
  const n0 = (await json(`fake.calls`)).length;
  await s.eval(`game.reset(); game.moveLog = []; view.setTwistAngle(0);`);
  await playGame(WIN);
  await waitFor(shown('mate'), 3000);
  ok((await s.eval(text('mate-rank'))) === 'Not ranked - Undo was used' && (await json(`fake.calls`)).length === n0,
     'a win after Undo is not sent');

  await s.eval(`openMenu(true)`); await click('two-players'); await sleep(2400);
  await playGame(WIN);
  await waitFor(shown('mate'), 3000);
  ok(!(await s.eval(shown('mate-rank'))) && (await json(`fake.calls`)).length === n0 && (await s.eval(text('pc-rank'))) === 'Not ranked',
     'a two-player checkmate sends nothing');

  // ---- 13. the leaderboard window ----
  await startAs('Luqman', '1234', 0, 'white');
  await click('lb-btn');
  await waitFor(`document.querySelectorAll('#lb-table tbody tr').length > 0`);
  const win = await json(`{ open: ${shown('lb')}, tab: document.querySelector('#lb-tabs .on').textContent,
    rows: [...document.querySelectorAll('#lb-table tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()),
    me: !!document.querySelector('#lb-table tr.me') }`);
  ok(win.open && win.tab === 'Casual' && win.rows.join() === '1 Luqman 1' && win.me,
     'Leaderboard opens on your level, your row marked', win.rows.join(' / '));
  await s.shot(__dirname + '/shots/leaderboard.png');
  await s.eval(`document.querySelector('#lb-tabs [data-level="3"]').click()`); await sleep(200);
  ok(/No wins at Brutal yet/.test(await s.eval(text('lb-table'))), 'tabs switch level');
  await key('f');
  ok((await s.eval(`view.flipped`)) === false, 'board shortcuts are off while it is open');
  await key('Escape'); await sleep(150);
  ok(!(await s.eval(shown('lb'))), 'Escape closes it');

  // ---- 14. a reload remembers the name, never the PIN ----
  await s.eval(`location.reload()`);
  await sleep(1500);
  const again = await json(`{ menu: ${shown('menu')}, name: document.getElementById('name').value, pin: document.getElementById('pin').value }`);
  ok(again.menu && again.name === 'Luqman' && again.pin === '', 'after a reload the name is filled in, the PIN is not', `"${again.name}" / "${again.pin}"`);
  const stored = await s.eval(`JSON.stringify(Object.assign({}, localStorage))`);
  ok(!/1234/.test(stored), 'the PIN is not in the browser\'s storage', stored);

  // ---- 15. fits a phone ----
  const fits = [];
  for (const [w, h] of [[390, 844], [768, 1024], [1400, 900]]) {
    await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
    await sleep(250);
    fits.push(await json(`(() => { const c = document.querySelector('.menu-card').getBoundingClientRect();
      return { w: ${w}, ok: c.left >= 0 && c.right <= ${w} && document.documentElement.scrollWidth <= ${w} }; })()`));
  }
  await s.send('Emulation.clearDeviceMetricsOverride');
  ok(fits.every((f) => f.ok), 'start screen fits at 390 / 768 / 1400 px', fits.map((f) => `${f.w}:${f.ok ? 'ok' : 'OUT'}`).join(' '));

  console.log('\nconsole errors:', errs().length ? errs() : 'none');
  console.log(`${pass} passed, ${fail} failed`);
  await s.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
