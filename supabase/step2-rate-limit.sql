-- Étape 2 : journal des envois (limites par connexion) et garde-fous sur la table « traces ».
-- À coller dans Supabase > SQL Editor > New query, puis Run.

create table if not exists public.submission_log (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists submission_log_ip_idx
  on public.submission_log (ip_hash, created_at desc);
create index if not exists submission_log_created_idx
  on public.submission_log (created_at desc);

-- Aucune règle d'accès : seule la fonction d'envoi (clé secrète) peut lire et écrire ce journal.
alter table public.submission_log enable row level security;

-- Garde-fous supplémentaires sur les traces
alter table public.traces
  add constraint traces_title_len check (title is null or char_length(title) <= 80),
  add constraint traces_pilot_len check (pilot_name is null or char_length(pilot_name) <= 60),
  add constraint traces_start_range check (
    start_lat is null or (start_lat between -90 and 90 and start_lon between -180 and 180)
  );
