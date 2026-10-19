-- Étape 1 : structure de la base (déjà exécutée dans Supabase > SQL Editor).
-- Conservée ici pour mémoire.

-- Table des traces
create table public.traces (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text,
  pilot_name text,
  file_format text not null check (file_format in ('gpx','fit','kml','igc')),
  file_path text not null,
  original_name text,
  file_size_bytes integer,
  activity_date timestamptz,
  duration_s integer,
  distance_m real,
  max_alt_m real,
  min_alt_m real,
  start_lat double precision,
  start_lon double precision,
  track_geojson jsonb,
  consent_public boolean not null check (consent_public),
  hidden boolean not null default false
);

create index traces_created_idx on public.traces (created_at desc);

-- Sécurité : tout le monde peut LIRE les traces non masquées,
-- personne ne peut écrire directement (les envois passent par la fonction submit-trace).
alter table public.traces enable row level security;

create policy "Lecture publique des traces visibles"
  on public.traces for select
  to anon, authenticated
  using (hidden = false);

-- Stockage privé des fichiers d'origine (max 20 Mo par fichier)
insert into storage.buckets (id, name, public, file_size_limit)
values ('trace-files', 'trace-files', false, 20971520)
on conflict (id) do nothing;
