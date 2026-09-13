const { launch, Session, sleep } = require('./cdp.js');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, msg, extra='') => { c?pass++:fail++; console.log(`${c?'PASS':'FAIL'}  ${msg.padEnd(38)}${extra}`); };

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(3200);
  fs.mkdirSync(__dirname + '/shots', { recursive: true });
  const errs = () => s.events.filter(e=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map(e=>e.params.entry.text);

  const board = await s.eval(`JSON.stringify((()=>{const r=document.getElementById('board').getBoundingClientRect();return{x:r.x,y:r.y};})())`);
  const B = JSON.parse(board);
  const at = async (name) => {
    const p = await s.eval(`JSON.stringify((()=>{const i='abcdefgh'.indexOf('${name}'[0])+(${+name[1]}-1)*16;const L=view.squareLayout(i);return[L.x,L.y];})())`);
    const [x,y] = JSON.parse(p);
    return [B.x + x, B.y + y];
  };
  // Wait until the board is flat, still, and accepting input.
  const waitSolid = async () => {
    for (let i = 0; i < 60; i++) {
      if (await s.eval(`view.isSolid`)) return true;
      await sleep(100);
    }
    return false;
  };
  const play = async (from, to) => {
    await waitSolid();
    await s.click(...await at(from)); await sleep(120);
    await s.click(...await at(to)); await sleep(260);
  };

  // ---- 1. FPS while the mechanism is animating ----
  const fps = await s.eval(`new Promise(res => {
    view.animateTo(THETA_OPEN, 1200);
    let frames = 0; const t0 = performance.now();
    const tick = () => { frames++;
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
      else res(Math.round(frames / ((performance.now()-t0)/1000))); };
    requestAnimationFrame(tick);
  })`);
  ok(fps >= 50, `fold animation runs smoothly`, `${fps} fps`);
  await s.eval(`view.setThetaManual(0)`); await sleep(100);

  // ---- 2. input is refused while the board is not solid ----
  await s.eval(`view.setThetaManual(-0.5); view.selected = -1`);
  await s.click(...await at('e2')); await sleep(120);
  const lockedOut = await s.eval(`view.selected`);
  ok(lockedOut === -1, 'no input accepted mid-fold');
  await s.eval(`view.setThetaManual(0)`); await sleep(120);

  // ---- 3. castling, through the real UI ----
  await s.eval(`
    epoch++; game.reset(); game.moveLog = []; view.setTwistAngle(0); game.twist = false; gameFinished = false;
    game.loadFEN('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    playerColor = WHITE; view.flipped = false; view.lastMove = null;
    refreshMoveList(); refreshCaptured(); refreshStatus(); ui.level.value = '0';
  `);
  await sleep(150);
  await play('e1', 'g1');
  const castled = await s.eval(`JSON.stringify({
    san: game.moveLog[0] && game.moveLog[0].san,
    kingOnG1: typeOf(game.board[0x06]) === KING,
    rookOnF1: typeOf(game.board[0x05]) === ROOK,
    e1empty: game.board[0x04] === EMPTY, h1empty: game.board[0x07] === EMPTY })`);
  const C = JSON.parse(castled);
  ok(C.san === 'O-O' && C.kingOnG1 && C.rookOnF1 && C.e1empty && C.h1empty,
     'kingside castling moves both pieces', JSON.stringify(C));

  // ---- 4. promotion picker ----
  await s.eval(`
    epoch++; game.reset(); game.moveLog = []; view.setTwistAngle(0); game.twist = false; gameFinished = false; thinking = false;
    game.loadFEN('8/4P3/8/8/8/8/8/K6k w - - 0 1');
    playerColor = WHITE; refreshStatus();
  `);
  await sleep(150);
  await play('e7', 'e8');
  const promoOpen = await s.eval(`JSON.stringify({
    visible: !document.getElementById('promo').hidden,
    choices: document.querySelectorAll('#promo-choices .promo-btn').length })`);
  ok(JSON.parse(promoOpen).visible && JSON.parse(promoOpen).choices === 4,
     'promotion offers four pieces', promoOpen);
  // choose a knight (last button) and confirm the board agrees
  await s.eval(`document.querySelectorAll('#promo-choices .promo-btn')[3].click()`);
  await sleep(300);
  const promoted = await s.eval(`JSON.stringify({
    piece: typeOf(game.board[0x74]) === KNIGHT ? 'knight' : typeOf(game.board[0x74]),
    san: game.moveLog[game.moveLog.length-1].san })`);
  ok(JSON.parse(promoted).piece === 'knight' && JSON.parse(promoted).san.includes('=N'),
     'promoting to a knight works', promoted);

  // ---- 5. checkmate ends the game and blooms the board open ----
  await s.eval(`
    epoch++; game.reset(); game.moveLog = []; view.setTwistAngle(0); game.twist = false; gameFinished = false; thinking = false;
    game.loadFEN('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    playerColor = WHITE; view.setThetaManual(0); refreshStatus();
  `);
  await sleep(150);
  await s.click(...await at('a1')); await sleep(150);
  const preMate = await s.eval(`JSON.stringify({selected: view.selected, targets: view.legalTargets.length, thinking, pendingPromo: !!pendingPromo, finished: gameFinished, turn: game.turn, solid: view.isSolid})`);
  console.log('      before Ra8:', preMate);
  await s.click(...await at('a8')); await sleep(300);
  await sleep(400);
  const mateState = await s.eval(`JSON.stringify({
    finished: gameFinished,
    status: document.getElementById('status').textContent,
    detail: document.getElementById('detail').textContent,
    san: game.moveLog[game.moveLog.length-1].san })`);
  ok(JSON.parse(mateState).finished && JSON.parse(mateState).san === 'Ra8#',
     'checkmate detected and announced', JSON.parse(mateState).status);
  await sleep(2600);
  const bloomed = await s.eval(`Math.abs(view.theta / THETA_OPEN)`);
  ok(bloomed > 0.9, 'board blooms open on game end', `theta at ${(bloomed*100).toFixed(0)}% of full`);
  await s.shot(__dirname + '/shots/checkmate.png');

  // ---- 6. undo restores the position exactly ----
  await s.eval(`
    epoch++; game.reset(); game.moveLog = []; view.setTwistAngle(0); game.twist = false; gameFinished = false; thinking = false;
    playerColor = WHITE; view.setThetaManual(0); ui.level.value = '0'; refreshStatus();
  `);
  await sleep(150);
  const before = await s.eval(`game.positionKey()`);
  await play('e2', 'e4');
  await sleep(2200);                                   // let the AI reply
  const movesPlayed = await s.eval(`game.moveLog.length`);
  await s.eval(`document.getElementById('undo').click()`);
  await sleep(250);
  const after = await s.eval(`JSON.stringify({ key: game.positionKey(), log: game.moveLog.length, turn: game.turn })`);
  const A = JSON.parse(after);
  ok(A.key === before && A.log === 0 && A.turn === 0,
     'undo restores the exact start position', `${movesPlayed} plies undone`);

  // ---- 7. en passant through the UI ----
  await s.eval(`
    epoch++; game.reset(); game.moveLog = []; view.setTwistAngle(0); game.twist = false; gameFinished = false; thinking = false;
    game.loadFEN('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    playerColor = WHITE; view.setThetaManual(0); refreshStatus();
  `);
  await sleep(150);
  await play('e5', 'd6');
  const ep = await s.eval(`JSON.stringify({
    san: game.moveLog[0] && game.moveLog[0].san,
    d5cleared: game.board[0x43] === EMPTY,
    pawnOnD6: typeOf(game.board[0x53]) === PAWN })`);
  const E = JSON.parse(ep);
  ok(E.san === 'exd6' && E.d5cleared && E.pawnOnD6, 'en passant removes the passed pawn', JSON.stringify(E));

  console.log('\nconsole errors:', errs().length ? errs() : 'none');
  console.log(`${pass} passed, ${fail} failed`);
  await s.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
