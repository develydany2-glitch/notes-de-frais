-- À coller dans Supabase › SQL Editor › New query, puis « Run ».
-- Crée la table des notes, l'espace de stockage des photos, et limite l'accès à votre seul compte.

create table if not exists public.expenses (
  id            text primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date          date not null,
  category      text,
  amount        numeric(10,2),
  place         text,
  note          text,
  status        text not null default 'a_declarer',
  reimbursed_on date,
  has_photo     boolean not null default false,
  photo_path    text,
  created_at    timestamptz,
  updated_at    timestamptz not null,
  deleted       boolean not null default false
);
alter table public.expenses add column if not exists photos jsonb;
alter table public.expenses add column if not exists month text;
alter table public.expenses add column if not exists verified boolean;
create index if not exists expenses_user_updated on public.expenses (user_id, updated_at);

alter table public.expenses enable row level security;

drop policy if exists "mes notes - lecture" on public.expenses;
drop policy if exists "mes notes - ajout" on public.expenses;
drop policy if exists "mes notes - modif" on public.expenses;
create policy "mes notes - lecture" on public.expenses for select to authenticated using (user_id = auth.uid());
create policy "mes notes - ajout"   on public.expenses for insert to authenticated with check (user_id = auth.uid());
create policy "mes notes - modif"   on public.expenses for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Photos des tickets (espace privé)
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "mes photos - lecture" on storage.objects;
drop policy if exists "mes photos - ajout" on storage.objects;
drop policy if exists "mes photos - modif" on storage.objects;
drop policy if exists "mes photos - suppr" on storage.objects;
create policy "mes photos - lecture" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mes photos - ajout" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mes photos - modif" on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mes photos - suppr" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

-- Déplacements (planning par journée) — ajouté en version 1.5
create table if not exists public.trips (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null,
  deleted    boolean not null default false
);
alter table public.trips enable row level security;
drop policy if exists "mes deplacements" on public.trips;
create policy "mes deplacements" on public.trips for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
