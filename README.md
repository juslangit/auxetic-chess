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
the structure auxetic. The board blooms open at the start of a game and closes
into play. A draw blooms it open again; a checkmate leaves it shut, with the
result shown over the board so the mating position stays readable.

Every one of the sixteen tiles carries the *same* 2x2 patch of checkerboard.
A tile starts at an even file and an even rank, so its local colour parity is
`(u+v)%2` no matter which tile it is -- and that parity survives flipping the
board. That is why the physical version needs only one tile printed sixteen
times, and why the renderer bakes a single tile sprite and blits it.

## The twist

This is the game, not an option and not a setting. **After every move, all
sixteen 2x2 blocks turn a quarter and carry the pieces standing on them.** The
four squares of a block, in the order content travels, are a1, a2, b2, b1:

```
a1 -> a2 -> b2 -> b1 -> a1
```

Three properties fall out of it being a permutation of four squares:

- **A twist can never capture.** Pieces only ever cycle, so nothing is ever
  displaced onto anything else.
- **Nothing ever leaves its own block.** Pieces travel by being carried, one
  step per move; only moves cross block boundaries.
- **Nothing can enter a block from outside** either, except by being played
  there.

### Pawns are carried too

A pawn is carried like everything else -- `a4` goes to `b4`, same as any piece.
What stays fixed is how a pawn *moves*: only ever forward, wherever the board
has put it. Never sideways, never backwards. That is asserted for every pawn
move in every position across a whole game.

An earlier version froze pawns in place and let the pieces cycle around them.
It was the wrong reading of the rule and it made the carry confusing: the cycle
had to skip occupied squares, so a piece on `a4` with a pawn on `b4` was shunted
diagonally to `b3` instead of simply turning to `b4`. The carry is uniform now --
one cell round, always, for everything.

A pawn carried onto the far rank promotes to a queen. There is no choice to
offer, because it is nobody's move.

### The twist yields, not the player

The obvious rule is "your move must leave your king safe *after* the twist."
That deadlocks. The permutation does not depend on what you play, so a king
boxed in by its own pieces is carried onto the same square every time, and if
that square is covered then *every* move is illegal. Self-play drew by stalemate
on move 3: White's king on e1 always carried to e2, a black queen on d4 always
carried to d3, which covers e2.

So the twist gives way instead. **If turning the board would walk your own king
onto an attacked square, it does not turn that turn.** Two things follow:

- Normal chess legality is completely untouched. The twist can never take a
  move away from you -- asserted directly against a twist-free clone of the same
  position, across 160 positions.
- It is still deterministic, so the twist runs *inside* `make`, and move
  generation, check, checkmate and the whole search see it for free rather than
  having it bolted on. The engine plays the variant properly.

In practice it stands down on roughly one turn in seven.

### What it does not do

Turning *every* block maps the checkerboard onto its own colour inverse. Each
block is `L D / D L`, and a quarter turn makes it `D L / L D`, so all 64 squares
flip and the board stays a perfectly regular checkerboard with light and dark
swapped. The disorder is in the pieces, not the pattern.

The pieces stay upright as the tiles turn beneath them. Five of the six types
are lathe shapes and look identical from any direction, which is exactly what
happens to the real turned pieces when you spin a tile under them.

### The sweep is derived, not assumed

Each piece is animated round its tile centre by the angle from the square it was
carried out of to the square it is on. With a uniform quarter turn that comes to
90 degrees for every piece -- but it is computed rather than hard-coded, because
that is what makes the animation land on the square the engine actually chose
instead of wherever 90 degrees happens to point.

`test/twist_browser.js` samples the position function at the start, middle and
end of a sweep: every piece must begin on the square it came from and end
exactly on the square it is on. A piece that arrives beside its square and then
jumps into place at the end fails that check, and nothing about the board state
or the paint angle would have caught it.

## Playing

Full legal chess underneath: castling, promotion, check, checkmate, stalemate,
the fifty-move rule, threefold repetition and insufficient material. En passant
is the one casualty -- a double push cannot be answered once everything has
moved.

Click a piece, then a highlighted square.

**Opponent** picks who you are playing:

- **Two players** -- hotseat. Both sides are played from the same keyboard, the
  computer never moves, and the board starts with White at the bottom. Use
  **Flip** to turn it round for the other player. One **Undo** takes back one
  turn.
- **Computer** at four strengths, from one that blunders on purpose to one that
  searches eight plies. **You play** picks your colour, and against the computer
  one **Undo** takes back its reply as well, so it is your turn again.

Undo reverses the twist along with the move, and winds the board's paint back by
a quarter for each turn that actually twisted.

Keys: `f` flip the board, `u` undo.

### Stop turning

Each player has **three stops** per game. Press **Stop turning** before your
move and the board does not turn after that move, *or* after your opponent's
reply. It turns again from the move after. A stop always covers exactly two
moves, whoever presses it:

```
White presses:   e4 (no turn)    ...e5 (no turn)   Nf3 (turns)
Black presses:   ...e5 (no turn)  Nf3 (no turn)    ...Nc6 (turns)
```

Pressing it again before you move takes it back. It cannot be pressed while
another stop is still running, so stops never chain, and undo gives a spent
stop back. Stopped moves are marked `STOP` in the move list.

In the engine a stop is part of the move -- the same move with a flag -- so one
move is still one undo record, and the computer weighs "Nf3" against "Nf3 and
stop the board" like any other pair of moves. It values an unused stop at one
pawn, so it only spends one when stopping wins more than that -- which can be
move one, since the turning board is sharp from the start, and it considers
pressing a stop for its own move and your reply, which keeps its search as deep
as before. It always knows when yours is running. The count is `STOPS_PER_GAME`
at the top of `js/main.js`.

## Layout

| File | What it holds |
|---|---|
| `js/chess.js` | Rules engine. 0x88 board, move generation, SAN, FEN |
| `js/ai.js` | Negamax, alpha-beta, quiescence, killer moves, repetition, tapered eval; under the twist each piece is scored by the average of its block's four squares |
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
that it does stand down when it would expose a king, that the board equals the
move followed by a quarter turn of everything, that `a4` is carried to `b4`,
that no pawn move is ever sideways or backwards, that a carried pawn promotes on
the far rank, and three self-play games that end in checkmate rather than
deadlock. It also
re-runs plain perft to prove the base engine is untouched.

`test/twist_browser.js` plays it through the real UI: the position after a click
equals the move followed by turning every block (rebuilt independently), a named
rook carried a1 to a2, the animation locking input while it runs, the paint angle
tracking one quarter per turn that twisted, clicks landing on the same squares at
any paint angle, and undo restoring position and paint together.

Stop turning has two more. `test/stop_test.js` plays both worked examples above
move by move, checks the three-stop limit and that stops never chain, unwinds
random games full of stops exactly, and checks the computer: legal moves only,
it picks a stop in a position where stopping wins material, and its search is as
deep with stops as without. `test/stop_browser.js` plays the White example
through the real button, then takes a stop back, undoes a stopped move, and
checks the computer's reply to your stop is not turned. `test/undo.js` covers
undo at awkward moments: after checkmate, mid-turn, and with the promotion box
open.
