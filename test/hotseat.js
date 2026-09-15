/* Two-player mode, driven through the real UI: both sides accept clicks, the
   computer never moves, and one undo takes back one turn. */
const { launch, Session, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(44)}${extra}`); };

(async () => {
  await launch();
  const s = await Session.open('http://localhost:8765/index.html');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await sleep(1200);
  // Past the start screen, the way a player gets there.
  await s.eval(`startGame({ level: 2, side: 'white', name: 'Tester' })`);
  await sleep(2400);
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
    await waitSolid();
  };

  // ---- pick two players and start ----
  await s.eval(`document.getElementById('menu-btn').click()`);
  await s.eval(`document.getElementById('two-players').click()`);
  await sleep(2600);
  const started = await s.eval(`JSON.stringify({
    hotseat: hotseat(),
    menuGone: getComputedStyle(document.getElementById('menu')).display === 'none',
    card: document.getElementById('pc-name').textContent + ' | ' + document.getElementById('pc-rank').textContent,
    status: document.getElementById('status').textContent,
    turn: game.turn, twist: game.twist, flipped: view.flipped })`);
  const S = JSON.parse(started);
  ok(S.hotseat && S.menuGone && S.card === 'Two players | Not ranked',
     'Two players starts from the menu, unranked', S.card);
  ok(S.status === 'White to move' && S.turn === 0 && S.twist === true && S.flipped === false,
     'starts with White to move, twist on', S.status);

  // ---- White moves ----
  await play('e2', 'e4');
  const afterWhite = await s.eval(`JSON.stringify({
    log: game.moveLog.map(x => x.san), turn: game.turn,
    status: document.getElementById('status').textContent, thinking })`);
  const W = JSON.parse(afterWhite);
  ok(W.log.length === 1 && W.turn === 1 && W.status === 'Black to move' && !W.thinking,
     'White moves, then it is Black to move', `${W.log.join(' ')} | ${W.status}`);

  // ---- the computer must not take Black's turn ----
  await sleep(2600);
  const stillBlack = await s.eval(`JSON.stringify({
    log: game.moveLog.map(x => x.san), turn: game.turn, thinking })`);
  const B0 = JSON.parse(stillBlack);
  ok(B0.log.length === 1 && B0.turn === 1 && !B0.thinking,
     'the computer never moves for Black', `${B0.log.length} ply after waiting`);

  // ---- Black moves, from the same keyboard ----
  await play('e7', 'e5');
  const afterBlack = await s.eval(`JSON.stringify({
    log: game.moveLog.map(x => x.san), turn: game.turn,
    status: document.getElementById('status').textContent })`);
  const B = JSON.parse(afterBlack);
  ok(B.log.length === 2 && B.turn === 0 && B.status === 'White to move',
     'Black moves too, back to White', `${B.log.join(' ')} | ${B.status}`);

  // ---- undo takes back exactly one turn ----
  await s.eval(`document.getElementById('undo').click()`);
  await sleep(400);
  const undone = await s.eval(`JSON.stringify({
    log: game.moveLog.map(x => x.san), turn: game.turn,
    status: document.getElementById('status').textContent })`);
  const U = JSON.parse(undone);
  ok(U.log.length === 1 && U.turn === 1 && U.status === 'Black to move',
     'undo takes back one ply, not two', `${U.log.join(' ')} | ${U.status}`);

  // ---- the twist still runs for both sides ----
  const twists = await s.eval(`game.moveLog.filter(x => x.twisted).length`);
  ok(twists >= 1, 'the twist runs on a hotseat turn', `${twists} of ${U.log.length} twisted`);

  // ---- back to the computer from the menu: a fresh game, and it plays ----
  await s.eval(`startGame({ level: 0, side: 'white', name: 'Tester' })`);
  await sleep(2800);
  const back = await s.eval(`JSON.stringify({
    hotseat: hotseat(), card: document.getElementById('pc-meta').textContent,
    log: game.moveLog.length, turn: game.turn })`);
  const K = JSON.parse(back);
  ok(!K.hotseat && K.log === 0 && /Casual/.test(K.card), 'starting a computer game ends two players',
     `${K.card}, fresh game: ${K.log === 0}`);

  await play('d2', 'd4');
  for (let i = 0; i < 60 && (await s.eval(`game.moveLog.length`)) < 2; i++) await sleep(200);
  const replied = await s.eval(`JSON.stringify({ log: game.moveLog.map(x => x.san) })`);
  ok(JSON.parse(replied).log.length === 2, 'and the computer replies again',
     JSON.parse(replied).log.join(' '));

  console.log('\nconsole errors:', errs().length ? errs() : 'none');
  console.log(`${pass} passed, ${fail} failed`);
  await s.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
