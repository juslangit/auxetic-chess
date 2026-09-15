/* Stop turning, played through the real UI: the button, the two stopped moves,
   the count, undo, and the computer respecting a stop. */
const { launch, Session, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(48)}${extra}`); };

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(3400);
  const errs = () => s.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
                             .map(e => e.params.entry.text);

  const origin = JSON.parse(await s.eval(`JSON.stringify((()=>{
    const r = document.getElementById('board').getBoundingClientRect(); return {x:r.x, y:r.y};})())`));
  const at = async (name) => {
    const p = JSON.parse(await s.eval(`JSON.stringify((()=>{
      const i = 'abcdefgh'.indexOf('${name}'[0]) + (${+name[1]} - 1) * 16;
      const L = view.squareLayout(i); return [L.x, L.y];})())`));
    return [origin.x + p[0], origin.y + p[1]];
  };
  const waitSolid = async () => {
    for (let i = 0; i < 80; i++) { if (await s.eval(`view.isSolid`)) return true; await sleep(100); }
    return false;
  };
  const play = async (from, to) => {
    await waitSolid();
    await s.click(...await at(from)); await sleep(130);
    await s.click(...await at(to));
    await sleep(150);
    await waitSolid();
  };
  const pressStop = async () => {
    const r = JSON.parse(await s.eval(`JSON.stringify((()=>{
      const b = document.getElementById('stop').getBoundingClientRect();
      return [b.x + b.width / 2, b.y + b.height / 2];})())`));
    await s.click(...r);
    await sleep(120);
  };
  const button = async () => JSON.parse(await s.eval(`JSON.stringify({
    disabled: ui.stop.disabled, armed: ui.stop.classList.contains('armed'),
    title: ui.stopTitle.textContent, sub: ui.stopSub.textContent,
    visible: getComputedStyle(ui.stop).display !== 'none' })`));
  const last = async () => JSON.parse(await s.eval(`JSON.stringify((()=>{
    const e = game.moveLog[game.moveLog.length - 1];
    return e ? { san: e.san, twisted: e.twisted, stopUsed: e.stopUsed, n: game.moveLog.length,
                 detail: ui.detail.textContent, quarters: view.twistAngle / (Math.PI / 2) } : null; })())`));

  // ---- two players ----
  await s.eval(`startGame({ level: 'hotseat' })`);
  await waitSolid();

  let B = await button();
  ok(B.visible && !B.disabled && B.title === 'Stop turning' && B.sub === 'White: 3 of 3 left',
     'button ready for White with 3 stops', `${B.title} | ${B.sub}`);

  await pressStop();
  B = await button();
  ok(B.armed && B.title === 'Stop is on', 'pressing it turns the stop on', B.sub);

  // White presses:  e4 (no turn)   ...e5 (no turn)   Nf3 (turns)
  await play('e2', 'e4');
  let L = await last();
  ok(L.san === 'e4' && L.stopUsed && !L.twisted && Math.abs(L.quarters) < 1e-6,
     'e4 with the stop: the board does not turn', `paint ${L.quarters.toFixed(3)} quarters`);
  ok(/White stopped the board/.test(L.detail), 'the status says who stopped it', L.detail);
  const marked = await s.eval(`document.querySelectorAll('#moves .stop-mark').length`);
  ok(marked === 1, 'the move list marks the stopped move', `${marked} mark`);

  B = await button();
  ok(B.disabled && B.title === 'Board stopped', 'Black cannot stop during White\'s stop', `${B.title} | ${B.sub}`);
  require('fs').mkdirSync(__dirname + '/shots', { recursive: true });
  await s.shot(__dirname + '/shots/stop-running.png');

  await play('e7', 'e5');
  L = await last();
  ok(L.san === 'e5' && !L.twisted && !L.stopUsed, '...e5: still no turn', L.detail);

  B = await button();
  ok(!B.disabled && !B.armed && B.sub === 'White: 2 of 3 left', 'White again, 2 stops left, not armed', B.sub);

  await play('g1', 'f3');
  L = await last();
  ok(L.san === 'Nf3' && L.twisted && Math.abs(L.quarters - 1) < 1e-6,
     'Nf3: the board turns again', `paint ${L.quarters.toFixed(3)} quarters`);

  B = await button();
  ok(!B.disabled && B.sub === 'Black: 3 of 3 left', 'Black still has all 3', B.sub);

  // ---- pressing twice takes it back ----
  await pressStop(); await pressStop();
  B = await button();
  ok(!B.armed && B.title === 'Stop turning', 'pressing again turns the stop off');
  const blackMove = JSON.parse(await s.eval(`JSON.stringify((()=>{
    const m = game.legalMoves().find(x => !(x.flags & F_STOP) && !(x.flags & F_CAPTURE));
    return [squareName(m.from), squareName(m.to)]; })())`));
  await play(...blackMove);
  L = await last();
  ok(L.twisted && !L.stopUsed, 'so the move turns the board as normal', L.san);

  // ---- undo gives the stop back ----
  for (let i = 0; i < 4; i++) {
    await s.eval(`document.getElementById('undo').click()`);
    await sleep(250);
  }
  const back = JSON.parse(await s.eval(`JSON.stringify({ n: game.moveLog.length, left: game.stopsLeft,
    sub: ui.stopSub.textContent, quarters: view.twistAngle / (Math.PI / 2) })`));
  ok(back.n === 0 && back.left[0] === 3 && back.left[1] === 3 && back.sub === 'White: 3 of 3 left' &&
     Math.abs(back.quarters) < 1e-6, 'undoing it all gives White the stop back',
     `${back.sub}, paint ${back.quarters.toFixed(3)}`);

  // ---- against the computer: it respects your stop ----
  await s.eval(`startGame({ level: 0, side: 'white', name: 'Tester' })`);
  await waitSolid();
  B = await button();
  ok(!B.disabled && B.sub === '3 of 3 left', 'against the computer: your count, no name', B.sub);
  await pressStop();
  await play('d2', 'd4');
  for (let i = 0; i < 60 && (await s.eval(`game.moveLog.length`)) < 2; i++) await sleep(150);
  await waitSolid();
  const reply = JSON.parse(await s.eval(`JSON.stringify(game.moveLog.map(e => ({ san: e.san, twisted: e.twisted, stop: e.stopUsed })))`));
  ok(reply.length === 2 && reply[0].stop && !reply[0].twisted && !reply[1].twisted && !reply[1].stop,
     'the computer\'s reply is not turned either', reply.map(e => e.san).join(' '));
  B = await button();
  ok(!B.disabled && B.sub === '2 of 3 left', 'your turn again, 2 left', B.sub);

  console.log('\nconsole errors:', errs().length ? errs() : 'none');
  console.log(`${pass} passed, ${fail} failed`);
  await s.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
