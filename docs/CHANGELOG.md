# Changelog

All user-facing and architectural changes. Newest first. Dates are the day
the change shipped (ISO).

---

## 2026-04-21 — Quick-Add polish (icon parity, FAB, "Nama Transaksi")

### Changed
- **Quick-Add category tiles use the same SVG icon bubbles as the
  Dashboard Recent Transactions / Detail views.** The previous
  emoji-in-tile rendering was swapped for `.cat-icon` tinted-bubble
  + Lucide-style SVG — so "Food & Beverage" gets the burger icon in
  the same orange tint across every surface.
- **New-category icon picker is now SVG-based**, not emoji-based. User
  picks from a 25-icon grid (`QA_ICON_OPTIONS`) — each icon carries a
  sensible default tint color. The saved category row stores `iconKey`
  + `iconColor` instead of a raw `icon` emoji.
- **"Catatan" field renamed to "Nama Transaksi"** (with an "(opsional)"
  hint). The old label confused users into thinking it was a separate
  free-text diary field, when actually it's the transaction's display
  name. Also moved to its own full-width row (previously stuck next to
  Tanggal in a 1fr/1fr grid where the text got clipped).
- **Tanggal moved to its own full-width row** for consistency with
  Nama Transaksi.

### Fixed
- **FAB scoped back to Dashboard only** (+ Sheets/Transactions and
  Sheets/Categories where it delegates to the existing add-row handlers).
  On Detail, Plans, Settings, Chat the FAB is hidden — those views don't
  need a fast-add shortcut and the floating pill was crowding the
  bottom-nav. Users on those pages still have the top-right "New Entry"
  button and the center Chat Bot pill.
- **FAB position raised** from `bottom: 78px` to `bottom: 110px` so it
  clears the floating mobile bottom-nav pill (which sits at `bottom:12px`
  + ~70px height) with a comfortable gap instead of visually touching
  the nav's top edge.

### Files
- `app/index.html` — `.qa-tile .cat-icon` CSS, `.qa-tile-add .cat-icon`
  CSS, `.qa-icon-grid` / `.qa-icon-tile` CSS, `.fab` bottom offset,
  `qaCatIconSvg()` helper, `QA_ICON_OPTIONS` list, rewritten
  `renderCatsHtml()` (SVG bubbles + inline SVG "+"), rewritten
  `renderNewCatStep()` (SVG icon grid + `.cat-icon` preview),
  `saveNewCategory()` now stores `iconKey`/`iconColor`, `renderMainStep()`
  stacked Tanggal + Nama Transaksi rows.

---

## 2026-04-21 — Quick-Add v2 (new-category + rapid entry)

### Added
- **Quick-Add "Entry Data" modal.** Manual-entry flow with a type bar
  (Expense / Income / Transfer), amount display with built-in calculator
  keypad (+ − × ÷, `000`, backspace, expression evaluator), category grid
  with emoji icons, inline sub-category chips, account selector (single
  for Expense/Income, from→to for Transfer), date, and free-text note.
  Saves straight into `state.transactions` without routing through AI
  parse.
- **Inline "+ Baru" tile** in the category grid opens a full new-category
  page with a name input, optional sub-category name, and a grouped
  emoji icon picker (~165 icons across 12 themes: Food & Drink,
  Transportation, Shopping, Home & Utilities, Health, Entertainment,
  Work & Education, Family & People, Money & Finance, Travel & Places,
  Pets & Nature, Others). Saving the new category adds it to
  `state.categories` with its chosen icon and auto-selects it back on the
  main entry step.
- **"+ Simpan & Lanjut" button** saves the current transaction but keeps
  the modal open — amount, note, and sub-category reset so the user can
  immediately input another entry. Type, category, account, and date are
  retained to make rapid multi-entry sessions fast.
- **Top-right "New Entry" button** opens Quick-Add (was previously a
  shortcut to the Chat view).
- **Mobile FAB default** opens Quick-Add on Dashboard, Detail, Plans,
  Settings, and Chat. Sheets/Transactions and Sheets/Categories keep the
  existing dense add-row flow.

### Changed
- **Modal layout reordered**: type bar → amount → keypad (directly below
  input) → category block → fields. Keypad no longer lives at the bottom.
- **Sub-category now renders inline** under the category grid instead of
  as a separate step. Tapping the same sub-chip toggles it off.
- **Demo mode (`?demo=1`)** always logs the user in as `demo` and skips
  the email login entirely — returning demo users keep whatever they
  added. Demo auth now carries `userId: 'demo'` and `plan: 'ocr'` for full
  feature access.

### Files
- `app/index.html` — `openQuickAddModal` (rewritten), `QA_EMOJI_POOL`,
  `QA_CAT_ICONS`, `qaIcon()` now consults `state.categories[*].icon`,
  `qaEvalExpr` calculator, `.qa-*` CSS (+ `.qa-tile-add`, `.qa-divider`,
  `.qa-emoji-*`), `btnTopNewEntry` handler, updated `updateMobileFab()`
  and FAB click handler, demo-bypass fix in `boot()`.

---

## 2026-04-20 — Phase 8: Auth, Sync, Tiering

### Added
- **Email-only magic-link login.** No password field anymore. The login
  screen takes an email, the Worker sends both a 6-digit code and a
  clickable link (Resend API, `admin@kerja.id`). The link goes to
  `/app/?signin=TOKEN` which boots straight into the app.
- **Opaque session tokens with 1-year sliding expiry.** Stored in a new
  `cfb_session_v1` localStorage key and sent as `Authorization: Bearer`
  on every Worker call. KV-backed; sessions are touched at most weekly to
  keep KV writes low.
- **Cloud sync.** Settings → Akun & Sync → Push / Pull. Full-blob per
  user into Cloudflare D1 (table `user_state`). Manual sync today — we
  don't auto-push on every write. Push confirms the last cloud
  update time; Pull prompts before replacing local data.
- **Plan tiering.** Free / Text / OCR. The Worker's `/api/ai/parse`
  refuses Free users outright, refuses OCR requests for Text users, and
  counts a daily quota per plan (300/day Text, 500/day OCR, +100/day
  OCR pipeline). Badge shown in Settings. Upgrades are manual for now
  (set `plan` in KV → `user:id:<userId>`).
- **Multi-session with per-device signout.** Settings → Logout semua
  revokes every session for this user.
- **Rate limiting.** Magic-link requests capped at 5/hour/email. AI
  calls rate-limited per plan per day.

### Changed
- **Worker v2 → v3** (`docs/worker.patched.js`). New endpoints:
  `/api/auth/request-link`, `/api/auth/verify`, `/api/auth/me`,
  `/api/auth/signout`, `/api/auth/signout-all`,
  `/api/sync/push`, `/api/sync/pull`, `/api/sync/status`.
  `/api/ai/parse` is now Bearer-auth gated.
- **`state.auth`** shape: added `userId` and `plan`. Old installs get
  migrated via the boot-time defaulting.

### Removed
- **Telegram Bot view** from the sidebar, mobile nav, and view router.
  The CSS/HTML for the Telegram preview bubble is dropped from the
  layout (dead `.tg-bubble` CSS left behind — harmless).
- **`settings.tgChatId`** field and link/unlink handlers.
- The Worker still exposes `/api/tg/*` endpoints so we can turn the bot
  back on later without redeploying.

### Files
- `docs/worker.patched.js` — Worker v3 (full rewrite of router, auth,
  sync, tiering layered on top of v2's OCR pipeline).
- `docs/schema.sql` — D1 `user_state` schema.
- `docs/SETUP_GUIDE.md` — beginner walkthrough for Resend + D1 +
  Worker secret setup.
- `app/index.html` — login UI, Settings Akun & Sync card, plan badge
  CSS, Bearer-attaching fetch for `/api/ai/parse`, magic-link
  `?signin=…` boot handler, Telegram removal.

---

## 2026-04-20 — Phase 7.2 (earlier same day)

- Recurring transactions (Plans → Recurring), Transfer type (net-zero
  across Income/Expense), and Dashboard "Next 3 days" upcoming-
  recurring preview card. See `IDEAS_BACKLOG.md` for the shipped
  entries with design notes.

---

## 2026-04 — Worker v2 (OCR)

- Mistral OCR pipeline for image/PDF attachments (`callMistralOcr`).
- `ALLOWED_ORIGINS` expanded to include `http://72.60.74.52:8081` (the
  user's self-hosted server) and localhost variants.
