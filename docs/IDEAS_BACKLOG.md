# Ideas backlog — not shipping today, but worth doing

Parking lot for feature ideas we've discussed and want to build later. Keep
this lean: one heading per idea, a short "why it matters", a sketch of how it
would work, and any open questions. When one graduates to a real build,
promote it to its own spec and delete from here.

---

## (shipped 2026-04-20) ~~Recurring transactions~~

Shipped as Phase 7.2. Lives in Plans → Recurring. `state.recurring[]` with
monthly/weekly/biweekly cadence, auto-materializes on boot + every
`renderDashboard()`, supports Income / Expense / Transfer, Pause/Resume,
Run now, and auto-tags posted rows with `recurringId` for traceability.

---

## (shipped 2026-04-20) ~~Goal-contribution double-counting fix~~

Shipped as Phase 7.2 alongside Recurring. Implemented via a new `Type:
'Transfer'` that carries both `fromAccount` + `toAccount` on a single row.
Transfers are net-zero across Income/Expense KPIs; `accountBalance()` has
a dedicated branch that debits the source and credits the destination.
The AI prompt now parses `nabung`/`tabung`/`setor`/`transfer`/`topup`/`pindah`
as Transfer, and the chat txn-card renders in indigo with a `↔` sign.

---

## (shipped 2026-04-20) ~~Dashboard "Next 3 days" recurring preview~~

Shipped same day as Phase 7.2 (initially sketched as "Next 7 days", trimmed
to 3 at the last moment for a calmer dashboard). Card lives in `.ds-grid`
at grid-area `upcoming`, rendered between the time-series chart and Recent
Transaction on desktop, and between the donut and Recent on mobile (flex
order: 3). `renderUpcomingRecurring()` filters `state.recurring` to active
entries whose `nextRunISO` is in `[today, today+3]`, sorts by soonest, and
hides the card entirely when the list is empty. Rows reuse
`formatNextRun()` for urgency pills (red `rc-due` / amber `rc-soon` /
neutral). Clicking a row calls `jumpToRecurring(id)` which nav-clicks
Plans, sets `_plansTab = 'recurring'`, re-renders, then in the next RAF
scrolls the matching `.recurring-card[data-id]` into view and pulses an
`rc-highlight` class for 1.6s. "Lihat semua →" link jumps without a
specific highlight.

Refreshes whenever `renderDashboard()` runs (after `materializeRecurring()`
so any nextRunISO that just rolled forward is reflected) — fine for PWA
usage where users reopen daily.
