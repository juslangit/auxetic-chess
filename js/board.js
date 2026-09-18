/* Auxetic board renderer, on Phaser.

   The board is 16 rigid square tiles, side a, each carrying a 2x2 patch of the
   checkerboard. Tiles are hinged at shared corners and alternate their rotation
   +theta / -theta. For the hinges to stay joined the centre pitch must be

       d = a * sqrt(2) * cos(45deg + theta)

   theta =   0deg  -> d = a        tiles flush, solid 8x8 board  (playable)
   theta = -45deg  -> d = a*sqrt2  fully bloomed, exactly 2x the area

   Because every tile carries the same 2x2 patch -- square (f,r) has colour
   parity (f+r)%2, and a tile starts at even f and even r, so its local parity
   is (u+v)%2 regardless of which tile it is -- all 16 tiles are identical.
   That is why the real thing can be printed 16 times from one model.

   ---

   All of the geometry above is unchanged and still computed here by hand; what
   Phaser replaced is everything *underneath* it. The tiles, pins, pieces and
   backdrop used to be blitted with ctx.drawImage sixty times a second. They are
   now Phaser game objects on a WebGL renderer, which is what buys the rest:
   real tweens, a particle system, camera shake, per-object filters, and a sound
   manager that can overlap samples.

   Two rules kept the swap safe:

   1. `BoardView` exposes exactly the API js/main.js and the six browser tests
      already used -- squareLayout, pointToSquare, isSolid, animateTo, twistOnce,
      setThetaManual, setTwistAngle, animateMove, flipped, selected,
      legalTargets, lastMove, checkSquare, pieceAnim, hover, onSquareClick --
      with the same units: CSS pixels measured from the canvas's top-left.
   2. The animation state machine still runs on its own clock, in `step()`, not
      on Phaser tweens. The fold and the twist have to resolve their promises at
      the exact moment the engine expects, and `isSolid` gates input for the
      whole transition. Phaser's tweens drive the decoration instead. */

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

// The same colours again as integers, for the parts of Phaser that want one.
const HEX = {
  amber: 0xffc44a,
  red: 0xe24a3e,
  warm: 0xf7f4ee,
  dark: 0x23272e,
};

/* ---- baked textures ----

   Every texture is drawn into an offscreen canvas once and handed to Phaser.
   Nothing is loaded over the network, which is what lets the page keep working
   when it is opened straight from the folder over file:// (D-004). */

const SHADOW_SIDE = 220;          // the tile edge inside the sprite
const SHADOW_BOX = 300;           // sprite extent, leaving room for the blur

function shadowCanvas() {
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
  return c;
}

/* Every tile carries the same 2x2 patch. In screen space a tile's local colour
   parity is (u+v)%2 whichever way the board is flipped, so ONE baked texture
   serves all sixteen -- the same reason the physical board needs one print. */
const TILE_REF = 320;

function tileCanvas() {
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

  // A soft sheen across the plastic, laid inside the clip so it stops at the
  // tile edge. WebGL shows a flat fill for exactly what it is; this is what
  // stops sixteen identical tiles reading as printed paper.
  const sheen = x.createLinearGradient(-half, -half, half, half);
  sheen.addColorStop(0.00, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(0.35, 'rgba(255,255,255,0.02)');
  sheen.addColorStop(0.62, 'rgba(0,0,0,0.04)');
  sheen.addColorStop(1.00, 'rgba(0,0,0,0.12)');
  x.fillStyle = sheen;
  x.fillRect(-half, -half, TILE_REF, TILE_REF);
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

  return c;
}

const PIN_REF = 96;

function pinCanvas() {
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
  // a highlight, so a pin reads as a turned metal loop rather than a flat disc
  const g = x.createRadialGradient(-r * 0.3, -r * 0.35, 1, 0, 0, r);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.fill();
  return c;
}

// A soft round grain, used for every particle: capture debris, twist dust and
// the checkmate burst. Tinted per emitter rather than baked six times.
const SPARK_REF = 48;

function sparkCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SPARK_REF;
  const x = c.getContext('2d');
  const m = SPARK_REF / 2;
  const g = x.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, SPARK_REF, SPARK_REF);
  return c;
}

const easeInOutQuart = (t) => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/* ---- sound ----

   Nine CC0 samples carried in the page as data URIs (js/sounds.js), played
   through Phaser's sound manager so they can overlap and be pitched. Every
   entry sets its own volume and a random rate window, because a chess game
   plays the same "piece down" sound forty times and an identical sample forty
   times running is what makes a game sound cheap. */
const SOUND_SPEC = {
  select:  { volume: 0.30, rate: [0.96, 1.06] },
  move:    { volume: 0.45, rate: [0.92, 1.08] },
  capture: { volume: 0.60, rate: [0.88, 1.00] },
  twist:   { volume: 0.28, rate: [0.90, 1.02] },
  fold:    { volume: 0.30, rate: [0.94, 1.00] },
  close:   { volume: 0.32, rate: [0.94, 1.00] },
  check:   { volume: 0.40, rate: [0.98, 1.04] },
  end:     { volume: 0.50, rate: [1.00, 1.00] },
  illegal: { volume: 0.30, rate: [0.98, 1.06] },
};

class Sfx {
  constructor() {
    this.scene = null;
    this.ready = false;
    this.muted = false;
  }

  attach(scene) {
    this.scene = scene;
    this.ready = true;
  }

  /* Browsers refuse to start audio until the page has been touched. Phaser
     parks the sound manager in that case and unlocks it on the first gesture,
     so a call before then is dropped rather than queued -- which is right: a
     sound that arrives four seconds late is worse than no sound. */
  play(kind, opts = {}) {
    if (this.muted || !this.ready) return;
    const spec = SOUND_SPEC[kind];
    if (!spec) return;
    try {
      const [lo, hi] = spec.rate;
      this.scene.sound.play(`sfx-${kind}`, {
        volume: (opts.volume ?? 1) * spec.volume,
        rate: lo + Math.random() * (hi - lo),
        detune: opts.detune ?? 0,
      });
    } catch (_) { /* sound is a nicety, never a failure */ }
  }
}

/* ---- the scene ----

   BoardScene owns the game objects and nothing else. Every number it draws with
   comes from the BoardView it was handed, so the view stays the single place
   where the board's state lives. */
class BoardScene extends Phaser.Scene {
  constructor(view) {
    super({ key: 'board' });
    this.view = view;
  }

  preload() {
    if (typeof SOUND_BANK === 'undefined') return;
    for (const [kind, uri] of Object.entries(SOUND_BANK)) {
      this.load.audio(`sfx-${kind}`, uri);
    }
  }

  create() {
    const t = this.textures;
    if (!t.exists('tile')) t.addCanvas('tile', tileCanvas());
    if (!t.exists('pin')) t.addCanvas('pin', pinCanvas());
    if (!t.exists('tileShadow')) t.addCanvas('tileShadow', shadowCanvas());
    if (!t.exists('spark')) t.addCanvas('spark', sparkCanvas());
    this.bakePieces();

    // Depth order matches the old painter: backdrop, shadows, tiles, the square
    // markers, then the hinge pins, then the pieces standing on top.
    this.bg = this.add.image(0, 0, this.bakeBackdrop()).setOrigin(0, 0).setDepth(0)
      .setDisplaySize(this.view.w, this.view.h);

    this.shadows = [];
    this.tiles = [];
    this.pins = [];
    for (let i = 0; i < 16; i++) {
      this.shadows.push(this.add.image(0, 0, 'tileShadow').setDepth(10));
      this.tiles.push(this.add.image(0, 0, 'tile').setDepth(20));
      for (let k = 0; k < 4; k++) this.pins.push(this.add.image(0, 0, 'pin').setDepth(40));
    }

    this.marks = this.add.graphics().setDepth(30);
    this.pieces = [];              // pooled, assigned to squares each frame

    this.sparks = this.add.particles(0, 0, 'spark', {
      lifespan: 620, speed: { min: 40, max: 210 }, scale: { start: 0.55, end: 0 },
      alpha: { start: 0.9, end: 0 }, gravityY: 320, blendMode: 'ADD',
      emitting: false,
    }).setDepth(60);

    this.applyFilters();

    this.view.sfx.attach(this);
    this.view.onSceneReady(this);
  }

  /* Each piece is drawn by js/pieces.js into a 320px offscreen canvas -- the
     same lathe profiles, shading and contact shadow as before -- and that canvas
     becomes a Phaser texture. The artwork is untouched; only its delivery
     changed. */
  bakePieces() {
    for (const type of [PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING]) {
      for (const color of [WHITE, BLACK]) {
        const key = `p${type}-${color}`;
        if (!this.textures.exists(key)) this.textures.addCanvas(key, pieceSprite(type, color));
      }
    }
  }

  /* The backdrop is a radial gradient the size of the canvas, so it is rebaked
     whenever the canvas changes size and at no other time. */
  bakeBackdrop() {
    const v = this.view;
    const key = 'backdrop';
    if (this.textures.exists(key)) this.textures.remove(key);
    const c = document.createElement('canvas');
    // Baked at device resolution, shown at CSS size: a gradient stretched from
    // half-resolution is the one thing on screen that would band visibly.
    c.width = Math.max(1, Math.round(v.w * v.dpr));
    c.height = Math.max(1, Math.round(v.h * v.dpr));
    const x = c.getContext('2d');
    x.scale(v.dpr, v.dpr);
    const g = x.createRadialGradient(v.w / 2, v.h * 0.36, 20,
                                     v.w / 2, v.h * 0.6, Math.max(v.w, v.h) * 0.78);
    g.addColorStop(0, PALETTE.bg0);
    g.addColorStop(1, PALETTE.bg1);
    x.fillStyle = g;
    x.fillRect(0, 0, v.w, v.h);
    this.textures.addCanvas(key, c);
    return key;
  }

  /* Filters are the one part of this that is allowed to fail quietly. They are
     pure decoration, they are the most version-sensitive thing here, and a
     renderer without them still plays chess -- so a missing one must never take
     the board down with it. */
  applyFilters() {
    // A camera already has a filter list and must not be told to enable one --
    // `enableFilters` is a game-object method, and calling it on a camera throws.
    try {
      // Wide and weak. A vignette is meant to settle the eye in the middle of
      // the board, and anything stronger than this starts eating the back ranks
      // -- a chess piece you have to squint at is a worse trade than a flat
      // backdrop, however good the screenshot looks.
      this.cameras.main.filters.internal.addVignette(0.5, 0.5, 0.95, 0.22);
    } catch (_) { /* no vignette, no problem */ }
    try {
      // Enough glow to find a legal-move dot on a phone in daylight, not so much
      // that the halo swamps the dot's own colour -- which is what tells you
      // whether the square under it is light or dark.
      this.marks.enableFilters();
      this.marks.filters.internal.addGlow(HEX.amber, 1.5, 0, 1, false, 6, 6);
    } catch (_) { /* markers still draw, just flat */ }
  }

  resized() {
    this.bg.setTexture(this.bakeBackdrop());
    this.bg.setDisplaySize(this.view.w, this.view.h);
  }

  update() {
    const now = performance.now();
    this.view.step(now);
    this.view.sync(now);
  }
}

class BoardView {
  constructor(canvas, game) {
    this.canvas = canvas;
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

    this.sfx = new Sfx();
    this.scene = null;
    // Pieces that landed this move and are still settling, keyed by square.
    this._landing = new Map();
    this._lastTwistAnim = null;
    this._lastTheta = this.theta;

    this.measure();
    this.bootPhaser();

    window.addEventListener('resize', () => this.resize());
    // The canvas can change size without the window doing so -- a phone turning,
    // the side panel growing as the move list fills, the browser's address bar
    // sliding away. Watching the element itself catches all of those; watching
    // the window, as this used to, catches only the first.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }
    canvas.addEventListener('pointerdown', (e) => this.handlePointer(e, true));
    canvas.addEventListener('pointermove', (e) => this.handlePointer(e, false));
    canvas.addEventListener('pointerleave', () => { this.hover = -1; });

    // Until the scene is alive nothing advances the fold, and main.js starts it
    // blooming the moment the page loads. This carries the state machine over
    // the boot gap and stands down as soon as the scene takes over.
    this._preBoot = (now) => {
      if (this.scene) return;
      this.step(now);
      requestAnimationFrame(this._preBoot);
    };
    requestAnimationFrame(this._preBoot);
  }

  /* ---- boot and size ----

     The game runs in CSS pixels: one world unit is one CSS pixel, with the
     canvas's top-left at (0,0). That is what `squareLayout` has always returned
     and what the browser tests add their element origin to, so it is the one
     thing about this file that is not free to change.

     Retina sharpness and that promise pull in opposite directions, and the
     camera is what reconciles them. The game is sized in *device* pixels, so
     the backing store is as sharp as the screen allows; the camera is then
     zoomed by the same factor and scrolled back, which leaves one world unit
     worth exactly one CSS pixel with world (0,0) on the canvas corner.

     Phaser's own `zoom` config is not that. It scales the canvas's CSS size and
     says so -- "the canvas pixel size remains untouched" -- so it makes the
     board bigger, never sharper.

     Phaser also wants to size the canvas element to match the game, which would
     burst the layout, so the element is pinned back to the 100%/100% the
     stylesheet asks for. */
  measure() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  pinCanvasStyle() {
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
  }

  /* Phaser picks a renderer for itself only when it makes its own canvas. This
     one is handed the #board element that was already in the page -- which is
     what keeps the layout, the CSS and the tests' `getBoundingClientRect()`
     exactly as they were -- and in return it insists on being told WebGL or
     Canvas outright. So ask a throwaway canvas whether WebGL exists at all:
     support is a property of the browser, not of one element.

     Canvas is a real fallback, not a failure. The board still plays; it loses
     the vignette and the marker glow, which are filters and WebGL-only. */
  detectRenderType() {
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2') || probe.getContext('webgl');
      if (gl) {
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        return Phaser.WEBGL;
      }
    } catch (_) { /* fall through */ }
    return Phaser.CANVAS;
  }

  bootPhaser() {
    this.phaser = new Phaser.Game({
      type: this.detectRenderType(),
      canvas: this.canvas,
      width: this.w * this.dpr,
      height: this.h * this.dpr,
      transparent: true,
      banner: false,
      audio: { disableWebAudio: false },
      // Input is handled on the canvas element directly, below: the board reads
      // one pointer and converts it with pointToSquare, and going through
      // Phaser's hit testing would only add a frame of lag to a click.
      input: { keyboard: false, gamepad: false, mouse: false, touch: false },
      scale: { mode: Phaser.Scale.NONE, autoRound: false },
      scene: new BoardScene(this),
    });
    this.pinCanvasStyle();
  }

  onSceneReady(scene) {
    this.scene = scene;
    this.aimCamera();
    this.pinCanvasStyle();
    this._tc = null;
  }

  /* Put one CSS pixel back on one world unit.

     The camera zooms about its own midpoint, so zooming alone would pin the
     centre of the board and push its corners off the canvas. Scrolling by
     c*(1-z)/z undoes that: with camera half-width c and zoom z, a world point
     lands at (world - scroll - c)*z + c, and that scroll makes it world*z --
     which is to say world (0,0) sits on the canvas corner and the board fills
     the canvas exactly as it did when this was a 2D context. */
  aimCamera() {
    if (!this.scene) return;
    const cam = this.scene.cameras.main;
    cam.setZoom(this.dpr);
    cam.setScroll((this.w / 2) * (1 - this.dpr), (this.h / 2) * (1 - this.dpr));
  }

  resize() {
    this.measure();
    this._tc = null;
    if (!this.scene) return;
    this.scene.scale.resize(this.w * this.dpr, this.h * this.dpr);
    this.aimCamera();
    this.scene.resized();
    this.pinCanvasStyle();
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
    this.sfx.play(theta === THETA_SOLID ? 'close' : 'fold');
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

     While this runs, `syncPieces` places every piece by the square it came FROM
     -- the engine has already moved them on -- and swings it round its tile
     centre. At a quarter turn that arc lands exactly on the new square. */
  twistOnce(dur = 430, delay = 200) {
    if (this.twistAnim && this.twistAnim.onDone) this.twistAnim.onDone();
    return new Promise((resolve) => {
      this.twistAnim = {
        base: this.twistAngle, t0: performance.now() + delay,
        dur, ease: easeInOutQuart, onDone: resolve, spoke: false,
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
    // Remember where each piece is going, so it can be given a landing bounce
    // and, if it took something, a puff of debris at the moment of contact.
    for (const p of parts) this._landing.set(p.to, { t0: performance.now() + dur, done: false });
  }

  /* A capture, told to the renderer by main.js. The board itself cannot see one:
     by the time it draws, the engine has already removed the taken piece. */
  capturedAt(sqIndex) {
    if (!this.scene) return;
    const L = this.squareLayout(sqIndex);
    this.scene.sparks.setParticleTint(HEX.warm);
    this.scene.sparks.emitParticleAt(L.x, L.y, 14);
    this.scene.cameras.main.shake(140, 0.004);
  }

  /* Check, and the end of the game: the two moments worth feeling. */
  alarm(kind) {
    if (!this.scene) return;
    const cam = this.scene.cameras.main;
    if (kind === 'check') {
      cam.shake(180, 0.006);
    } else if (kind === 'end') {
      cam.shake(520, 0.011);
      const c = this.squareSize() * 4;
      this.scene.sparks.setParticleTint(HEX.amber);
      this.scene.sparks.emitParticleAt(this.w / 2, this.h / 2 - c * 0.2, 90);
    }
  }

  /* ---- the clock ----

     One step per frame, advancing the three motions and firing the sounds and
     effects that belong to them. Kept off Phaser's tween system on purpose: the
     promises these resolve are what the engine waits on. */
  step(now) {
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.t0) / this.tween.dur);
      this.theta = this.tween.from + (this.tween.to - this.tween.from) * this.tween.ease(t);
      if (t >= 1) { const done = this.tween.onDone; this.tween = null; if (done) done(); }
    }
    if (this.twistAnim) {
      const tw = this.twistAnim;
      // The mechanism speaks when it starts moving, not when it was asked to.
      if (!tw.spoke && now >= tw.t0) { tw.spoke = true; this.sfx.play('twist'); }
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

    // A piece that has just come to rest taps the board once.
    for (const [sq, land] of this._landing) {
      if (!land.done && now >= land.t0) {
        land.done = true;
        land.settled = now;
      }
      if (land.done && now - land.settled > 260) this._landing.delete(sq);
    }
  }

  /* ---- drawing ----

     Everything below only moves game objects; no state is decided here. */
  sync(now) {
    const s = this.scene;
    if (!s) return;
    const bloom = Math.abs(this.theta / THETA_OPEN);      // 0 solid .. 1 bloomed

    for (let jj = 0; jj < 4; jj++) for (let ii = 0; ii < 4; ii++) {
      const i = jj * 4 + ii;
      const t = this.tileTransform(ii, jj);

      const sh = s.shadows[i];
      const span = SHADOW_BOX * (t.a / SHADOW_SIDE);
      sh.setPosition(t.cx, t.cy + t.a * 0.05).setRotation(t.paintRot)
        .setDisplaySize(span, span).setAlpha(0.5 * (1 - bloom * 0.35));

      s.tiles[i].setPosition(t.cx, t.cy).setRotation(t.paintRot).setDisplaySize(t.a, t.a);

      // The hinge loops. Every tile corner carries one; where two tiles meet
      // they land on the same point and read as a single pin, and around the rim
      // they stick out the way they do on the printed board.
      const R = t.a / Math.SQRT2;
      const pinSpan = t.a * 0.22;
      for (let k = 0; k < 4; k++) {
        const ang = (45 + 90 * k) * DEG + t.gridRot;
        s.pins[i * 4 + k]
          .setPosition(t.cx + R * Math.cos(ang), t.cy + R * Math.sin(ang))
          .setDisplaySize(pinSpan, pinSpan);
      }
    }

    this.syncMarks(now);
    this.syncPieces(now);
  }

  // Which chess square sits at screen slot (ii,jj,u,v)?
  screenToSquare(ii, jj, u, v) {
    const sf = ii * 2 + u, sr = jj * 2 + v;
    const f = this.flipped ? 7 - sf : sf;
    const r = this.flipped ? sr : 7 - sr;
    return r * 16 + f;
  }

  /* Is the painted square at tile slot (u,v) light? The tile texture is light
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
  syncMarks(now) {
    const g = this.scene.marks;
    g.clear();

    // One slow breath shared by everything that pulses, so the selected square,
    // its dots and the king in check are all on the same rhythm.
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);

    for (let jj = 0; jj < 4; jj++) for (let ii = 0; ii < 4; ii++) {
      const t = this.tileTransform(ii, jj);
      const half = t.a / 2;
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
      if (!marks.length) continue;

      g.save();
      g.translateCanvas(t.cx, t.cy);
      g.rotateCanvas(t.gridRot);
      for (const m of marks) {
        const x = -half + m.u * t.s, y = -half + m.v * t.s;
        if (m.chk) {
          // check breathes; a flat red square is easy to stop noticing
          g.fillStyle(HEX.red, 0.42 + 0.30 * pulse);
          g.fillRect(x, y, t.s, t.s);
        }
        if (m.last) { g.fillStyle(HEX.amber, 0.22); g.fillRect(x, y, t.s, t.s); }
        if (m.sel) { g.fillStyle(HEX.amber, 0.40 + 0.18 * pulse); g.fillRect(x, y, t.s, t.s); }
        if (m.hov) {
          g.lineStyle(t.s * 0.05, HEX.amber, 0.5);
          g.strokeRect(x + t.s * 0.025, y + t.s * 0.025, t.s * 0.95, t.s * 0.95);
        }
        if (m.tgt) {
          const c = m.isLight ? HEX.dark : HEX.warm;
          const a = (m.isLight ? 0.36 : 0.42) + 0.14 * pulse;
          if (m.occupied) {
            g.lineStyle(t.s * 0.085, c, a);
            g.strokeCircle(x + t.s / 2, y + t.s / 2, t.s * 0.40);
          } else {
            g.fillStyle(c, a);
            g.fillCircle(x + t.s / 2, y + t.s / 2, t.s * (0.115 + 0.022 * pulse));
          }
        }
      }
      g.restore();
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

  /* Pieces are drawn upright, outside any tile transform: five of the six types
     are lathe shapes and look identical from every direction, which is what
     happens to the real turned pieces when the tile spins under them.

     The images are pooled rather than created per frame -- at most 32 exist,
     and the spare ones are parked invisible. */
  syncPieces(now) {
    const s = this.scene;
    let n = 0;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const sqIdx = r * 16 + f;
      const p = this.game.board[sqIdx];
      if (p === EMPTY) continue;

      let img = s.pieces[n];
      if (!img) { img = s.add.image(0, 0, 'p1-0').setDepth(50); s.pieces[n] = img; }
      n++;

      const P = this.piecePosition(sqIdx, now);
      const k = PIECE_H * P.size / 100;          // authored units -> px
      const span = SPRITE_UNITS * k;

      // A piece that has just landed squashes and comes back, which is what sells
      // the weight of a plastic chess piece being set down.
      let sx = 1, sy = 1;
      const land = this._landing.get(sqIdx);
      if (land && land.done) {
        const e = Math.min(1, (now - land.settled) / 260);
        const bump = Math.sin(e * Math.PI) * (1 - e) * 0.13;
        sx = 1 + bump; sy = 1 - bump;
      }

      img.setTexture(`p${typeOf(p)}-${colorOf(p)}`)
         .setVisible(true)
         .setPosition(P.x, P.y - P.lift + BASE_DROP * P.size - 42 * k)
         .setDisplaySize(span * sx, span * sy);
    }
    for (let i = n; i < s.pieces.length; i++) s.pieces[i].setVisible(false);
  }
}
