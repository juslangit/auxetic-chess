-- The shared leaderboard.
--
-- Three tables. Only `standings` can be read from a browser. `players` (which
-- holds the hashed PINs) and `wins` (which holds every game's moves) have row
-- level security switched on and no policies at all, so the public key can
-- neither read nor write them. The only way in is the two functions below, and
-- those can only be called with the server's key -- from the edge function,
-- after it has replayed the game.

create extension if not exists pgcrypto with schema extensions;

create table public.players (
  id              bigint generated always as identity primary key,
  name            text not null check (char_length(name) between 1 and 16),
  name_key        text generated always as (lower(name)) stored unique,
  pin_hash        text not null,
  failed_attempts int  not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table public.wins (
  id          bigint generated always as identity primary key,
  player_id   bigint   not null references public.players (id) on delete cascade,
  level       smallint not null check (level between 0 and 3),
  side        smallint not null check (side in (0, 1)),
  plies       int      not null,
  moves       text     not null,
  moves_hash  text     not null,
  created_at  timestamptz not null default now(),
  -- The same winning game counts once per player per level. Strong and Brutal
  -- play the same reply to the same moves, so a memorised win could otherwise
  -- be replayed for a point every time.
  unique (player_id, level, moves_hash)
);

create table public.standings (
  player_id  bigint   not null references public.players (id) on delete cascade,
  level      smallint not null check (level between 0 and 3),
  name       text     not null,
  wins       int      not null default 0,
  reached_at timestamptz not null,      -- when they reached their current count: breaks ties
  primary key (player_id, level)
);
create index standings_rank on public.standings (level, wins desc, reached_at asc);

alter table public.players   enable row level security;
alter table public.wins      enable row level security;
alter table public.standings enable row level security;

create policy "anyone can read the standings" on public.standings
  for select to anon, authenticated using (true);


-- check_player: claims a name that is free, or checks the PIN for one that is
-- taken. Five wrong PINs lock the name for 15 minutes, which puts guessing all
-- 10,000 PINs out of reach.
create function public.check_player(p_name text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r public.players;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('status', 'bad-pin');
  end if;

  insert into public.players (name, pin_hash)
  values (p_name, crypt(p_pin, gen_salt('bf')))
  on conflict (name_key) do nothing
  returning * into r;
  if found then
    return jsonb_build_object('status', 'claimed', 'id', r.id, 'name', r.name);
  end if;

  select * into r from public.players where name_key = lower(p_name) for update;

  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('status', 'locked', 'until', r.locked_until);
  end if;

  if r.pin_hash = crypt(p_pin, r.pin_hash) then
    update public.players set failed_attempts = 0, locked_until = null where id = r.id;
    return jsonb_build_object('status', 'ok', 'id', r.id, 'name', r.name);
  end if;

  if r.failed_attempts + 1 >= 5 then
    update public.players
       set failed_attempts = 0, locked_until = now() + interval '15 minutes'
     where id = r.id;
    return jsonb_build_object('status', 'locked', 'until', now() + interval '15 minutes');
  end if;
  update public.players set failed_attempts = failed_attempts + 1 where id = r.id;
  return jsonb_build_object('status', 'wrong-pin', 'tries_left', 4 - r.failed_attempts);
end;
$$;


-- record_win: stores a win the edge function has already replayed, and moves
-- the player up the level's standings. Returns their total and rank.
create function public.record_win(p_player bigint, p_level int, p_side int, p_moves text, p_plies int)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
  v_wins int;
  v_at   timestamptz;
  v_rank int;
begin
  select name into v_name from public.players where id = p_player;
  if v_name is null then
    return jsonb_build_object('status', 'no-player');
  end if;

  insert into public.wins (player_id, level, side, plies, moves, moves_hash)
  values (p_player, p_level, p_side, p_plies, p_moves, encode(digest(p_moves, 'sha256'), 'hex'))
  on conflict (player_id, level, moves_hash) do nothing;
  if not found then
    return jsonb_build_object('status', 'duplicate');
  end if;

  insert into public.standings as s (player_id, level, name, wins, reached_at)
  values (p_player, p_level, v_name, 1, now())
  on conflict (player_id, level)
  do update set wins = s.wins + 1, reached_at = now(), name = excluded.name
  returning wins, reached_at into v_wins, v_at;

  select count(*) + 1 into v_rank
    from public.standings
   where level = p_level
     and (wins > v_wins or (wins = v_wins and reached_at < v_at));

  return jsonb_build_object('status', 'saved', 'name', v_name, 'wins', v_wins, 'rank', v_rank);
end;
$$;

-- Postgres lets everyone run a new function by default, and Supabase exposes
-- public functions over the API. Only the server may run these two.
revoke all on function public.check_player(text, text) from public, anon, authenticated;
revoke all on function public.record_win(bigint, int, int, text, int) from public, anon, authenticated;
grant execute on function public.check_player(text, text) to service_role;
grant execute on function public.record_win(bigint, int, int, text, int) to service_role;
