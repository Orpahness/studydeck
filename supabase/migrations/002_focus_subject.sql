-- "Studying now" subject picked on the dashboard
alter table public.profiles add column if not exists focus_folder_id uuid references public.folders (id) on delete set null;
create index if not exists profiles_focus_folder_id_idx on public.profiles (focus_folder_id);
