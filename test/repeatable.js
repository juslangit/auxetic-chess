/* Makes an engine test give the same answer on every run.

   Two things used to make results differ from run to run:

   1. Chance. The tests play random games, and the casual and club levels pick
      at random among near-best moves (ai.js, `jitter`). `seed(n)` replaces
      Math.random with a fixed sequence, so every run plays the same games and
      the engine makes the same picks.

   2. The clock. `think` searches deeper until its time budget runs out, so a
      busy machine searches less deeply and can choose a different move.
      `fullDepth(fn)` stops the clock while `fn` runs, so every search goes to
      its level's full depth however loaded the machine is. Use it where a test
      checks *which move* the engine picks; leave it off where a test is about
      speed.

   The engine files are loaded with `new Function`, which shares this process's
   Math and Date, so both reach inside the engine without changing it. */

// mulberry32: a small, well-mixed 32-bit generator.
function seed(n) {
  let a = n >>> 0;
  Math.random = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fullDepth(fn) {
  const realNow = Date.now, frozen = realNow();
  Date.now = () => frozen;
  try { return fn(); } finally { Date.now = realNow; }
}

module.exports = { seed, fullDepth };
