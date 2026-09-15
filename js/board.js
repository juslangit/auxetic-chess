/* Auxetic board renderer.

   The board is 16 rigid square tiles, side a, each carrying a 2x2 patch of the
   checkerboard. Tiles are hinged at shared corners and alternate their rotation
   +theta / -theta. For the hinges to stay joined the centre pitch must be

       d = a * sqrt(2) * cos(45deg + theta)

   theta =   0deg  -> d = a        tiles flush, solid 8x8 board  (playable)
   theta = -45deg  -> d = a*sqrt2  fully bloomed, exactly 2x the area

   Because every tile carries the same 2x2 patch -- square (f,r) has colour
   parity (f+r)%2, and a tile starts at even f and even r, so its local parity
   is (u+v)%2 regardless of which tile it is -- all 16 tiles are identical.
   That is why the real thing can be printed 16 times from one model. */

const DEG = Math.PI / 180;
const THETA_OPEN = -45 * DEG;     // fully bloomed
const THETA_SOLID = 0;            // playable

const PALETTE = {
  bg0: '#1b1f26', bg1: '#0d0f13',
  tile: '#f7f4ee',
  lightSq: '#efe9dd', darkSq: '#23272e',
  seam: 'rgba(0,0,0,0.10)',
  pin: '#fbf9f5', pinEdge: '#c8c0b0',
  sel: 'rgba(255, 196, 74, 0.55)',
  last: 'rgba(255, 196, 74, 0.22)',
  dot: 'rgba(30,34,40,0.36)', dotLight: 'rgba(250,248,244,0.42)',
  check: 'rgba(226, 74, 62, 0.68)',
};

/* One blurred rounded-square, built once and blitted per tile. */
const SHADOW_SIDE = 220;          // the tile edge inside the sprite
const SHADOW_BOX = 300;           // sprite extent, leaving room for the blur
let _shadowSprite = null;

function tileShadowSprite() {
  if (_shadowSprite) return _shadowSprite;
  const c = document.createElement('canvas');
  c.width = c.height = SHADOW_BOX;
  const x = c.getContext('2d');
  x.translate(SHADOW_BOX / 2, SHADOW_BOX / 2);
  x.filter = 'blur(16px)';
  x.fillStyle = 'rgba(0,0,0,0.9)';
  const h = SHADOW_SIDE / 2, r = SHADOW_SIDE * 0.05;
  x.beginPath();
  x.moveTo(-h + r, -h);
  x.arcTo(h, -h, h, h, r);
  x.arcTo(h, h, -h, h, r);
  x.arcTo(-h, h, -h, -h, r);
  x.arcTo(-h, -h, h, -h, r);
  x.closePath();
  x.fill();
  _shadowSprite = c;
  return c;
}

/* Every tile carries the same 2x2 patch. In screen space a tile's local colour
   parity is (u+v)%2 whichever way the board is flipped, so ONE baked sprite
   serves all sixteen -- the same reason the physical board needs one print. */
const TILE_REF = 320;
let _tileBody = null, _pinSprite = null;

function tileBodySprite() {
  if (_tileBody) return _tileBody;
  const c = document.createElement('canvas');
  c.width = c.height = TILE_REF;
  const x = c.getContext('2d');
  const half = TILE_REF / 2, cell = TILE_REF / 2, r = TILE_REF * 0.05;
  x.translate(half, half);

  const round = () => {
    x.beginPath();
    x.moveTo(-half + r, -half);
    x.arcTo(half, -half, half, half, r);
    x.arcTo(half, half, -half, half, r);
    x.arcTo(-half, half, -half, -half, r);
    x.arcTo(-half, -half, half, -half, r);
    x.closePath();
  };

  round();
  x.fillStyle = PALETTE.tile;
  x.fill();

  x.save();
  round();
  x.clip();
  for (let v = 0; v < 2; v++) for (let u = 0; u < 2; u++) {
    const isLight = (u + v) % 2 === 0;
    x.fillStyle = isLight ? PALETTE.lightSq : PALETTE.darkSq;
    x.fillRect(-half + u * cell, -half + v * cell, cell + 0.5, cell + 0.5);
    x.strokeStyle = PALETTE.seam;
    x.lineWidth = 1.5;
    x.strokeRect(-half + u * cell + 0.75, -half + v * cell + 0.75, cell, cell);
  }
  x.restore();

  // bevel: light from the upper left, dark on the lower right
  round();
  const bev = x.createLinearGradient(-half, -half, half, half);
  bev.addColorStop(0, 'rgba(255,255,255,0.32)');
  bev.addColorStop(0.5, 'rgba(255,255,255,0)');
  bev.addColorStop(1, 'rgba(0,0,0,0.26)');
  x.strokeStyle = bev;
  x.lineWidth = TILE_REF * 0.022;
  x.stroke();

  _tileBody = c;
  return c;
}

const PIN_REF = 96;
function pinSprite() {
  if (_pinSprite) return _pinSprite;
  const c = document.createElement('canvas');
  c.width = c.height = PIN_REF;
  const x = c.getContext('2d');
  const m = PIN_REF / 2, r = PIN_REF * 0.40;
  x.translate(m, m);
  x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2);
  x.fillStyle = PALETTE.pin; x.fill();
  x.lineWidth = r * 0.22; x.strokeStyle = PALETTE.pinEdge; x.stroke();
  x.beginPath(); x.arc(0, 0, r * 0.42, 0, Math.PI * 2);
  x.fillStyle = 'rgba(0,0,0,0.18)'; x.fill();
  _pinSprite = c;
  return c;
}

const easeInOutQuart = (t) => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

class BoardView {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;

    this.theta = THETA_OPEN;
    this.tween = null;            // {from, to, t0, dur, ease, onDone}
    this.flipped = false;

    // The twist. `twistAngle` is how far the tile paint has turned in total; the
    // grid of board squares does NOT turn with it -- a1 is a position, and the
    // twist carries pieces between positions. `twistAnim` runs one quarter.
    this.twistAngle = 0;
    this.twistAnim = null;

    // Per-frame cache of the sixteen tile transforms. Every piece and every
    // marker asks for one, so without this they are recomputed 64+ times a
    // frame. Rebuilt whenever anything they depend on moves.
    this._tc = null;

    this.selected = -1;
    this.legalTargets = [];
    this.lastMove = null;
    this.checkSquare = -1;
    this.hover = -1;

    this.pieceAnim = null;        // {parts:[{piece,from,to}], t0, dur}
    this.onSquareClick = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('pointerdown', (e) => this.handlePointer(e, true));
    canvas.addEventListener('pointermove', (e) => this.handlePointer(e, false));
    canvas.addEventListener('pointerleave', () => { this.hover = -1; });

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.dpr = dpr;
    this.w = rect.width;
    this.h = rect.height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bg = null;                 // rebuilt lazily at the new size
    this._tc = null;
  }

  // The backdrop never changes between resizes, so paint it once and blit it.
  background() {
    if (this.bg && this.bg.width === this.canvas.width && this.bg.height === this.canvas.height) {
      return this.bg;
    }
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const x = c.getContext('2d');
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = x.createRadialGradient(this.w / 2, this.h * 0.36, 20,
                                     this.w / 2, this.h * 0.6, Math.max(this.w, this.h) * 0.78);
    g.addColorStop(0, PALETTE.bg0);
    g.addColorStop(1, PALETTE.bg1);
    x.fillStyle = g;
    x.fillRect(0, 0, this.w, this.h);
    this.bg = c;
    return c;
  }

  /* ---- geometry ---- */

  // Normalised pitch d/a for the current angle. 1 when solid.
  pitchNorm(theta = this.theta) { return Math.SQRT2 * Math.cos(45 * DEG + theta); }

  // Square size in px. Shrinks as the board blooms so the lattice always fits,
  // but only partly, so you still see it grow. A tile twisting a quarter about
  // its own centre covers the same square, so the twist needs no compensation.
  squareSize() {
    const fit = Math.min(this.w, this.h) * 0.86;
    return (fit / 8) * Math.pow(this.pitchNorm(), -0.65);
  }

  // Screen placement of tile (ii,jj) in *screen* coordinates, 0,0 top-left.
  tileTransform(ii, jj) {
    if (!this._tc || this._tcTheta !== this.theta || this._tcTwist !== this.twistAngle ||
        this._tcW !== this.w || this._tcH !== this.h) {
      this.rebuildTileCache();
    }
    return this._tc[jj * 4 + ii];
  }

  rebuildTileCache() {
    const s = this.squareSize();
    const a = s * 2;
    const d = a * this.pitchNorm();
    const ox = this.w / 2 - 2 * d;
    const oy = this.h / 2 - 2 * d;
    const tc = new Array(16);
    for (let jj = 0; jj < 4; jj++) {
      for (let ii = 0; ii < 4; ii++) {
        const sign = ((ii + jj) % 2 === 0) ? 1 : -1;
        const gridRot = sign * this.theta;        // where the board squares are
        tc[jj * 4 + ii] = {
          cx: ox + (ii + 0.5) * d,
          cy: oy + (jj + 0.5) * d,
          gridRot,
          paintRot: gridRot + this.twistAngle,    // how the tile itself is turned
          a, s,
        };
      }
    }
    this._tc = tc;
    this._tcTheta = this.theta;
    this._tcTwist = this.twistAngle;
    this._tcW = this.w;
    this._tcH = this.h;
  }

  // Chess square -> which tile holds it and where inside that tile.
  squareLayout(sqIndex) {
    const f = sqIndex & 7, r = sqIndex >> 4;
    const sf = this.flipped ? 7 - f : f;             // screen file, left to right
    const sr = this.flipped ? r : 7 - r;             // screen row, top to bottom
    const ii = sf >> 1, jj = sr >> 1;
    const u = sf & 1, v = sr & 1;
    const t = this.tileTransform(ii, jj);
    const lx = (u - 0.5) * t.s, ly = (v - 0.5) * t.s;
    // Grid orientation only: the twist turns the paint and carries the pieces,
    // but the square called e4 stays exactly where it is.
    const cos = Math.cos(t.gridRot), sin = Math.sin(t.gridRot);
    return {
      x: t.cx + lx * cos - ly * sin,
      y: t.cy + lx * sin + ly * cos,
      size: t.s, rot: t.gridRot, tile: t, u, v,
    };
  }

  // Screen point -> chess square. Only meaningful when the board is solid.
  pointToSquare(px, py) {
    const s = this.squareSize();
    const ox = this.w / 2 - 4 * s, oy = this.h / 2 - 4 * s;
    const sf = Math.floor((px - ox) / s), sr = Math.floor((py - oy) / s);
    if (sf < 0 || sf > 7 || sr < 0 || sr > 7) return -1;
    const f = this.flipped ? 7 - sf : sf;
    const r = this.flipped ? sr : 7 - sr;
    return r * 16 + f;
  }

  // The gate for input and hover: the board must be flat AND standing still.
  get isSolid() {
    return Math.abs(this.theta) < 0.004 && !this.tween && !this.twistAnim;
  }

  handlePointer(e, isDown) {
    const rect = this.canvas.getBoundingClientRect();
    const sq = this.pointToSquare(e.clientX - rect.left, e.clientY - rect.top);
    if (!this.isSolid) { this.hover = -1; return; }
    if (isDown) { if (this.onSquareClick) this.onSquareClick(sq); }
    else this.hover = sq;
  }

  /* ---- animation ---- */

  animateTo(theta, dur = 1500, ease = easeInOutQuart) {
    // Settle any tween we are replacing, or whoever awaited it waits forever.
    if (this.tween && this.tween.onDone) this.tween.onDone();
    return new Promise((resolve) => {
      this.tween = { from: this.theta, to: theta, t0: performance.now(), dur, ease, onDone: resolve };
    });
  }

  setThetaManual(theta) { this.tween = null; this.theta = theta; }

  /* Turn every 2x2 block a quarter, carrying the pieces.

     `delay` holds everything still first, so the piece that just moved lands
     before the board turns under it. The tween is created immediately even so:
     it is what makes `isSolid` false, which keeps the whole transition atomic
     instead of letting input back in during the pause.

     While this runs, `drawPieces` places every piece by the square it came FROM
     -- the engine has already moved them on -- and swings it round its tile
     centre. At a quarter turn that arc lands exactly on the new square. */
  twistOnce(dur = 430, delay = 200) {
    if (this.twistAnim && this.twistAnim.onDone) this.twistAnim.onDone();
    return new Promise((resolve) => {
      this.twistAnim = {
        base: this.twistAngle, t0: performance.now() + delay,
        dur, ease: easeInOutQuart, onDone: resolve,
      };
    });
  }

  setTwistAngle(v) { this.twistAnim = null; this.twistAngle = v; }

  // Eased progress of the running twist, 0 to 1.
  twistProgress(now) {
    const tw = this.twistAnim;
    if (!tw) return 0;
    const t = Math.min(1, Math.max(0, (now - tw.t0) / tw.dur));
    return tw.ease(t);
  }

  // How far the tile paint has turned into the running twist, 0 to 90 degrees.
  twistAlpha(now) { return this.twistProgress(now) * (Math.PI / 2); }

  // Slide pieces along their move. `parts` lets castling move king and rook together.
  animateMove(parts, dur = 210) {
    this.pieceAnim = { parts, t0: performance.now(), dur };
  }

  loop(now) {
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.t0) / this.tween.dur);
      this.theta = this.tween.from + (this.tween.to - this.tween.from) * this.tween.ease(t);
      if (t >= 1) { const done = this.tween.onDone; this.tween = null; if (done) done(); }
    }
    if (this.twistAnim) {
      const tw = this.twistAnim;
      this.twistAngle = tw.base + this.twistAlpha(now);
      if (now - tw.t0 >= tw.dur) {
        // keep the accumulated angle bounded; a quarter turn is all that shows
        this.twistAngle = (tw.base + Math.PI / 2) % (Math.PI * 2);
        const done = tw.onDone;
        this.twistAnim = null;
        if (done) done();
      }
    }
    if (this.pieceAnim && now - this.pieceAnim.t0 >= this.pieceAnim.dur) this.pieceAnim = null;
    this.render(now);
    requestAnimationFrame(this.loop);
  }

  /* ---- painting ---- */

  render(now) {
    const ctx = this.ctx;
    ctx.drawImage(this.background(), 0, 0, this.w, this.h);

    const bloom = Math.abs(this.theta / THETA_OPEN);      // 0 solid .. 1 bloomed

    // Shadows first, so no tile casts onto another. The blur is baked into a
    // sprite once: running ctx.filter per tile per frame costs ~4 fps.
    const shadow = tileShadowSprite();
    ctx.save();
    ctx.globalAlpha = 0.5 * (1 - bloom * 0.35);
    for (let jj = 0; jj < 4; jj++) for (let ii = 0; ii < 4; ii++) {
      const t = this.tileTransform(ii, jj);
      const scale = t.a / SHADOW_SIDE;
      const span = SHADOW_BOX * scale;
      ctx.save();
      ctx.translate(t.cx, t.cy + t.a * 0.05);
      ctx.rotate(t.paintRot);
      ctx.drawImage(shadow, -span / 2, -span / 2, span, span);
      ctx.restore();
    }
    ctx.restore();

    for (let jj = 0; jj < 4; jj++) for (let ii = 0; ii < 4; ii++) this.drawTile(ii, jj, now);
    for (let jj = 0; jj < 4; jj++) for (let ii = 0; ii < 4; ii++) this.drawPins(ii, jj);

    // Pieces are drawn upright, outside any tile transform: five of the six
    // types are lathe shapes and look identical from every direction, which is
    // what happens to the real turned pieces when the tile spins under them.
    this.drawPieces(now);
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Which chess square sits at screen slot (ii,jj,u,v)?
  screenToSquare(ii, jj, u, v) {
    const sf = ii * 2 + u, sr = jj * 2 + v;
    const f = this.flipped ? 7 - sf : sf;
    const r = this.flipped ? sr : 7 - sr;
    return r * 16 + f;
  }

  /* Is the painted square at tile slot (u,v) light? The tile sprite is light
     where (u+v) is even, but the paint turns with the twist, and each quarter
     turn swaps light and dark. So after an odd number of quarters the answer
     flips. The move dots use this to pick a colour that shows up. */
  slotIsLight(u, v) {
    const quarters = Math.round(this.twistAngle / (Math.PI / 2));
    return ((u + v) % 2 === 0) !== (quarters % 2 !== 0);
  }

  /* Two transforms, deliberately.

     The tile body carries the printed checkerboard, so it turns with the twist.
     The square markers -- selection, last move, check, legal-move dots -- belong
     to board positions, which do not turn. At rest the two differ by a multiple
     of 90 degrees and the cells line up either way; mid-twist they come apart,
     and that is correct: the markers stay on their squares while the tile spins
     underneath. */
  drawTile(ii, jj, now) {
    const ctx = this.ctx;
    const t = this.tileTransform(ii, jj);
    const half = t.a / 2;

    // the plastic, turned by the twist
    ctx.save();
    ctx.translate(t.cx, t.cy);
    ctx.rotate(t.paintRot);
    ctx.drawImage(tileBodySprite(), -half, -half, t.a, t.a);
    ctx.restore();

    // Only the live state is painted per frame; the plastic is baked.
    const marks = [];
    for (let v = 0; v < 2; v++) for (let u = 0; u < 2; u++) {
      const sqIdx = this.screenToSquare(ii, jj, u, v);
      const isLight = this.slotIsLight(u, v);
      const sel = sqIdx === this.selected;
      const last = this.lastMove && (sqIdx === this.lastMove.from || sqIdx === this.lastMove.to);
      const chk = sqIdx === this.checkSquare;
      const tgt = this.legalTargets.includes(sqIdx);
      const hov = this.isSolid && sqIdx === this.hover && !sel &&
        this.game.board[sqIdx] !== EMPTY && colorOf(this.game.board[sqIdx]) === this.game.turn;
      if (sel || last || chk || tgt || hov) {
        marks.push({ u, v, isLight, sel, last, chk, tgt, hov, occupied: this.game.board[sqIdx] !== EMPTY });
      }
    }
    if (!marks.length) return;

    // the markers, in the grid's own orientation
    ctx.save();
    ctx.translate(t.cx, t.cy);
    ctx.rotate(t.gridRot);
    for (const m of marks) {
      const x = -half + m.u * t.s, y = -half + m.v * t.s;
      if (m.chk) { ctx.fillStyle = PALETTE.check; ctx.fillRect(x, y, t.s, t.s); }
      if (m.last) { ctx.fillStyle = PALETTE.last; ctx.fillRect(x, y, t.s, t.s); }
      if (m.sel) { ctx.fillStyle = PALETTE.sel; ctx.fillRect(x, y, t.s, t.s); }
      if (m.hov) {
        ctx.strokeStyle = 'rgba(255,196,74,0.5)';
        ctx.lineWidth = t.s * 0.05;
        ctx.strokeRect(x + t.s * 0.025, y + t.s * 0.025, t.s * 0.95, t.s * 0.95);
      }
      if (m.tgt) {
        ctx.fillStyle = m.isLight ? PALETTE.dot : PALETTE.dotLight;
        ctx.beginPath();
        if (m.occupied) {
          ctx.lineWidth = t.s * 0.085;
          ctx.strokeStyle = ctx.fillStyle;
          ctx.arc(x + t.s / 2, y + t.s / 2, t.s * 0.40, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.arc(x + t.s / 2, y + t.s / 2, t.s * 0.125, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // The hinge loops. Every tile corner carries one; where two tiles meet they
  // land on the same point and read as a single pin, and around the rim they
  // stick out the way they do on the printed board.
  drawPins(ii, jj) {
    const ctx = this.ctx;
    const t = this.tileTransform(ii, jj);
    const R = t.a / Math.SQRT2;
    const span = t.a * 0.22;
    const pin = pinSprite();
    for (let k = 0; k < 4; k++) {
      const ang = (45 + 90 * k) * DEG + t.gridRot;
      const x = t.cx + R * Math.cos(ang), y = t.cy + R * Math.sin(ang);
      ctx.drawImage(pin, x - span / 2, y - span / 2, span, span);
    }
  }

  /* Where a piece is drawn, and why it is not simply "rotate by the twist angle".

     Two motions can be running. The move slide carries the piece that was just
     played from its old square to its new one. The twist then sweeps each piece
     round its tile centre.

     The sweep is derived, not assumed: each piece turns by the actual angle
     from the square it was carried out of to the square it is on. With the
     plain quarter turn that comes to 90 degrees for everything, but deriving it
     is what makes the animation land exactly on the square the engine chose
     rather than wherever 90 degrees happens to point. Hard-coding the angle is
     how a piece ends up beside its square and snaps into place at the end. */
  piecePosition(sqIdx, now) {
    const twisting = !!this.twistAnim;
    const home = twisting ? this.game.twistPreimage(sqIdx) : sqIdx;
    const L = this.squareLayout(home);
    let x = L.x, y = L.y, lift = 0;

    const anim = this.pieceAnim;
    if (anim) {
      const slide = easeOutCubic(Math.min(1, (now - anim.t0) / anim.dur));
      const part = anim.parts.find((q) => q.to === home);
      if (part) {
        const A = this.squareLayout(part.from);
        x = A.x + (L.x - A.x) * slide;
        y = A.y + (L.y - A.y) * slide;
        lift = Math.sin(slide * Math.PI) * L.size * 0.10;
      }
    }

    if (twisting && home !== sqIdx) {
      const cx = L.tile.cx, cy = L.tile.cy;
      const target = this.squareLayout(sqIdx);
      const from = Math.atan2(L.y - cy, L.x - cx);
      const to = Math.atan2(target.y - cy, target.x - cx);
      // always sweep the way the tile turns, so 0 means "already there"
      const TAU = Math.PI * 2;
      const sweep = ((to - from) % TAU + TAU) % TAU;
      const ang = sweep * this.twistProgress(now);
      const c = Math.cos(ang), sn = Math.sin(ang);
      const dx = x - cx, dy = y - cy;
      x = cx + dx * c - dy * sn;
      y = cy + dx * sn + dy * c;
    }

    return { x, y, lift, size: L.size };
  }

  drawPieces(now) {
    const ctx = this.ctx;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const sqIdx = r * 16 + f;
      const p = this.game.board[sqIdx];
      if (p === EMPTY) continue;
      const P = this.piecePosition(sqIdx, now);
      drawPiece(ctx, typeOf(p), colorOf(p), P.x, P.y - P.lift, P.size * 0.96);
    }
  }
}
