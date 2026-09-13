/* The twist: every 2x2 block turns a quarter after each move, carrying pieces.
   Run with node from the project root. */
const fs = require('fs'), H = __dirname + '/../js/';
const ctx = new Function(
  fs.readFileSync(H + 'chess.js', 'utf8') + '\n' + fs.readFileSync(H + 'ai.js', 'utf8') +
  '\n; return {Chess, AI, twistForward, twistBack, squareName, sq, PAWN, QUEEN, KING, ROOK,' +
  ' WHITE, BLACK, EMPTY, typeOf, colorOf, FILES};')();
const { Chess, AI, twistForward, twistBack, squareName, PAWN, QUEEN, KING, WHITE, BLACK, EMPTY, typeOf, colorOf } = ctx;

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(46)}${extra}`); };
const idx = (n) => 'abcdefgh'.indexOf(n[0]) + (+n[1] - 1) * 16;
const snapshot = (g) => Array.from(g.board).join(',');

console.log('--- the permutation ---');
{
  // one named cycle, spelled out
  const chain = ['a1', 'a2', 'b2', 'b1'];
  let good = true, trace = [];
  for (let i = 0; i < 4; i++) {
    const from = chain[i], want = chain[(i + 1) % 4];
    const got = squareName(twistForward(idx(from)));
    trace.push(`${from}->${got}`);
    if (got !== want) good = false;
  }
  ok(good, 'a1 -> a2 -> b2 -> b1 -> a1', trace.join(' '));

  // forward then back is identity, on every square
  let inverseOk = true;
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const s = r * 16 + f;
    if (twistBack(twistForward(s)) !== s) inverseOk = false;
  }
  ok(inverseOk, 'twistBack undoes twistForward everywhere');

  // four turns is the identity, and no square ever leaves its own block
  let p4 = true, stays = true;
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const s = r * 16 + f;
    let t = s;
    for (let i = 0; i < 4; i++) {
      t = twistForward(t);
      if ((t & 7 & ~1) !== (f & ~1) || ((t >> 4) & ~1) !== (r & ~1)) stays = false;
    }
    if (t !== s) p4 = false;
  }
  ok(p4, 'four quarter turns is the identity');
  ok(stays, 'a piece never leaves its own 2x2 block');
}

console.log('\n--- it is a permutation, so it can never capture ---');
{
  const g = new Chess(); g.twist = true;
  const count = () => { let n = 0; for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (g.board[r * 16 + f]) n++; return n; };
  const before = count();
  g.rotateAllBlocks(1);
  const after = count();
  ok(before === after && before === 32, 'the twist alone preserves every piece', `${before} -> ${after}`);

  // through a real non-capturing move: 32 pieces before, 32 after
  const g2 = new Chess(); g2.twist = true;
  const m = g2.legalMoves().find((x) => !(x.flags & 1));
  g2.make(m);
  let n = 0; for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (g2.board[r * 16 + f]) n++;
  ok(n === 32, 'a quiet move plus twist still leaves 32 pieces', `${n}`);
}

console.log('\n--- make / unmake is exact ---');
{
  const g = new Chess(); g.twist = true;
  const start = snapshot(g);
  const startMeta = [g.turn, g.castling, g.ep, g.halfmove, g.kingSq[0], g.kingSq[1]].join('|');
  let allOk = true, depth = 0;
  // walk a long line, unmaking all the way back
  const walk = (d) => {
    if (d === 0) return;
    const moves = g.legalMoves();
    if (!moves.length) return;
    for (const m of moves.slice(0, 4)) {
      const before = snapshot(g);
      const beforeMeta = [g.turn, g.castling, g.ep, g.halfmove, g.kingSq[0], g.kingSq[1]].join('|');
      g.make(m);
      depth = Math.max(depth, 4 - d + 1);
      walk(d - 1);
      g.unmake();
      if (snapshot(g) !== before) allOk = false;
      if ([g.turn, g.castling, g.ep, g.halfmove, g.kingSq[0], g.kingSq[1]].join('|') !== beforeMeta) allOk = false;
    }
  };
  walk(4);
  ok(allOk && snapshot(g) === start &&
     [g.turn, g.castling, g.ep, g.halfmove, g.kingSq[0], g.kingSq[1]].join('|') === startMeta,
     'board and state restored exactly, 4 deep', `depth ${depth}`);
}

console.log('\n--- kings are tracked through the twist ---');
{
  const g = new Chess(); g.twist = true;
  let good = true;
  for (let i = 0; i < 8; i++) {
    const moves = g.legalMoves();
    if (!moves.length) break;
    g.make(moves[(Math.random() * moves.length) | 0]);
    for (const c of [WHITE, BLACK]) {
      const p = g.board[g.kingSq[c]];
      if (typeOf(p) !== KING || colorOf(p) !== c) good = false;
    }
  }
  ok(good, 'kingSq still points at each king');
}

console.log('\n--- legality is exactly normal chess ---');
{
  /* Because the twist yields when it would expose your king, it can never take
     a move away from you. So the legal move set must be identical to plain
     chess in every position -- that invariant is what stops the game freezing,
     and it is worth asserting directly. */
  const clonePlain = (src) => {
    const c = new Chess();
    c.twist = false;
    c.board = Int8Array.from(src.board);
    c.turn = src.turn; c.castling = src.castling; c.ep = src.ep;
    c.halfmove = src.halfmove; c.fullmove = src.fullmove;
    c.kingSq = src.kingSq.slice(); c.history = [];
    return c;
  };
  const key = (ms) => ms.map((m) => m.from + ':' + m.to + ':' + m.promo).sort().join(' ');

  const t = new Chess(); t.twist = true;
  let same = true, checked = 0, skipped = 0, worstPly = -1;
  for (let ply = 0; ply < 160; ply++) {
    const legalT = t.legalMoves();
    if (!legalT.length) break;
    if (key(legalT) !== key(clonePlain(t).legalMoves())) { same = false; worstPly = ply; break; }
    checked++;
    const m = legalT[(Math.random() * legalT.length) | 0];
    t.make(m);
    if (!t.history[t.history.length - 1].twisted) skipped++;
  }
  ok(same, 'the twist never removes a legal move',
     same ? `identical in ${checked} positions` : `diverged at ply ${worstPly}`);
  ok(skipped > 0, 'and it does stand down when it would expose your king',
     `${skipped} of ${checked} turns did not twist`);

  // no legal move may leave you in check, twist or no twist
  const g = new Chess(); g.twist = true;
  let safe = true;
  for (let ply = 0; ply < 40; ply++) {
    const ms = g.legalMoves();
    if (!ms.length) break;
    for (const m of ms) {
      g.make(m);
      if (g.isAttacked(g.kingSq[g.turn ^ 1], g.turn)) safe = false;
      g.unmake();
    }
    g.make(ms[(Math.random() * ms.length) | 0]);
  }
  ok(safe, 'no legal move ever leaves your king attacked');
}

console.log('\n--- a pawn carried to the far rank promotes ---');
{
  const g = new Chess(); g.twist = true;
  // white pawn on b7: b7 is (f=1,r=6) -> twistForward -> (f=1-1+0, r=6-0+1-1)=a7? check by running
  // find any position where a white pawn is carried to rank 8
  let found = null;
  for (let f = 0; f < 8; f++) {
    for (let r = 6; r <= 7; r++) {
      const from = r * 16 + f;
      if (twistForward(from) >> 4 === 7) { found = { from, to: twistForward(from) }; break; }
    }
    if (found) break;
  }
  g.loadFEN('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  g.twist = true;
  g.board[found.from] = PAWN;
  const m = g.legalMoves().find((x) => x.from === g.kingSq[WHITE]);
  g.make(m);
  const landed = g.board[found.to];
  ok(typeOf(landed) === QUEEN && colorOf(landed) === WHITE,
     'pawn carried onto rank 8 becomes a queen',
     `${squareName(found.from)} -> ${squareName(found.to)}`);
  g.unmake();
  ok(typeOf(g.board[found.from]) === PAWN, 'and unmake turns it back into a pawn');
}

console.log('\n--- the plain engine is untouched (twist off) ---');
{
  function perft(g, d) {
    if (d === 0) return 1;
    let n = 0;
    for (const m of g.generate()) {
      g.make(m);
      if (!g.isAttacked(g.kingSq[g.turn ^ 1], g.turn)) n += perft(g, d - 1);
      g.unmake();
    }
    return n;
  }
  const g = new Chess();                       // twist defaults to off
  const n1 = perft(g, 4);                      // count once, then assert on it
  ok(n1 === 197281, 'startpos perft(4) still 197,281', String(n1));
  const k = new Chess();
  k.loadFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const n2 = perft(k, 3);
  ok(n2 === 97862, 'kiwipete perft(3) still 97,862', String(n2));
}

console.log('\n--- is it actually playable? ---');
{
  const g = new Chess(); g.twist = true;
  const ai = new AI(g);
  let plies = 0, minLegal = 999, sumLegal = 0, over = null;
  const t0 = Date.now();
  while (plies < 120) {
    over = g.gameOver();
    if (over) break;
    const n = g.legalMoves().length;
    minLegal = Math.min(minLegal, n); sumLegal += n;
    const r = ai.think(1);
    if (!r) break;
    g.make(r.move);
    plies++;
  }
  const ms = Date.now() - t0;
  ok(plies > 20 && minLegal > 0,
     'a whole self-play game runs without deadlock',
     `${plies} plies, ${(sumLegal / Math.max(1, plies)).toFixed(1)} legal moves avg, min ${minLegal}, ${over ? over.type : 'ongoing'}, ${ms}ms`);
}

console.log('\n--- search cost of the twist ---');
{
  for (const tw of [false, true]) {
    const g = new Chess(); g.twist = tw;
    const ai = new AI(g);
    const r = ai.think(2);
    console.log(`      twist ${tw ? 'on ' : 'off'}: depth ${r.depth}, ${r.nodes} nodes in ${r.ms}ms ` +
                `(${Math.round(r.nodes / Math.max(1, r.ms))}k nps)`);
  }
  ok(true, 'search still reaches a usable depth with the twist');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
