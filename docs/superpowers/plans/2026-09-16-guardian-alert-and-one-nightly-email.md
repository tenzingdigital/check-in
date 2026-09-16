# Guardian alert, register conflict flag, one nightly email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At 22:00 site time the ticked managers get an email naming any household whose children are on site with no guardian on site and no supervision arrangement; the register flags a check-in recorded while the gate had that person out; the two existing nightly emails become one, with those two new counts alongside the old two.

**Architecture:** Migration 054 adds `overnight_guardian_gaps` + `snapshot_guardian_gaps(night)`, the view `v_checkin_conflicts`, `guardian_gaps_now()` (the named rows for the 22:00 email), `app_settings.nightly_email`, and two new unsubscribe kinds. `lib/guardianAlert.js` and `lib/nightlyEmail.js` compose the two messages (mirroring `lib/safeguardingAlert.js`). `jobs.js` gains an `evening` mode (cron `hut-evening`, 21:00 and 22:00 UTC, local-hour ≥ 22 gate, once a night) and its nightly mode replaces `notifyThresholds()` + `safeguardingNightly()` with `nightlyEmail()`. Two reports, a line on the register sheet, one Settings switch, copy.

**Tech Stack:** as piece A. Spec: `docs/superpowers/specs/2026-09-16-guardian-alert-and-one-nightly-email-design.md`. Piece A (on main) provides `v_household_care` (guardians/children on site, running arrangement) and `households`.

## Global Constraints

- **The 22:00 fact:** a household with `children_on_site > 0 and guardians_on_site = 0 and arrangement_id is null` in `v_household_care`. Nothing else.
- **The 22:00 email names people** (household label, room(s), children first name + age, off-site guardians full name + signed-out time); it goes to the staff ticked `safeguarding_alert`; footer: "This email names residents because it needs acting on tonight — treat it as you would the register itself."
- **The nightly email is counts and links only**, four sections in this order: Children on site without a guardian · Children away overnight without authorisation · Check-ins recorded while signed out · At the House Rules figures. Sent when any count > 0, and always on Sunday. Recipients: the `safeguarding_alert` tick. Job name `nightly-email`.
- **Conflict:** a `checkin_events` row whose latest `gate_events` row for that resident with `occurred_at <= checkin.occurred_at` is `out`, or none exists. Computed by a view; never stored, never undone.
- **Switches:** `feature_households` gates the guardian parts; `nightly_email` (054, default false, backfilled true where `notify_thresholds_email` is true or any profile has `safeguarding_alert`) gates both emails; `notify_thresholds_email` stays in the table, unread.
- **Retire nothing destructively:** old job names stop being written; old unsubscribe kinds map to `nightly`; the old Settings switch UI is replaced, the column kept.
- **Gates:** evening mode sends only when local hour ≥ 22, once per site date (`job_runs` guard matching `emailed$` with ≥1 delivered), `feature_households` on, `nightly_email` on, recipients present; `force` bypasses the hour gate only.
- **Copy:** plain sentences; the app states facts and never decides. Comments in the surrounding voice.
- **Migrations:** `public.` hard-coded; new columns looped into `t_*` (052 pattern); new tables NOT looped (053 ruling); `tenant/template.sql` regenerated; `docs/PERMISSIONS.md` regenerated.
- Before any task: `git fetch origin && git status -sb` — main clean at the named commit. Commit per task. Do NOT push. Do not run two `check.sh` at once.

---

### Task 1: Migration 054 — gaps table + snapshot, conflicts view, `guardian_gaps_now()`, switch, kinds; DB tests

**Files:**
- Create: `migrations/054_guardian_alert_and_conflicts.sql`
- Modify: `test/compliance.sql` (append block), `jobs.js` (`TENANT_JOBS`: purge), regenerate `tenant/template.sql`

**Interfaces (Produces):**
- `overnight_guardian_gaps (night date, household_id uuid, children_on_site int, guardians_out int, first_out_at timestamptz, recorded_at timestamptz, pk (night, household_id))`; `snapshot_guardian_gaps(p_night date) returns integer` (rows written; `on conflict do nothing`).
- `v_checkin_conflicts (checkin_id bigint, resident_id uuid, occurred_at timestamptz, guard_id uuid, source text, last_gate_kind text, last_gate_at timestamptz)`.
- `guardian_gaps_now() returns table (household_id uuid, household_label text, room_labels text, children text, guardians_out text, first_out_at timestamptz)` — supervisor/admin only; `children` = "Cormac (9)"; `guardians_out` = "Aoife Brennan (out since 19:40)".
- `app_settings.nightly_email boolean not null default false` (+ backfill).
- `email_opt_outs.kind` CHECK extended with `'guardian_alert', 'nightly'`; existing `'safeguarding_alert'`/`'house_rules'` rows copied to `'nightly'` (on conflict do nothing).
- `purge_guardian_gaps() returns integer` (register retention).

- [ ] **Step 1: Failing DB tests** — append to `test/compliance.sql` in the file's idiom (`\gset`, `set role authenticated; set request.jwt.claim.sub = …; reset role;`; supervisor `2222…`, guard `1111…`, kiosk `5555…`):

```sql
\echo ''
\echo '=========== 054: GUARDIAN GAPS AND CHECK-IN CONFLICTS ==========='
reset role;
-- Fixture: household P (adult Gia + child Gil), carer Gus outside it; gate events as the owner.
insert into public.households default values returning id as gap_hh \gset
insert into public.residents (first_name, last_name, date_of_birth, status, household_id)
  values ('Gia', 'Gapfixture', '1990-01-01', 'active', :'gap_hh') returning id as gap_parent \gset
insert into public.residents (first_name, last_name, date_of_birth, status, household_id)
  values ('Gil', 'Gapfixture', (current_date - interval '7 years')::date, 'active', :'gap_hh') returning id as gap_kid \gset
insert into public.residents (first_name, last_name, date_of_birth, status)
  values ('Gus', 'Gapcarer', '1980-01-01', 'active') returning id as gap_carer \gset
-- Everyone signs in, then the parent signs out at 19:40 site time today.
insert into public.gate_events (resident_id, guard_id, kind, occurred_at) values
  (:'gap_parent', '11111111-1111-1111-1111-111111111111', 'in',  now() - interval '6 hours'),
  (:'gap_kid',    '11111111-1111-1111-1111-111111111111', 'in',  now() - interval '6 hours'),
  (:'gap_carer',  '11111111-1111-1111-1111-111111111111', 'in',  now() - interval '6 hours'),
  (:'gap_parent', '11111111-1111-1111-1111-111111111111', 'out', now() - interval '2 hours');

select pg_temp.expect('054 view: children on site, no guardian', (select children_on_site from public.v_household_care where household_id = :'gap_hh'), 1);
select pg_temp.expect('054 view: guardians on site is zero', (select guardians_on_site from public.v_household_care where household_id = :'gap_hh'), 0);

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.expect('054 guardian_gaps_now names the household', (select count(*)::int from public.guardian_gaps_now() g where g.household_id = :'gap_hh'), 1);
select pg_temp.expect('054 guardian_gaps_now names the child with age', (select children from public.guardian_gaps_now() g where g.household_id = :'gap_hh'), 'Gil (7)');
select pg_temp.expect('054 guardian_gaps_now names the parent as out', (select guardians_out like 'Gia Gapfixture (out since %' from public.guardian_gaps_now() g where g.household_id = :'gap_hh'), true);
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('054 guard cannot call guardian_gaps_now', 'select * from public.guardian_gaps_now()');
reset role;

-- An arrangement covering the household removes it from the fact.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.record_supervision(:'gap_hh', :'gap_carer', now() - interval '3 hours', now() + interval '12 hours', true) as gap_arr \gset
select pg_temp.expect('054 covered household is not a gap', (select count(*)::int from public.guardian_gaps_now() g where g.household_id = :'gap_hh'), 0);
select public.end_supervision(:'gap_arr');
reset role;

-- Snapshot writes the gap for the night and nothing for a covered/attended household.
select pg_temp.expect('054 snapshot writes one row', public.snapshot_guardian_gaps(public.site_today()), 1);
select pg_temp.expect('054 snapshot row carries the counts', (select children_on_site from public.overnight_guardian_gaps where night = public.site_today() and household_id = :'gap_hh'), 1);
select pg_temp.expect('054 snapshot is idempotent', public.snapshot_guardian_gaps(public.site_today()), 0);

-- Conflicts: a check-in recorded after the parent signed out is a conflict; the carer's is not.
select public.record_checkin_at(:'gap_parent', '11111111-1111-1111-1111-111111111111', now() - interval '1 hour', null, 'desk') as gap_ci \gset
select public.record_checkin_at(:'gap_carer',  '11111111-1111-1111-1111-111111111111', now() - interval '1 hour', null, 'desk') as gap_ci2 \gset
select pg_temp.expect('054 conflict: check-in after an OUT', (select count(*)::int from public.v_checkin_conflicts c where c.resident_id = :'gap_parent'), 1);
select pg_temp.expect('054 conflict carries the gate fact', (select last_gate_kind from public.v_checkin_conflicts c where c.resident_id = :'gap_parent'), 'out');
select pg_temp.expect('054 no conflict when signed in', (select count(*)::int from public.v_checkin_conflicts c where c.resident_id = :'gap_carer'), 0);

-- The switch backfill and the kinds.
select pg_temp.expect('054 nightly_email column exists', (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'app_settings' and column_name = 'nightly_email'), 1);
insert into public.email_opt_outs (profile_id, kind) values ('22222222-2222-2222-2222-222222222222', 'guardian_alert');
select pg_temp.expect('054 guardian_alert is a kind', (select count(*)::int from public.email_opt_outs where kind = 'guardian_alert'), 1);
delete from public.email_opt_outs where kind = 'guardian_alert';
```

Check `record_checkin_at`'s real signature in migration 026 (`p_resident_id, p_guard_id, p_at, p_note, p_source`?) and adjust the two calls; keep the assertions.

- [ ] **Step 2: RED** — `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/sql.sh 2>&1 | tail -12` → fails at the first 054 line (`guardian_gaps_now` missing).

- [ ] **Step 3: Migration**

```sql
-- 054_guardian_alert_and_conflicts.sql — children on site with no guardian,
-- check-ins recorded while signed out, and one nightly email.
--
-- The incident of September 2026: a parent signed OUT at the gate in the
-- evening and did not come back; she had checked in earlier so the register
-- read "verified present"; her children were on site with nobody
-- responsible; nothing said so until Monday. House Rules 3.5.4 makes a
-- child left unsupervised a matter staff must report. This file holds the
-- two facts the app can state — a household with children on site and no
-- guardian on site and no supervision arrangement (053), and a check-in
-- recorded while the gate had the person out — and the switch for the one
-- nightly email that replaces the House Rules reminder (032) and the
-- overnight safeguarding alert (041).

-- 1. The nightly record of guardian gaps, written by the snapshot.
create table if not exists public.overnight_guardian_gaps (
  night            date not null,
  household_id     uuid not null references public.households (id) on delete cascade,
  children_on_site integer not null,
  guardians_out    integer not null,
  first_out_at     timestamptz,
  recorded_at      timestamptz not null default now(),
  primary key (night, household_id)
);
alter table public.overnight_guardian_gaps enable row level security;
drop policy if exists guardian_gaps_read on public.overnight_guardian_gaps;
create policy guardian_gaps_read on public.overnight_guardian_gaps for select using (public.is_staff());
revoke all on public.overnight_guardian_gaps from anon, public, authenticated;
grant select on public.overnight_guardian_gaps to authenticated;

create or replace function public.snapshot_guardian_gaps(p_night date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.overnight_guardian_gaps (night, household_id, children_on_site, guardians_out, first_out_at)
  select p_night, c.household_id, c.children_on_site, c.guardians - c.guardians_on_site,
         (select min(v.last_event_at) from public.residents r join public.v_resident_status v on v.id = r.id
           where r.household_id = c.household_id and r.status = 'active' and v.is_adult and v.presence = 'out')
    from public.v_household_care c
   where c.children_on_site > 0 and c.guardians_on_site = 0 and c.arrangement_id is null
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.snapshot_guardian_gaps(date) from public, anon, authenticated;

create or replace function public.purge_guardian_gaps()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.overnight_guardian_gaps
   where night < current_date - (select compliance_retention_days from public.app_settings where id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_guardian_gaps() from public, anon, authenticated;

-- 2. The 22:00 rows, with names, for the people whose duty it is.
create or replace function public.guardian_gaps_now()
returns table (household_id uuid, household_label text, room_labels text, children text, guardians_out text, first_out_at timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (select adult_age_years, local_timezone from public.app_settings where id)
  select c.household_id,
         (select rm.household_label from public.v_resident_room rm where rm.household_id = c.household_id limit 1),
         (select string_agg(distinct rm.room_label, ', ') from public.v_resident_room rm where rm.household_id = c.household_id and rm.room_label is not null),
         (select string_agg(btrim(r.first_name) || ' (' || v.age_years || ')', ', ' order by r.date_of_birth)
            from public.residents r join public.v_resident_status v on v.id = r.id cross join s
           where r.household_id = c.household_id and r.status = 'active' and not v.is_adult and v.presence = 'in'),
         (select string_agg(v.full_name || ' (out since ' || to_char(v.last_event_at at time zone s.local_timezone, 'HH24:MI') || ')', ', ' order by v.last_name)
            from public.residents r join public.v_resident_status v on v.id = r.id cross join s
           where r.household_id = c.household_id and r.status = 'active' and v.is_adult),
         (select min(v.last_event_at) from public.residents r join public.v_resident_status v on v.id = r.id
           where r.household_id = c.household_id and r.status = 'active' and v.is_adult)
    from public.v_household_care c
   where public.is_supervisor()
     and c.children_on_site > 0 and c.guardians_on_site = 0 and c.arrangement_id is null
   order by 2
$$;
revoke all on function public.guardian_gaps_now() from public, anon;
grant execute on function public.guardian_gaps_now() to authenticated;
-- A guard gets zero rows, not an error: `where is_supervisor()`; the test
-- uses pg_temp.try which reports "blocked" on zero rows as well — check
-- test/compliance.sql's try() and if it reports only on exceptions, change
-- the function to raise 42501 for a non-supervisor instead (plpgsql).

-- 3. Check-ins recorded while the gate had the person out.
create or replace view public.v_checkin_conflicts as
select e.id as checkin_id, e.resident_id, e.occurred_at, e.guard_id, e.source,
       g.kind as last_gate_kind, g.occurred_at as last_gate_at
  from public.checkin_events e
  left join lateral (
    select ge.kind, ge.occurred_at from public.gate_events ge
     where ge.resident_id = e.resident_id and ge.occurred_at <= e.occurred_at
     order by ge.occurred_at desc, ge.id desc limit 1) g on true
 where public.is_staff()
   and e.occurred_at > now() - make_interval(days => (select compliance_retention_days from public.app_settings where id))
   and (g.kind is null or g.kind = 'out');
grant select on public.v_checkin_conflicts to authenticated;

-- 4. One switch for the one nightly email (and the 22:00 alert).
alter table public.app_settings add column if not exists nightly_email boolean not null default false;
comment on column public.app_settings.nightly_email is
  'The nightly email (children without a guardian, children away, check-in conflicts, House Rules figures) and the 22:00 guardian alert, to the staff ticked safeguarding_alert. Replaces notify_thresholds_email (032), which is kept but no longer read.';
update public.app_settings set nightly_email = true
 where notify_thresholds_email or exists (select 1 from public.profiles p where p.safeguarding_alert);
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.app_settings add column if not exists nightly_email boolean not null default false', s);
  end loop;
end $$;

-- 5. Two new unsubscribe kinds; the two retired kinds fold into 'nightly'.
alter table public.email_opt_outs drop constraint if exists email_opt_outs_kind_check;
alter table public.email_opt_outs add constraint email_opt_outs_kind_check
  check (kind in ('weekly_report', 'safeguarding_alert', 'house_rules', 'guardian_alert', 'nightly'));
insert into public.email_opt_outs (profile_id, kind)
select distinct profile_id, 'nightly' from public.email_opt_outs where kind in ('safeguarding_alert', 'house_rules')
on conflict do nothing;
```

Check: the real constraint name on `email_opt_outs.kind` (`\d` it, or read 049) and `v_resident_status`'s column for the last gate time (`last_event_at` is used in routes/reports.js's absent report — confirm). `jobs.js` `TENANT_JOBS`: add `["purge-guardian-gaps", "select purge_guardian_gaps()"]` beside the other purges. Regenerate the template.

- [ ] **Step 4: GREEN** — `./test/sql.sh` then full `./check.sh`. 54 migrations.
- [ ] **Step 5: Commit** — `git add migrations/054_guardian_alert_and_conflicts.sql test/compliance.sql jobs.js tenant/template.sql` / `git commit -m "Migration 054: guardian gaps, check-in conflicts, one nightly-email switch, two unsubscribe kinds"`.

---

### Task 2: Composers, unsubscribe kinds, settings column, two reports

**Files:**
- Create: `lib/guardianAlert.js`, `lib/nightlyEmail.js`
- Modify: `lib/emailPrefs.js` (KINDS), `routes/settings.js` (COLUMNS: `nightly_email`), `routes/reports.js` (two reports), `test/api.test.js`, `test/permissions.js` (+ regen `docs/PERMISSIONS.md`)

**Interfaces (Produces):**
- `guardianAlert.compose({ siteName, gaps: [{ household_label, room_labels, children, guardians_out }], link, unsubscribe }) → { subject, text, html }` — subject `` `${site}: children on site without a guardian — ${n} household${n===1?'':'s'}` ``; one block per household; footer sentence per Global Constraints; uses `layout({ …, footer })`.
- `nightlyEmail.compose({ siteName, night, counts: { guardian_gaps, children_away, conflicts, at_figures }, links: { families, overnight, conflicts, absences }, unsubscribe })` — subject `` `${site}: tonight — ${total} to look at` `` or `` `${site}: tonight — nothing to report` ``; four rows label/value with a link each (`layout` `rows` + one `cta` for the first non-zero section; the plain-text part lists all four links).
- `emailPrefs.KINDS` gains `guardian_alert` ("the 22:00 guardian alert", tick `safeguarding_alert`) and `nightly` ("the nightly email", tick `safeguarding_alert`); `house_rules`/`safeguarding_alert` entries stay valid for old links but their names read "(now the nightly email)".
- Reports: `guardian-gaps` ("Children on site without a guardian", ranged by `night`; columns night, household, room, children, guardians_out, first_out_at) and `checkin-conflicts` ("Check-ins recorded while signed out", ranged by date; columns date, resident, time, recorded_by, source, last_gate_movement, last_gate_at).

- [ ] **Step 1: Failing tests** — in test/api.test.js after the families block: `guardianAlert.compose` names the household/children/guardians and carries the footer sentence and link; `nightlyEmail.compose` carries four counts and four links, no resident name (feed a fixture gap with a name and assert it is absent), Sunday subject variant; `GET /api/reports/guardian-gaps` and `checkin-conflicts` 200 for a supervisor, audited, 403 guard; `PATCH /api/settings { nightly_email }` round-trips; `KINDS` has the two new kinds and `prefs.linkFor(..., kind: 'nightly')` mints a link that `/unsubscribe` accepts. Bump the report-count assertion (19 → 21). Permissions rows for the two reports (SUPERVISOR).
- [ ] **Step 2: RED**, **Step 3: implement** (mirror `lib/safeguardingAlert.js` for shape and comment voice; `layout` from `lib/mail.js`; `textFooter`), **Step 4: GREEN**, **Step 5: Commit** — `"Guardian alert and nightly-email composers, two reports, the nightly_email setting, unsubscribe kinds"`.

---

### Task 3: `jobs.js` — evening mode, one nightly email; cron; README

**Files:**
- Modify: `jobs.js`, `render.yaml`, `README.md`, `test/api.test.js` (replace the `notifyThresholds` tests), `lib/emailPrefs.js` only if needed

**Interfaces (Produces):**
- `eveningGate({ localHour, force }) → null | 'before 22:00'`; `guardianAlert(schema, label, { force })`; `nightlyEmail(schema, label)`; `main('evening')`; exports `{ weeklyRegister, sendGate, guardianAlert, eveningGate, nightlyEmail, main }` (`notifyThresholds` and `safeguardingNightly` removed).

- [ ] **Step 1: Failing tests** — replace the `notifyThresholds`/`safeguardingNightly` tests (grep them at ~3130–3150 and ~3951–4010) with: `eveningGate` table; `guardianAlert("public","",{force:true})` with the Gap fixture from Task 1 recreated via the API (household, parent signs out via `/api/gate-events`, child in) sends one sink mail to the safeguarding-ticked supervisor naming the household and child, records `… emailed`; a second forced run records `already sent today`; with a running arrangement, records `nothing to report`; `nightlyEmail("public","")` sends counts+links only (assert no fixture name in body) and records `nightly-email`; `main('evening', { keepPool: true })` runs only the guardian job; `main('nightly', …)` writes `nightly-email` and no `overnight-safeguarding-alert`/`notify-thresholds` rows. Keep the unsubscribe test at ~3951 working by switching it to `nightlyEmail` and kind `'nightly'`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: implement.** `eveningGate` beside `sendGate`. `guardianAlert()`: settings (`nightly_email as on, feature_households, site_name, local_timezone, extract(hour …) as local_hour, site_today`), `safeguarding.recipients(client)` (reuse), gate, once-a-night guard on `guardian-alert-email` (`emailed$` with ≥1 delivered, same regex as weekly), `select * from guardian_gaps_now()` under the owner (`withOwnerIn` — note the function's `is_supervisor()` guard returns zero rows for the owner unless the owner passes it; check how `overnight_safeguarding_count` is called by the job and do the same — if needed, make `guardian_gaps_now()` skip the role check when `auth.uid() is null`, matching whatever 041 does), `'nothing to report'` when empty, else compose per recipient with `reportLink({ tab: 'families' })` and `prefs.linkFor(kind: 'guardian_alert')`, send with attachments none, record `${n} households, k/m emailed`. `nightlyEmail()`: after the snapshot in nightly mode: `snapshot_guardian_gaps(last night)`, then counts: `select count(*) from overnight_guardian_gaps where night = $1`, `overnight_safeguarding_count($1)`, `select count(*) from v_checkin_conflicts where (occurred_at at time zone tz)::date = $1`, and the House Rules count query lifted from the old `notifyThresholds` (keep its SQL verbatim); links via `reportLink` for `families`, `reports/overnight`, `reports/checkin-conflicts`, `absences`; send when any > 0 or `dow = 7`; record `nightly-email`. Delete `notifyThresholds` and `safeguardingNightly` and their call sites; keep `snapshot-overnight-absences` and its "skipped" record for the nightly email. `main()`: `'evening'` mode → `guardianAlert` per live tenant only. Header table gains `hut-evening   21:00 and 22:00 UTC   node jobs.js evening   the 22:00 guardian alert, once, at 22:00 site time`.
- `render.yaml`: cron `hut-evening`, `schedule: "0 21,22 * * *"`, `startCommand: node jobs.js evening`, env as `hut-weekly` incl. the `sync: false` mail keys and a comment.
- README §5: the third cron; the nightly email now one message; owner steps (mail keys at sync; tick "Gets the nightly email and the 22:00 alert" for the managers; the old House Rules switch is gone).
- [ ] **Step 4: GREEN**, **Step 5: Commit** — `"jobs: the 22:00 guardian alert (node jobs.js evening, hut-evening) and one nightly email in place of two"`.

---

### Task 4: Settings, staff tick label, register conflict line, help, GDPR, roadmap, site

**Files:**
- Modify: `public/admin.html` (Settings: replace `stNotify` with `stNightly` bound to `nightly_email` with the four-section copy; staff tick label → "Gets the nightly email and the 22:00 alert"; `NAMES` map for unsubscribe display), `public/checkin.html` (detail sheet: for each of today's check-ins that is a conflict, append "· recorded while signed out at the gate" — the sheet gets `checkins_today_events`; add `conflict: true` to those events in `routes/residents.js`'s compliance detail by joining `v_checkin_conflicts`), `routes/residents.js`, `public/help.html`, `docs/GDPR.md` ("What leaves by email": the 22:00 alert names residents; the nightly email replaces two; processors row), `docs/PRODUCT-ROADMAP.md` (site-visit bullets: nightly merge, overnight alert, conflict flag → built), `tools/build-site.py` (the IPAS sentence at ~466 "emails a nightly count of under-18s away overnight… a count and a link, never a name" → "…and a nightly email of counts — children away overnight without authorisation, children on site without a guardian, check-ins recorded while signed out, House Rules figures — a count and a link each, never a name; the 22:00 alert to the managers about children without a guardian does name them, because it must be acted on that night") then regenerate `site/`.
- Test: the compliance-detail test asserts `conflict` on the fixture check-in; parse step; check-site clean.
- Commit — `"One nightly email in Settings; the 22:00 alert on the staff tick; conflicts on the register sheet; copy"`.

---

## Done when

- `./check.sh` green (54 migrations, DB + HTTP suites incl. the new blocks, site consistent, permissions doc current).
- Four commits on `main`; the controller pushes with piece A.
- Owner items after deploy: `hut-evening` appears at blueprint sync (mail keys prompted); tick the managers for "Gets the nightly email and the 22:00 alert" (Amy, Niamh, and the managers@ account when added); the House Rules switch is gone — the nightly email covers it.
