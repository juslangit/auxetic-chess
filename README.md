# Auxetic Chess

Chess on a **rotating-squares auxetic board**: sixteen rigid square tiles, hinged
at their corners, that bloom open to exactly twice their area and close into a
solid 8x8 to play on.

After the 3D-printed original by **Ruven Bals**.

No build step, no dependencies. Open `index.html`, or serve the folder:

```sh
python3 -m http.server 8000
```

## The mechanism

The fold is real kinematics, not an animation curve. For the corner hinges to
stay joined, the centre-to-centre pitch of the tiles is fixed by the rotation:

```
d = a * sqrt(2) * cos(45deg + theta)
```

where `a` is the tile edge and tiles alternate their rotation `+theta` / `-theta`
in a checkerboard pattern.

| `theta` | pitch | extent | state |
|---|---|---|---|
| `0deg`   | `a`        | `4a`    | tiles flush, solid 8x8 board -- playable |
| `-22.5deg` | `1.307a` | `5.23a` | opening, rhombic voids |
| `-45deg` | `a*sqrt(2)` | `5.66a` | fully bloomed, **exactly 2x the area** |

Growing on both axes at once is the negative-Poisson-ratio signature that makes
the structure auxetic. Drag the **Fold** slider to work the mechanism by hand.

Every one of the sixteen tiles carries the *same* 2x2 patch of checkerboard.
A tile starts at an even file and an even rank, so its local colour parity is
`(u+v)%2` no matter which tile it is -- and that parity survives flipping the
board. That is why the physical version needs only one tile printed sixteen
times, and why the renderer bakes a single tile sprite and blits it.

## The twist

This is the game, not decoration. **After every move, all sixteen 2x2 blocks turn
a quarter, carrying whatever is standing on them.** Inside a block the contents
go `(u,v) -> (v, 1-u)`, which on the board reads

```
a1 -> a2 -> b2 -> b1 -> a1        period 4
```

Three properties fall out of it being a permutation of four squares:

- **A twist can never capture.** Pieces only ever cycle; nothing is displaced
  onto anything else.
- **Nothing ever leaves its own block.** Pieces travel by being carried, one
  step per move, and only moves cross block boundaries.
- **Four turns is the identity.** Leave the board alone for four moves and every
  block is back where it started.

It also promotes: a pawn carried onto the far rank becomes a queen. There is no
choice to offer, because it is nobody's move. En passant never arises -- a double
push cannot be answered once everything has moved -- and castling rights lapse
as soon as a twist carries the king off e1.

### The twist yields, not the player

The obvious rule is "your move must leave your king safe *after* the twist."
That deadlocks. The permutation is the same whatever you play, so a king boxed
in by its own pieces is carried onto the same square every time, and if that
square is covered then *every* move is illegal. Self-play drew by stalemate on
move 3: White's king on e1 always carried to e2, a black queen on d4 always
carried to d3, which covers e2.

So the twist gives way instead. **If turning the board would walk your own king
onto an attacked square, it does not turn that turn.** Two things follow:

- Normal chess legality is completely untouched. The twist can never take a move
  away from you -- asserted directly in the tests, across 160 positions.
- It is still deterministic, so the twist runs *inside* `make`, and move
  generation, check, checkmate and the whole search see it for free rather than
  having it bolted on. The engine plays the variant properly.

In practice it stands down on roughly one turn in seven.

### What it does not do

Turning *every* block maps the checkerboard onto its own colour inverse. Each
block is `L D / D L`, and a quarter turn makes it `D L / L D`, so all 64 squares
flip and the board stays a perfectly regular checkerboard with light and dark
swapped. The disorder is entirely in the pieces, not the pattern.

The pieces stay upright as the tiles turn beneath them. Five of the six types
are lathe shapes and look identical from any direction, which is exactly what
happens to the real turned pieces when you spin a tile under them.

Toggle the whole mechanic with **Twist**; unchecked, it is ordinary chess.

## Playing

Full legal chess: castling, en passant, promotion, check, checkmate, stalemate,
the fifty-move rule, threefold repetition and insufficient material.

Click a piece, then a highlighted square. Four opponent strengths, from one that
blunders on purpose to one that searches eight plies deep.

Undo reverses the twist along with the move, and winds the board's paint back by
a quarter for each turn that actually twisted.

Keys: `f` flip the board, `u` undo.

## Layout

| File | What it holds |
|---|---|
| `js/chess.js` | Rules engine. 0x88 board, move generation, SAN, FEN |
| `js/ai.js` | Negamax, alpha-beta, quiescence, killer moves, tapered eval |
| `js/pieces.js` | Piece artwork, baked to offscreen sprites |
| `js/board.js` | The auxetic geometry and the canvas renderer |
| `js/main.js` | Game flow, input, the side panel |

## Correctness

The move generator is verified by **perft** against the published reference
counts for the six standard test positions -- start position to depth 5
(4,865,609 nodes), Kiwipete, and positions 3 to 6. All 26 counts match, which
covers the cases that catch most engines: en-passant legality, castling through
check, pinned pieces, discovered checks and promotion.

The geometry is verified numerically: across the whole range of `theta`, every
shared hinge corner of every neighbouring tile pair coincides to within 1e-15
of the tile edge, so the tiles genuinely stay hinged rather than approximately so.

The twist has two suites. `test/twist_test.js` covers the mechanic in the engine:
the permutation and its period, that it never captures and never leaves a block,
that make/unmake is exact four deep, that legality is *identical* to plain chess,
that it does stand down when it would expose a king, pawn promotion by carry, and
a full self-play game that ends in checkmate rather than deadlock. It also
re-runs plain perft to prove the base engine is untouched.

`test/twist_browser.js` plays it through the real UI: the position after a click
equals the move followed by turning every block (rebuilt independently), a named
rook carried a1 to a2, the animation locking input while it runs, the paint angle
tracking one quarter per turn that twisted, clicks landing on the same squares at
any paint angle, and undo restoring position and paint together.
