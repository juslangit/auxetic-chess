const { launch, Session, sleep } = require('./cdp.js');
const fs = require('fs');

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(3200);
  fs.mkdirSync(__dirname + '/shots', { recursive: true });

  const errs = () => s.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
                             .map(e => e.params.entry.text);

  // --- colour convention: a1 dark, h1 light, and the 4x4 tiling is uniform ---
  const colours = await s.eval(`(() => {
    const name = i => 'abcdefgh'[i & 7] + ((i >> 4) + 1);
    const isLight = i => ((i & 7) + (i >> 4)) % 2 === 1;
    return JSON.stringify({
      a1: isLight(0) ? 'light' : 'dark',
      h1: isLight(7) ? 'light' : 'dark',
      a8: isLight(0x70) ? 'light' : 'dark',
      h8: isLight(0x77) ? 'light' : 'dark',
      // every tile must carry the identical 2x2 patch -- that is why one print does 16
      allTilesIdentical: (() => {
        const pat = t => [0,1,2,3].map(k => isLight(((t>>2)*2 + (k>>1))*16 + (t&3)*2 + (k&1)) ? 'L':'D').join('');
        const first = pat(0);
        return [...Array(16).keys()].every(t => pat(t) === first) ? first : 'MISMATCH';
      })(),
    });
  })()`);
  console.log('board colours:', colours);

  // --- the fold is genuine kinematics: hinges must stay joined at every angle ---
  const hinge = await s.eval(`(() => {
    const worst = [];
    for (const deg of [0,-10,-22.5,-35,-45]) {
      view.setThetaManual(deg * Math.PI/180);
      let maxGap = 0;
      const corners = (ii,jj) => {
        const t = view.tileTransform(ii,jj), R = t.a/Math.SQRT2;
        return [0,1,2,3].map(k => { const a=(45+90*k)*Math.PI/180 + t.rot;
          return [t.cx + R*Math.cos(a), t.cy + R*Math.sin(a)]; });
      };
      for (let j=0;j<4;j++) for (let i=0;i<4;i++) for (const [di,dj] of [[1,0],[0,1]]) {
        if (i+di>3 || j+dj>3) continue;
        const A = corners(i,j), B = corners(i+di,j+dj);
        let best = Infinity;
        for (const p of A) for (const q of B) best = Math.min(best, Math.hypot(p[0]-q[0], p[1]-q[1]));
        maxGap = Math.max(maxGap, best);
      }
      worst.push(deg + 'deg:' + maxGap.toExponential(1) + 'px');
    }
    view.setThetaManual(0);
    return worst.join('  ');
  })()`);
  console.log('hinge gaps on screen:', hinge);

  // --- screenshots across the fold ---
  const stageBox = await s.eval(`JSON.stringify((()=>{const r=document.querySelector('.stage').getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height};})())`);
  const clip = JSON.parse(stageBox);

  for (const [deg, tag] of [[0,'solid'], [-15,'fold15'], [-30,'fold30'], [-45,'bloom']]) {
    await s.eval(`view.setThetaManual(${deg} * Math.PI/180)`);
    await sleep(220);
    await s.shot(`${__dirname}/shots/fold-${tag}.png`, clip);
  }
  await s.eval(`view.setThetaManual(0)`);
  await sleep(150);

  // --- actually play: click e2 then e4 ---
  const sqCentre = await s.eval(`(() => {
    const r = document.getElementById('board').getBoundingClientRect();
    const f = n => { const L = view.squareLayout(n); return [r.x + L.x, r.y + L.y]; };
    const idx = n => ('abcdefgh'.indexOf(n[0])) + (+n[1]-1)*16;
    return JSON.stringify({ e2: f(idx('e2')), e4: f(idx('e4')), g1: f(idx('g1')), f3: f(idx('f3')) });
  })()`);
  const P = JSON.parse(sqCentre);

  await s.click(...P.e2); await sleep(200);
  const sel = await s.eval(`JSON.stringify({selected: view.selected, targets: view.legalTargets.length})`);
  console.log('after clicking e2:', sel);
  await s.shot(`${__dirname}/shots/selected.png`, clip);

  await s.click(...P.e4); await sleep(300);
  await s.shot(`${__dirname}/shots/after-e4.png`, clip);

  // let the AI reply
  await sleep(3500);
  const afterAI = await s.eval(`JSON.stringify({
    log: game.moveLog.map(m=>m.san), turn: game.turn,
    status: document.getElementById('status').textContent,
    detail: document.getElementById('detail').textContent })`);
  console.log('after AI reply:', afterAI);
  await s.shot(`${__dirname}/shots/after-ai.png`, clip);
  await s.shot(`${__dirname}/shots/full-page.png`);

  console.log('console errors:', errs().length ? errs() : 'none');
  await s.close();
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
