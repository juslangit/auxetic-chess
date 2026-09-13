// Rotating-squares auxetic mechanism.
// 4x4 grid of rigid square tiles, side a, hinged at shared corners.
// Tile (i,j) rotates by s*theta where s = +1 on "even" tiles, -1 on odd.
// Claim: the mechanism stays closed iff centre pitch d = a*sqrt(2)*cos(45deg + theta).
// Verify numerically that every shared corner of every neighbour pair coincides.

const a = 1, R = a / Math.SQRT2, D = Math.PI / 180;

function corners(i, j, theta, d) {
  const s = ((i + j) % 2 === 0) ? 1 : -1;
  const cx = (i + 0.5) * d, cy = (j + 0.5) * d;
  const out = [];
  for (let k = 0; k < 4; k++) {
    const ang = (45 + 90 * k) * D + s * theta;
    out.push([cx + R * Math.cos(ang), cy + R * Math.sin(ang)]);
  }
  return out;
}

let worst = 0;
for (const deg of [-45, -40, -30, -22.5, -10, 0, 10, 22.5, 30, 40]) {
  const theta = deg * D;
  const d = a * Math.SQRT2 * Math.cos(45 * D + theta);
  let maxGap = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const ni = i + di, nj = j + dj;
      if (ni > 3 || nj > 3) continue;
      const A = corners(i, j, theta, d), B = corners(ni, nj, theta, d);
      // nearest corner pair between the two tiles must be coincident
      let best = Infinity;
      for (const p of A) for (const q of B) {
        best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
      }
      maxGap = Math.max(maxGap, best);
    }
  }
  worst = Math.max(worst, maxGap);
  const extent = 4 * d;
  console.log(
    `theta ${String(deg).padStart(6)}deg   pitch d=${d.toFixed(4)}a   ` +
    `extent=${extent.toFixed(3)}a   max hinge gap=${maxGap.toExponential(2)}`
  );
}
console.log('\nworst gap across all states:', worst.toExponential(2),
            worst < 1e-12 ? '-> mechanism is exact' : '-> BROKEN');
