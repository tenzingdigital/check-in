# Risk register

*ISO 27001:2022 clause 6.1. One row per risk; the treatment is what is done
about it and where the evidence is. Likelihood and impact are Low / Medium /
High, judged for one centre of about 200 residents. Review every quarter
with the access review, and after any incident.*

Scoring is deliberately coarse. The point of this table is that each risk has
an owner and a treatment someone can check, not that the numbers are precise.

| # | Risk | Likelihood | Impact | Treatment | Evidence | Status |
|---|---|---|---|---|---|---|
| R1 | A shared terminal is left logged in and someone at the door reads or changes the register | Medium | High | Idle lock ends the session after `idle_lock_minutes` (default 20); log out at handover; kiosk mode and the screen angled away from the door | `mountIdleLock()` in `public/app-common.js`; the browser test locks a page; `ACCESS-JOINER-MOVER-LEAVER.md` | Treated |
| R2 | A staff member's password is guessed or reused | Medium | High | 12-character minimum, bcrypt cost 12, lockout after repeated failures, every attempt logged with IP for 90 days; invitations mean nobody types a password for anyone else | `lib/auth.js`; `auth.login_events`; HTTP suite lockout assertions | Treated. MFA for supervisors and admins is the next step (roadmap 3.1) |
| R3 | A guard sees data they have no need for (dates of birth, identity numbers in lists) | Low | Medium | Row-level security and views: guards read `v_resident_status` (age, no date of birth); lists never carry the identity number | SQL suite asserts 0 rows for a guard on `residents`; HTTP suite asserts no `id_number` in a list | Treated |
| R4 | An administrator changes or exports a record and nobody can tell who or why | Low | High | `admin_audit` by trigger with the row before and after; exports require a reason and are logged; erasure needs the name typed back | Migration 012; HTTP suite audit assertions | Treated |
| R5 | The record is edited after the fact to hide or invent a missed day | Low | High | No role holds UPDATE or DELETE on the event tables or the register; corrections are new events; late entries are flagged | SQL suite; `late_entry` and `recorded_at` columns | Treated |
| R6 | The internet link at the hut drops for minutes to hours | High | Medium | Service worker keeps the app loading; encrypted register copy and event queue on the terminal; sync inside a 48-hour window with idempotent references | `public/offline.js`, `routes/sync.js`; the browser suite drives an outage end to end | Treated |
| R7 | The link drops for longer than the window, or the terminal dies | Low | High | The paper sheet and the supervisor's late entry; rehearsed quarterly | `PAPER-FALLBACK.md`; rehearsal dates recorded there | Treated on paper; **first rehearsal still to run** |
| R8 | The database is lost: provider failure, account loss, billing lapse, a bad migration | Low | High | Render's daily backups plus point-in-time recovery; an encrypted off-provider copy kept 35 days; a quarterly restore rehearsal | `BACKUP-AND-RESTORE.md`; `tools/backup.sh`; `tools/restore-rehearsal.sh` | Scripts rehearsed on 4 Sep 2026; **the daily off-provider backup is not yet scheduled, and PITR is not yet confirmed in the dashboard** |
| R9 | The database runs out of memory under load and the service returns 502s | High on the smallest plan | Medium | Pool capped at 4, one register query per page load instead of four, terminals queue on a 5xx; the plan must be raised to 1 GB | `docs/KNOWN-ISSUES.md` 19c and 19d; Render metrics from 4 Sep 2026 | Mitigated in code; **plan upgrade is the owner's action** |
| R10 | The nightly close-out stops running and missed days are never recorded | Low | High | Every run recorded in `job_runs`; the register page shows a red banner when close-out is behind; Render failure notifications | `v_system_health`; `/api/session/health` | Treated in the app; **Render notifications still to switch on** |
| R11 | A change ships that breaks the authorisation model | Medium | High | 180 assertions across the SQL and HTTP suites plus a browser suite, run on every push by GitHub Actions; the review rule in `docs/TAO.md` | `.github/workflows/check.yml`; `check.sh` | Treated. **Branch protection on `main` requiring the check is still to switch on** |
| R12 | A dependency carries a known vulnerability | Medium | Medium | Three runtime dependencies only; `npm audit` in CI at the high level; `qs` pinned past Express 4's exact version | `package.json` overrides; CI | Treated |
| R13 | A lost or stolen phone or tablet with the app logged in | Medium | High | Disable the account (ends every session); the terminal copy is AES-GCM with a key that dies with the tab; idle lock | `INCIDENT-RESPONSE.md`; `public/offline.js` | Treated |
| R14 | Someone who has left Tenzing still holds the Render, GitHub or Resend login, or the database credential | Low | High | Leaver procedure: remove, rotate the credential and the keys the same day; MFA on all three; quarterly review | `ACCESS-JOINER-MOVER-LEAVER.md` | Treated on paper; **the platform table has blanks to fill** |
| R15 | Identity numbers reveal immigration status to someone who should not see them | Low | High | Detail view only, never lists or email; the DPA tells the centre in Annex I; the centre's DPIA | `routes/residents.js`; `docs/legal/DPA-2026-09-03.md` | Treated |
| R16 | A US provider is compelled to disclose EU data | Low | High | EU residency at Render and Resend; SCCs; a transfer impact assessment; the option of EU-owned hosting costed in `docs/TECH-STACK.md` | `docs/legal/README.md` lists the TIA as outstanding | **TIA and provider DPAs still to file** |
| R17 | The documents describing the system drift from the code and an auditor stops trusting them | Medium | Medium | `docs/GDPR.md` rewritten against the schema on 4 Sep 2026; each roadmap finding carries its fix date; this register reviewed quarterly | `docs/SECURITY-ROADMAP.md` | Treated; recurs |
| R18 | A second customer's data is visible to the first once there are two tenants | n/a today | High | Schema-per-tenant groundwork exists; the binding (`search_path` per request, tenant-scoped staff and reset) and a negative test are required **before** the second tenant | `docs/MULTI-TENANCY.md`; roadmap F11 | Gate, not yet built. Do not onboard a second tenant without it |
| R19 | A staff member types sensitive detail into a place it does not belong | Low | Medium | There is no free-text field; room and note columns were removed; the briefing says so | Migration 006; `docs/GDPR.md` | Treated |
| R20 | A migration is edited after it was applied and production diverges from the repo | Low | Medium | Per-file checksum with a warning at every boot | `database.js` migrate; `docs/KNOWN-ISSUES.md` 16 | Treated |

## Open items, by owner

**Aimee (Tenzing):** upgrade `hut-db` to 1 GB (R9); confirm PITR and record
Render's backup retention (R8); schedule `tools/backup.sh` somewhere in the
EU that Tenzing controls (R8); switch on Render failure notifications for
`hut-nightly` (R10); switch on branch protection for `main` requiring the
`check` job (R11); fill in the platform access table and the incident
contacts (R14); file the Render and Resend DPAs and the transfer impact
assessment (R16).

**The centre:** run the first paper rehearsal (R7); brief staff (R1, R19);
decide the lawful basis and do the DPIA (`docs/GDPR.md`).

**Next build:** MFA for supervisors and admins (R2); the tenancy binding
before a second customer (R18).

| Review date | Reviewed by | Changes |
|---|---|---|
| 2026-09-04 | Claude, during the hardening build | First version |
