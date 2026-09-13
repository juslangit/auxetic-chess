const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../js/chess.js', 'utf8');
const { Chess } = new Function(src + '; return {Chess};')();

function perft(g, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of g.generate()) {
    g.make(m);
    if (!g.isAttacked(g.kingSq[g.turn ^ 1], g.turn)) n += perft(g, depth - 1);
    g.unmake();
  }
  return n;
}

// Standard perft suite (Chess Programming Wiki). These numbers are published
// reference values -- any deviation means the move generator is wrong.
const suite = [
  ['startpos', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
   [20, 400, 8902, 197281, 4865609]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
   [48, 2039, 97862, 4085603]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
   [14, 191, 2812, 43238, 674624]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
   [6, 264, 9467, 422333]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
   [44, 1486, 62379, 2103487]],
  ['position 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
   [46, 2079, 89890, 3894594]],
];

let pass = 0, fail = 0;
for (const [name, fen, expected] of suite) {
  for (let d = 1; d <= expected.length; d++) {
    const g = new Chess();
    g.loadFEN(fen);
    const t0 = Date.now();
    const got = perft(g, d);
    const ms = Date.now() - t0;
    const ok = got === expected[d - 1];
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(11)} depth ${d}  ` +
      `${String(got).padStart(9)} ${ok ? '' : '(expected ' + expected[d - 1] + ')'}  ${ms}ms`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
