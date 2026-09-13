/* Game wiring: input, the AI turn, the move list, and the fold. */

const game = new Chess();
const ai = new AI(game);
const canvas = document.getElementById('board');
const view = new BoardView(canvas, game);

const el = (id) => document.getElementById(id);
const ui = {
  status: el('status'), detail: el('detail'), moves: el('moves'),
  capW: el('cap-white'), capB: el('cap-black'),
  fold: el('fold'), foldVal: el('fold-val'),
  level: el('level'), side: el('side'),
  promo: el('promo'), promoBtns: el('promo-choices'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let playerColor = WHITE;
let thinking = false;
let pendingPromo = null;
let gameFinished = false;
// Bumped on every new game or position setup. A queued AI turn from an earlier
// game carries the old epoch and is dropped, so it can never move for the player.
let epoch = 0;

/* ---- sound: a small synth, no files to load ---- */
let audio = null;
const sound = (kind) => {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const spec = {
      move:    { f: 320, f2: 150, dur: 0.10, gain: 0.16, type: 'triangle' },
      capture: { f: 190, f2: 70,  dur: 0.17, gain: 0.24, type: 'sawtooth' },
      fold:    { f: 110, f2: 260, dur: 0.55, gain: 0.09, type: 'sine' },
      end:     { f: 440, f2: 660, dur: 0.5,  gain: 0.16, type: 'sine' },
    }[kind];
    const osc = audio.createOscillator(), g = audio.createGain(), lp = audio.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.f, t);
    osc.frequency.exponentialRampToValueAtTime(spec.f2, t + spec.dur);
    g.gain.setValueAtTime(spec.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + spec.dur);
    osc.connect(lp); lp.connect(g); g.connect(audio.destination);
    osc.start(t); osc.stop(t + spec.dur + 0.02);
  } catch (_) { /* audio is a nicety, never a failure */ }
};

/* ---- rendering the side panel ---- */

const GLYPH = { [PAWN]: '♟', [KNIGHT]: '♞', [BISHOP]: '♝', [ROOK]: '♜', [QUEEN]: '♛', [KING]: '♚' };
const START_COUNT = { [PAWN]: 8, [KNIGHT]: 2, [BISHOP]: 2, [ROOK]: 2, [QUEEN]: 1, [KING]: 1 };

function refreshCaptured() {
  const live = [{}, {}];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = game.board[r * 16 + f];
    if (p === EMPTY) continue;
    const c = colorOf(p), t = typeOf(p);
    live[c][t] = (live[c][t] || 0) + 1;
  }
  for (const color of [WHITE, BLACK]) {
    let html = '', pts = 0;
    for (const t of [QUEEN, ROOK, BISHOP, KNIGHT, PAWN]) {
      const missing = START_COUNT[t] - (live[color][t] || 0);
      for (let i = 0; i < missing; i++) html += GLYPH[t];
      pts += missing * { [PAWN]: 1, [KNIGHT]: 3, [BISHOP]: 3, [ROOK]: 5, [QUEEN]: 9 }[t];
    }
    // Pieces missing from `color` were taken by the other side.
    const box = color === WHITE ? ui.capB : ui.capW;
    box.innerHTML = html || '<span class="none">-</span>';
    box.dataset.pts = pts;
  }
  const wLost = +ui.capB.dataset.pts, bLost = +ui.capW.dataset.pts;
  ui.capW.nextElementSibling.textContent = bLost > wLost ? `+${bLost - wLost}` : '';
  ui.capB.nextElementSibling.textContent = wLost > bLost ? `+${wLost - bLost}` : '';
}

function refreshMoveList() {
  let html = '';
  for (let i = 0; i < game.moveLog.length; i += 2) {
    const n = i / 2 + 1;
    const w = game.moveLog[i], b = game.moveLog[i + 1];
    html += `<li><span class="n">${n}.</span><span class="m">${w.san}</span>` +
            `<span class="m">${b ? b.san : ''}</span></li>`;
  }
  ui.moves.innerHTML = html;
  ui.moves.scrollTop = ui.moves.scrollHeight;
}

function setStatus(main, detail) {
  ui.status.textContent = main;
  ui.detail.textContent = detail || '';
}

function refreshStatus() {
  if (gameFinished) return;
  const over = game.gameOver();
  if (over) return finish(over);
  const side = game.turn === WHITE ? 'White' : 'Black';
  const yours = game.turn === playerColor;
  view.checkSquare = game.inCheck() ? game.kingSq[game.turn] : -1;
  setStatus(
    thinking ? 'Thinking...' : (yours ? 'Your move' : `${side} to move`),
    game.inCheck() ? `${side} is in check` : `${side} - move ${game.fullmove}`
  );
}

function finish(over) {
  gameFinished = true;
  view.selected = -1; view.legalTargets = [];
  const names = ['White', 'Black'];
  const msg = over.type === 'checkmate'
    ? `${names[over.winner]} wins`
    : over.type === 'stalemate' ? 'Stalemate' : 'Draw';
  const why = over.type === 'checkmate'
    ? (over.winner === playerColor ? 'Checkmate - you won' : 'Checkmate')
    : `Draw by ${over.type}`;
  setStatus(msg, why);
  sound('end');
  // The board blooms back open when the game ends -- but only if this is still
  // that game, so a new one started in the meantime is not pulled apart.
  const mine = epoch;
  setTimeout(() => {
    if (mine !== epoch) return;
    sound('fold');
    // sync the slider when the bloom finishes, not when it starts
    view.animateTo(THETA_OPEN, 1800).then(syncFoldSlider);
  }, 700);
}

function syncFoldSlider() {
  const v = Math.round(Math.abs(view.theta / THETA_OPEN) * 100);
  ui.fold.value = v;
  ui.foldVal.textContent = `${(Math.abs(view.theta) / DEG).toFixed(0)}°`;
}

/* ---- playing a move ---- */

function applyMove(m) {
  const piece = game.board[m.from];
  const mine = epoch;
  const parts = [{ piece, from: m.from, to: m.to }];
  if (m.flags & F_CASTLE_K) parts.push({ piece: game.board[m.to + 1], from: m.to + 1, to: m.to - 1 });
  if (m.flags & F_CASTLE_Q) parts.push({ piece: game.board[m.to - 2], from: m.to - 2, to: m.to + 1 });

  const legal = game.legalMoves();
  const san = game.toSAN(m, legal);

  view.animateMove(parts);
  sound(m.flags & F_CAPTURE ? 'capture' : 'move');

  game.make(m);
  const twisted = !!game.history[game.history.length - 1].twisted;
  game.pushRepetition();
  game.moveLog.push({ san, move: m, twisted });

  view.lastMove = { from: m.from, to: m.to };
  view.selected = -1;
  view.legalTargets = [];

  refreshMoveList();
  refreshCaptured();
  refreshStatus();
  if (!twisted) {
    ui.detail.textContent = 'the blocks held - turning would have exposed the king';
  }

  advanceTurn(mine, twisted);
}

/* Let the piece land, turn the blocks, then give the AI the move.

   `twisted` comes from the engine: the twist stands down on turns where it
   would walk the mover's king onto an attacked square, and on those turns there
   is nothing to animate.

   The search runs on this thread (D-004), so it must not start until the twist
   has finished -- otherwise the board freezes mid-turn while the engine thinks. */
async function advanceTurn(mine, twisted) {
  if (twisted) {
    // One atomic motion: the 200ms pause lets the piece land, but the board is
    // already marked in-motion so nothing can be clicked in between.
    await view.twistOnce();
    if (mine !== epoch) return;
  } else {
    await sleep(260);
    if (mine !== epoch) return;
  }
  if (!gameFinished && game.turn !== playerColor) aiTurn();
}

function aiTurn() {
  if (gameFinished || thinking) return;
  if (game.turn === playerColor) return;        // never move on the player's behalf
  const mine = epoch;
  thinking = true;
  refreshStatus();
  // Let the browser paint "Thinking..." before the search blocks the thread.
  requestAnimationFrame(() => setTimeout(() => {
    if (mine !== epoch) { thinking = false; return; }
    const r = ai.think(+ui.level.value);
    thinking = false;
    if (mine !== epoch || !r || gameFinished || game.turn === playerColor) { refreshStatus(); return; }
    applyMove(r.move);
    if (r.depth) ui.detail.textContent += `  -  depth ${r.depth}, ${(r.nodes / 1000 | 0)}k nodes`;
  }, 10));
}

view.onSquareClick = (sqIdx) => {
  if (gameFinished || thinking || pendingPromo) return;
  if (game.turn !== playerColor) return;
  if (sqIdx < 0) { view.selected = -1; view.legalTargets = []; return; }

  const legal = game.legalMoves();

  if (view.selected >= 0) {
    const candidates = legal.filter((m) => m.from === view.selected && m.to === sqIdx);
    if (candidates.length > 1) return askPromotion(candidates);   // promotion
    if (candidates.length === 1) return applyMove(candidates[0]);
  }

  const p = game.board[sqIdx];
  if (p !== EMPTY && colorOf(p) === game.turn) {
    view.selected = sqIdx;
    view.legalTargets = legal.filter((m) => m.from === sqIdx).map((m) => m.to);
  } else {
    view.selected = -1;
    view.legalTargets = [];
  }
};

function askPromotion(candidates) {
  pendingPromo = candidates;
  ui.promoBtns.innerHTML = '';
  for (const t of [QUEEN, ROOK, BISHOP, KNIGHT]) {
    const m = candidates.find((c) => c.promo === t);
    if (!m) continue;
    const b = document.createElement('button');
    b.className = 'promo-btn';
    b.innerHTML = `<span class="glyph ${playerColor === WHITE ? 'w' : 'b'}">${GLYPH[t]}</span>`;
    b.title = { [QUEEN]: 'Queen', [ROOK]: 'Rook', [BISHOP]: 'Bishop', [KNIGHT]: 'Knight' }[t];
    b.onclick = () => { ui.promo.hidden = true; pendingPromo = null; applyMove(m); };
    ui.promoBtns.appendChild(b);
  }
  ui.promo.hidden = false;
}

/* ---- controls ---- */

async function newGame() {
  epoch++;
  game.reset();
  game.moveLog = [];
  gameFinished = false;
  thinking = false;
  pendingPromo = null;
  ui.promo.hidden = true;
  view.lastMove = null;
  view.selected = -1;
  view.legalTargets = [];
  view.checkSquare = -1;
  view.pieceAnim = null;

  playerColor = ui.side.value === 'black' ? BLACK : WHITE;
  view.flipped = playerColor === BLACK;

  refreshMoveList();
  refreshCaptured();
  setStatus('Unfolding', 'the board closes into play');

  game.twist = true;              // this is the game, not an option
  view.setTwistAngle(0);
  view.setThetaManual(THETA_OPEN);
  syncFoldSlider();
  sound('fold');
  await view.animateTo(THETA_SOLID, 1700);
  syncFoldSlider();

  refreshStatus();
  if (game.turn !== playerColor) setTimeout(aiTurn, 300);
}

el('new-game').onclick = newGame;

el('flip').onclick = () => { view.flipped = !view.flipped; };

el('undo').onclick = () => {
  if (thinking || !game.moveLog.length) return;
  // Take back a full move so it is the player's turn again.
  const plies = (game.turn === playerColor) ? 2 : 1;
  let unwind = 0;
  for (let i = 0; i < plies && game.moveLog.length; i++) {
    const h = game.history[game.history.length - 1];
    if (h) game.popRepetition(game.positionKey());
    game.unmake();
    // The engine reverses the twist itself inside unmake; the paint has to be
    // wound back too, but only for the turns that actually twisted.
    if (game.moveLog.pop().twisted) unwind++;
  }
  gameFinished = false;
  const TWO_PI = Math.PI * 2;
  view.setTwistAngle(((view.twistAngle - unwind * (Math.PI / 2)) % TWO_PI + TWO_PI) % TWO_PI);
  view.lastMove = game.history.length
    ? { from: game.history[game.history.length - 1].move.from,
        to: game.history[game.history.length - 1].move.to }
    : null;
  view.selected = -1; view.legalTargets = [];
  refreshMoveList(); refreshCaptured(); refreshStatus();
};

ui.fold.oninput = () => {
  if (thinking) return;
  view.setThetaManual(THETA_OPEN * (+ui.fold.value / 100));
  ui.foldVal.textContent = `${(Math.abs(view.theta) / DEG).toFixed(0)}°`;
  view.selected = -1; view.legalTargets = [];
};

ui.side.onchange = newGame;

document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); newGame(); }
  if (e.key === 'f') el('flip').click();
  if (e.key === 'u') el('undo').click();
});

newGame();
