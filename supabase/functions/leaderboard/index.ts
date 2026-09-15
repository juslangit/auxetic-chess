// The one thing that writes to the leaderboard.
//
//   POST { action: "check", name, pin }                      -> claim a name, or check its PIN
//   POST { action: "win",   name, pin, level, side, moves }  -> replay the game; save it if it is a real win
//
// Reading the leaderboard does not come through here: the browser reads the
// `standings` table directly with the public key.
//
// `engine.js` is generated from the game's own js/chess.js, js/leaderboard.js
// and server/replay.js by tools/build_function.js, so the server plays by
// exactly the rules the browser does. Never edit it by hand.

import engine from "./engine.js";

const { replayWin, cleanName } = engine;

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { status: "error", reason: "POST only" });

  let body: any;
  try {
    const text = await req.text();
    if (text.length > 20000) return reply(413, { status: "error", reason: "too large" });
    body = JSON.parse(text);
  } catch {
    return reply(400, { status: "error", reason: "not JSON" });
  }

  const name = cleanName(body?.name);
  const pin = String(body?.pin ?? "");
  if (!name) return reply(400, { status: "error", reason: "a name is needed" });
  if (!/^[0-9]{4}$/.test(pin)) return reply(400, { status: "bad-pin" });

  try {
    const player = await rpc("check_player", { p_name: name, p_pin: pin });

    if (body.action === "check") return reply(200, player);

    if (body.action === "win") {
      if (player.status !== "ok" && player.status !== "claimed") return reply(200, player);
      const level = body.level, side = body.side;
      if (![0, 1, 2, 3].includes(level)) return reply(400, { status: "error", reason: "bad level" });

      const check = replayWin({ moves: body.moves, side });
      if (!check.ok) return reply(200, { status: "rejected", reason: check.reason });

      const saved = await rpc("record_win", {
        p_player: player.id, p_level: level, p_side: side,
        p_moves: body.moves.join(" "), p_plies: check.plies,
      });
      return reply(200, saved);
    }

    return reply(400, { status: "error", reason: "unknown action" });
  } catch (e) {
    console.error(e);
    return reply(500, { status: "error", reason: "server error" });
  }
});
