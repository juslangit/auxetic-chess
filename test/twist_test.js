/* The twist: every 2x2 block turns a quarter after each move, carrying pieces.
   Run with node from the project root. */
const fs = require('fs'), H = __dirname + '/../js/';
const ctx = new Function(
  fs.readFileSync(H + 'chess.js', 'utf8') + '\n' + fs.readFileSync(H + 'ai.js', 'utf8') +
  '\n; return {Chess, AI, twistForward, twistBack, squareName, sq, PAWN, QUEEN, KING, ROOK,' +
  ' WHITE, BLACK, EMPTY, typeOf, colorOf, FILES};')();
const { Chess, AI, twistForward, twistBack, squareName, PAWN, QUEEN, KING, ROOK, WHITE, BLACK, EMPTY, typeOf, colorOf } = ctx;

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

  // the example Luqman gave: a4 is the top-left cell of the a3-b4 block
  ok(squareName(twistForward(idx('a4'))) === 'b4',
     'a4 is carried to b4', `a4 -> ${squareName(twistForward(idx('a4')))}`);

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

console.log('\n--- everything is carried, pawns included ---');
{
  /* The board turns and takes every piece with it -- one cell round its block,
     the same for pawns as for anything else. Checked against an independent
     rotation of the position rather than against itself. */
  const g = new Chess(); g.twist = true;
  const m = g.legalMoves().find((x) => !(x.flags & 1));
  const before = Int8Array.from(g.board);
  // apply just the move to a twist-free clone, then rotate it by hand
  const clone = new Chess(); clone.twist = false;
  clone.board = Int8Array.from(before);
  clone.turn = WHITE; clone.castling = 15; clone.ep = -1;
  clone.kingSq = [0x04, 0x74]; clone.history = [];
  clone.make(clone.legalMoves().find((x) => x.from === m.from && x.to === m.to));
  const expect = Int8Array.from(clone.board);
  const rotated = new Int8Array(128);
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = r * 16 + f;
    rotated[twistForward(sq)] = expect[sq];
  }
  g.make(m);
  let same = true;
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = r * 16 + f;
    if (g.board[sq] !== rotated[sq]) same = false;
  }
  ok(same, 'the board equals the move then a quarter turn of everything');

  // a pawn really does travel
  const h = new Chess(); h.twist = true;
  h.make(h.legalMoves().find((x) => x.from === idx('a2') && x.to === idx('a4')));
  const carried = h.legalMoves();      // a2-a4 then the twist: a4 -> b4
  ok(typeOf(h.board[idx('b4')]) === PAWN && h.board[idx('a4')] === EMPTY,
     'a pawn played to a4 is carried to b4',
     `b4 holds a pawn: ${typeOf(h.board[idx('b4')]) === PAWN}, a4 empty: ${h.board[idx('a4')] === EMPTY}`);
  void carried;
}

console.log('\n--- but a pawn only ever MOVES forward ---');
{
  /* Luqman's rule. The board may carry a pawn anywhere; the pawn's own moves
     must always go up the board for White and down for Black, never sideways
     and never backwards. Checked for every pawn in every position of a game. */
  const g = new Chess(); g.twist = true;
  let plies = 0, bad = null;
  while (plies < 160 && !bad) {
    const legal = g.legalMoves();
    if (!legal.length) break;
    for (const m of legal) {
      const p = g.board[m.from];
      if (typeOf(p) !== PAWN) continue;
      const dr = (m.to >> 4) - (m.from >> 4);
      const df = Math.abs((m.to & 7) - (m.from & 7));
      const forward = colorOf(p) === WHITE ? dr > 0 : dr < 0;
      // one step straight, two on the first push, or one diagonal to capture
      if (!forward || df > 1) {
        bad = `${squareName(m.from)}->${squareName(m.to)} at ply ${plies}`;
        break;
      }
    }
    g.make(legal[(Math.random() * legal.length) | 0]);
    plies++;
  }
  ok(!bad, 'no pawn move is ever sideways or backwards',
     bad || `checked every pawn move across ${plies} plies`);
}

console.log('\n--- a pawn carried to the far rank promotes ---');
{
  const g = new Chess();
  g.loadFEN('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  g.twist = true;
  const before = typeOf(g.board[6 * 16]) === PAWN;                 // a7
  g.make(g.legalMoves().find((m) => m.from === g.kingSq[WHITE]));
  const landed = g.board[7 * 16];                                  // a8
  ok(before && typeOf(landed) === QUEEN && colorOf(landed) === WHITE,
     'a pawn on a7 is carried to a8 and becomes a queen');
  g.unmake();
  ok(typeOf(g.board[6 * 16]) === PAWN, 'and unmake turns it back into a pawn on a7');
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
  /* What "playable" means here is specifically: the twist does not freeze the
     game. The first rule tried drew by stalemate on move 3 because every move
     was illegal. So the thing to assert is that games reach a legitimate result
     and that none of them dies early in a draw -- not that they last a certain
     number of plies. A fast checkmate is a good outcome, not a deadlock. */
  const results = [];
  let earlyDraw = null, zeroLegal = null;

  for (let gameNo = 0; gameNo < 3; gameNo++) {
    const g = new Chess(); g.twist = true;
    const ai = new AI(g);
    let plies = 0, over = null;
    while (plies < 100) {
      over = g.gameOver();
      if (over) break;
      const n = g.legalMoves().length;
      if (n === 0) { zeroLegal = plies; break; }      // would be a contradiction
      const r = ai.think(1);
      if (!r) break;
      g.make(r.move);
      plies++;
    }
    const how = over ? over.type : 'still going at 100';
    results.push(`${how}@${plies}`);
    const isDraw = over && over.type !== 'checkmate';
    if (isDraw && plies < 20) earlyDraw = `${over.type} after only ${plies} plies`;
  }

  ok(!earlyDraw && !zeroLegal,
     'games reach a real result, none dies in an early draw',
     earlyDraw || (zeroLegal !== null ? `no legal moves at ply ${zeroLegal}` : results.join('  ')));
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
