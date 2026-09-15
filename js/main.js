/* Game wiring: input, the AI turn, the move list, and the fold. */

// Stops each player gets per game. Change this one number to change the rule.
const STOPS_PER_GAME = 3;

const game = new Chess();
game.stopsPerGame = STOPS_PER_GAME;
const ai = new AI(game);
const canvas = document.getElementById('board');
const view = new BoardView(canvas, game);

const el = (id) => document.getElementById(id);
const ui = {
  status: el('status'), detail: el('detail'), moves: el('moves'),
  capW: el('cap-white'), capB: el('cap-black'),
  pcName: el('pc-name'), pcMeta: el('pc-meta'), pcRank: el('pc-rank'),
  promo: el('promo'), promoBtns: el('promo-choices'),
  mate: el('mate'), mateKing: el('mate-king'), mateWinner: el('mate-winner'), mateRank: el('mate-rank'),
  stop: el('stop'), stopTitle: el('stop-title'), stopSub: el('stop-sub'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* What the start screen chose. `level` is 0-3 for the computer, or 'hotseat'
   for two players. `name` is only set against the computer. */
const settings = { level: 2, side: WHITE, name: '' };
const leaderboard = new Leaderboard((() => { try { return window.localStorage; } catch (_) { return null; } })());

/* Who is at the keyboard. In hotseat both sides are, and `playerColor` only
   says which way up the board starts. Everything that used to compare against
   `playerColor` asks `humanPlays` instead. */
let playerColor = WHITE;
const hotseat = () => settings.level === 'hotseat';
const humanPlays = (color) => hotseat() || color === playerColor;
let thinking = false;
let pendingPromo = null;
let gameFinished = false;
// "Stop turning" pressed, waiting for the move it goes with.
let stopArmed = false;
// Set by the first undo against the computer. The game plays on, but a win no
// longer goes on the leaderboard -- otherwise any win is one takeback away.
let undoUsed = false;
// This game's win has been written to the leaderboard.
let winSaved = false;
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
    const mark = (e) => e && e.stopUsed ? '<span class="stop-mark">stop</span>' : '';
    html += `<li><span class="n">${n}.</span><span class="m">${w.san}${mark(w)}</span>` +
            `<span class="m">${b ? b.san : ''}${mark(b)}</span></li>`;
  }
  ui.moves.innerHTML = html;
  ui.moves.scrollTop = ui.moves.scrollHeight;
}

function setStatus(main, detail) {
  ui.status.textContent = main;
  ui.detail.textContent = detail || '';
}

/* The stop button always describes one player: the side to move in two-player
   mode, and you against the computer. Pressing it only arms it; the stop is
   spent by the move you then play. */
function refreshStopButton() {
  const names = ['White', 'Black'];
  const who = hotseat() ? game.turn : playerColor;
  const left = game.stopsLeft[who];
  const yourTurn = humanPlays(game.turn) && game.turn === who;
  if (!game.canStop()) stopArmed = false;

  ui.stop.disabled = gameFinished || thinking || !!pendingPromo || !yourTurn || !game.canStop();
  ui.stop.classList.toggle('armed', stopArmed && !ui.stop.disabled);
  ui.stop.classList.toggle('running', game.stopPlies > 0);

  const owner = hotseat() ? `${names[who]}: ` : '';
  if (game.stopPlies > 0) {
    // Only ever seen on the reply: the stopped move itself has already gone.
    ui.stopTitle.textContent = 'Board stopped';
    ui.stopSub.textContent = 'no turn after this move either';
  } else if (stopArmed) {
    ui.stopTitle.textContent = 'Stop is on';
    ui.stopSub.textContent = 'make your move - the board will not turn';
  } else {
    ui.stopTitle.textContent = 'Stop turning';
    ui.stopSub.textContent = `${owner}${left} of ${STOPS_PER_GAME} left`;
  }
}

function refreshStatus() {
  refreshStopButton();
  if (gameFinished) return;
  const over = game.gameOver();
  if (over) return finish(over);
  const side = game.turn === WHITE ? 'White' : 'Black';
  view.checkSquare = game.inCheck() ? game.kingSq[game.turn] : -1;
  const headline = thinking ? 'Thinking...'
    : hotseat() ? `${side} to move`
    : (game.turn === playerColor ? 'Your move' : `${side} to move`);
  setStatus(
    headline,
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
  const why = over.type !== 'checkmate' ? `Draw by ${over.type}`
    : hotseat() ? `Checkmate by ${names[over.winner]}`
    : (over.winner === playerColor ? 'Checkmate - you won' : 'Checkmate');
  setStatus(msg, why);
  refreshStopButton();
  sound('end');
  // Recorded now, not when the card appears, so a quick New game cannot lose it.
  const rankLine = rankResult(over);
  refreshPlayerCard();
  // After a short beat -- long enough for a mating move's twist to land -- a
  // checkmate is announced over the board, which stays shut so the final
  // position can be seen. A draw blooms the board back open instead. Either
  // way only if this is still that game, so a new one is not disturbed.
  const mine = epoch;
  setTimeout(() => {
    if (mine !== epoch) return;
    if (over.type === 'checkmate') {
      ui.mateKing.className = `mate-king ${over.winner === WHITE ? 'w' : 'b'}`;
      ui.mateWinner.textContent = `${names[over.winner]} wins`;
      ui.mateRank.textContent = rankLine;
      ui.mateRank.hidden = !rankLine;
      ui.mate.hidden = false;
    } else {
      sound('fold');
      view.animateTo(THETA_OPEN, 1800);
    }
  }, 700);
}

/* ---- the leaderboard ---- */

const levelName = (level) => LEVEL_NAMES[level];

/* A finished game against the computer. Only a checkmate you delivered, in a
   game with no undo, counts. Returns the line for the checkmate card. */
function rankResult(over) {
  if (hotseat() || over.type !== 'checkmate' || over.winner !== playerColor) return '';
  if (undoUsed) return 'Not ranked - Undo was used';
  const r = leaderboard.addWin(settings.level, settings.name);
  if (!r) return '';
  winSaved = true;
  return `${r.name}: ${r.wins} ${r.wins === 1 ? 'win' : 'wins'} at ${levelName(settings.level)} - #${r.rank}`;
}

// The table itself, shared by the start screen and the leaderboard window.
function renderLeaderboard(box, level, highlight = '') {
  const rows = leaderboard.top(level, 10);
  const me = highlight.toLowerCase();
  if (!rows.length) {
    box.innerHTML = `<p class="lb-empty">No wins at ${levelName(level)} yet.<br>Be the first.</p>`;
    return;
  }
  const esc = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  box.innerHTML = '<table class="lb-table"><thead><tr><th>#</th><th>Player</th><th>Wins</th></tr></thead><tbody>' +
    rows.map((r, i) => `<tr class="${r.name.toLowerCase() === me ? 'me' : ''}"><td>${i + 1}</td>` +
      `<td>${esc(r.name)}</td><td>${r.wins}</td></tr>`).join('') +
    '</tbody></table>';
}

// Who is playing, at what, and whether this game still counts.
function refreshPlayerCard() {
  if (hotseat()) {
    ui.pcName.textContent = 'Two players';
    ui.pcMeta.textContent = 'Same device';
    ui.pcRank.textContent = 'Not ranked';
    ui.pcRank.className = 'pc-rank off';
    return;
  }
  ui.pcName.textContent = settings.name;
  ui.pcMeta.textContent = `vs Computer - ${levelName(settings.level)} - ${playerColor === WHITE ? 'White' : 'Black'}`;
  ui.pcRank.textContent = undoUsed ? 'Practice - Undo used, a win won\'t count'
    : winSaved ? `Win saved to the ${levelName(settings.level)} leaderboard`
    : `Ranked - a win goes on the ${levelName(settings.level)} leaderboard`;
  ui.pcRank.className = `pc-rank ${undoUsed ? 'off' : 'on'}`;
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

  stopArmed = false;
  const names = ['White', 'Black'];
  const mover = names[game.turn];

  game.make(m);
  const h = game.history[game.history.length - 1];
  const twisted = !!h.twisted;
  const stopUsed = !!(m.flags & F_STOP);
  game.pushRepetition();
  game.moveLog.push({ san, move: m, twisted, stopUsed });

  view.lastMove = { from: m.from, to: m.to };
  view.selected = -1;
  view.legalTargets = [];

  refreshMoveList();
  refreshCaptured();
  refreshStatus();
  // A note on what the board did. It adds to the status line, never replaces
  // it: a finished game keeps its result ("Checkmate - you won"), and a check
  // is still reported in front of the note.
  const note = stopUsed ? `${mover} stopped the board - no turn now or after the reply`
    : h.stopped ? 'the board is still stopped - it turns again next move'
    : !twisted ? 'the blocks held - turning would have exposed the king'
    : '';
  if (note && !gameFinished) {
    const side = names[game.turn];
    ui.detail.textContent = game.inCheck() ? `${side} is in check - ${note}` : note;
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
  if (!gameFinished && !humanPlays(game.turn)) aiTurn();
}

function aiTurn() {
  if (gameFinished || thinking) return;
  if (humanPlays(game.turn)) return;           // never move on a human's behalf
  const mine = epoch;
  thinking = true;
  refreshStatus();
  // Let the browser paint "Thinking..." before the search blocks the thread.
  requestAnimationFrame(() => setTimeout(() => {
    if (mine !== epoch) { thinking = false; return; }
    const r = ai.think(settings.level);
    thinking = false;
    if (mine !== epoch || !r || gameFinished || humanPlays(game.turn)) { refreshStatus(); return; }
    applyMove(r.move);
    // Search stats are a footnote; never tack them onto a result.
    if (r.depth && !gameFinished) ui.detail.textContent += `  -  depth ${r.depth}, ${(r.nodes / 1000 | 0)}k nodes`;
  }, 10));
}

view.onSquareClick = (sqIdx) => {
  if (gameFinished || thinking || pendingPromo) return;
  if (!humanPlays(game.turn)) return;
  if (sqIdx < 0) { view.selected = -1; view.legalTargets = []; return; }

  const legal = game.legalMoves();

  if (view.selected >= 0) {
    // Every move exists with and without a stop; the button decides which.
    const candidates = legal.filter((m) => m.from === view.selected && m.to === sqIdx &&
      !!(m.flags & F_STOP) === stopArmed);
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
    b.innerHTML = `<span class="glyph ${game.turn === WHITE ? 'w' : 'b'}">${GLYPH[t]}</span>`;
    b.title = { [QUEEN]: 'Queen', [ROOK]: 'Rook', [BISHOP]: 'Bishop', [KNIGHT]: 'Knight' }[t];
    b.onclick = () => {
      // Only if this box is still the open question -- see undo.
      if (pendingPromo !== candidates) return;
      ui.promo.hidden = true; pendingPromo = null; applyMove(m);
    };
    ui.promoBtns.appendChild(b);
  }
  ui.promo.hidden = false;
  refreshStopButton();
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
  ui.mate.hidden = true;
  stopArmed = false;
  undoUsed = false;
  winSaved = false;
  view.lastMove = null;
  view.selected = -1;
  view.legalTargets = [];
  view.checkSquare = -1;
  view.pieceAnim = null;

  playerColor = settings.side;
  // In hotseat the board just starts with White at the bottom; use Flip to turn
  // it round for the other player.
  view.flipped = !hotseat() && playerColor === BLACK;
  refreshPlayerCard();

  refreshMoveList();
  refreshCaptured();
  setStatus('Unfolding', 'the board closes into play');

  game.twist = true;              // this is the game, not an option
  view.setTwistAngle(0);
  view.setThetaManual(THETA_OPEN);
  sound('fold');
  await view.animateTo(THETA_SOLID, 1700);

  refreshStatus();
  if (!humanPlays(game.turn)) setTimeout(aiTurn, 300);
}

el('new-game').onclick = newGame;

el('flip').onclick = () => { view.flipped = !view.flipped; };

// Arms the stop for the move you are about to play; press again to take it back.
ui.stop.onclick = () => {
  if (ui.stop.disabled) return;
  stopArmed = !stopArmed;
  refreshStopButton();
};

el('undo').onclick = () => {
  if (thinking || !game.moveLog.length) return;
  // Not while the blocks are turning. The paint angle is only a whole number of
  // quarters once the turn lands; winding it back mid-turn left the tiles
  // crooked for the rest of the game. Board clicks wait for the same thing.
  if (view.twistAnim) return;

  // Take back a full move so it is the player's turn again.
  // Against the computer, take back its reply too so it is your turn again.
  // In hotseat one ply is one turn, so take back exactly one.
  const plies = hotseat() ? 1 : (game.turn === playerColor ? 2 : 1);
  // Playing Black, the computer's opening move has no move of yours before it.
  // Taking it back alone would hand the turn to the computer with nothing to
  // make it play, so there is simply nothing to undo yet.
  if (game.moveLog.length < plies) return;

  // A promotion box belongs to the position it was opened in. Close it, or a
  // choice made after the undo plays that move into a different position.
  pendingPromo = null;
  ui.promo.hidden = true;

  // Drops anything queued for the position being taken back -- above all what
  // follows a finished game, the checkmate text or the bloom, which would
  // otherwise land on top of a live one.
  epoch++;
  ui.mate.hidden = true;
  stopArmed = false;
  if (!hotseat()) undoUsed = true;

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
  view.selected = -1; view.legalTargets = []; view.pieceAnim = null;
  refreshMoveList(); refreshCaptured(); refreshStatus(); refreshPlayerCard();

  // The game is live again, so close the board back up if a draw had bloomed
  // it open (or started to). Clicks are ignored until it is flat.
  if (view.tween || Math.abs(view.theta - THETA_SOLID) > 0.004) {
    sound('fold');
    view.animateTo(THETA_SOLID, 900);
  }
};

/* ---- start screen ---- */

const menu = {
  box: el('menu'), form: el('start-form'), name: el('name'), hint: el('name-hint'),
  levels: el('level-pick'), sides: el('side-pick'), resume: el('resume'),
  lbLevel: el('menu-lb-level'), lbTable: el('menu-lb-table'),
};
const lbWin = { box: el('lb'), tabs: el('lb-tabs'), table: el('lb-table') };
const NAME_KEY = 'auxetic-chess.name';

// What is picked on the start screen, before Start is pressed.
const pick = { level: 2, side: WHITE };

const store = {
  get(k) { try { return window.localStorage.getItem(k) || ''; } catch (_) { return ''; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (_) { /* remembering is a nicety */ } },
};

const markSelected = (group, attr, value) => {
  for (const b of group.querySelectorAll('button')) {
    const on = b.dataset[attr] === String(value);
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  }
};

function refreshMenu() {
  markSelected(menu.levels, 'level', pick.level);
  markSelected(menu.sides, 'side', pick.side === WHITE ? 'white' : 'black');
  menu.lbLevel.textContent = levelName(pick.level);
  renderLeaderboard(menu.lbTable, pick.level, cleanName(menu.name.value));
}

const menuOpen = () => !menu.box.hidden;

// `canResume` when opened from a game that is still there to go back to.
function openMenu(canResume) {
  if (!hotseat()) pick.level = settings.level;
  pick.side = settings.side;
  menu.name.value = settings.name || store.get(NAME_KEY);
  menu.hint.textContent = 'Needed for the leaderboard.';
  menu.hint.classList.remove('bad');
  menu.resume.hidden = !canResume;
  menu.box.hidden = false;
  refreshMenu();
  // No keyboard popping up over the board on a phone just from opening the menu.
  if (!('ontouchstart' in window)) menu.name.focus();
}

function closeMenu() { menu.box.hidden = true; }

/* Start a game. The start screen calls this, and so do the browser tests, so
   they go through exactly the same setup a player does. */
function startGame({ level, side, name = '' }) {
  settings.level = level === 'hotseat' ? 'hotseat' : +level;
  settings.side = side === 'black' || side === BLACK ? BLACK : WHITE;
  settings.name = settings.level === 'hotseat' ? '' : cleanName(name);
  closeMenu();
  return newGame();
}

menu.levels.onclick = (e) => {
  const b = e.target.closest('button[data-level]');
  if (b) { pick.level = +b.dataset.level; refreshMenu(); }
};
menu.sides.onclick = (e) => {
  const b = e.target.closest('button[data-side]');
  if (b) { pick.side = b.dataset.side === 'black' ? BLACK : WHITE; refreshMenu(); }
};
menu.name.oninput = () => {
  menu.hint.classList.remove('bad');
  menu.hint.textContent = 'Needed for the leaderboard.';
  renderLeaderboard(menu.lbTable, pick.level, cleanName(menu.name.value));
};

// Start (or Enter in the name box): against the computer, a name is required.
menu.form.onsubmit = (e) => {
  e.preventDefault();
  const name = cleanName(menu.name.value);
  if (!name) {
    menu.hint.textContent = 'Enter a username to play the computer.';
    menu.hint.classList.add('bad');
    menu.name.focus();
    return;
  }
  store.set(NAME_KEY, name);
  startGame({ level: pick.level, side: pick.side, name });
};

el('two-players').onclick = () => startGame({ level: 'hotseat', side: WHITE });
menu.resume.onclick = closeMenu;
el('menu-btn').onclick = () => openMenu(true);

/* ---- the leaderboard window ---- */

const lbOpen = () => !lbWin.box.hidden;
function showLeaderboard(level) {
  markSelected(lbWin.tabs, 'level', level);
  renderLeaderboard(lbWin.table, level, settings.name);
  lbWin.box.hidden = false;
}
el('lb-btn').onclick = () => showLeaderboard(hotseat() ? 2 : settings.level);
lbWin.tabs.onclick = (e) => {
  const b = e.target.closest('button[data-level]');
  if (b) showLeaderboard(+b.dataset.level);
};
el('lb-close').onclick = () => { lbWin.box.hidden = true; };
// A click on the dimmed backdrop, outside the card, closes it too.
lbWin.box.onclick = (e) => { if (e.target === lbWin.box) lbWin.box.hidden = true; };

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lbOpen()) { lbWin.box.hidden = true; return; }
  // Shortcuts belong to the board. On the start screen, or while typing a name,
  // "f" and "u" are letters -- and Cmd+N must not start a game with no name.
  if (menuOpen() || lbOpen() || e.target.closest('input, textarea, select')) return;
  if (e.key === 'n' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); newGame(); }
  // Plain f and u only. With a modifier held they belong to the browser --
  // Cmd+F is find, and it used to flip the board as well.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'f') el('flip').click();
  if (e.key === 'u') el('undo').click();
});

// On load: the board waits bloomed open behind the start screen.
game.reset();
game.moveLog = [];
view.setThetaManual(THETA_OPEN);
refreshCaptured();
setStatus('Choose a game', 'enter a username and pick a level');
openMenu(false);
