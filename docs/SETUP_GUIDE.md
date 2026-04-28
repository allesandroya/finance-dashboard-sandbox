# Phase 8 Setup Guide — Beginner edition

This walks you through what to do **manually in a browser** to turn on
email login, cloud sync, and plan tiering. I've tried to keep this
click-by-click. No terminal commands unless you really want them.

You'll need accounts on **Resend** (for email) and **Cloudflare** (you
already have this). Total time: ~30–45 minutes.

---

## 0. What you already have
- Cloudflare account, Worker `finance-bot-worker` running at
  `https://finance-bot-worker.allesandroya.workers.dev`
- KV namespace `FB_KV` bound to the Worker
- Domain `kerja.id` (this guide assumes DNS is managed at your
  registrar — could be Cloudflare, Niagahoster, GoDaddy, etc.)
- Mistral API key set as Worker secret `MISTRAL_API_KEY`

---

## 1. Sign up for Resend (email sender) — 5 min

1. Open **https://resend.com** in your browser. Click **"Sign up"** top-right.
2. Sign up with your email (free plan: **100 emails/day**, enough for
   hundreds of logins/day).
3. Verify your signup email.
4. After login, Resend asks you to **add a domain**. Click **"Add
   Domain"** in the left sidebar.
5. Enter `kerja.id`. Click **Add**.

Resend will now show you DNS records to add (SPF, DKIM, optionally
DMARC). Keep this tab open — you need it for step 2.

---

## 2. Verify `kerja.id` DNS so Resend can send as `admin@kerja.id` — 10 min

Resend shows 3–4 DNS records like:
- `TXT` record named `send.kerja.id`, value starts with `v=spf1…`
- `TXT` record with a long DKIM key (name looks like `resend._domainkey.kerja.id`)
- Optional `TXT` DMARC record for `_dmarc.kerja.id`

### Where to add these
Find out who manages DNS for `kerja.id`. Most likely:

- **If Cloudflare manages DNS:** go to **dash.cloudflare.com** → pick
  `kerja.id` → **DNS** tab → **Add record** for each row from Resend.
- **If your registrar (Niagahoster, GoDaddy, etc.) manages DNS:**
  log in to their panel → find "DNS management" for `kerja.id` → Add
  record.

For each Resend row:
- **Type** → match what Resend says (`TXT` for most)
- **Name / Host** → paste exactly what Resend shows (sometimes the
  registrar auto-appends `.kerja.id` — if so, don't type `.kerja.id`
  again, only the prefix like `resend._domainkey`)
- **Value / Content** → paste exactly what Resend shows
- **TTL** → Auto / 3600 is fine

Save each record. Then **go back to Resend → Domains → kerja.id →
"Verify"**. Wait 1–5 minutes and refresh. Once all checkmarks turn
green, you're done.

### Create the API key
1. In Resend, click **"API Keys"** in the left sidebar.
2. Click **"Create API Key"**. Name it `cashflow-worker`.
3. Permission: **"Sending access"** is enough.
4. Copy the key (it starts with `re_…`). **Save it somewhere safe —
   Resend only shows it once.** You'll paste it into Cloudflare in
   step 5.

---

## 3. Create the D1 database (cloud sync storage) — 5 min

1. Open **https://dash.cloudflare.com** → pick your account.
2. Left sidebar: **Workers & Pages** → **D1** (sometimes
   "Workers → D1 SQL Database").
3. Click **"Create database"**.
4. Name it `finance-bot-db`. Location: pick the one closest to you
   (e.g. `APAC`). Click **Create**.
5. You're on the new database's page. Click **"Console"** tab.
6. Open the file `docs/schema.sql` from this repo in your editor.
   Copy its entire contents.
7. Paste into the Console query box. Click **Execute** (or press
   Ctrl+Enter). You should see `Success` — the `user_state` table is
   created.

---

## 4. Bind D1 to your Worker — 3 min

1. Still in Cloudflare dashboard, go to **Workers & Pages** → open
   your `finance-bot-worker`.
2. Click the **Settings** tab → **Bindings** (sometimes under
   "Variables").
3. Scroll to **D1 Databases** → click **Add binding**.
4. Variable name: `FB_DB` (exactly this — case matters).
5. D1 database: pick `finance-bot-db`.
6. Click **Save / Deploy**.

---

## 5. Add Worker secrets & variables — 5 min

Same Worker → **Settings** → **Variables and Secrets** (or
"Environment Variables").

### Secrets (encrypted)
Click **Add variable** → choose **"Encrypt"** / "Secret" for these:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | The `re_…` key you copied in step 2 |

(Existing secrets `MISTRAL_API_KEY`, `INGEST_SECRET`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` stay as-is.)

### Plaintext vars
Click **Add variable** → leave as plaintext for these:

| Name | Value |
|---|---|
| `APP_ORIGIN` | `https://allesandroya.github.io` *(the domain where the magic-link lands)* |
| `EMAIL_FROM` | `Cash Flow Bot <admin@kerja.id>` |

Click **Save / Deploy**.

> ℹ️ `APP_ORIGIN` is the URL users land on when they click the email
> link. If you want the link to land on your server instead
> (`http://72.60.74.52:8081`), use that value. Pick one — the one you
> use most often.

---

## 6. Deploy the new Worker code — 3 min

1. Open `docs/worker.patched.js` in your editor. Select all, copy.
2. Cloudflare dashboard → your `finance-bot-worker` → click
   **"Edit code"** (top-right) or the **Deployments** tab →
   **"Quick edit"**.
3. Select the entire existing `worker.js` in the editor. Delete it.
4. Paste the contents of `docs/worker.patched.js`. Click **Save and
   deploy**.
5. Verify: open a new tab and visit
   `https://finance-bot-worker.allesandroya.workers.dev/` — you
   should see `{"ok":true,"service":"cash-flow-bot-worker","version":3}`.
   If you see `"version":2`, the deploy didn't land — redo step 4.

---

## 7. Deploy the new app HTML — 3 min

The app is a single file (`app/index.html`). You host it on:
- GitHub Pages at `https://allesandroya.github.io/finance-bot/app/`
- Your server at `http://72.60.74.52:8081/app/`

### GitHub Pages
If you use the mirror repo `allesandroya/finance-bot`:

1. Open the `finance-bot-deploy` folder in your editor.
2. Copy the new `app/index.html` over the old one (or let the commit
   script in step 11 do it).
3. `git add app/index.html`, `git commit -m "Phase 8 auth + sync"`,
   `git push`. GitHub Pages redeploys automatically (~1 min).

### Your server
Upload the new `app/index.html` to whatever serves
`http://72.60.74.52:8081/app/` — SFTP, rsync, or the admin panel,
whichever you normally use.

---

## 8. Try it out — 2 min

1. Open `https://allesandroya.github.io/finance-bot/app/` in a fresh
   browser tab (or incognito).
2. You should see the new login screen with just one field: **Email**.
3. Type your email, click **"Kirim kode & link"**.
4. Check inbox (and spam). You should see an email from
   `admin@kerja.id` with a login button and a 6-digit code.
5. Either click the button (logs in automatically) **or** type the
   code into the app. Either way, you're in.

If the email doesn't arrive within 1 minute:
- Check spam
- Check Resend dashboard → **Logs**. If you see an error, it's
  usually DNS not verified yet.
- In Cloudflare → Worker → **Logs** (real-time), re-submit the
  request-link and watch for an error.

---

## 9. Upgrade your plan (self) — 2 min

New accounts default to `plan: free` — AI chat parse is **off** for
Free. To give yourself Text or OCR access:

1. Cloudflare dashboard → **Workers & Pages** → **KV** → pick
   `FB_KV`.
2. Search for a key that starts with `user:id:u_…`. That's you.
3. Click the key. The value is JSON like:
   ```json
   {"email":"you@example.com","plan":"free","createdAt":…,"lastSeen":…}
   ```
4. Click **Edit**, change `"free"` to `"ocr"` (or `"text"`). Save.
5. In the app, go to **Settings → Akun & Sync**. The badge should
   update to "OCR" within a few seconds (the app refetches `/api/auth/me`).

---

## 10. Try cloud sync — 2 min

1. After login, go to **Settings → Akun & Sync**.
2. Click **Push**. Toast says "Push sukses ✓". The status line
   updates with a "Cloud terakhir diupdate: …" timestamp.
3. On another device (or incognito window), login with the same
   email. You'll start empty. Click **Pull**. Confirm the prompt.
   The app reloads with your data.

---

## 11. (Optional) Commit the repo changes

```
cd finance-bot-deploy
# Copy the freshly edited files from your working copy if needed
git add app/index.html docs/worker.patched.js docs/schema.sql docs/CHANGELOG.md docs/SETUP_GUIDE.md docs/IDEAS_BACKLOG.md
git commit -m "Phase 8: magic-link auth, cloud sync, plan tiering; remove Telegram UI"
git push
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Email never arrives | DNS not verified | Re-check Resend → Domains. Wait 5 min, refresh. |
| "Link kadaluarsa" when clicking email | Link used / >15 min old | Request a new one from the login screen. |
| "Paket kamu belum termasuk AI parse" | `plan: free` | Upgrade via step 9. |
| "Kuota AI harian habis" | Daily cap hit | Wait for midnight UTC, or bump limits in worker.js → `PLAN_LIMITS`. |
| "D1 binding missing (FB_DB)" | Worker deployed before D1 bound | Redo step 4, then step 6. |
| Sync Pull says "Belum ada data di cloud" | You haven't pushed yet | Push on one device first, then Pull on another. |
| CORS error on new device | Origin not in `ALLOWED_ORIGINS` | Add your origin to the array in `worker.patched.js`, redeploy. |
| Sessions persist even after signout | Old session in localStorage | Clear `cfb_session_v1` in DevTools → Application → Local Storage. |

---

## What's next

Features intentionally deferred (see `IDEAS_BACKLOG.md`):
- Payment UI for plan upgrades (still manual via KV today).
- Native iOS/Android shells (PWA works fine on mobile already).
- Per-row sync (today's sync is full-blob — works fine up to ~8 MB
  state, which is thousands of transactions).
- Sheets-based external sync — decide later if Google Sheets sync
  should run alongside D1 or replace it.
