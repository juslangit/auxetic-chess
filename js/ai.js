/* Search: negamax with alpha-beta, iterative deepening, quiescence,
   MVV-LVA capture ordering and killer moves. Runs synchronously inside a
   time budget so it works from file:// with no worker. */

const VALUE = { [PAWN]: 100, [KNIGHT]: 320, [BISHOP]: 330, [ROOK]: 500, [QUEEN]: 900, [KING]: 20000 };
const MATE = 30000;

/* Hard ceilings on recursion. In plain chess the check extension terminates by
   itself -- you cannot stay in check indefinitely. Under the twist you can:
   kings are carried around every move, so check recurs, the extension fires at
   every level, depth never falls and the search runs until the stack dies.
   These caps make the search safe regardless of the rules it is searching. */
const MAX_PLY = 64;            // absolute depth, then just evaluate
const MAX_QUIESCE = 16;        // capture chains
const EXTENSION_SLACK = 8;     // plies of extension allowed past the root depth

// Piece-square tables, written from White's point of view with rank 8 on the
// first row so they read like a board. Mirrored for Black at lookup time.
const PST_MID = {
  [PAWN]: [
      0,  0,  0,  0,  0,  0,  0,  0,
     50, 50, 50, 50, 50, 50, 50, 50,
     10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0],
  [KNIGHT]: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50],
  [BISHOP]: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20],
  [ROOK]: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0],
  [QUEEN]: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20],
  [KING]: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20],
};

// In the endgame the king should walk to the centre instead of hiding.
const PST_KING_END = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50];

// 0x88 square -> index into the tables above, from the mover's point of view.
function pstIndex(s, color) {
  const f = s & 7, r = s >> 4;
  return color === WHITE ? (7 - r) * 8 + f : r * 8 + f;
}

class AI {
  constructor(game) {
    this.game = game;
    this.nodes = 0;
    this.killers = [];
    this.deadline = 0;
    this.aborted = false;
  }

  // Phase 0 = full opening material, 1 = bare endgame. Used to taper the king table.
  phase() {
    let npm = 0;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = this.game.board[sq(f, r)];
      if (p === EMPTY) continue;
      const t = typeOf(p);
      if (t !== PAWN && t !== KING) npm += VALUE[t];
    }
    const FULL = 2 * (2 * VALUE[KNIGHT] + 2 * VALUE[BISHOP] + 2 * VALUE[ROOK] + VALUE[QUEEN]);
    return Math.max(0, Math.min(1, 1 - npm / FULL));
  }

  // Score from the side-to-move's point of view.
  evaluate() {
    const g = this.game;
    const ph = this.phase();
    let score = 0;
    const pawnFiles = [new Int8Array(8), new Int8Array(8)];
    const bishops = [0, 0];

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const s = sq(f, r);
        const p = g.board[s];
        if (p === EMPTY) continue;
        const c = colorOf(p), t = typeOf(p);
        const i = pstIndex(s, c);
        let v = VALUE[t];
        v += (t === KING)
          ? PST_MID[KING][i] * (1 - ph) + PST_KING_END[i] * ph
          : PST_MID[t][i];
        score += c === WHITE ? v : -v;
        if (t === PAWN) pawnFiles[c][f]++;
        if (t === BISHOP) bishops[c]++;
      }
    }

    for (const c of [WHITE, BLACK]) {
      const sign = c === WHITE ? 1 : -1;
      if (bishops[c] >= 2) score += sign * 30;                     // bishop pair
      for (let f = 0; f < 8; f++) {
        const n = pawnFiles[c][f];
        if (n > 1) score -= sign * 12 * (n - 1);                   // doubled pawns
        if (n > 0 && (f === 0 || !pawnFiles[c][f - 1]) && (f === 7 || !pawnFiles[c][f + 1])) {
          score -= sign * 14;                                      // isolated pawns
        }
      }
    }

    return g.turn === WHITE ? score : -score;
  }

  // Most Valuable Victim / Least Valuable Aggressor, plus killer-move bonus.
  scoreMove(m, depth) {
    const g = this.game;
    if (m.flags & F_CAPTURE) {
      const victim = (m.flags & F_EP) ? PAWN : typeOf(g.board[m.to]);
      const attacker = typeOf(g.board[m.from]);
      return 1e6 + VALUE[victim] * 10 - VALUE[attacker];
    }
    if (m.flags & F_PROMO) return 9e5 + VALUE[m.promo];
    const k = this.killers[depth];
    if (k && k.from === m.from && k.to === m.to) return 8e5;
    return 0;
  }

  order(moves, depth) {
    for (const m of moves) m._s = this.scoreMove(m, depth);
    moves.sort((a, b) => b._s - a._s);
    return moves;
  }

  // Search only captures until the position is quiet, so the engine is not
  // fooled by a mid-exchange snapshot.
  quiesce(alpha, beta, qply = 0) {
    this.nodes++;
    const stand = this.evaluate();
    if (qply >= MAX_QUIESCE) return stand;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    const g = this.game;
    for (const m of this.order(g.generate(true), 0)) {
      g.make(m);
      if (g.isAttacked(g.kingSq[g.turn ^ 1], g.turn)) { g.unmake(); continue; }
      const score = -this.quiesce(-beta, -alpha, qply + 1);
      g.unmake();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  negamax(depth, alpha, beta, ply) {
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) { this.aborted = true; return 0; }
    if (ply >= MAX_PLY) return this.evaluate();
    if (depth <= 0) return this.quiesce(alpha, beta);
    this.nodes++;

    const g = this.game;
    const inCheck = g.inCheck();
    // Extend on check, but only so far past the root depth -- see MAX_PLY.
    if (inCheck && ply < this.rootDepth + EXTENSION_SLACK) depth++;

    let legal = 0, best = -Infinity;
    for (const m of this.order(g.generate(), ply)) {
      g.make(m);
      if (g.isAttacked(g.kingSq[g.turn ^ 1], g.turn)) { g.unmake(); continue; }
      legal++;
      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      g.unmake();
      if (this.aborted) return 0;

      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!(m.flags & F_CAPTURE)) this.killers[ply] = { from: m.from, to: m.to };
        return beta;
      }
    }

    if (legal === 0) return inCheck ? -MATE + ply : 0;       // mate or stalemate
    if (g.halfmove >= 100) return 0;
    return best;
  }

  /* Pick a move. `level` sets both depth cap and time budget.
     Returns {move, score, depth, nodes, ms}. */
  think(level = 2) {
    const cfg = [
      { maxDepth: 2, ms: 120,  jitter: 90 },   // 0 casual   - blunders on purpose
      { maxDepth: 4, ms: 500,  jitter: 25 },   // 1 club
      { maxDepth: 6, ms: 1500, jitter: 0  },   // 2 strong
      { maxDepth: 8, ms: 4000, jitter: 0  },   // 3 brutal
    ][level] || { maxDepth: 4, ms: 500, jitter: 25 };

    const g = this.game;
    this.nodes = 0;
    this.killers = [];
    this.aborted = false;
    this.deadline = Date.now() + cfg.ms;
    const t0 = Date.now();

    this.rootDepth = 1;
    const root = g.legalMoves();
    if (!root.length) return null;

    let best = root[0], bestScore = -Infinity, reached = 0;

    for (let depth = 1; depth <= cfg.maxDepth; depth++) {
      this.rootDepth = depth;
      let localBest = null, localScore = -Infinity;
      const scored = [];

      // Search last iteration's best move first -- it usually still is.
      const ordered = this.order(root.slice(), 0);
      const bi = ordered.findIndex((m) => m.from === best.from && m.to === best.to && m.promo === best.promo);
      if (bi > 0) ordered.unshift(ordered.splice(bi, 1)[0]);

      for (const m of ordered) {
        g.make(m);
        const score = -this.negamax(depth - 1, -Infinity, Infinity, 1);
        g.unmake();
        if (this.aborted) break;
        scored.push({ m, score });
        if (score > localScore) { localScore = score; localBest = m; }
      }

      if (this.aborted) break;
      reached = depth;

      // At the casual level, pick randomly among moves close to the best so the
      // engine feels human instead of repeating one line forever.
      if (cfg.jitter > 0) {
        const pool = scored.filter((x) => x.score >= localScore - cfg.jitter);
        localBest = pool[(Math.random() * pool.length) | 0].m;
        localScore = scored.find((x) => x.m === localBest).score;
      }

      best = localBest; bestScore = localScore;
      if (Math.abs(bestScore) > MATE - 100) break;          // forced mate found
      if (Date.now() > this.deadline) break;
    }

    return { move: best, score: bestScore, depth: reached, nodes: this.nodes, ms: Date.now() - t0 };
  }
}
