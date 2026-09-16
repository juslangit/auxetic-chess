/* The server's check on a claimed win: a real finished game is accepted, and
   every way of faking or bending one is refused. */
const fs = require('fs'), H = __dirname + '/../js/', S = __dirname + '/../server/';
const ctx = new Function(
  fs.readFileSync(H + 'chess.js', 'utf8') + '\n' + fs.readFileSync(H + 'ai.js', 'utf8') + '\n' +
  fs.readFileSync(S + 'replay.js', 'utf8') +
  '\n; return {Chess, AI, replayWin, encodeMove, F_STOP, WHITE, BLACK, MAX_PLIES};')();
const { Chess, AI, replayWin, encodeMove, F_STOP, WHITE, BLACK, MAX_PLIES } = ctx;
const { seed } = require('./repeatable.js');
seed(+process.env.TEST_SEED || 1);

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(54)}${extra}`); };

const newGame = () => { const g = new Chess(); g.twist = true; g.stopsPerGame = 3; g.reset(); return g; };

// A real game, played the way the page plays it: club against casual until one mates.
function playToMate() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const g = newGame(), a = new AI(g), b = new AI(g), moves = [];
    let over = null;
    while (moves.length < 300 && !(over = g.gameOver())) {
      const r = g.turn === WHITE ? a.think(1) : b.think(0);
      moves.push(encodeMove(r.move));
      g.make(r.move);
      g.pushRepetition();
    }
    if (over && over.type === 'checkmate') return { moves, winner: over.winner, usedStop: moves.some((x) => x.endsWith('s')) };
  }
  throw new Error('no checkmate in 20 games');
}

console.log('--- a real win ---');
const game = playToMate();
const real = replayWin({ moves: game.moves, side: game.winner });
ok(real.ok && real.plies === game.moves.length, 'a real checkmate is accepted',
   `${game.moves.length} plies, ${game.winner === WHITE ? 'White' : 'Black'} mates${game.usedStop ? ', stops used' : ''}`);
ok(!replayWin({ moves: game.moves, side: game.winner ^ 1 }).ok, 'claiming it for the losing side is refused');

console.log('\n--- the move encoding ---');
{
  const g = newGame();
  const withStop = g.legalMoves().find((m) => m.flags & F_STOP);
  const plain = g.legalMoves().find((m) => !(m.flags & F_STOP) && m.from === withStop.from && m.to === withStop.to);
  ok(encodeMove(withStop) === encodeMove(plain) + 's', 'a stopped move is the same move plus "s"', `${encodeMove(plain)} / ${encodeMove(withStop)}`);
  // White pawn on e7 with nothing in front: four promotions, one string each.
  g.loadFEN('7k/4P3/8/8/8/8/8/K7 w - - 0 1');
  const promos = g.legalMoves().filter((m) => m.promo && !(m.flags & F_STOP)).map(encodeMove).sort();
  ok(promos.join() === 'e7e8b,e7e8n,e7e8q,e7e8r', 'each promotion has its own letter', promos.join(' '));
}

console.log('\n--- fakes ---');
{
  const m = game.moves;
  const why = (moves, side = game.winner) => replayWin({ moves, side });

  const swapped = m.slice(); [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  let r = why(swapped);
  ok(!r.ok && /move 1/.test(r.reason), 'moves out of order are refused', r.reason);

  r = why(m.slice(0, -1));
  ok(!r.ok && r.reason === 'the game is not finished', 'a game cut short of mate is refused', r.reason);

  r = why(m.concat(['e2e4']));
  ok(!r.ok && /already over/.test(r.reason), 'moves after the mate are refused', r.reason);

  r = why(['e2e5']);
  ok(!r.ok && /not legal/.test(r.reason), 'an impossible move is refused', r.reason);

  // Stripping the stops changes which turns turned, so the same squares stop being legal.
  const noStops = m.map((x) => x.replace(/s$/, ''));
  r = why(noStops);
  ok(!game.usedStop || !r.ok, 'the same game with its stops removed is refused', game.usedStop ? r.reason : 'game used no stops');

  // Four stops for White: play a quiet game where White stops whenever it can,
  // then forge a fourth on White's next move once all three are spent.
  const g = newGame(), moves = [];
  const play = (x) => { moves.push(encodeMove(x)); g.make(x); g.pushRepetition(); };
  while (!(g.turn === WHITE && g.stopsLeft[WHITE] === 0 && g.stopPlies === 0) && !g.gameOver() && moves.length < 60) {
    const legal = g.legalMoves().filter((x) => !(x.flags & 1));            // no captures: keep it going
    const pool = legal.length ? legal : g.legalMoves();
    const want = g.turn === WHITE && g.canStop();
    play(pool.find((x) => !!(x.flags & F_STOP) === want) || pool[0]);
  }
  const next = !g.gameOver() && g.legalMoves().find((x) => !(x.flags & F_STOP));
  r = next ? replayWin({ moves: moves.concat([encodeMove(next) + 's']), side: WHITE }) : { ok: true, reason: 'setup failed' };
  ok(!r.ok && /not legal/.test(r.reason), 'a fourth stop is refused', `${r.reason}, after ${moves.length} plies`);

  ok(!why([]).ok && !why('e2e4').ok && !why([42]).ok, 'empty, non-list and non-text moves are refused');
  ok(!why(new Array(MAX_PLIES + 1).fill('e2e4')).ok, `more than ${MAX_PLIES} moves is refused`);
  ok(!replayWin({ moves: m, side: 2 }).ok && !replayWin({ moves: m, side: 'white' }).ok, 'a side other than 0 or 1 is refused');
}

console.log('\n--- a draw is not a win ---');
{
  // Random games mostly end in a draw of some kind. Take the first one and claim it.
  let drawn = null;
  for (let t = 0; t < 50 && !drawn; t++) {
    const g = newGame(), moves = [];
    let over = null;
    while (moves.length < 400 && !(over = g.gameOver())) {
      const legal = g.legalMoves(), x = legal[(Math.random() * legal.length) | 0];
      moves.push(encodeMove(x)); g.make(x); g.pushRepetition();
    }
    if (over && over.type !== 'checkmate') drawn = { moves, type: over.type };
  }
  const r = drawn ? replayWin({ moves: drawn.moves, side: WHITE }) : { ok: true };
  ok(drawn && !r.ok && r.reason === `the game ended in ${drawn.type}`, 'a drawn game is refused for either side',
     drawn ? `${drawn.type} after ${drawn.moves.length} plies` : 'no draw found');
  ok(drawn && !replayWin({ moves: drawn.moves, side: BLACK }).ok, 'and for Black too');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
