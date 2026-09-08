-- 033: a note on the record when a drill or evacuation ends.
--
-- "Improve start-a-drill detail capture": what the fire safety record
-- wants beside the times and the count is a line about the event itself:
-- which alarm, the assembly point used, what went wrong. One short note,
-- about the drill, never about a person.
alter table public.roll_calls add column if not exists note text check (note is null or length(note) <= 200);
comment on column public.roll_calls.note is 'A line about the drill or evacuation itself, written when it ends. Not about any person.';

drop function if exists public.end_roll_call(uuid, timestamptz);
create or replace function public.end_roll_call(p_id uuid, p_at timestamptz default now(), p_note text default null)
returns public.roll_calls
language plpgsql security definer set search_path = public
as $$
declare v public.roll_calls;
begin
  if not public.is_staff() then raise exception 'Not authorised to end a roll call' using errcode = '42501'; end if;
  update public.roll_calls
     set ended_at = least(coalesce(p_at, now()), now()), ended_by = auth.uid(),
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note)
   where id = p_id and ended_at is null;
  select * into v from public.roll_calls where id = p_id;
  if v.id is null then raise exception 'No such roll call' using errcode = 'P0002'; end if;
  return v;
end;
$$;
revoke all on function public.end_roll_call(uuid, timestamptz, text) from public, anon;
grant execute on function public.end_roll_call(uuid, timestamptz, text) to authenticated;
