/* The leaderboard client on its own, with a fake network: what it asks for,
   what it sends, and how it reports trouble. Nothing here touches the internet. */
const { OnlineLeaderboard, cleanName } = require('../js/leaderboard.js');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(56)}${extra}`); };

// A stand-in for fetch that records each call and answers from `reply`.
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const r = await reply(url, opts);
    if (r instanceof Error) throw r;
    return { status: r.status || 200, json: async () => { if (r.body === undefined) throw new Error('no json'); return r.body; } };
  };
  fn.calls = calls;
  return fn;
}
const CONFIG = { url: 'https://example.supabase.co/', key: 'sb_publishable_test' };

(async () => {
  // ---- reading ----
  {
    const f = fakeFetch(() => ({ body: [{ name: 'Luqman', wins: 3 }, { name: 'Aiman', wins: 1 }] }));
    const lb = new OnlineLeaderboard(CONFIG, f);
    const rows = await lb.top(2);
    const c = f.calls[0];
    ok(rows.length === 2 && rows[0].name === 'Luqman', 'top() returns the rows it is sent');
    ok(c.url === 'https://example.supabase.co/rest/v1/standings?select=name,wins&level=eq.2&order=wins.desc,reached_at.asc&limit=10',
       'asks for one level, most wins first, ties by who got there first', c.url.replace('https://example.supabase.co', ''));
    ok(c.opts.headers.apikey === CONFIG.key && !c.opts.method, 'reads with the public key, a plain GET');
    await lb.top('2; drop table', 5);
    ok(/level=eq\.NaN&/.test(f.calls[1].url), 'a level that is not a number cannot be slipped into the query', f.calls[1].url.split('?')[1]);
  }

  // ---- writing goes to the server function, never to a table ----
  {
    const f = fakeFetch(() => ({ body: { status: 'saved', name: 'Luqman', wins: 4, rank: 1 } }));
    const lb = new OnlineLeaderboard(CONFIG, f);
    const r = await lb.submitWin({ name: '  Luqman ', pin: '1234', level: 3, side: 1, moves: ['e2e4', 'e7e5'] });
    const c = f.calls[0];
    ok(r.status === 'saved' && r.rank === 1, 'submitWin() returns the server\'s answer');
    ok(c.url.endsWith('/functions/v1/leaderboard') && c.opts.method === 'POST', 'a win is POSTed to the leaderboard function');
    ok(JSON.stringify(c.body) === JSON.stringify({ action: 'win', name: 'Luqman', pin: '1234', level: 3, side: 1, moves: ['e2e4', 'e7e5'] }),
       'it sends the cleaned name, PIN, level, side and moves');

    await lb.checkPlayer('Aiman', 42);
    ok(f.calls[1].body.action === 'check' && f.calls[1].body.pin === '42', 'checkPlayer() sends a check, PIN as text');
  }

  // ---- trouble ----
  {
    const bad = (reply) => new OnlineLeaderboard(CONFIG, fakeFetch(reply));
    const throws = async (p) => { try { await p; return false; } catch (_) { return true; } };

    ok(await throws(bad(() => new Error('network down')).top(0)), 'no network: throws, so the page can say "offline"');
    ok(await throws(bad(() => ({ status: 500, body: { status: 'error' } })).top(0)), 'a server error throws');
    ok(await throws(bad(() => ({ status: 200 })).top(0)), 'an answer that is not JSON throws');
    ok(await throws(bad(() => ({ body: { not: 'a list' } })).top(0)), 'a table read that is not a list throws');
    const pin = await bad(() => ({ status: 400, body: { status: 'bad-pin' } })).checkPlayer('A', 'x');
    ok(pin.status === 'bad-pin', 'a 400 with an answer is an answer, not an outage');

    const blank = new OnlineLeaderboard({});
    ok(!blank.configured && await throws(blank.top(0)), 'not configured: throws without trying the network');
  }

  // ---- names (the server uses this same function) ----
  ok(cleanName('  Hafiz   the \n great ') === 'Hafiz the great', 'spaces squashed, control characters dropped');
  ok(cleanName('abcdefghijklmnopqrstuvwxyz').length === 16, 'names capped at 16 characters');
  ok(cleanName('   ') === '' && cleanName(null) === '', 'a blank name is no name');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
