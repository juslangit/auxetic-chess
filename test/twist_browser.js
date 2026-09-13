/* The twist, driven through the real UI: does a click actually carry the pieces
   round, does the animation land, and does undo put everything back. */
const { launch, Session, sleep } = require('./cdp.js');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(46)}${extra}`); };
const QUARTER = Math.PI / 2;

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(3400);
  fs.mkdirSync(__dirname + '/shots', { recursive: true });
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
  const waitTurn = async () => {
    for (let i = 0; i < 120; i++) {
      const st = JSON.parse(await s.eval(`JSON.stringify({
        solid: view.isSolid, thinking, yours: game.turn === playerColor })`));
      if (st.solid && !st.thinking && st.yours) return true;
      await sleep(100);
    }
    return false;
  };
  const setup = async (extra = '') => {
    await s.eval(`epoch++; game.reset(); game.moveLog = []; gameFinished = false; thinking = false;
      playerColor = WHITE; view.flipped = false; view.setThetaManual(0); view.setTwistAngle(0);
      game.twist = true; ui.level.value = '0';
      view.lastMove = null; view.selected = -1; view.legalTargets = []; view.pieceAnim = null;
      ${extra} refreshMoveList(); refreshCaptured(); refreshStatus();`);
    await sleep(250);
  };

  // ---- 1. the board really is move-then-rotate-every-block ----
  /* The AI's reply would land before this can be measured, so stub it out for
     this one case. `aiTurn` is a top-level function in a classic script, so it
     is a writable global. Restored immediately afterwards. */
  await setup(`window.__aiTurn = aiTurn; aiTurn = function () {};`);
  const before = await s.eval(`JSON.stringify(Array.from(game.board))`);
  await s.click(...await at('e2')); await sleep(140);
  await s.click(...await at('e4'));
  await waitSolid();
  const check1 = await s.eval(`(() => {
    // rebuild the expected position independently: same move on a twist-free
    // clone, then turn every block once.
    const expect = new Chess();
    expect.twist = false;
    expect.board = Int8Array.from(${before});
    expect.turn = WHITE; expect.castling = 15; expect.ep = -1;
    expect.kingSq = [0x04, 0x74]; expect.history = [];
    const m = expect.legalMoves().find(x => x.from === 0x14 && x.to === 0x34);
    expect.make(m);
    expect.rotateAllBlocks(1);
    const a = Array.from(game.board).join(','), b = Array.from(expect.board).join(',');
    return JSON.stringify({ match: a === b, log: game.moveLog.map(x => x.san + (x.twisted ? '*' : '')) });
  })()`);
  const C1 = JSON.parse(check1);
  ok(C1.match, 'position = the move, then every block turned', `log ${C1.log.join(' ')}`);
  await s.eval(`aiTurn = window.__aiTurn;`);

  // ---- 2. a named piece is carried exactly one step round its block ----
  await setup(`game.loadFEN('4k3/8/8/8/8/8/8/R3K3 w - - 0 1'); game.twist = true; playerColor = WHITE;`);
  const carried = await s.eval(`(() => {
    const a1 = 0x00, a2 = 0x10;
    const rookBefore = typeOf(game.board[a1]) === ROOK;
    const m = game.legalMoves().find(x => x.from === game.kingSq[WHITE]);
    game.make(m);
    const rookAfter = typeOf(game.board[a2]) === ROOK && game.board[a1] === EMPTY;
    game.unmake();
    return JSON.stringify({ rookBefore, rookAfter, backOnA1: typeOf(game.board[a1]) === ROOK });
  })()`);
  const C2 = JSON.parse(carried);
  ok(C2.rookBefore && C2.rookAfter && C2.backOnA1,
     'a rook on a1 is carried to a2, and unmake returns it', JSON.stringify(C2));

  // ---- 3. the animation runs, locks the board, and the paint tracks the engine ----
  await setup();
  const paint0 = await s.eval(`view.twistAngle`);
  await s.click(...await at('d2')); await sleep(140);
  await s.click(...await at('d4'));
  await sleep(120);
  const midAnim = await s.eval(`JSON.stringify({ running: !!view.twistAnim, solid: view.isSolid })`);
  ok(JSON.parse(midAnim).running && !JSON.parse(midAnim).solid,
     'the twist animates and locks the board while it runs', midAnim);

  /* Measuring the paint on a timer races the AI's own reply, so let the round
     finish and tie the angle to the engine's record instead: one quarter for
     every turn that actually twisted. That is the invariant worth asserting. */
  await waitTurn();
  const tracked = await s.eval(`JSON.stringify({
    paint: view.twistAngle,
    twists: game.moveLog.filter(x => x.twisted).length,
    plies: game.moveLog.length })`);
  const T3 = JSON.parse(tracked);
  const expected = (paint0 + T3.twists * QUARTER) % (Math.PI * 2);
  ok(Math.abs(T3.paint - expected) < 1e-9,
     'paint = one quarter per turn that twisted',
     `${T3.plies} plies, ${T3.twists} twisted, paint ${(T3.paint / QUARTER).toFixed(3)} quarters`);

  // ---- 4. input is refused mid-twist ----
  await setup();
  await s.eval(`view.twistOnce(1500, 0); view.selected = -1`);
  await sleep(250);
  await s.click(...await at('e2')); await sleep(120);
  ok(await s.eval(`view.selected`) === -1, 'no input accepted mid-twist');
  await waitSolid();

  // ---- 5. the grid does not turn, so clicks stay on their squares ----
  let hits = true, detail = [];
  for (const quarters of [0, 1, 2, 3]) {
    await setup(`view.setTwistAngle(${quarters} * Math.PI / 2);`);
    for (const sq of ['a1', 'e2', 'h1', 'd1']) {
      await s.click(...await at(sq));
      await sleep(80);
      const got = await s.eval(`(() => { const v = view.selected;
        return v < 0 ? 'none' : 'abcdefgh'[v & 7] + ((v >> 4) + 1); })()`);
      if (got !== sq) { hits = false; detail.push(`${quarters}q ${sq}->${got}`); }
    }
  }
  ok(hits, 'clicks land on the same squares at any paint angle',
     hits ? 'all 16 hits' : detail.join(' '));

  // ---- 6. undo restores the position and the paint together ----
  await setup();
  const key0 = await s.eval(`game.positionKey()`);
  const paintStart = await s.eval(`view.twistAngle`);
  await s.click(...await at('g1')); await sleep(140);
  await s.click(...await at('f3'));
  await waitTurn();
  const pliesPlayed = await s.eval(`game.moveLog.length`);
  await s.eval(`document.getElementById('undo').click()`);
  await sleep(350);
  const restored = await s.eval(`JSON.stringify({
    key: game.positionKey(), log: game.moveLog.length, paint: view.twistAngle })`);
  const R = JSON.parse(restored);
  ok(R.key === key0 && R.log === 0 && Math.abs(R.paint - paintStart) < 1e-9,
     'undo restores position and paint angle', `${pliesPlayed} plies undone, paint ${R.paint.toFixed(4)}`);

  // ---- 7. a full round with the AI, twist and all ----
  await setup(`ui.level.value = '1';`);
  await s.click(...await at('e2')); await sleep(140);
  await s.click(...await at('e4'));
  const settled = await waitTurn();
  const round = await s.eval(`JSON.stringify({
    log: game.moveLog.map(x => x.san + (x.twisted ? '*' : '')),
    turn: game.turn, pieces: (()=>{let n=0;for(let r=0;r<8;r++)for(let f=0;f<8;f++)if(game.board[r*16+f])n++;return n;})(),
    status: document.getElementById('status').textContent })`);
  const RD = JSON.parse(round);
  ok(settled && RD.log.length === 2 && RD.turn === 0 && RD.pieces === 32,
     'a full round plays out, nothing captured by twisting', JSON.stringify(RD.log) + ` ${RD.pieces} pieces`);

  // ---- 8. frame rate while every block turns ----
  /* Headless Chrome rasterises in software, so the absolute number here is a
     floor, not what a real GPU does. The meaningful check is that the cost is
     fill rate and not algorithmic: shrink the canvas and the frame rate must
     come back up. If it did not, something per-piece or per-tile is too slow. */
  await setup();
  const bench = async () => s.eval(`(async () => {
    const px = document.getElementById('board');
    const fps = await new Promise(res => {
      view.twistOnce(1000, 0);
      let n = 0; const t0 = performance.now();
      const tick = () => { n++;
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else res(Math.round(n / ((performance.now() - t0) / 1000))); };
      requestAnimationFrame(tick);
    });
    return JSON.stringify({ fps, mp: +(px.width * px.height / 1e6).toFixed(2) });
  })()`);

  const big = JSON.parse(await bench());
  await waitSolid();
  await s.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 500, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  const small = JSON.parse(await bench());
  await waitSolid();
  await s.send('Emulation.clearDeviceMetricsOverride');
  await sleep(900);

  ok(small.fps >= 55, 'twist is not algorithmically bound',
     `${small.fps} fps at ${small.mp} MP`);
  ok(big.fps >= 28, 'and clears the software-raster floor at full size',
     `${big.fps} fps at ${big.mp} MP`);

  // ---- shots: mid-twist and settled ----
  /* `s.eval` awaits promises, and twistOnce resolves only when the animation
     ends -- so `void` it, or every capture lands after the twist has finished. */
  await setup(`ui.level.value = '0';`);
  await s.eval(`void view.twistOnce(3000, 0)`);
  await sleep(1100);
  const midAlpha = await s.eval(`+(view.twistAlpha(performance.now()) * 180 / Math.PI).toFixed(1)`);
  await s.shot(__dirname + '/shots/twist-mid.png');
  ok(midAlpha > 5 && midAlpha < 85, 'captured the twist genuinely mid-flight', `alpha ${midAlpha} deg`);
  await waitSolid();
  await s.shot(__dirname + '/shots/twist-done.png');

  console.log('\nconsole errors:', errs().length ? errs() : 'none');
  console.log(`${pass} passed, ${fail} failed`);
  await s.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
