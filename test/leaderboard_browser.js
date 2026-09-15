/* The start screen and the leaderboard, through the real page: a name is
   required, the choices reach the game, only a clean win against the computer
   is saved, and the name is remembered next time. */
const { launch, Session, sleep } = require('./cdp.js');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(50)}${extra}`); };

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(1200);
  fs.mkdirSync(__dirname + '/shots', { recursive: true });
  const errs = () => s.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
                             .map(e => e.params.entry.text);
  const json = async (expr) => JSON.parse(await s.eval(`JSON.stringify(${expr})`));
  const shown = (id) => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
  const text = (id) => `document.getElementById('${id}').textContent`;
  const click = (id) => s.eval(`document.getElementById('${id}').click()`);
  const key = async (k, extra = {}) => {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, ...extra });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, ...extra });
  };
  const type = async (str) => { for (const ch of str) await key(ch); };

  // A fresh browser: nothing saved.
  await s.eval(`localStorage.clear(); location.reload()`);
  await sleep(1500);

  // ---- 1. the page opens on the start screen, board bloomed behind it ----
  const open = await json(`{ menu: ${shown('menu')}, bloomed: Math.abs(view.theta - THETA_OPEN) < 1e-6, status: ${text('status')},
    moves: game.moveLog.length, empty: ${text('menu-lb-table')} }`);
  ok(open.menu && open.bloomed && open.moves === 0,
     'opens on the start screen, board open behind', open.status);
  ok(/No wins at Strong yet/.test(open.empty), 'empty leaderboard says so', open.empty.trim());
  await s.shot(__dirname + '/shots/start-screen.png');

  // ---- 2. Start with no name does not start ----
  await click('start');
  await sleep(300);
  const noName = await json(`{ menu: ${shown('menu')}, bad: document.getElementById('name-hint').classList.contains('bad'),
    hint: ${text('name-hint')}, name: settings.name }`);
  ok(noName.menu && noName.bad && noName.name === '', 'no name: stays on the start screen', noName.hint);

  // ---- 3. typing f and u in the name box types, it does not flip or undo ----
  await s.eval(`document.getElementById('name').focus()`);
  await type('fu');
  const typed = await json(`{ value: document.getElementById('name').value, flipped: view.flipped }`);
  ok(typed.value === 'fu' && typed.flipped === false, '"f" and "u" type letters in the name box', `"${typed.value}"`);
  // Cmd+N belongs to the board, not the start screen.
  await key('n', { modifiers: 4 });
  await sleep(300);
  ok(await s.eval(shown('menu')), 'Cmd+N does not start a game from the menu');

  // ---- 4. choices reach the game ----
  await s.eval(`document.getElementById('name').value = ''`);
  await type('Luqman');
  await s.eval(`document.querySelector('#level-pick [data-level="1"]').click();
                document.querySelector('#side-pick [data-side="black"]').click();`);
  const heading = await s.eval(text('menu-lb-level'));
  ok(heading === 'Club', 'picking a level shows that level\'s leaderboard', heading);
  await key('Enter', { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });   // Enter in the name box starts
  await sleep(300);
  const started = await json(`{ menu: ${shown('menu')}, settings, flipped: view.flipped,
    name: ${text('pc-name')}, meta: ${text('pc-meta')}, rank: ${text('pc-rank')} }`);
  ok(!started.menu && started.settings.level === 1 && started.settings.side === 1 &&
     started.settings.name === 'Luqman' && started.flipped,
     'Enter starts: Club, Black, board turned round', `${started.name} | ${started.meta}`);
  ok(/^Ranked/.test(started.rank), 'the game is marked ranked', started.rank);
  await sleep(2400);

  // ---- 5. Menu mid-game, then back to the same game ----
  for (let i = 0; i < 60 && (await s.eval(`game.moveLog.length`)) < 1; i++) await sleep(150);
  const plies = await s.eval(`game.moveLog.length`);
  await click('menu-btn');
  await sleep(200);
  const midMenu = await json(`{ menu: ${shown('menu')}, resume: ${shown('resume')}, name: document.getElementById('name').value }`);
  ok(midMenu.menu && midMenu.resume && midMenu.name === 'Luqman', 'Menu mid-game offers "Back to the game"');
  await click('resume');
  await sleep(200);
  ok(!(await s.eval(shown('menu'))) && (await s.eval(`game.moveLog.length`)) === plies,
     'and going back leaves the game as it was', `${plies} plies`);

  // A mate-in-one for White, twist off so the mate is plain (as in gameplay.js).
  const mateIn1 = async () => {
    await s.eval(`epoch++; game.reset(); game.moveLog = []; view.setTwistAngle(0); game.twist = false;
      gameFinished = false; thinking = false; ui.mate.hidden = true;
      game.loadFEN('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
      playerColor = WHITE; view.flipped = false; view.setThetaManual(0); view.lastMove = null;
      refreshMoveList(); refreshCaptured(); refreshStatus();`);
    await sleep(200);
    const origin = await json(`(() => { const r = document.getElementById('board').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
    const at = async (sq) => {
      const p = await json(`(() => { const L = view.squareLayout(${sq}); return [L.x, L.y]; })()`);
      return [origin.x + p[0], origin.y + p[1]];
    };
    await s.click(...await at(0x00)); await sleep(150);
    await s.click(...await at(0x70));
    await sleep(1300);                                  // past the 700ms beat before the card
  };

  // ---- 6. a clean win is saved ----
  await s.eval(`startGame({ level: 0, side: 'white', name: 'Luqman' })`);
  await sleep(2400);
  await mateIn1();
  const won = await json(`{ top: leaderboard.top(0), line: ${text('mate-rank')}, lineShown: ${shown('mate-rank')},
    card: ${shown('mate')} }`);
  ok(won.top.length === 1 && won.top[0].name === 'Luqman' && won.top[0].wins === 1,
     'a win against Casual goes on the Casual board', JSON.stringify(won.top));
  ok(won.card && won.lineShown && won.line === 'Luqman: 1 win at Casual - #1', 'the checkmate card says so', won.line);
  ok((await json(`leaderboard.top(1)`)).length === 0, 'and not on any other level');
  const saved = await s.eval(text('pc-rank'));
  ok(saved === 'Win saved to the Casual leaderboard', 'the side panel confirms it', saved);
  await s.shot(__dirname + '/shots/ranked-win.png');

  // ---- 7. after an undo, a win does not count ----
  await s.eval(`startGame({ level: 0, side: 'white', name: 'Luqman' })`);
  await sleep(2400);
  await s.eval(`{ const m = game.legalMoves().find(x => !(x.flags & F_STOP) && squareName(x.from) === 'e2'); applyMove(m); }`);
  for (let i = 0; i < 60 && (await s.eval(`game.moveLog.length`)) < 2; i++) await sleep(150);
  for (let i = 0; i < 40 && !(await s.eval(`view.isSolid && !thinking`)); i++) await sleep(100);
  await click('undo');
  await sleep(300);
  const practice = await s.eval(text('pc-rank'));
  ok(/^Practice/.test(practice), 'Undo turns the game into practice', practice);
  await mateIn1();
  const unranked = await json(`{ top: leaderboard.top(0), line: ${text('mate-rank')} }`);
  ok(unranked.top[0].wins === 1 && unranked.line === 'Not ranked - Undo was used',
     'a win after Undo is not saved', unranked.line);

  // ---- 8. New game starts ranked again ----
  await click('new-game');
  await sleep(200);
  ok(/^Ranked/.test(await s.eval(text('pc-rank'))), 'New game is ranked again');
  await sleep(2400);

  // ---- 9. losing, and two players, never touch the board ----
  const lost = await json(`{ line: rankResult({ type: 'checkmate', winner: BLACK }), top: leaderboard.top(0) }`);
  ok(lost.line === '' && lost.top[0].wins === 1, 'a loss records nothing');
  await click('menu-btn');
  await click('two-players');
  await sleep(2400);
  await mateIn1();
  const hot = await json(`{ top: leaderboard.top(0), lineShown: ${shown('mate-rank')}, card: ${text('pc-rank')} }`);
  const allLevels = await json(`[0,1,2,3].map(l => leaderboard.top(l).length)`);
  ok(hot.top[0].wins === 1 && !hot.lineShown && allLevels.join() === '1,0,0,0',
     'a two-player checkmate is not saved', `${hot.card}, tables ${allLevels.join('/')}`);

  // ---- 10. the leaderboard window ----
  await s.eval(`startGame({ level: 0, side: 'white', name: 'Luqman' })`);
  await sleep(2400);
  await click('lb-btn');
  await sleep(300);
  const win = await json(`{ open: ${shown('lb')}, tab: document.querySelector('#lb-tabs .on').textContent,
    rows: [...document.querySelectorAll('#lb-table tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()),
    me: !!document.querySelector('#lb-table tr.me') }`);
  ok(win.open && win.tab === 'Casual' && win.rows.join() === '1 Luqman 1' && win.me,
     'Leaderboard opens on your level, your row marked', win.rows.join(' / '));
  await s.shot(__dirname + '/shots/leaderboard.png');
  await s.eval(`document.querySelector('#lb-tabs [data-level="3"]').click()`);
  ok(/No wins at Brutal yet/.test(await s.eval(text('lb-table'))), 'tabs switch level');
  await key('f');
  ok((await s.eval(`view.flipped`)) === false, 'board shortcuts are off while it is open');
  await key('Escape');
  await sleep(150);
  ok(!(await s.eval(shown('lb'))), 'Escape closes it');

  // ---- 11. the name is remembered ----
  await s.eval(`location.reload()`);
  await sleep(1500);
  const again = await json(`{ menu: ${shown('menu')}, name: document.getElementById('name').value,
    rows: document.querySelectorAll('#menu-lb-table tbody tr').length, level: ${text('menu-lb-level')} }`);
  ok(again.menu && again.name === 'Luqman', 'after a reload the name is filled in', `"${again.name}"`);
  await s.eval(`document.querySelector('#level-pick [data-level="0"]').click()`);
  ok((await s.eval(`document.querySelectorAll('#menu-lb-table tbody tr').length`)) === 1,
     'and the saved win is still there');

  // ---- 12. fits a phone ----
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
