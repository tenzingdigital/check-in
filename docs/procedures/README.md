# Procedures

The operational half of the security posture: what people do, as opposed to
what the code does. Each is one to three pages and written for the person
who has to act, not for an auditor — though an auditor will ask for exactly
these (ISO 27001:2022 Annex A 5.24–5.30, 5.18, 8.13).

| Document | When you need it |
|---|---|
| `PAPER-FALLBACK.md` | The terminal cannot record: a long outage, a dead device, a locked-out guard |
| `INCIDENT-RESPONSE.md` | Something may have gone wrong with the data: a lost device, a leaked credential, a bug, a provider breach |
| `ACCESS-JOINER-MOVER-LEAVER.md` | Someone joins, changes role or leaves — at the centre or at Tenzing — and the quarterly access review |
| `BACKUP-AND-RESTORE.md` | Taking the off-provider backup, restoring either copy, and the quarterly rehearsal |
| `RISK-REGISTER.md` | The list of what could go wrong, what is done about it, and what is still open, reviewed quarterly |

The technical facts these rely on are in `../GDPR.md` (what is held and for
how long), `../SECURITY-ROADMAP.md` (findings and their status) and
`../../README.md` (how the system is run). The customer-facing promises they
exist to keep are in `../legal/`.

Three of these have blanks or tables to fill in before the first customer is
live: the contacts in `INCIDENT-RESPONSE.md`, the platform access table in
`ACCESS-JOINER-MOVER-LEAVER.md`, and Render's backup retention in
`BACKUP-AND-RESTORE.md`.
