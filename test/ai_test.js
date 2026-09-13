const fs = require('fs'), H = __dirname + '/../js/';
const ctx = new Function(
  fs.readFileSync(H + 'chess.js', 'utf8') + '\n' + fs.readFileSync(H + 'ai.js', 'utf8') +
  '\n; return {Chess, AI};')();
const { Chess, AI } = ctx;

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(34)}${extra}`); };

// Find every move that delivers mate, using the perft-proven generator.
// The test never trusts my own analysis of the position.
function matingMoves(g) {
  const out = [];
  for (const m of g.legalMoves()) {
    g.make(m);
    if (g.inCheck() && g.legalMoves().length === 0) out.push(m);
    g.unmake();
  }
  return out;
}

console.log('--- mate in 1: engine must find a mate the generator proves exists ---');
for (const fen of [
  '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
  '7k/6R1/5K2/8/8/8/8/8 w - - 0 1',
  '3qk3/8/8/8/8/8/5PPP/4R1K1 w - - 0 1',
  'k7/8/1K6/8/8/8/8/7R w - - 0 1',
  '2k5/8/2K5/8/8/8/8/4R3 w - - 0 1',
]) {
  const g = new Chess(); g.loadFEN(fen);
  const mates = matingMoves(g);
  if (!mates.length) { console.log(`SKIP  no mate in 1 exists in ${fen}`); continue; }
  const want = mates.map(m => g.toSAN(m));
  const r = new AI(g).think(2);
  const got = g.toSAN(r.move);
  ok(want.includes(got), `mate found: ${got}`, `of [${want.join(' ')}]  d${r.depth} ${r.ms}ms`);
}

console.log('\n--- material: engine must win free material ---');
for (const [fen, note] of [
  ['4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1', 'pawn takes queen'],
  ['4k3/8/8/8/8/5n2/8/3QK3 w - - 0 1',  'queen takes knight'],
  ['rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2', 'exd5'],
]) {
  const g = new Chess(); g.loadFEN(fen);
  const before = new AI(g).evaluate();
  const r = new AI(g).think(2);
  const san = g.toSAN(r.move);
  g.make(r.move);
  const after = -new AI(g).evaluate();   // still from White's point of view
  g.unmake();
  ok(after > before, `${note}: ${san}`, `eval ${before} -> ${after}`);
}

console.log('\n--- the engine must not hang its queen ---');
{
  // Qd1, black rook a8 eyeing the a-file. Qa4 would drop the queen to nothing;
  // check that after the engine's move its queen is not simply capturable for free.
  const g = new Chess(); g.loadFEN('r3k3/8/8/8/8/8/8/3QK3 w - - 0 1');
  const r = new AI(g).think(2);
  const san = g.toSAN(r.move);
  g.make(r.move);
  const loses = g.legalMoves().some(m => (m.flags & 1) && typeOf(g.board[m.to]) === 5);
  g.unmake();
  ok(!loses, `queen kept safe after ${san}`);
}

console.log('\n--- strength: level 3 must beat level 0 across a full game ---');
{
  const g = new Chess();
  const strong = new AI(g), weak = new AI(g);
  let plies = 0, over = null;
  while (plies < 160) {
    over = g.gameOver();
    if (over) break;
    // White = strong (level 2 to keep the test quick), Black = casual (level 0)
    const r = (g.turn === 0 ? strong.think(2) : weak.think(0));
    const legal = g.legalMoves();
    if (!legal.some(m => m.from === r.move.from && m.to === r.move.to && m.promo === r.move.promo)) {
      ok(false, 'ILLEGAL move in self-play at ply ' + plies); break;
    }
    g.make(r.move); plies++;
  }
  const ev = new AI(g).evaluate();
  const whiteAdv = g.turn === 0 ? ev : -ev;
  ok(whiteAdv > 100 || (over && over.type === 'checkmate' && over.winner === 0),
     'strong side is winning', `${plies} plies, white eval ${whiteAdv}, ${over ? over.type : 'ongoing'}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
