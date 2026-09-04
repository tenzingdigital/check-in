-- 019: reports are logged — Stage 4 of docs/PRODUCT-ROADMAP.md.
--
-- The register, attendance, movements, occupancy, the evacuation list and
-- the drill record can be downloaded as CSV or shown as a printable page
-- for an inspection. Nothing new is held; what is new is that each export
-- is on the record, like a resident export: who, which report, what range,
-- and the reason they gave. Supervisors and admins may export.

create or replace function public.note_report(p_report text, p_reason text, p_from date default null, p_to date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin may export a report' using errcode = '42501';
  end if;
  if length(coalesce(btrim(p_reason), '')) = 0 then
    raise exception 'A reason for the export is required' using errcode = '22023';
  end if;
  insert into public.admin_audit (actor_id, table_name, row_id, action, note)
  values (auth.uid(), 'reports', p_report,
          'export',
          btrim(p_reason) || case when p_from is not null then ' [' || p_from::text || ' to ' || coalesce(p_to, p_from)::text || ']' else '' end);
end;
$$;
revoke all on function public.note_report(text, text, date, date) from public, anon;
grant execute on function public.note_report(text, text, date, date) to authenticated;
