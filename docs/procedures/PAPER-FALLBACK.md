# Paper fallback — when the terminal cannot record

*Procedure for the centre. ISO 27001:2022 5.29, 5.30. Print this and keep it
in the hut with a pad of the sheet at the bottom.*

## When to use paper

The terminal handles short outages by itself. When the pill in the header
turns amber ("Offline" or "Reconnecting"), keep using the app exactly as
normal: check-ins and gate events are recorded on the terminal, shown as
*Queued* on the card, and sent automatically when the connection returns.
Nothing is lost in an outage of minutes or hours.

Move to paper only when **any** of these is true:

1. The terminal itself is unusable — dead, stolen, screen broken, or the app
   will not open at all.
2. The pill has been amber for longer than the sync window less a margin.
   The window is 48 hours by default (Settings → *Offline sync window*); if
   the link has been down for more than **36 hours**, start writing the sheet
   as well, because events older than the window are refused when they
   finally sync.
3. The app shows a red error rather than an amber pill, and a second attempt
   does not clear it.
4. A staff member has been locked out (the idle lock, a forgotten password)
   and cannot log back in because the link is down. Do not share another
   person's login; write the sheet.

## The sheet

One line per person, per event. Write clearly; a supervisor will type this
in later.

| Date | Time | Resident's full name | TRC / IRP number | Event (check-in / in / out) | Staff initials |
|---|---|---|---|---|---|
| | | | | | |

- **Time** is the time the person was actually in front of you, from the
  hut clock. Not the time you wrote the line.
- **Event**: *check-in* is the daily presentation. *In* and *out* are the
  door log. A person presenting for the day and walking in is two lines.
- Keep the sheet in the hut, face down, out of sight of the door. It holds
  identity numbers.

## When the connection returns

1. Let the terminal sync first. Wait until the pill reads *Online* and no
   card still says *Queued*. If a card says the event was refused, note the
   name; it goes on the sheet.
2. A **supervisor** enters the sheet the same day, before the nightly
   close-out at 00:30 UTC where possible, or the next morning inside the
   window. Each line goes in through the app as a normal check-in or gate
   event **with the time from the sheet**: open the person's card, and use
   the late-entry option when the time is in the past. The record is stored
   with `late_entry = true`, the sheet time as `occurred_at`, and the entry
   time as `recorded_at`, so an auditor can always tell paper from live.
3. Events older than the window cannot be entered through the app. That is
   deliberate: a check-in typed in days later, for a day already closed,
   would silently change a register the centre may already have reported
   on. Keep those lines on the sheet and attach the sheet to the register
   for that day.
4. Write "ENTERED — date — initials" across the sheet and file it with the
   centre's own records for the register retention period (180 days by
   default). Then it can be destroyed.

## Rehearsal

Once a quarter, a supervisor runs the sheet for one real shift with the
terminal deliberately offline (airplane mode on the tablet), then enters it.
Record the date and how long the entry took in `RISK-REGISTER.md` under R7.
The first time is the one that finds the problems.

## Why not just wait

Because a resident who presented and was not recorded is, on the register,
a resident who missed the day. The register is the evidence the centre is
inspected on, and a missed day that was not missed is worse than a gap that
is explained. The sheet is an explanation.
