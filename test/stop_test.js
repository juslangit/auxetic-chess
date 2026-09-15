/* Stop turning: a player may stop the board for their move and the reply.
   Run with node from the project root. */
const fs = require('fs'), H = __dirname + '/../js/';
const ctx = new Function(
  fs.readFileSync(H + 'chess.js', 'utf8') + '\n' + fs.readFileSync(H + 'ai.js', 'utf8') +
  '\n; return {Chess, AI, squareName, F_STOP, WHITE, BLACK};')();
const { Chess, AI, squareName, F_STOP, WHITE, BLACK } = ctx;

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(52)}${extra}`); };
const idx = (n) => 'abcdefgh'.indexOf(n[0]) + (+n[1] - 1) * 16;
const snapshot = (g) => Array.from(g.board).join(',');

const newGame = () => { const g = new Chess(); g.twist = true; g.stopsPerGame = 3; g.reset(); return g; };
// Play from-to, with or without a stop. Throws if that move is not legal.
const play = (g, from, to, stop = false) => {
  const m = g.legalMoves().find((x) => x.from === idx(from) && x.to === idx(to) &&
    !!(x.flags & F_STOP) === stop);
  if (!m) throw new Error(`not legal: ${from}-${to}${stop ? ' with stop' : ''}`);
  g.make(m);
  return g.history[g.history.length - 1];
};
const turned = (h) => !!h.twisted;

console.log('--- the rule, as agreed ---');
{
  // White presses:  e4 (no turn)   ...e5 (no turn)   Nf3 (turns)
  const g = newGame();
  const a = play(g, 'e2', 'e4', true);
  ok(!turned(a) && a.stopped, 'White stops: e4 does not turn');
  ok(!g.canStop() && !g.legalMoves().some((m) => m.flags & F_STOP),
     'Black cannot stop while White\'s stop is running');
  // After e4 with no turn, e7 and e5 are where plain chess has them.
  const b = play(g, 'e7', 'e5');
  ok(!turned(b) && b.stopped, '...e5 does not turn either');
  const c = play(g, 'g1', 'f3');
  ok(turned(c) && !c.stopped, 'Nf3 turns again');
  ok(g.stopsLeft[WHITE] === 2 && g.stopsLeft[BLACK] === 3, 'White has 2 left, Black still 3',
     g.stopsLeft.join(' / '));
}
{
  // Black presses:  ...e5 (no turn)  Nf3 (no turn)  ...Nc6 (turns)
  const g = newGame();
  g.loadFEN('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  const a = play(g, 'e7', 'e5', true);
  ok(!turned(a), 'Black stops: ...e5 does not turn');
  const b = play(g, 'g1', 'f3');
  ok(!turned(b), 'White\'s reply Nf3 does not turn');
  const c = play(g, 'b8', 'c6');
  ok(turned(c), '...Nc6 turns again');
  ok(g.stopsLeft[BLACK] === 2 && g.stopsLeft[WHITE] === 3, 'Black has 2 left, White still 3',
     g.stopsLeft.join(' / '));
}
{
  // A stopped move leaves the board exactly as plain chess would.
  const g = newGame(), plain = new Chess();
  play(g, 'd2', 'd4', true);
  plain.make(plain.legalMoves().find((m) => m.from === idx('d2') && m.to === idx('d4')));
  ok(snapshot(g) === snapshot(plain), 'a stopped move is just the move, nothing carried');
}

console.log('\n--- limits ---');
{
  const g = newGame();
  const log = [];
  // White stops every time it is allowed to, Black never does.
  for (let ply = 0; ply < 16; ply++) {
    const us = g.turn;
    const wantStop = us === WHITE && g.canStop();
    const legal = g.legalMoves().filter((m) => !!(m.flags & F_STOP) === wantStop);
    g.make(legal[0]);
    if (wantStop) log.push(ply);
  }
  ok(log.length === 3, 'three stops per game, then no more', `White stopped at plies ${log.join(', ')}`);
  ok(log.every((p, i) => i === 0 || p - log[i - 1] >= 2), 'a new stop only after the last one ended');
  ok(g.stopsLeft[WHITE] === 0, 'White has none left', g.stopsLeft.join(' / '));
}
{
  // Stops off (the engine default) produce no stop moves at all.
  const g = new Chess(); g.twist = true;
  ok(!g.legalMoves().some((m) => m.flags & F_STOP), 'engine default: no stops offered');
  const s = newGame();
  ok(s.legalMoves().length === 40, 'start position: 20 moves, each with and without a stop',
     String(s.legalMoves().length));
}

console.log('\n--- undo ---');
{
  const g = newGame();
  const before = { board: snapshot(g), key: g.positionKey(), left: g.stopsLeft.join(), plies: g.stopPlies };
  play(g, 'e2', 'e4', true); play(g, 'e7', 'e5'); play(g, 'g1', 'f3');
  // Nf3 turned the board, so Black's pieces have moved: take any stopped move.
  g.make(g.legalMoves().find((m) => m.flags & F_STOP));
  for (let i = 0; i < 4; i++) g.unmake();
  ok(snapshot(g) === before.board && g.positionKey() === before.key &&
     g.stopsLeft.join() === before.left && g.stopPlies === before.plies,
     'unmake gives the stops back and restores everything', `left ${g.stopsLeft.join(' / ')}`);

  // Random games with stops, unwound to the start, many times.
  let exact = true;
  for (let t = 0; t < 20 && exact; t++) {
    const r = newGame(), start = r.positionKey() + snapshot(r);
    let n = 0;
    for (; n < 40; n++) {
      const ms = r.legalMoves();
      if (!ms.length) break;
      r.make(ms[(Math.random() * ms.length) | 0]);
    }
    while (n--) r.unmake();
    if (r.positionKey() + snapshot(r) !== start) exact = false;
  }
  ok(exact, 'random games with stops unwind exactly', '20 games, 40 plies each');
}

console.log('\n--- repetition ---');
{
  // Nf3 with a stop leaves the same board as plain chess -- so the only
  // difference from the plain position is the stops, and that must count.
  const g = newGame();
  play(g, 'g1', 'f3', true);
  const noStop = newGame(); noStop.loadFEN('rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 0 1');
  ok(g.positionKey() !== noStop.positionKey(), 'a running stop or a spent one makes it a new position');
}

console.log('\n--- the computer ---');
{
  // It must play legal moves, stops included, and not throw them all away at once.
  let illegal = null, firstStops = [];
  for (let game = 0; game < 3 && !illegal; game++) {
    const g = newGame(), ai = new AI(g);
    let plies = 0, first = null;
    while (plies < 40 && !g.gameOver()) {
      const r = ai.think(1);
      const legal = g.legalMoves().some((m) => m.from === r.move.from && m.to === r.move.to &&
        m.flags === r.move.flags && m.promo === r.move.promo);
      if (!legal) { illegal = `game ${game} ply ${plies}`; break; }
      if ((r.move.flags & F_STOP) && first === null) first = plies;
      g.make(r.move);
      plies++;
    }
    firstStops.push(first === null ? 'none' : first);
  }
  ok(!illegal, 'the computer only plays legal moves, stops included', illegal || 'first stop at ' + firstStops.join(', '));
  /* An earlier version of this suite asserted the computer never stops on its
     first move, on the belief that such a stop was an evaluation illusion. It
     is not: with material alone, a normal first move lets the turning board
     hand Black an early check (1.Nf3, twist, ...Bc4+) and loses about 4 pawns
     by depth 6, while a stop loses about 2. So early stops are allowed. What
     a stop's price must guarantee is narrower: never spend one for nothing. */
  {
    const g = newGame();
    g.loadFEN('k7/8/8/8/8/8/8/7K w - - 0 1');        // nothing on the board a stop could change
    let spent = 0;
    for (let p = 0; p < 6; p++) {
      const r = new AI(g).think(1);
      if (r.move.flags & F_STOP) spent++;
      g.make(r.move);
    }
    ok(spent === 0, 'a stop is never spent when it gains nothing', `${spent} stops in 6 king moves`);
  }

  // It sees a stop it can use. Rather than hand-craft one, find a position where
  // the best stopped move beats the best plain move by more than a minor piece,
  // and check the real search picks a stopped move there.
  let found = null;
  for (let t = 0; t < 400 && !found; t++) {
    const g = newGame();
    for (let p = 0; p < 6 + (t % 10); p++) {
      const ms = g.legalMoves().filter((m) => !(m.flags & F_STOP));
      if (!ms.length) break;
      g.make(ms[(Math.random() * ms.length) | 0]);
    }
    if (g.gameOver() || !g.canStop()) continue;
    const ai = new AI(g);
    // compare the best plain move against the best stopped move, 2 plies + quiescence
    const scoreOf = (stop) => {
      let best = -Infinity;
      for (const m of g.legalMoves().filter((x) => !!(x.flags & F_STOP) === stop)) {
        g.make(m);
        ai.deadline = Date.now() + 1e9; ai.aborted = false; ai.rootDepth = 2;
        const s = -ai.negamax(1, -Infinity, Infinity, 1);
        g.unmake();
        if (s > best) best = s;
      }
      return best;
    };
    const plain = scoreOf(false), stopped = scoreOf(true);
    if (stopped - plain > 300) found = { g, plain, stopped };
  }
  if (found) {
    const r = new AI(found.g).think(1);
    ok(!!(r.move.flags & F_STOP), 'when stopping wins material, the computer stops',
       `stop worth ${found.stopped - found.plain} over the best plain move`);
  } else {
    ok(false, 'when stopping wins material, the computer stops', 'no test position found');
  }

  // Search depth is not crippled by the doubled move list.
  const plainG = new Chess(); plainG.twist = true;
  const stopG = newGame();
  const dPlain = new AI(plainG).think(2).depth, dStop = new AI(stopG).think(2).depth;
  ok(dStop >= dPlain, 'strong level searches as deep with stops as without', `${dStop} vs ${dPlain}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
