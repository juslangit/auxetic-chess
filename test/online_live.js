/* The real, deployed leaderboard, tested from outside the way a stranger would
   see it. Not part of run.sh: it needs the internet and a deployed project.

     node test/online_live.js

   It uses throwaway names starting "zz-live-" and deletes them at the end
   (through the management API, with SUPABASE_ACCESS_TOKEN from ~/.claude/.env),
   so the public board is left as it was. */
const fs = require('fs'), path = require('path');
const H = __dirname + '/../js/', S = __dirname + '/../server/';
const { seed } = require('./repeatable.js');

const ONLINE = new Function(fs.readFileSync(H + 'config.js', 'utf8') + '\n; return ONLINE;')();
if (!ONLINE.url) { console.error('js/config.js is empty: run tools/deploy_online.sh first'); process.exit(1); }
const env = Object.fromEntries(fs.readFileSync(path.join(process.env.HOME, '.claude/.env'), 'utf8')
  .split('\n').filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]));
const REF = new URL(ONLINE.url).hostname.split('.')[0];

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(56)}${extra}`); };

const E = new Function(fs.readFileSync(H + 'chess.js', 'utf8') + '\n' + fs.readFileSync(H + 'ai.js', 'utf8') + '\n' +
  fs.readFileSync(S + 'replay.js', 'utf8') + '\n; return {Chess, AI, encodeMove, WHITE};')();
seed(7);
function whiteMates() {
  for (let t = 0; t < 30; t++) {
    const g = new E.Chess(); g.twist = true; g.stopsPerGame = 3; g.reset();
    const w = new E.AI(g), b = new E.AI(g), moves = [];
    let over = null;
    while (moves.length < 300 && !(over = g.gameOver())) {
      const r = g.turn === E.WHITE ? w.think(1) : b.think(0);
      moves.push(E.encodeMove(r.move)); g.make(r.move); g.pushRepetition();
    }
    if (over && over.type === 'checkmate' && over.winner === E.WHITE) return moves;
  }
  throw new Error('no White mate found');
}

const pub = { apikey: ONLINE.key, 'Content-Type': 'application/json' };
const rest = (p, opts = {}) => fetch(ONLINE.url + p, { ...opts, headers: { ...pub, ...(opts.headers || {}) } });
const fn = async (body) => {
  const r = await fetch(ONLINE.url + '/functions/v1/leaderboard', { method: 'POST', headers: pub, body: JSON.stringify(body) });
  return { http: r.status, ...(await r.json().catch(() => ({}))) };
};
const sqlAdmin = (query) => fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }) }).then((r) => r.json());

(async () => {
  const tag = 'zz-live-' + Math.random().toString(36).slice(2, 6);
  const me = tag + 'a', other = tag + 'b';
  try {
    console.log('--- what the public key can and cannot do ---');
    const read = await rest('/rest/v1/standings?select=name,wins&level=eq.0&limit=3');
    ok(read.status === 200 && Array.isArray(await read.json()), 'anyone can read the standings');

    const players = await rest('/rest/v1/players?select=*');
    const pbody = await players.json().catch(() => null);
    ok(!(Array.isArray(pbody) && pbody.length), 'nobody can read players (the PIN hashes)', `${players.status} ${JSON.stringify(pbody).slice(0, 60)}`);
    const wins = await rest('/rest/v1/wins?select=*');
    const wbody = await wins.json().catch(() => null);
    ok(!(Array.isArray(wbody) && wbody.length), 'nobody can read wins', `${wins.status}`);

    const forge = await rest('/rest/v1/standings', { method: 'POST', body: JSON.stringify({ player_id: 1, level: 0, name: 'hacker', wins: 999, reached_at: new Date().toISOString() }) });
    ok(forge.status >= 400, 'nobody can write a standing directly', `${forge.status}`);
    const rpc = await rest('/rest/v1/rpc/check_player', { method: 'POST', body: JSON.stringify({ p_name: me, p_pin: '1234' }) });
    ok(rpc.status >= 400, 'nobody can call the database functions directly', `${rpc.status}`);
    const rpc2 = await rest('/rest/v1/rpc/record_win', { method: 'POST', body: JSON.stringify({ p_player: 1, p_level: 0, p_side: 0, p_moves: 'x', p_plies: 1 }) });
    ok(rpc2.status >= 400, 'including the one that records a win', `${rpc2.status}`);

    console.log('\n--- names and PINs ---');
    let r = await fn({ action: 'check', name: me, pin: '1234' });
    ok(r.status === 'claimed' && r.name === me, 'a free name is claimed', r.status);
    r = await fn({ action: 'check', name: me.toUpperCase(), pin: '1234' });
    ok(r.status === 'ok' && r.name === me, 'the same name in capitals is the same player', `${r.status} ${r.name}`);
    r = await fn({ action: 'check', name: me, pin: '9999' });
    ok(r.status === 'wrong-pin' && r.tries_left === 4, 'a wrong PIN says how many tries are left', `${r.status} ${r.tries_left}`);
    r = await fn({ action: 'check', name: me, pin: '1234' });
    ok(r.status === 'ok', 'the right PIN resets the count');
    r = await fn({ action: 'check', name: me, pin: '12' });
    ok(r.status === 'bad-pin', 'a PIN that is not 4 digits is refused', `${r.http} ${r.status}`);

    await fn({ action: 'check', name: other, pin: '1111' });
    for (let i = 0; i < 4; i++) await fn({ action: 'check', name: other, pin: '0000' });
    r = await fn({ action: 'check', name: other, pin: '0000' });
    ok(r.status === 'locked', 'five wrong PINs lock the name', r.status);
    r = await fn({ action: 'check', name: other, pin: '1111' });
    ok(r.status === 'locked', 'the right PIN is refused while locked', r.status);
    const hash = await sqlAdmin(`select pin_hash from public.players where name = '${me}'`);
    ok(Array.isArray(hash) && /^\$2[aby]\$/.test(hash[0].pin_hash) && !hash[0].pin_hash.includes('1234'), 'PINs are stored hashed (bcrypt)', hash[0] && hash[0].pin_hash.slice(0, 7) + '...');

    console.log('\n--- wins ---');
    const WIN = whiteMates();
    r = await fn({ action: 'win', name: me, pin: '1234', level: 0, side: 0, moves: WIN });
    ok(r.status === 'saved' && r.wins === 1, 'a real win is replayed and saved', `${WIN.length} plies, ${r.status}, #${r.rank}`);
    const board = await (await rest(`/rest/v1/standings?select=name,wins&level=eq.0&name=eq.${me}`)).json();
    ok(board.length === 1 && board[0].wins === 1, 'and appears on the public standings');
    r = await fn({ action: 'win', name: me, pin: '1234', level: 0, side: 0, moves: WIN });
    ok(r.status === 'duplicate', 'the same game again is not counted', r.status);
    r = await fn({ action: 'win', name: me, pin: '1234', level: 1, side: 1, moves: WIN });
    ok(r.status === 'rejected', 'claiming it for the losing side is refused', r.reason);
    r = await fn({ action: 'win', name: me, pin: '1234', level: 0, side: 0, moves: WIN.slice(0, -1) });
    ok(r.status === 'rejected', 'a game cut short of mate is refused', r.reason);
    r = await fn({ action: 'win', name: me, pin: '9999', level: 0, side: 0, moves: WIN });
    ok(r.status === 'wrong-pin', 'a win with the wrong PIN is refused', r.status);
    r = await fn({ action: 'win', name: me, pin: '1234', level: 7, side: 0, moves: WIN });
    ok(r.status === 'error' && r.http === 400, 'a level that does not exist is refused', r.reason);
    const huge = await fetch(ONLINE.url + '/functions/v1/leaderboard', { method: 'POST', headers: pub,
      body: JSON.stringify({ action: 'win', name: me, pin: '1234', level: 0, side: 0, moves: new Array(5000).fill('e2e4') }) });
    ok(huge.status === 413, 'an oversized request is refused', `${huge.status}`);
  } finally {
    const gone = await sqlAdmin(`delete from public.players where name like 'zz-live-%' returning name`);
    console.log(`\ncleaned up ${Array.isArray(gone) ? gone.length : '?'} test players`);
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
