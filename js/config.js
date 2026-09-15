/* Where the shared leaderboard lives.

   `key` is the Supabase project's *publishable* key. It is made to sit in a
   public web page: on its own it can only read the `standings` table, because
   row level security keeps every other table closed, and wins can only be
   written by the server function after it has replayed the game. The server's
   secret key is never in this repo.

   Left empty, the game still plays and says the leaderboard is not connected.
   tools/deploy_online.sh fills these in. */

const ONLINE = {
  url: '',
  key: '',
};
