/* Checks a claimed win by playing the game again with the real rules.

   The browser sends the moves of a finished game. This replays them from the
   starting position, with the twist and three stops each exactly as the game
   plays, and says whether they really end in a checkmate by the side that
   claims it. It is what stops someone posting a win for a game that never
   happened -- a made-up move list either contains an illegal move or does not
   end in mate.

   What it cannot check: that the computer's moves were really chosen by the
   computer. A patient cheater could play both sides by hand. For a leaderboard
   among friends that is an accepted limit.

   Moves are short strings, one per ply: from-square, to-square, then `q r b n`
   for a promotion and `s` if "stop turning" was pressed -- "e2e4", "e7e8q",
   "g1f3s". The same file runs in the browser tests, in node, and inside the
   server function, where it is bundled with js/chess.js. */

const MAX_PLIES = 1000;
const PROMO_LETTER = { 5: 'q', 4: 'r', 3: 'b', 2: 'n' };   // QUEEN, ROOK, BISHOP, KNIGHT

function encodeMove(m) {
  return squareName(m.from) + squareName(m.to) + (m.promo ? PROMO_LETTER[m.promo] : '') +
    (m.flags & F_STOP ? 's' : '');
}

// -> { ok: true, plies } or { ok: false, reason }
function replayWin({ moves, side }) {
  if (!Array.isArray(moves) || moves.length === 0) return { ok: false, reason: 'no moves' };
  if (moves.length > MAX_PLIES) return { ok: false, reason: 'too many moves' };
  if (side !== WHITE && side !== BLACK) return { ok: false, reason: 'bad side' };

  const g = new Chess();
  g.twist = true;
  g.stopsPerGame = 3;
  g.reset();

  for (let i = 0; i < moves.length; i++) {
    if (typeof moves[i] !== 'string') return { ok: false, reason: `move ${i + 1} is not text` };
    // The game ends at the first result; nothing may be played after it.
    if (g.gameOver()) return { ok: false, reason: `game was already over before move ${i + 1}` };
    const m = g.legalMoves().find((x) => encodeMove(x) === moves[i]);
    if (!m) return { ok: false, reason: `move ${i + 1} (${moves[i]}) is not legal` };
    g.make(m);
    g.pushRepetition();
  }

  const over = g.gameOver();
  if (!over) return { ok: false, reason: 'the game is not finished' };
  if (over.type !== 'checkmate') return { ok: false, reason: `the game ended in ${over.type}` };
  if (over.winner !== side) return { ok: false, reason: 'the other side won' };
  return { ok: true, plies: moves.length };
}

if (typeof module !== 'undefined') module.exports = { replayWin, encodeMove, MAX_PLIES };
