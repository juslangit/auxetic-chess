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

  // ---- 2b. a pushed pawn follows the rotation and stays there ----
  /* Luqman's case: play a2-a4, the board turns, and the pawn must now be on b4
     -- and still be there once the animation has finished, not back on a4.
     Driven by clicks, and the drawn position is checked as well as the board. */
  await setup(`window.__aiTurn = aiTurn; aiTurn = function () {};`);
  await s.click(...await at('a2')); await sleep(140);
  await s.click(...await at('a4'));
  await waitSolid();
  const pawnCarried = await s.eval(`(() => {
    const idx = n => 'abcdefgh'.indexOf(n[0]) + (+n[1] - 1) * 16;
    const name = i => 'abcdefgh'[i & 7] + ((i >> 4) + 1);
    const A4 = idx('a4'), B4 = idx('b4');
    const p = game.board[B4];
    const onB4 = typeOf(p) === PAWN && colorOf(p) === WHITE;
    // and it is DRAWN there, now the animation is over
    const drawn = view.piecePosition(B4, performance.now());
    const seat = view.squareLayout(B4);
    const settled = Math.abs(drawn.x - seat.x) < 0.01 && Math.abs(drawn.y - seat.y) < 0.01;
    const moves = game.legalMoves().filter(m => m.from === B4).map(m => {
      const dr = (m.to >> 4) - (B4 >> 4), df = (m.to & 7) - (B4 & 7);
      return name(m.to) + ':' + [dr > 0 ? 'forward' : dr < 0 ? 'BACK' : '',
        df > 0 ? 'RIGHT' : df < 0 ? 'LEFT' : ''].filter(Boolean).join('+');
    });
    return JSON.stringify({ onB4, a4empty: game.board[A4] === 0, settled, moves,
                            log: game.moveLog.map(x => x.san) });
  })()`);
  const CR = JSON.parse(pawnCarried);
  ok(CR.onB4 && CR.a4empty && CR.settled,
     'a2-a4 then the twist leaves the pawn on b4',
     `on b4: ${CR.onB4}, a4 empty: ${CR.a4empty}, drawn there: ${CR.settled}`);
  await s.eval(`aiTurn = window.__aiTurn;`);

  // ---- 2c. every piece lands on its own square, with no snap at the end ----
  /* The sweep must go to each piece's ACTUAL destination, which is not always a
     quarter turn: pawns are frozen and the rest cycle among the free squares,
     so a block like e1-f2 (pawns on e2 and f2) leaves the king and bishop in a
     two-cycle -- half a turn. Rotating everything by 90 degrees puts them in the
     wrong place and they snap when the animation ends.

     Sampling piecePosition at the animation's start, middle and end catches
     exactly that: start must equal the square each piece came from, end must
     equal the square it is on, and a frozen pawn must not move at all. */
  await setup(`window.__aiTurn = aiTurn; aiTurn = function () {};`);
  const landing = await s.eval(`(() => {
    const name = i => 'abcdefgh'[i & 7] + ((i >> 4) + 1);
    const idx = n => 'abcdefgh'.indexOf(n[0]) + (+n[1] - 1) * 16;

    const m = game.legalMoves().find(x => x.from === idx('b1') && x.to === idx('c3'));
    game.make(m);
    view.pieceAnim = null;                       // isolate the twist sweep
    void view.twistOnce(1000, 0);
    const tw = view.twistAnim;
    const at = (frac) => tw.t0 + tw.dur * frac;

    const near = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    const startWrong = [], endWrong = [], pawnMoved = [];
    let halfTurns = 0, quarterTurns = 0, frozen = 0;

    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f;
      const piece = game.board[sq];
      if (!piece) continue;
      const home = game.twistPreimage(sq);

      // where it should be at each end of the sweep
      if (!near(view.piecePosition(sq, at(0)), view.squareLayout(home))) startWrong.push(name(sq));
      if (!near(view.piecePosition(sq, at(1)), view.squareLayout(sq))) endWrong.push(name(sq));

      if (home === sq) {
        frozen++;                                  // should never happen now
      } else {
        const L = view.squareLayout(home), T = view.squareLayout(sq), C = L.tile;
        const TAU = Math.PI * 2;
        const d = ((Math.atan2(T.y - C.cy, T.x - C.cx) - Math.atan2(L.y - C.cy, L.x - C.cx)) % TAU + TAU) % TAU;
        if (Math.abs(d - Math.PI) < 0.01) halfTurns++;
        else if (Math.abs(d - Math.PI / 2) < 0.01) quarterTurns++;
      }
    }
    view.setTwistAngle(view.twistAngle);         // stop the animation cleanly
    return JSON.stringify({ startWrong, endWrong, halfTurns, quarterTurns, frozen });
  })()`);
  const LD = JSON.parse(landing);
  ok(LD.startWrong.length === 0, 'every piece starts on the square it came from',
     LD.startWrong.length ? LD.startWrong.join(' ') : 'all correct');
  ok(LD.endWrong.length === 0, 'every piece lands on its square, no snap',
     LD.endWrong.length ? `wrong: ${LD.endWrong.join(' ')}` : 'all correct');
  ok(LD.frozen === 0 && LD.quarterTurns > 0 && LD.halfTurns === 0,
     'every piece travels exactly one quarter turn',
     `${LD.quarterTurns} quarter, ${LD.halfTurns} half, ${LD.frozen} stayed put`);
  await s.eval(`aiTurn = window.__aiTurn;`);

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
