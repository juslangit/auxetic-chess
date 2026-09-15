/* Chess rules engine. 0x88 board representation.
   A square index is rank*16 + file; a square is off-board iff (sq & 0x88) != 0,
   which makes every "did I walk off the edge" test a single mask. */

const EMPTY = 0;
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const WHITE = 0, BLACK = 1;

// A piece is its type for white, type|8 for black.
const colorOf = (p) => p >> 3;
const typeOf = (p) => p & 7;

const KNIGHT_OFF = [33, 31, 18, 14, -14, -18, -31, -33];
const KING_OFF = [16, -16, 1, -1, 17, 15, -15, -17];
const BISHOP_OFF = [17, 15, -15, -17];
const ROOK_OFF = [16, -16, 1, -1];

// Move flags
const F_CAPTURE = 1, F_EP = 2, F_CASTLE_K = 4, F_CASTLE_Q = 8, F_DOUBLE = 16, F_PROMO = 32;
// Played with "stop turning" pressed. See `canStop`.
const F_STOP = 64;

// Castling-right bits
const CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8;

const A1 = 0x00, E1 = 0x04, H1 = 0x07;
const A8 = 0x70, E8 = 0x74, H8 = 0x77;

const sq = (file, rank) => rank * 16 + file;
const fileOf = (s) => s & 7;
const rankOf = (s) => s >> 4;
const onBoard = (s) => (s & 0x88) === 0;

const FILES = 'abcdefgh';
const squareName = (s) => FILES[fileOf(s)] + (rankOf(s) + 1);

/* The twist. Every 2x2 block of the board turns a quarter and carries whatever
   is standing on it -- every piece, pawns included. The four squares of a block
   in the order content travels are a1, a2, b2, b1, so within the block

       a1 -> a2 -> b2 -> b1 -> a1          and e.g. a4 -> b4

   which is the plain quarter turn: one cell round, always, for everything. It
   is a permutation of four squares, so a twist can never capture, nothing ever
   leaves its block or enters one, and four turns is the identity.

   A pawn is carried like anything else. Its *moves* are unaffected -- a pawn
   only ever moves forward, wherever the board has put it -- which is what keeps
   "a pawn never moves left, right or back" true while the board still turns it
   round.

   Note that a quarter turn maps the checkerboard onto its own colour inverse:
   every block is L D / D L, and turning it gives D L / L D. Turning all sixteen
   flips all 64 squares, so the board stays a regular checkerboard with the two
   colours swapped. The disorder is in the pieces, not the pattern. */

/* The quarter turn, (u,v) -> (v, 1-u), where u and v are the file and rank
   offsets inside the block. This is both the geometry the renderer turns the
   tile by and the permutation the engine applies to the board. */
function twistForward(s) {
  const f = s & 7, r = s >> 4, u = f & 1, v = r & 1;
  return (r - v + 1 - u) * 16 + (f - u + v);
}

function twistBack(s) {
  const f = s & 7, r = s >> 4, u = f & 1, v = r & 1;
  return (r - v + u) * 16 + (f - u + 1 - v);
}

class Chess {
  constructor() {
    // Variant switch. Off by default so the plain rules engine -- and the perft
    // suite that proves it -- are unaffected.
    this.twist = false;
    // Stops each side gets per game. 0 by default, for the same reason as the
    // twist: the existing suites keep testing exactly what they always did.
    this.stopsPerGame = 0;
    this.reset();
  }

  reset() {
    this.board = new Int8Array(128);
    this.turn = WHITE;
    this.castling = CR_WK | CR_WQ | CR_BK | CR_BQ;
    this.ep = -1;             // en-passant target square, or -1
    this.halfmove = 0;        // plies since last pawn move or capture
    this.fullmove = 1;
    this.kingSq = [E1, E8];
    this.resetStops();
    this.history = [];        // undo records
    this.moveLog = [];        // {san, move, fenKey} for the sidebar
    this.repetition = new Map();

    const back = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];
    for (let f = 0; f < 8; f++) {
      this.board[sq(f, 0)] = back[f];
      this.board[sq(f, 1)] = PAWN;
      this.board[sq(f, 6)] = PAWN | 8;
      this.board[sq(f, 7)] = back[f] | 8;
    }
    this.pushRepetition();
  }

  /* ---- position key, for threefold repetition ---- */
  positionKey() {
    let k = '';
    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) k += String.fromCharCode(65 + this.board[sq(f, r)]);
    }
    // Stops are part of the position: the same board with a stop running, or
    // with different stops left, is not a repeat.
    return k + this.turn + ':' + this.castling + ':' + this.ep + ':' +
      this.stopsLeft[WHITE] + ',' + this.stopsLeft[BLACK] + ',' + this.stopPlies;
  }

  pushRepetition() {
    const k = this.positionKey();
    this.repetition.set(k, (this.repetition.get(k) || 0) + 1);
  }

  popRepetition(key) {
    const n = this.repetition.get(key);
    if (n <= 1) this.repetition.delete(key); else this.repetition.set(key, n - 1);
  }

  /* ---- the twist ---- */

  /* Turn every 2x2 block a quarter. `dir` 1 forward, -1 to put it back.

     A plain 4-cycle per block, applied to every piece alike -- pawns are
     carried too. Four writes forward, the same four in reverse to undo. */
  rotateAllBlocks(dir) {
    const b = this.board;
    for (let r0 = 0; r0 < 8; r0 += 2) {
      for (let f0 = 0; f0 < 8; f0 += 2) {
        const BL = r0 * 16 + f0, TL = BL + 16, TR = BL + 17, BR = BL + 1;
        if (dir > 0) {
          const t = b[TL];
          b[TL] = b[BL]; b[BL] = b[BR]; b[BR] = b[TR]; b[TR] = t;
        } else {
          const t = b[BL];
          b[BL] = b[TL]; b[TL] = b[TR]; b[TR] = b[BR]; b[BR] = t;
        }
      }
    }
  }

  /* Where the content of `s` goes on the next twist, and where it came from on
     the last one. The renderer uses the preimage to sweep each piece out of the
     square it was carried from. */
  twistImage(s) { return twistForward(s); }
  twistPreimage(s) { return twistBack(s); }

  /* Apply the twist at the end of a move. Amends the undo record that `make`
     has already pushed, so one record still covers one whole turn. */
  applyTwist() {
    const h = this.history[this.history.length - 1];

    this.rotateAllBlocks(1);
    this.kingSq[WHITE] = twistForward(this.kingSq[WHITE]);
    this.kingSq[BLACK] = twistForward(this.kingSq[BLACK]);

    // A double push cannot be answered en passant once everything has moved.
    this.ep = -1;

    /* A pawn carried onto the far rank promotes to a queen. No choice is
       offered because it is nobody's move. Recorded so unmake can put the pawn
       back. */
    let promos = null;
    for (let f = 0; f < 8; f++) {
      const w = 7 * 16 + f;
      if (this.board[w] === PAWN) { (promos || (promos = [])).push(w); this.board[w] = QUEEN; }
      if (this.board[f] === (PAWN | 8)) { (promos || (promos = [])).push(f); this.board[f] = QUEEN | 8; }
    }
    h.rotPromos = promos;
    h.twisted = true;

    this.refreshCastlingRights();
  }

  // Undo the twist: un-promote whatever the carry promoted, then turn back.
  undoTwist(h) {
    if (h.rotPromos) {
      for (const sq of h.rotPromos) {
        this.board[sq] = PAWN | (colorOf(this.board[sq]) === WHITE ? 0 : 8);
      }
    }
    this.rotateAllBlocks(-1);
  }

  // A twist can carry a king or a rook off its home square, which forfeits the
  // matching right. Recomputed from occupancy rather than tracked.
  refreshCastlingRights() {
    if (this.board[E1] !== KING) this.castling &= ~(CR_WK | CR_WQ);
    if (this.board[H1] !== ROOK) this.castling &= ~CR_WK;
    if (this.board[A1] !== ROOK) this.castling &= ~CR_WQ;
    if (this.board[E8] !== (KING | 8)) this.castling &= ~(CR_BK | CR_BQ);
    if (this.board[H8] !== (ROOK | 8)) this.castling &= ~CR_BK;
    if (this.board[A8] !== (ROOK | 8)) this.castling &= ~CR_BQ;
  }

  /* Run the twist if it is safe to.

     The first rule tried was "your move must leave your king safe after the
     twist". It deadlocks: the permutation is the same whatever you play, so a
     king boxed in by its own pieces is carried onto the same square every time,
     and if that square is attacked then *every* move is illegal. Self-play drew
     by stalemate on move 3 -- White's king on e1 always carried to e2, a black
     queen on d4 always carried to d3, which covers e2.

     So the twist yields instead of the player: if turning the board would walk
     your own king onto an attacked square, it does not turn that turn. Normal
     chess legality is therefore completely untouched -- the twist can never take
     a move away from you -- and it is still fully deterministic, so the search
     models it exactly. */
  tryTwist(us, them) {
    const h = this.history[this.history.length - 1];
    // A move that leaves your own king attacked is illegal on its own account.
    // Leave it that way so legalMoves() can see it, instead of letting a twist
    // paper over an illegal move.
    if (this.isAttacked(this.kingSq[us], them)) return;

    const ep = this.ep, castling = this.castling;
    const kw = this.kingSq[WHITE], kb = this.kingSq[BLACK];

    this.applyTwist();

    if (this.isAttacked(this.kingSq[us], them)) {
      this.undoTwist(h);
      this.ep = ep;
      this.castling = castling;
      this.kingSq[WHITE] = kw;
      this.kingSq[BLACK] = kb;
      h.twisted = false;
      h.rotPromos = null;
    }
  }

  /* ---- stop turning ----

     Before moving, a player may press "stop turning". The board then does not
     turn after that move, nor after the opponent's reply; it turns again from
     the move after. So a stop always covers exactly two moves, whoever presses:

         White presses:  e4 (no turn)   ...e5 (no turn)   Nf3 (turns)
         Black presses:  ...e5 (no turn)  Nf3 (no turn)  ...Nc6 (turns)

     Each side has `stopsPerGame` of them, and one cannot be pressed while
     another is still running, so stops never chain.

     A stop is part of the move -- the same move with the F_STOP flag -- rather
     than a separate action. That keeps one move = one undo record, and it lets
     the search weigh "play Nf3" against "play Nf3 and stop the board" like any
     other pair of moves. */

  resetStops() {
    this.stopsLeft = [this.stopsPerGame, this.stopsPerGame];
    this.stopPlies = 0;       // moves still to come with the board stopped
  }

  canStop() {
    return this.twist && this.stopPlies === 0 && this.stopsLeft[this.turn] > 0;
  }

  /* ---- attack detection ---- */

  // Is `target` attacked by any piece of `by`?
  isAttacked(target, by) {
    const them = by === WHITE ? 0 : 8;

    // pawns: a white pawn on t-17/t-15 attacks t
    const pawnFrom = by === WHITE ? [target - 17, target - 15] : [target + 17, target + 15];
    for (const s of pawnFrom) {
      if (onBoard(s) && this.board[s] === (PAWN | them)) return true;
    }
    for (const off of KNIGHT_OFF) {
      const s = target + off;
      if (onBoard(s) && this.board[s] === (KNIGHT | them)) return true;
    }
    for (const off of KING_OFF) {
      const s = target + off;
      if (onBoard(s) && this.board[s] === (KING | them)) return true;
    }
    for (const off of BISHOP_OFF) {
      for (let s = target + off; onBoard(s); s += off) {
        const p = this.board[s];
        if (p === EMPTY) continue;
        if (p === (BISHOP | them) || p === (QUEEN | them)) return true;
        break;
      }
    }
    for (const off of ROOK_OFF) {
      for (let s = target + off; onBoard(s); s += off) {
        const p = this.board[s];
        if (p === EMPTY) continue;
        if (p === (ROOK | them) || p === (QUEEN | them)) return true;
        break;
      }
    }
    return false;
  }

  inCheck(color = this.turn) {
    return this.isAttacked(this.kingSq[color], color ^ 1);
  }

  /* ---- move generation ---- */

  // Pseudo-legal moves; `capturesOnly` is used by quiescence search.
  generate(capturesOnly = false, stops = true) {
    const moves = [];
    const us = this.turn, them = us ^ 1;
    const mine = us === WHITE ? 0 : 8;

    const add = (from, to, flags, promo) => {
      moves.push({ from, to, flags: flags | 0, promo: promo | 0 });
    };

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const from = sq(f, r);
        const p = this.board[from];
        if (p === EMPTY || colorOf(p) !== us) continue;
        const t = typeOf(p);

        if (t === PAWN) {
          const dir = us === WHITE ? 16 : -16;
          const startRank = us === WHITE ? 1 : 6;
          const promoRank = us === WHITE ? 7 : 0;

          const one = from + dir;
          if (!capturesOnly && onBoard(one) && this.board[one] === EMPTY) {
            if (rankOf(one) === promoRank) {
              for (const q of [QUEEN, ROOK, BISHOP, KNIGHT]) add(from, one, F_PROMO, q);
            } else {
              add(from, one, 0, 0);
              const two = from + dir * 2;
              if (r === startRank && this.board[two] === EMPTY) add(from, two, F_DOUBLE, 0);
            }
          }
          for (const dx of [-1, 1]) {
            const to = from + dir + dx;
            if (!onBoard(to)) continue;
            const tp = this.board[to];
            if (tp !== EMPTY && colorOf(tp) === them) {
              if (rankOf(to) === promoRank) {
                for (const q of [QUEEN, ROOK, BISHOP, KNIGHT]) add(from, to, F_CAPTURE | F_PROMO, q);
              } else add(from, to, F_CAPTURE, 0);
            } else if (to === this.ep && tp === EMPTY) {
              add(from, to, F_CAPTURE | F_EP, 0);
            }
          }
          continue;
        }

        if (t === KNIGHT || t === KING) {
          const offs = t === KNIGHT ? KNIGHT_OFF : KING_OFF;
          for (const off of offs) {
            const to = from + off;
            if (!onBoard(to)) continue;
            const tp = this.board[to];
            if (tp === EMPTY) { if (!capturesOnly) add(from, to, 0, 0); }
            else if (colorOf(tp) === them) add(from, to, F_CAPTURE, 0);
          }
          continue;
        }

        // sliders
        const offs = t === BISHOP ? BISHOP_OFF : t === ROOK ? ROOK_OFF : KING_OFF;
        for (const off of offs) {
          for (let to = from + off; onBoard(to); to += off) {
            const tp = this.board[to];
            if (tp === EMPTY) { if (!capturesOnly) add(from, to, 0, 0); continue; }
            if (colorOf(tp) === them) add(from, to, F_CAPTURE, 0);
            break;
          }
        }
      }
    }

    // Castling: king and rook unmoved, path empty, and the king may not start in,
    // pass through, or land on an attacked square.
    if (!capturesOnly) {
      const kingFrom = us === WHITE ? E1 : E8;
      if (this.board[kingFrom] === (KING | mine) && !this.isAttacked(kingFrom, them)) {
        const kSide = us === WHITE ? CR_WK : CR_BK;
        const qSide = us === WHITE ? CR_WQ : CR_BQ;
        const rookK = us === WHITE ? H1 : H8;
        const rookQ = us === WHITE ? A1 : A8;

        if ((this.castling & kSide) && this.board[rookK] === (ROOK | mine) &&
            this.board[kingFrom + 1] === EMPTY && this.board[kingFrom + 2] === EMPTY &&
            !this.isAttacked(kingFrom + 1, them) && !this.isAttacked(kingFrom + 2, them)) {
          add(kingFrom, kingFrom + 2, F_CASTLE_K, 0);
        }
        if ((this.castling & qSide) && this.board[rookQ] === (ROOK | mine) &&
            this.board[kingFrom - 1] === EMPTY && this.board[kingFrom - 2] === EMPTY &&
            this.board[kingFrom - 3] === EMPTY &&
            !this.isAttacked(kingFrom - 1, them) && !this.isAttacked(kingFrom - 2, them)) {
          add(kingFrom, kingFrom - 2, F_CASTLE_Q, 0);
        }
      }
    }

    // Every move can also be played with a stop. Not in captures-only
    // generation: quiescence is about settling exchanges, not planning. The
    // search may also leave them out deeper in the tree (`stops` false), since
    // doubling every move at every level costs a whole ply of depth.
    if (stops && !capturesOnly && this.canStop()) {
      const n = moves.length;
      for (let i = 0; i < n; i++) {
        const m = moves[i];
        moves.push({ from: m.from, to: m.to, flags: m.flags | F_STOP, promo: m.promo });
      }
    }

    return moves;
  }

  // Fully legal moves: make each pseudo-legal move and keep it only if our king survives.
  legalMoves() {
    const out = [];
    for (const m of this.generate()) {
      this.make(m);
      if (!this.isAttacked(this.kingSq[this.turn ^ 1], this.turn)) out.push(m);
      this.unmake();
    }
    return out;
  }

  legalMovesFrom(from) {
    return this.legalMoves().filter((m) => m.from === from);
  }

  /* ---- make / unmake ---- */

  make(m) {
    const us = this.turn, them = us ^ 1;
    const piece = this.board[m.from];
    const captured = (m.flags & F_EP)
      ? this.board[m.to + (us === WHITE ? -16 : 16)]
      : this.board[m.to];

    this.history.push({
      move: m, piece, captured,
      castling: this.castling, ep: this.ep,
      halfmove: this.halfmove, fullmove: this.fullmove,
      kingSq: this.kingSq.slice(),
      key: this.positionKey(),
      stopW: this.stopsLeft[WHITE], stopB: this.stopsLeft[BLACK], stopPlies: this.stopPlies,
    });

    if (m.flags & F_EP) this.board[m.to + (us === WHITE ? -16 : 16)] = EMPTY;

    this.board[m.from] = EMPTY;
    this.board[m.to] = (m.flags & F_PROMO) ? (m.promo | (us === WHITE ? 0 : 8)) : piece;

    if (m.flags & F_CASTLE_K) {
      this.board[m.to - 1] = this.board[m.to + 1];
      this.board[m.to + 1] = EMPTY;
    } else if (m.flags & F_CASTLE_Q) {
      this.board[m.to + 1] = this.board[m.to - 2];
      this.board[m.to - 2] = EMPTY;
    }

    if (typeOf(piece) === KING) this.kingSq[us] = m.to;

    // Any touch of a king or rook home square kills the matching right.
    if (m.from === E1 || m.to === E1) this.castling &= ~(CR_WK | CR_WQ);
    if (m.from === E8 || m.to === E8) this.castling &= ~(CR_BK | CR_BQ);
    if (m.from === H1 || m.to === H1) this.castling &= ~CR_WK;
    if (m.from === A1 || m.to === A1) this.castling &= ~CR_WQ;
    if (m.from === H8 || m.to === H8) this.castling &= ~CR_BK;
    if (m.from === A8 || m.to === A8) this.castling &= ~CR_BQ;

    this.ep = (m.flags & F_DOUBLE) ? (m.from + (us === WHITE ? 16 : -16)) : -1;

    this.halfmove = (typeOf(piece) === PAWN || (m.flags & F_CAPTURE)) ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = them;

    // A stop covers this move and the reply, so two moves go by unturned.
    if (m.flags & F_STOP) {
      this.stopsLeft[us]--;
      this.stopPlies = 2;
    }

    // The twist runs inside make, which is what makes the variant real: move
    // generation, check, mate and the whole search see it for free.
    if (this.stopPlies > 0) {
      this.stopPlies--;
      this.history[this.history.length - 1].stopped = true;
    } else if (this.twist) {
      this.tryTwist(us, them);
    }
  }

  unmake() {
    const h = this.history.pop();
    if (!h) return;
    const m = h.move;
    const us = this.turn ^ 1;

    if (h.twisted) this.undoTwist(h);

    this.board[m.from] = h.piece;
    this.board[m.to] = EMPTY;

    if (m.flags & F_EP) {
      this.board[m.to + (us === WHITE ? -16 : 16)] = h.captured;
    } else if (m.flags & F_CAPTURE) {
      this.board[m.to] = h.captured;
    }

    if (m.flags & F_CASTLE_K) {
      this.board[m.to + 1] = this.board[m.to - 1];
      this.board[m.to - 1] = EMPTY;
    } else if (m.flags & F_CASTLE_Q) {
      this.board[m.to - 2] = this.board[m.to + 1];
      this.board[m.to + 1] = EMPTY;
    }

    this.castling = h.castling;
    this.ep = h.ep;
    this.halfmove = h.halfmove;
    this.fullmove = h.fullmove;
    this.kingSq = h.kingSq;
    this.stopsLeft[WHITE] = h.stopW;
    this.stopsLeft[BLACK] = h.stopB;
    this.stopPlies = h.stopPlies;
    this.turn = us;
    return h;
  }

  /* ---- game state ---- */

  insufficientMaterial() {
    const minors = [];
    let others = 0;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = this.board[sq(f, r)];
      if (p === EMPTY) continue;
      const t = typeOf(p);
      if (t === KING) continue;
      if (t === BISHOP || t === KNIGHT) minors.push({ t, color: colorOf(p), light: (f + r) % 2 === 1 });
      else others++;
    }
    if (others > 0) return false;
    if (minors.length === 0) return true;                        // K v K
    if (minors.length === 1) return true;                        // K+minor v K
    if (minors.length === 2 && minors[0].t === BISHOP && minors[1].t === BISHOP &&
        minors[0].light === minors[1].light) return true;        // same-colour bishops
    return false;
  }

  // Returns null while the game is live, otherwise {type, winner}
  gameOver() {
    const legal = this.legalMoves();
    if (legal.length === 0) {
      return this.inCheck()
        ? { type: 'checkmate', winner: this.turn ^ 1 }
        : { type: 'stalemate', winner: null };
    }
    if (this.halfmove >= 100) return { type: 'fifty-move', winner: null };
    if ((this.repetition.get(this.positionKey()) || 0) >= 3) return { type: 'repetition', winner: null };
    if (this.insufficientMaterial()) return { type: 'insufficient material', winner: null };
    return null;
  }

  /* ---- SAN, for the move list ---- */
  toSAN(m, legal) {
    if (m.flags & F_CASTLE_K) return this.suffix(m, 'O-O');
    if (m.flags & F_CASTLE_Q) return this.suffix(m, 'O-O-O');

    const piece = this.board[m.from];
    const t = typeOf(piece);
    const letters = { [KNIGHT]: 'N', [BISHOP]: 'B', [ROOK]: 'R', [QUEEN]: 'Q', [KING]: 'K' };
    let s = '';

    if (t === PAWN) {
      if (m.flags & F_CAPTURE) s += FILES[fileOf(m.from)] + 'x';
      s += squareName(m.to);
      if (m.flags & F_PROMO) s += '=' + letters[m.promo];
    } else {
      s += letters[t];
      // disambiguate against other same-type pieces that can reach the same square
      const rivals = (legal || this.legalMoves()).filter((o) =>
        o.to === m.to && o.from !== m.from && typeOf(this.board[o.from]) === t);
      if (rivals.length) {
        const sameFile = rivals.some((o) => fileOf(o.from) === fileOf(m.from));
        const sameRank = rivals.some((o) => rankOf(o.from) === rankOf(m.from));
        if (!sameFile) s += FILES[fileOf(m.from)];
        else if (!sameRank) s += String(rankOf(m.from) + 1);
        else s += squareName(m.from);
      }
      if (m.flags & F_CAPTURE) s += 'x';
      s += squareName(m.to);
    }
    return this.suffix(m, s);
  }

  // Append + or # by looking at the position after the move.
  suffix(m, s) {
    this.make(m);
    const check = this.inCheck();
    const mate = check && this.legalMoves().length === 0;
    this.unmake();
    return s + (mate ? '#' : check ? '+' : '');
  }
}

/* FEN loading. Used by the test suite and for setting up custom positions. */
Chess.prototype.loadFEN = function (fen) {
  const [placement, active, castle, epField, half, full] = fen.trim().split(/\s+/);
  this.board = new Int8Array(128);
  this.history = [];
  this.moveLog = [];
  this.repetition = new Map();

  const map = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
  let rank = 7, file = 0;
  for (const ch of placement) {
    if (ch === '/') { rank--; file = 0; continue; }
    if (ch >= '1' && ch <= '8') { file += +ch; continue; }
    const lower = ch.toLowerCase();
    const piece = map[lower] | (ch === lower ? 8 : 0);
    const s = sq(file, rank);
    this.board[s] = piece;
    if (typeOf(piece) === KING) this.kingSq[colorOf(piece)] = s;
    file++;
  }

  this.turn = active === 'w' ? WHITE : BLACK;
  this.castling = 0;
  if (castle.includes('K')) this.castling |= CR_WK;
  if (castle.includes('Q')) this.castling |= CR_WQ;
  if (castle.includes('k')) this.castling |= CR_BK;
  if (castle.includes('q')) this.castling |= CR_BQ;
  this.ep = (!epField || epField === '-') ? -1
    : sq(FILES.indexOf(epField[0]), +epField[1] - 1);
  this.halfmove = half ? +half : 0;
  this.fullmove = full ? +full : 1;
  this.resetStops();
  this.pushRepetition();
  return this;
};
