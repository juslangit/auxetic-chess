/* Piece artwork. Each piece is drawn once into an offscreen sprite and then
   blitted, which caches the work and -- importantly -- keeps the `source-atop`
   sheen scoped to the piece instead of smearing it across the whole board.

   Sprite space is a 120x120 unit box with 10 units of padding, wrapping the
   100x100 box the shapes below are authored in: y down, standing on y = 92. */

const SPRITE_PX = 320;
const SPRITE_UNITS = 120;
const spriteCache = new Map();

// Right-hand profile, base upward. Mirrored to make a lathe shape.
const PROFILES = {
  [PAWN]: [[25, 92], [25, 85], [17, 79], [13, 73], [20, 69], [20, 65], [12, 56], [10, 46], [13, 41]],
  [BISHOP]: [[28, 92], [28, 85], [19, 79], [14, 73], [22, 69], [22, 64], [13, 52], [11, 40], [14, 34]],
  [ROOK]: [[30, 92], [30, 84], [22, 78], [19, 72], [25, 68], [23, 46], [27, 40], [30, 36]],
  [QUEEN]: [[31, 92], [31, 84], [22, 78], [16, 71], [25, 66], [25, 60], [15, 44], [13, 32], [20, 26]],
  [KING]: [[31, 92], [31, 84], [22, 78], [16, 71], [25, 66], [25, 60], [15, 44], [14, 32], [21, 27]],
  [KNIGHT]: null,
};

function lathePath(ctx, profile) {
  // Trace one continuous outline: up the left flank, across the neck, down the
  // right flank, and let closePath lay the base. Walking the profile in the
  // wrong order here self-intersects the path and the stroke then draws a
  // spurious diagonal across the piece.
  const n = profile.length;
  ctx.beginPath();
  ctx.moveTo(-profile[0][0], profile[0][1]);            // bottom left
  for (let i = 1; i < n; i++) ctx.lineTo(-profile[i][0], profile[i][1]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(profile[i][0], profile[i][1]);
  ctx.closePath();                                      // base
}

function knightPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(-30, 92); ctx.lineTo(30, 92);
  ctx.lineTo(30, 84); ctx.lineTo(23, 78);
  ctx.lineTo(25, 69);
  ctx.lineTo(21, 60);
  ctx.lineTo(27, 42);
  ctx.lineTo(29, 28);
  ctx.lineTo(22, 17);              // back ear
  ctx.lineTo(17, 24);
  ctx.lineTo(11, 13);              // front ear
  ctx.lineTo(3, 23);
  ctx.lineTo(-11, 24);             // forehead
  ctx.lineTo(-25, 34);             // muzzle
  ctx.lineTo(-30, 45);             // nose
  ctx.lineTo(-21, 49);             // jaw
  ctx.lineTo(-11, 47);
  ctx.lineTo(-16, 59);             // throat
  ctx.lineTo(-23, 70);
  ctx.lineTo(-25, 78); ctx.lineTo(-30, 84);
  ctx.closePath();
}

function crownPath(ctx, points, cy, rOuter, rInner, spread) {
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const x = (t - 0.5) * spread;
    if (i === 0) ctx.moveTo(x - rOuter, cy + rInner); else ctx.lineTo(x - rOuter, cy + rInner);
    ctx.lineTo(x, cy - rOuter);
    ctx.lineTo(x + rOuter, cy + rInner);
  }
  ctx.closePath();
}

function buildSprite(type, color) {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_PX;
  const ctx = c.getContext('2d');
  const k = SPRITE_PX / SPRITE_UNITS;

  const light = color === WHITE;
  // The rim is the key to readability: a warm grey outline separates a white
  // piece from a light square, and a light grey one lifts a black piece off a
  // dark square -- which is what ambient light does on the printed originals.
  const body = light ? '#f4f1ea' : '#33383f';
  const edge = light ? '#aea48f' : '#6a7280';
  const hiA = light ? 0.50 : 0.30;
  const loA = light ? 0.26 : 0.40;

  ctx.scale(k, k);
  ctx.translate(60, 10);           // authored box origin inside the padded sprite

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = edge;
  ctx.fillStyle = body;
  const paint = () => { ctx.fill(); ctx.stroke(); };

  if (type === KNIGHT) {
    knightPath(ctx); paint();
    ctx.save();
    ctx.fillStyle = edge;
    ctx.beginPath(); ctx.arc(-7, 32, 3.2, 0, Math.PI * 2); ctx.fill();          // eye
    ctx.strokeStyle = edge; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-26, 41); ctx.lineTo(-18, 39); ctx.stroke();    // nostril
    ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(2, 26); ctx.lineTo(14, 31); ctx.stroke();       // mane
    ctx.restore();
  } else {
    lathePath(ctx, PROFILES[type]); paint();

    if (type === PAWN) {
      ctx.beginPath(); ctx.arc(0, 27, 16, 0, Math.PI * 2); paint();
    } else if (type === BISHOP) {
      ctx.beginPath();
      ctx.moveTo(-15, 36); ctx.quadraticCurveTo(-17, 12, 0, 2);
      ctx.quadraticCurveTo(17, 12, 15, 36); ctx.closePath(); paint();
      ctx.save();
      ctx.strokeStyle = edge; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(6, 27); ctx.lineTo(-6, 14); ctx.stroke();     // mitre slit
      ctx.restore();
      ctx.beginPath(); ctx.arc(0, -2, 5.5, 0, Math.PI * 2); paint();
    } else if (type === ROOK) {
      ctx.beginPath();
      ctx.moveTo(-32, 37); ctx.lineTo(-32, 18); ctx.lineTo(-22, 18); ctx.lineTo(-22, 26);
      ctx.lineTo(-8, 26); ctx.lineTo(-8, 18); ctx.lineTo(8, 18); ctx.lineTo(8, 26);
      ctx.lineTo(22, 26); ctx.lineTo(22, 18); ctx.lineTo(32, 18); ctx.lineTo(32, 37);
      ctx.closePath(); paint();
    } else if (type === QUEEN) {
      crownPath(ctx, 5, 18, 7, 9, 46); paint();
      ctx.beginPath(); ctx.ellipse(0, 31, 24, 7, 0, 0, Math.PI * 2); paint();
    } else if (type === KING) {
      ctx.beginPath();
      ctx.moveTo(-5, 23); ctx.lineTo(-5, 13); ctx.lineTo(-14, 13); ctx.lineTo(-14, 4);
      ctx.lineTo(-5, 4); ctx.lineTo(-5, -7); ctx.lineTo(5, -7); ctx.lineTo(5, 4);
      ctx.lineTo(14, 4); ctx.lineTo(14, 13); ctx.lineTo(5, 13); ctx.lineTo(5, 23);
      ctx.closePath(); paint();
      ctx.beginPath(); ctx.ellipse(0, 30, 25, 8, 0, 0, Math.PI * 2); paint();
    }
  }

  // Shading, scoped to the piece: this offscreen canvas holds nothing else, so
  // source-atop touches only the silhouette. Light comes from the upper left.
  ctx.globalCompositeOperation = 'source-atop';

  // form shading, gently graded so there is no hard highlight band
  const g = ctx.createLinearGradient(-38, -6, 34, 86);
  g.addColorStop(0.00, `rgba(255,255,255,${hiA})`);
  g.addColorStop(0.22, `rgba(255,255,255,${(hiA * 0.45).toFixed(3)})`);
  g.addColorStop(0.44, 'rgba(255,255,255,0)');
  g.addColorStop(0.64, `rgba(0,0,0,${(loA * 0.32).toFixed(3)})`);
  g.addColorStop(1.00, `rgba(0,0,0,${loA})`);
  ctx.fillStyle = g;
  ctx.fillRect(-60, -10, 120, 120);

  // one soft specular, so the plastic reads as round rather than printed flat
  const spec = ctx.createRadialGradient(-13, 24, 1, -13, 24, 34);
  spec.addColorStop(0, `rgba(255,255,255,${light ? 0.34 : 0.20})`);
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(-60, -10, 120, 120);

  // ambient occlusion where the piece meets the board
  const ao = ctx.createLinearGradient(0, 74, 0, 93);
  ao.addColorStop(0, 'rgba(0,0,0,0)');
  ao.addColorStop(1, 'rgba(0,0,0,0.30)');
  ctx.fillStyle = ao;
  ctx.fillRect(-60, 70, 120, 25);

  // Contact shadow goes behind everything already drawn.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.filter = `blur(${3}px)`;
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.beginPath(); ctx.ellipse(1, 92, 29, 7.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.filter = 'none';

  return c;
}

function pieceSprite(type, color) {
  const key = type * 2 + color;
  let s = spriteCache.get(key);
  if (!s) { s = buildSprite(type, color); spriteCache.set(key, s); }
  return s;
}

/* Blit a piece standing on the square centred at (x, y).

   PIECE_H is the piece height as a fraction of the square, and BASE_DROP sits
   its footprint just below the square centre so it looks planted rather than
   floating. The authored box is 100 units tall inside a 120-unit sprite. */
const PIECE_H = 0.90;
const BASE_DROP = 0.30;

function drawPiece(ctx, type, color, x, y, size, opts = {}) {
  const s = pieceSprite(type, color);
  const k = PIECE_H * size / 100;          // authored units -> px
  const span = SPRITE_UNITS * k;
  const alpha = opts.alpha ?? 1;
  if (alpha !== 1) { ctx.save(); ctx.globalAlpha = alpha; }
  ctx.drawImage(s, x - 60 * k, y + BASE_DROP * size - 102 * k, span, span);
  if (alpha !== 1) ctx.restore();
}
