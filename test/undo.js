/* Undo at awkward moments, driven through the real UI with the twist on:
   after a finished game, while the blocks are turning, and with the promotion
   box open. Each of these once broke the game. */
const { launch, Session, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(48)}${extra}`); };

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(3400);
  const errs = () => s.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
                             .map(e => e.params.entry.text);

  const origin = JSON.parse(await s.eval(`JSON.stringify((()=>{
    const r = document.getElementById('board').getBoundingClientRect(); return {x:r.x, y:r.y};})())`));
  const at = async (name) => {
    const p = JSON.parse(await s.eval(`JSON.stringify((()=>{
      const i = 'abcdefgh'.indexOf('${name}'[0]) + (${+name[1]} - 1) * 16;
      const L = view.squareLayout(i); return [L.x, L.y];})())`));
    return [origin.x + p[0], origin.y + p[1]];
  };
  const waitSolid = async () => {
    for (let i = 0; i < 80; i++) { if (await s.eval(`view.isSolid`)) return true; await sleep(100); }
    return false;
  };
  const play = async (from, to) => {
    await waitSolid();
    await s.click(...await at(from)); await sleep(130);
    await s.click(...await at(to));
  };
  const pressU = async () => {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'u', code: 'KeyU', text: 'u' });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU' });
  };
  // Two players, twist on, from a given position.
  const setup = async (fen) => {
    await s.eval(`ui.level.value = 'hotseat'; ui.level.onchange();`);
    await waitSolid();
    await s.eval(`game.loadFEN('${fen}'); view.setTwistAngle(0); view.lastMove = null;
      refreshMoveList(); refreshCaptured(); refreshStatus();`);
    await sleep(150);
  };
  const quarters = `(view.twistAngle / (Math.PI / 2))`;
  const whole = (q) => Math.abs(q - Math.round(q)) < 1e-6;

  const mateShown = `!document.getElementById('mate').hidden`;

  // ---- 1a. undo after checkmate clears the text and play goes on ----
  await setup('k7/2K5/8/8/8/8/8/1R6 w - - 0 1');
  await play('b1', 'a1');                              // Ra1#
  await sleep(1500);                                   // announced
  const mated = JSON.parse(await s.eval(`JSON.stringify({
    finished: gameFinished, shown: ${mateShown}, solid: view.isSolid })`));
  ok(mated.finished && mated.shown && mated.solid, 'setup: checkmate text up, board shut',
     `text shown: ${mated.shown}, solid: ${mated.solid}`);
  await pressU();
  await sleep(300);
  const after = JSON.parse(await s.eval(`JSON.stringify({
    finished: gameFinished, shown: ${mateShown}, solid: view.isSolid,
    log: game.moveLog.length, turn: game.turn,
    status: document.getElementById('status').textContent })`));
  ok(!after.finished && !after.shown && after.solid && after.log === 0 && after.turn === 0,
     'undo after checkmate clears the text', `${after.status}, text shown: ${after.shown}`);
  await play('b1', 'a1');
  await sleep(600);
  const replayed = await s.eval(`game.moveLog.length`);
  ok(replayed === 1, 'and the board takes clicks again', `${replayed} ply played`);

  // ---- 1b. undo straight after mate: the text must not land on a live game ----
  await setup('k7/2K5/8/8/8/8/8/1R6 w - - 0 1');
  await play('b1', 'a1');
  await sleep(250);                                    // before the 700ms beat
  await pressU();
  await sleep(1500);                                   // well past where it would show
  const early = JSON.parse(await s.eval(`JSON.stringify({
    finished: gameFinished, shown: ${mateShown}, solid: view.isSolid })`));
  ok(!early.finished && !early.shown && early.solid, 'quick undo after mate: no text appears',
     `text shown: ${early.shown}`);

  // ---- 1c. a draw still blooms open, and undo folds it shut ----
  await setup('k7/2K5/8/8/8/8/8/1Q6 w - - 0 1');
  await play('b1', 'b6');                              // stalemate
  await sleep(3000);
  const drawn = JSON.parse(await s.eval(`JSON.stringify({
    over: document.getElementById('status').textContent, shown: ${mateShown},
    bloom: Math.abs(view.theta / THETA_OPEN) })`));
  ok(drawn.over === 'Stalemate' && !drawn.shown && drawn.bloom > 0.9,
     'stalemate blooms open, no checkmate text', `bloom ${(drawn.bloom * 100).toFixed(0)}%`);
  await pressU();
  const closed = await waitSolid();
  ok(closed && !(await s.eval(`gameFinished`)), 'undo after a draw folds the board shut',
     `solid: ${closed}`);

  // ---- 2. undo while the blocks are turning ----
  await setup('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  await play('e2', 'e4');
  // Wait until the tiles are visibly part-way round, not in the pause before.
  let q0 = 0;
  for (let i = 0; i < 40; i++) {
    q0 = await s.eval(quarters);
    if (q0 > 0.2 && q0 < 0.8) break;
    await sleep(15);
  }
  const midTurn = q0 > 0.2 && q0 < 0.8;
  await pressU();                                      // mid-turn
  await waitSolid();
  const q1 = await s.eval(quarters);
  const log1 = await s.eval(`game.moveLog.length`);
  ok(midTurn && whole(q1), 'undo mid-turn leaves the tiles square',
     `pressed at ${q0.toFixed(2)} quarters, paint now ${q1.toFixed(4)}`);
  ok(log1 === 1, 'and waits for the turn to land', `${log1} ply still on the board`);
  await pressU();                                      // now it is allowed
  await sleep(300);
  const q2 = await s.eval(quarters);
  const log2 = await s.eval(`game.moveLog.length`);
  ok(log2 === 0 && Math.abs(q2) < 1e-6, 'undo once it has landed works as before',
     `${log2} plies, paint ${q2.toFixed(4)} quarters`);

  // ---- 3. undo with the promotion box open ----
  await setup('k7/5P2/8/8/8/8/8/7K b - - 0 1');
  await play('a8', 'a7');                              // black moves; the f7 pawn is carried to e7
  await waitSolid();
  await play('e7', 'e8');
  await sleep(200);
  const boxOpen = await s.eval(`!document.getElementById('promo').hidden`);
  const stale = await s.eval(`document.querySelectorAll('#promo-choices .promo-btn').length`);
  await pressU();
  await sleep(300);
  const undone = JSON.parse(await s.eval(`JSON.stringify({
    hidden: document.getElementById('promo').hidden, pending: !!pendingPromo,
    log: game.moveLog.length, turn: game.turn, key: game.positionKey() })`));
  ok(boxOpen && stale === 4 && undone.hidden && !undone.pending,
     'undo closes the promotion box', `was open: ${boxOpen}, closed: ${undone.hidden}`);
  // A leftover button, clicked anyway, must do nothing.
  await s.eval(`document.querySelectorAll('#promo-choices .promo-btn')[0].click()`);
  await sleep(700);
  const untouched = JSON.parse(await s.eval(`JSON.stringify({
    log: game.moveLog.length, turn: game.turn, key: game.positionKey() })`));
  ok(untouched.log === undone.log && untouched.turn === undone.turn && untouched.key === undone.key,
     'a stale promotion choice plays nothing', `${untouched.log} plies, turn ${untouched.turn ? 'Black' : 'White'}`);

  console.log('\nconsole errors:', errs().length ? errs() : 'none');
  console.log(`${pass} passed, ${fail} failed`);
  await s.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
