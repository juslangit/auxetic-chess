#!/bin/sh
# Puts the shared leaderboard online, or updates it.
#
#   1. finds the Supabase project named "Auxetic Chess"
#   2. sets up the database the first time (supabase/migrations)
#   3. rebuilds and deploys the server function that checks wins
#   4. writes the project's address and publishable key into js/config.js
#
# Safe to run again: the database step is skipped once the tables exist.
# Needs SUPABASE_ACCESS_TOKEN in ~/.claude/.env and the supabase CLI.
set -e
cd "$(dirname "$0")/.."

set -a; . "$HOME/.claude/.env"; set +a
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is not set in ~/.claude/.env}"
API=https://api.supabase.com/v1
auth="Authorization: Bearer $SUPABASE_ACCESS_TOKEN"

REF=$(curl -sf -H "$auth" "$API/projects" |
  python3 -c "import sys, json; print(next((p['ref'] for p in json.load(sys.stdin) if p['name'] == 'Auxetic Chess'), ''))")
[ -n "$REF" ] || { echo "No Supabase project named \"Auxetic Chess\" yet."; exit 1; }
echo "project: $REF"

sql() {   # runs one SQL text through the management API, prints the JSON result
  python3 -c "import json, sys; print(json.dumps({'query': sys.stdin.read()}))" |
    curl -sf -X POST -H "$auth" -H "Content-Type: application/json" --data-binary @- "$API/projects/$REF/database/query"
}

if echo "select to_regclass('public.players') is not null as ready;" | sql | grep -q '"ready":true'; then
  echo "database: already set up"
else
  for f in supabase/migrations/*.sql; do
    echo "database: applying $f"
    sql < "$f" > /dev/null
  done
fi

node tools/build_function.js
supabase functions deploy leaderboard --project-ref "$REF" --no-verify-jwt --use-api

# The publishable key is the one meant for a public page; fall back to the legacy anon key.
KEY=$(curl -sf -H "$auth" "$API/projects/$REF/api-keys" | python3 -c "
import sys, json
keys = json.load(sys.stdin)
pick = next((k for k in keys if k.get('type') == 'publishable'), None) or next((k for k in keys if k.get('name') == 'anon'), None)
print(pick['api_key'] if pick else '')")
[ -n "$KEY" ] || { echo "Could not read the project's publishable key."; exit 1; }

python3 - "$REF" "$KEY" <<'EOF'
import re, sys
ref, key = sys.argv[1], sys.argv[2]
path = 'js/config.js'
src = open(path).read()
src = re.sub(r"url: '[^']*'", f"url: 'https://{ref}.supabase.co'", src)
src = re.sub(r"key: '[^']*'", f"key: '{key}'", src)
open(path, 'w').write(src)
print('config: js/config.js points at', f'https://{ref}.supabase.co')
EOF
