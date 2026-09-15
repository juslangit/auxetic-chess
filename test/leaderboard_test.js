/* The leaderboard on its own: ranking, names, one table per level, and what
   happens when the browser will not store anything. */
const { Leaderboard, cleanName } = require('../js/leaderboard.js');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(52)}${extra}`); };

// Stands in for localStorage.
const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

// ---- ranking ----
{
  const lb = new Leaderboard(fakeStorage());
  lb.addWin(2, 'Aiman', 1);
  lb.addWin(2, 'Luqman', 2);
  lb.addWin(2, 'Luqman', 3);
  const r = lb.top(2);
  ok(r.map((x) => `${x.name}:${x.wins}`).join(' ') === 'Luqman:2 Aiman:1', 'most wins first', r.map((x) => x.name).join(' '));

  const res = lb.addWin(2, 'Aiman', 4);
  ok(res.wins === 2 && res.rank === 2, 'equal wins: whoever got there first stays ahead', `Aiman #${res.rank}`);
}

// ---- names ----
{
  const lb = new Leaderboard(fakeStorage());
  lb.addWin(0, 'Luqman', 1);
  const res = lb.addWin(0, '  luqman ', 2);
  ok(lb.top(0).length === 1 && res.wins === 2 && res.name === 'Luqman', '"Luqman" and "luqman" are one player', `${res.name} ${res.wins}`);
  ok(cleanName('  Hafiz   the \n great ') === 'Hafiz the great', 'spaces squashed, control characters dropped');
  ok(cleanName('abcdefghijklmnopqrstuvwxyz').length === 16, 'names capped at 16 characters');
  ok(lb.addWin(0, '   ') === null && lb.top(0).length === 1, 'a blank name records nothing');
}

// ---- one table per level ----
{
  const lb = new Leaderboard(fakeStorage());
  lb.addWin(0, 'Aiman');
  lb.addWin(3, 'Luqman');
  ok(lb.top(0).map((x) => x.name).join() === 'Aiman' && lb.top(3).map((x) => x.name).join() === 'Luqman' &&
     lb.top(1).length === 0 && lb.top(2).length === 0, 'a win only counts on its own level');
  ok(lb.addWin('hotseat', 'Aiman') === null && lb.addWin(4, 'Aiman') === null, 'no table for two players or unknown levels');
}

// ---- saved, and read back by a fresh page ----
{
  const store = fakeStorage();
  new Leaderboard(store).addWin(1, 'Luqman');
  const again = new Leaderboard(store).top(1);
  ok(again.length === 1 && again[0].wins === 1, 'scores survive a reload');
}

// ---- top 10 ----
{
  const lb = new Leaderboard(fakeStorage());
  for (let i = 0; i < 14; i++) for (let w = 0; w <= i; w++) lb.addWin(2, `P${i}`, i * 100 + w);
  const t = lb.top(2);
  ok(t.length === 10 && t[0].name === 'P13' && t[9].name === 'P4', 'shows the top 10', `${t[0].name} .. ${t[9].name}`);
}

// ---- storage that fails ----
{
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const lb = new Leaderboard(broken);
  lb.addWin(2, 'Luqman');
  lb.addWin(2, 'Luqman');
  ok(lb.top(2).length === 1 && lb.top(2)[0].wins === 2, 'blocked storage: scores kept for the session');

  const junk = fakeStorage(); junk.setItem('auxetic-chess.leaderboard.v1', '{not json');
  ok(new Leaderboard(junk).top(2).length === 0, 'damaged saved data reads as empty, not a crash');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
