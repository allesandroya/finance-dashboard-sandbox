// worker.js — v4 (Phase 9: Pairing-code auth + auto-sync + Admin gate)
//
// New in v4 (v3 → v4):
//   ✦ Pairing-code device linking — 6-digit, 10-min TTL, KV-backed.
//     Device A creates code → Device B claims it → both share one userId.
//   ✦ /api/sync/push + /api/sync/pull now accept anonymous userId flow:
//     userId is generated locally (crypto.randomUUID), no email needed.
//     Bearer-auth path kept for back-compat so old sessions still work.
//   ✦ /api/admin/verify — shared-secret check against env.ADMIN_SECRET,
//     returns 200 for matches, 401 otherwise. Used to unlock Admin Mode
//     only for the owner without needing email login.
//   ✦ Email magic-link flow preserved but not required. Will be wired
//     back in as "Enable account recovery" later.
//
// Kept from v3 (Phase 8):
//   ✦ Email-only magic-link login via Resend (link + 6-digit code).
//   ✦ Opaque session tokens stored in KV with 1-year sliding expiry.
//   ✦ Multi-session support with per-device signout and signout-all.
//   ✦ Full-blob cloud sync to Cloudflare D1 (table: user_state).
//   ✦ Per-plan tiering on /api/ai/parse (free | text | ocr).
//   ✦ Rate-limit counters: magic-link (5/hour/email), AI (plan-based/day).
//   ✦ Telegram pipeline stays intact server-side.
//
// Bindings required in Cloudflare dashboard → Worker Settings → Variables:
//   • KV namespace          FB_KV          (already in place, reused)
//   • D1 database           FB_DB          (new — schema in docs/schema.sql)
//   • Secret                MISTRAL_API_KEY
//   • Secret                RESEND_API_KEY         (for future email recovery)
//   • Secret                ADMIN_SECRET           ← NEW in v4 (owner-only admin)
//   • Var (plaintext)       APP_ORIGIN     = "https://allesandroya.github.io"
//   • Var (plaintext)       EMAIL_FROM     = "Inputin <onboarding@resend.dev>"
//   • Secret                INGEST_SECRET          (existing, optional)
//   • Secret                TELEGRAM_BOT_TOKEN     (existing, optional)
//   • Secret                TELEGRAM_WEBHOOK_SECRET(existing, optional)

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const ALLOWED_ORIGINS = [
  'https://allesandroya.github.io',
  'https://n8n.kerja.id',
  'http://72.60.74.52:8081',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status = 200, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...(req ? corsHeaders(req) : {}) },
  });
}

function handleOptions(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

// ===========================================================================
// Crypto + id helpers
// ===========================================================================
function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomCode6() {
  // 6-digit decimal code for email delivery
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}
function nowSec() { return Math.floor(Date.now() / 1000); }
function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }

// ===========================================================================
// Rate limiting — coarse hour/day bucket counters in KV
// ===========================================================================
async function rateLimit(env, key, limit, windowSec) {
  const bucket = Math.floor(nowSec() / windowSec);
  const k = `rl:${key}:${bucket}`;
  const cur = parseInt((await env.FB_KV.get(k)) || '0', 10);
  if (cur >= limit) return { ok: false, remaining: 0 };
  await env.FB_KV.put(k, String(cur + 1), { expirationTtl: windowSec + 60 });
  return { ok: true, remaining: limit - (cur + 1) };
}

// ===========================================================================
// Users & sessions (KV-backed)
// ===========================================================================
const SESSION_TTL_SEC = 365 * 24 * 3600;       // 1 year sliding
const SESSION_REFRESH_AFTER = 7 * 24 * 3600;   // touch KV at most weekly
const MAGIC_TTL_SEC = 15 * 60;                 // 15 min to use a link/code

async function getOrCreateUserByEmail(env, email) {
  const e = normalizeEmail(email);
  const existingId = await env.FB_KV.get(`user:email:${e}`);
  if (existingId) {
    const raw = await env.FB_KV.get(`user:id:${existingId}`);
    return raw ? { userId: existingId, user: JSON.parse(raw) } : null;
  }
  const userId = 'u_' + randomHex(12);
  const user = {
    email: e,
    plan: 'free',
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  await env.FB_KV.put(`user:id:${userId}`, JSON.stringify(user));
  await env.FB_KV.put(`user:email:${e}`, userId);
  return { userId, user };
}

async function readUser(env, userId) {
  const raw = await env.FB_KV.get(`user:id:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function createSession(env, userId, deviceLabel) {
  const token = randomHex(32);
  const now = Date.now();
  const session = {
    userId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + SESSION_TTL_SEC * 1000,
    deviceLabel: deviceLabel || '',
  };
  await env.FB_KV.put(`session:${token}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SEC,
  });
  // Track token on user for signout-all
  const listKey = `sessions:user:${userId}`;
  const raw = await env.FB_KV.get(listKey);
  const list = raw ? JSON.parse(raw) : [];
  list.push(token);
  await env.FB_KV.put(listKey, JSON.stringify(list.slice(-50)));
  return token;
}

async function readSession(env, token) {
  if (!token) return null;
  const raw = await env.FB_KV.get(`session:${token}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function touchSession(env, token, session) {
  const now = Date.now();
  if (now - (session.lastUsedAt || 0) < SESSION_REFRESH_AFTER * 1000) return;
  session.lastUsedAt = now;
  session.expiresAt = now + SESSION_TTL_SEC * 1000;
  await env.FB_KV.put(`session:${token}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SEC,
  });
}

async function deleteSession(env, token, userId) {
  await env.FB_KV.delete(`session:${token}`);
  if (userId) {
    const listKey = `sessions:user:${userId}`;
    const raw = await env.FB_KV.get(listKey);
    if (raw) {
      try {
        const list = JSON.parse(raw).filter((t) => t !== token);
        await env.FB_KV.put(listKey, JSON.stringify(list));
      } catch {}
    }
  }
}

async function deleteAllSessions(env, userId) {
  const listKey = `sessions:user:${userId}`;
  const raw = await env.FB_KV.get(listKey);
  const list = raw ? JSON.parse(raw) : [];
  for (const t of list) await env.FB_KV.delete(`session:${t}`);
  await env.FB_KV.delete(listKey);
}

async function requireAuth(req, env) {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'Missing bearer token' };
  const token = m[1].trim();
  const session = await readSession(env, token);
  if (!session) return { ok: false, status: 401, error: 'Invalid or expired session' };
  if (session.expiresAt && session.expiresAt < Date.now()) {
    return { ok: false, status: 401, error: 'Session expired' };
  }
  const user = await readUser(env, session.userId);
  if (!user) return { ok: false, status: 401, error: 'User not found' };
  await touchSession(env, token, session);
  return { ok: true, token, session, userId: session.userId, user };
}

// ===========================================================================
// Resend email — used to send magic-link + 6-digit code
// ===========================================================================
async function sendMagicEmail(env, { to, code, link }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — skipping email. Code:', code);
    return { ok: false, error: 'Email sender not configured' };
  }
  const from = env.EMAIL_FROM || 'Inputin <onboarding@resend.dev>';
  const subject = 'Masuk ke Inputin';
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0F172A">
      <h2 style="margin:0 0 12px 0;font-size:20px;">Masuk ke Inputin</h2>
      <p style="margin:0 0 16px 0;line-height:1.6;color:#475569">Klik tombol di bawah untuk masuk, atau masukkan kode 6-digit di aplikasi.</p>
      <p style="margin:0 0 16px 0;">
        <a href="${link}" style="display:inline-block;background:#16A34A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Masuk sekarang →</a>
      </p>
      <div style="background:#F1F5F9;border-radius:8px;padding:14px 16px;margin:16px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;letter-spacing:6px;text-align:center;color:#0F172A;">${code}</div>
      <p style="margin:0 0 6px 0;font-size:13px;color:#64748B;">Kode &amp; link berlaku 15 menit.</p>
      <p style="margin:0;font-size:12px;color:#94A3B8;">Kalau kamu tidak meminta ini, abaikan email ini.</p>
    </div>`;
  const text = `Masuk ke Inputin\n\nKode: ${code}\nAtau klik: ${link}\n\nBerlaku 15 menit.`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, error: errText.slice(0, 400) };
  }
  return { ok: true };
}

// ===========================================================================
// Auth endpoints
// ===========================================================================
async function handleAuthRequestLink(req, env) {
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400, req); }
  const email = normalizeEmail(payload?.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: 'Email tidak valid' }, 400, req);
  }
  const rl = await rateLimit(env, `magic:${email}`, 5, 3600);
  if (!rl.ok) {
    return json({ ok: false, error: 'Terlalu banyak permintaan. Coba lagi nanti.' }, 429, req);
  }
  const code = randomCode6();
  const token = randomHex(24);
  await env.FB_KV.put(
    `magic:code:${email}:${code}`,
    JSON.stringify({ email, createdAt: Date.now() }),
    { expirationTtl: MAGIC_TTL_SEC },
  );
  await env.FB_KV.put(
    `magic:tok:${token}`,
    JSON.stringify({ email, createdAt: Date.now() }),
    { expirationTtl: MAGIC_TTL_SEC },
  );
  const appOrigin = env.APP_ORIGIN || (new URL(req.url)).origin.replace(/\/$/, '');
  const link = `${appOrigin}/app/?signin=${token}`;
  const sent = await sendMagicEmail(env, { to: email, code, link });
  if (!sent.ok) {
    return json({ ok: false, error: `Email gagal terkirim: ${sent.error}` }, 502, req);
  }
  return json({ ok: true }, 200, req);
}

async function handleAuthVerify(req, env) {
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400, req); }
  const { deviceLabel } = payload || {};
  let email = normalizeEmail(payload?.email);
  const code = String(payload?.code || '').trim();
  const linkToken = String(payload?.linkToken || '').trim();

  // Two verification paths: (A) email+code, (B) link token (?signin=...)
  if (linkToken) {
    const raw = await env.FB_KV.get(`magic:tok:${linkToken}`);
    if (!raw) return json({ ok: false, error: 'Link kadaluarsa atau sudah dipakai' }, 400, req);
    try {
      const rec = JSON.parse(raw);
      email = normalizeEmail(rec.email);
    } catch {
      return json({ ok: false, error: 'Link rusak' }, 400, req);
    }
    await env.FB_KV.delete(`magic:tok:${linkToken}`);
  } else {
    if (!email || !code || !/^\d{6}$/.test(code)) {
      return json({ ok: false, error: 'Email & kode 6-digit wajib diisi' }, 400, req);
    }
    const raw = await env.FB_KV.get(`magic:code:${email}:${code}`);
    if (!raw) return json({ ok: false, error: 'Kode salah atau kadaluarsa' }, 400, req);
    await env.FB_KV.delete(`magic:code:${email}:${code}`);
  }

  const { userId, user } = await getOrCreateUserByEmail(env, email);
  user.lastSeen = Date.now();
  await env.FB_KV.put(`user:id:${userId}`, JSON.stringify(user));
  const token = await createSession(env, userId, deviceLabel || '');
  return json({
    ok: true,
    sessionToken: token,
    user: { email: user.email, plan: user.plan, userId },
  }, 200, req);
}

async function handleAuthMe(req, env) {
  const auth = await requireAuth(req, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, req);
  const listKey = `sessions:user:${auth.userId}`;
  const raw = await env.FB_KV.get(listKey);
  const tokens = raw ? JSON.parse(raw) : [];
  const sessions = [];
  for (const t of tokens) {
    const srec = await readSession(env, t);
    if (srec) sessions.push({
      current: t === auth.token,
      deviceLabel: srec.deviceLabel || '',
      createdAt: srec.createdAt,
      lastUsedAt: srec.lastUsedAt,
      expiresAt: srec.expiresAt,
      tokenSuffix: t.slice(-6),
    });
  }
  return json({
    ok: true,
    user: { email: auth.user.email, plan: auth.user.plan, userId: auth.userId },
    sessions,
  }, 200, req);
}

async function handleAuthSignout(req, env) {
  const auth = await requireAuth(req, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, req);
  await deleteSession(env, auth.token, auth.userId);
  return json({ ok: true }, 200, req);
}

async function handleAuthSignoutAll(req, env) {
  const auth = await requireAuth(req, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, req);
  await deleteAllSessions(env, auth.userId);
  return json({ ok: true }, 200, req);
}

// ===========================================================================
// Sync endpoints — D1 `user_state` table, full-blob per user
// ===========================================================================
// Resolve the effective userId for a sync request.
// Phase 9: if Authorization: Bearer <token> is present, derive userId from
// session. Otherwise use userId supplied in body/query (anonymous local flow).
// Returns { ok, userId, deviceLabel? } or { ok: false, status, error }.
function isValidUserId(id) {
  return typeof id === 'string' && /^u_[A-Za-z0-9_]{6,64}$/.test(id);
}

async function resolveSyncUser(req, env, bodyUserId) {
  const h = req.headers.get('Authorization') || '';
  if (h.match(/^Bearer\s+(.+)$/i)) {
    const auth = await requireAuth(req, env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    return {
      ok: true,
      userId: auth.userId,
      deviceLabel: auth.session?.deviceLabel || '',
    };
  }
  if (!isValidUserId(bodyUserId)) {
    return { ok: false, status: 400, error: 'Missing or invalid userId' };
  }
  return { ok: true, userId: bodyUserId, deviceLabel: '' };
}

async function handleSyncPush(req, env) {
  if (!env.FB_DB) return json({ ok: false, error: 'D1 binding missing (FB_DB)' }, 500, req);
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400, req); }
  const who = await resolveSyncUser(req, env, payload?.userId);
  if (!who.ok) return json({ ok: false, error: who.error }, who.status, req);
  const state = payload?.state;
  const deviceLabel = String(payload?.deviceLabel || who.deviceLabel || '').slice(0, 64);
  if (!state || typeof state !== 'object') {
    return json({ ok: false, error: 'Missing state object' }, 400, req);
  }
  const stateJson = JSON.stringify(state);
  const sizeBytes = new TextEncoder().encode(stateJson).length;
  const MAX = 8 * 1024 * 1024;
  if (sizeBytes > MAX) {
    return json({ ok: false, error: 'State too large (max 8 MB)' }, 413, req);
  }
  const updatedAt = Date.now();
  await env.FB_DB.prepare(
    `INSERT INTO user_state (user_id, state_json, updated_at, size_bytes, last_device_label)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       state_json = excluded.state_json,
       updated_at = excluded.updated_at,
       size_bytes = excluded.size_bytes,
       last_device_label = excluded.last_device_label`,
  ).bind(who.userId, stateJson, updatedAt, sizeBytes, deviceLabel).run();
  return json({ ok: true, updatedAt, sizeBytes }, 200, req);
}

async function handleSyncPull(req, env) {
  if (!env.FB_DB) return json({ ok: false, error: 'D1 binding missing (FB_DB)' }, 500, req);
  const url = new URL(req.url);
  const who = await resolveSyncUser(req, env, url.searchParams.get('userId'));
  if (!who.ok) return json({ ok: false, error: who.error }, who.status, req);
  const row = await env.FB_DB.prepare(
    'SELECT state_json, updated_at, size_bytes, last_device_label FROM user_state WHERE user_id = ?',
  ).bind(who.userId).first();
  if (!row) {
    return json({ ok: true, exists: false }, 200, req);
  }
  let state;
  try { state = JSON.parse(row.state_json); } catch { state = null; }
  return json({
    ok: true,
    exists: true,
    state,
    updatedAt: row.updated_at,
    sizeBytes: row.size_bytes,
    lastDevice: row.last_device_label || '',
  }, 200, req);
}

async function handleSyncStatus(req, env) {
  if (!env.FB_DB) return json({ ok: false, error: 'D1 binding missing (FB_DB)' }, 500, req);
  const url = new URL(req.url);
  const who = await resolveSyncUser(req, env, url.searchParams.get('userId'));
  if (!who.ok) return json({ ok: false, error: who.error }, who.status, req);
  const row = await env.FB_DB.prepare(
    'SELECT updated_at, size_bytes, last_device_label FROM user_state WHERE user_id = ?',
  ).bind(who.userId).first();
  if (!row) return json({ ok: true, exists: false }, 200, req);
  return json({
    ok: true,
    exists: true,
    updatedAt: row.updated_at,
    sizeBytes: row.size_bytes,
    lastDevice: row.last_device_label || '',
  }, 200, req);
}

// ===========================================================================
// Phase 9: Device pairing — 6-digit code, 10-min TTL in KV
// ===========================================================================
const PAIR_TTL_SEC = 10 * 60;

async function handlePairCreate(req, env) {
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400, req); }
  const userId = String(payload?.userId || '').trim();
  const deviceLabel = String(payload?.deviceLabel || '').slice(0, 64);
  if (!isValidUserId(userId)) {
    return json({ ok: false, error: 'Missing or invalid userId' }, 400, req);
  }
  // Rate-limit code creation per userId (prevent spam)
  const rl = await rateLimit(env, `pair:${userId}`, 10, 3600);
  if (!rl.ok) {
    return json({ ok: false, error: 'Terlalu banyak kode dibuat. Coba lagi nanti.' }, 429, req);
  }
  // Generate code, ensure no collision
  let code = '';
  for (let i = 0; i < 5; i++) {
    const c = randomCode6();
    const existing = await env.FB_KV.get(`pair:code:${c}`);
    if (!existing) { code = c; break; }
  }
  if (!code) {
    return json({ ok: false, error: 'Gagal membuat kode, coba lagi.' }, 500, req);
  }
  const expiresAt = Date.now() + PAIR_TTL_SEC * 1000;
  await env.FB_KV.put(
    `pair:code:${code}`,
    JSON.stringify({ userId, deviceLabel, createdAt: Date.now() }),
    { expirationTtl: PAIR_TTL_SEC },
  );
  return json({ ok: true, code, expiresAt, ttlSec: PAIR_TTL_SEC }, 200, req);
}

async function handlePairClaim(req, env) {
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400, req); }
  const code = String(payload?.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return json({ ok: false, error: 'Kode harus 6 digit' }, 400, req);
  }
  const raw = await env.FB_KV.get(`pair:code:${code}`);
  if (!raw) {
    return json({ ok: false, error: 'Kode salah atau kadaluarsa' }, 404, req);
  }
  let rec;
  try { rec = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'Kode rusak' }, 500, req); }
  // One-shot: delete on successful claim
  await env.FB_KV.delete(`pair:code:${code}`);
  return json({
    ok: true,
    userId: rec.userId,
    sourceDevice: rec.deviceLabel || '',
  }, 200, req);
}

// ===========================================================================
// Phase 9: Admin verify — shared-secret gate (owner-only Admin Mode unlock)
// ===========================================================================
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function handleAdminVerify(req, env) {
  if (!env.ADMIN_SECRET) {
    return json({ ok: false, error: 'Admin tidak dikonfigurasi di server' }, 500, req);
  }
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400, req); }
  const secret = String(payload?.secret || '');
  if (!secret) {
    return json({ ok: false, error: 'Secret kosong' }, 400, req);
  }
  // Rate-limit by IP + first chars of attempted secret to slow brute force
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await rateLimit(env, `admin:${ip}`, 10, 3600);
  if (!rl.ok) {
    return json({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' }, 429, req);
  }
  if (!timingSafeEqual(secret, env.ADMIN_SECRET)) {
    return json({ ok: false, error: 'Secret salah' }, 401, req);
  }
  return json({ ok: true }, 200, req);
}

// ===========================================================================
// Mistral OCR + text parse (v2 logic, now gated by auth + plan tiering)
// ===========================================================================
const PLAN_LIMITS = {
  free: { aiPerDay: 0,   ocrPerDay: 0,   allowText: false, allowOcr: false },
  text: { aiPerDay: 300, ocrPerDay: 0,   allowText: true,  allowOcr: false },
  ocr:  { aiPerDay: 500, ocrPerDay: 100, allowText: true,  allowOcr: true  },
};

async function callMistralOcr(env, images) {
  const chunks = [];
  for (const img of images) {
    const mime = img.mime || '';
    const isPdf = mime.startsWith('application/pdf');
    const dataUrl = `data:${mime};base64,${img.base64 || ''}`;
    const body = {
      model: 'mistral-ocr-latest',
      document: isPdf
        ? { type: 'document_url', document_url: dataUrl }
        : { type: 'image_url', image_url: dataUrl },
      include_image_base64: false,
    };
    const res = await fetch('https://api.mistral.ai/v1/ocr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        status: res.status,
        error: `OCR failed for ${img.name || 'attachment'}: ${errText.slice(0, 400)}`,
      };
    }
    const data = await res.json();
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const text = pages.map((p) => p.markdown || p.text || '').filter(Boolean).join('\n\n');
    chunks.push(`[Attachment: ${img.name || 'file'}]\n${text}`);
  }
  return { ok: true, content: chunks.join('\n\n---\n\n') };
}

async function callMistral(env, { systemPrompt, userText, model, images }) {
  let combinedUser = userText;
  if (Array.isArray(images) && images.length > 0) {
    const ocr = await callMistralOcr(env, images);
    if (!ocr.ok) return ocr;
    combinedUser = [userText, ocr.content].filter(Boolean).join('\n\n');
  }
  const body = {
    model: model || 'mistral-medium-latest',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: combinedUser || '(empty message)' },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  };
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, status: res.status, error: errText.slice(0, 500) };
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return { ok: true, content };
}

async function handleAiParse(req, env) {
  const auth = await requireAuth(req, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, req);

  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON body' }, 400, req); }
  const { systemPrompt, userText, model, images } = payload || {};
  if (!systemPrompt || !userText) {
    return json({ ok: false, error: 'Missing systemPrompt or userText' }, 400, req);
  }
  if (!env.MISTRAL_API_KEY) {
    return json({ ok: false, error: 'Server missing MISTRAL_API_KEY' }, 500, req);
  }

  // Plan gate
  const plan = auth.user.plan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const hasImages = Array.isArray(images) && images.length > 0;

  if (!limits.allowText) {
    return json({
      ok: false,
      error: 'Paket kamu belum termasuk AI parse. Upgrade ke paket Text untuk chat bot AI.',
      plan,
      upgrade: 'text',
    }, 402, req);
  }
  if (hasImages && !limits.allowOcr) {
    return json({
      ok: false,
      error: 'Paket kamu belum termasuk OCR. Upgrade ke paket OCR untuk scan struk/PDF.',
      plan,
      upgrade: 'ocr',
    }, 402, req);
  }

  // Daily quota
  const aiRl = await rateLimit(env, `ai:${auth.userId}`, limits.aiPerDay, 86400);
  if (!aiRl.ok) {
    return json({ ok: false, error: 'Kuota AI harian habis. Coba lagi besok.' }, 429, req);
  }
  if (hasImages) {
    const ocrRl = await rateLimit(env, `ocr:${auth.userId}`, limits.ocrPerDay, 86400);
    if (!ocrRl.ok) {
      return json({ ok: false, error: 'Kuota OCR harian habis. Coba lagi besok.' }, 429, req);
    }
  }

  // Size guardrails (unchanged)
  if (hasImages) {
    if (images.length > 5) {
      return json({ ok: false, error: 'Max 5 attachments per request' }, 400, req);
    }
    const totalBytes = images.reduce(
      (s, im) => s + ((im.base64 && im.base64.length) || 0) * 0.75,
      0,
    );
    const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return json({ ok: false, error: 'Attachments too large (max 10 MB total)' }, 413, req);
    }
  }

  const result = await callMistral(env, { systemPrompt, userText, model, images });
  if (!result.ok) {
    return json(
      { ok: false, error: 'Upstream AI error', detail: result.error },
      result.status || 502,
      req,
    );
  }
  return json({ ok: true, content: result.content, plan }, 200, req);
}

// ===========================================================================
// Telegram pipeline — preserved from v2 (UI removed in app, kept on server
// so we can switch it back on later without redeploying).
// ===========================================================================
async function sendTelegramMessage(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  }).catch(() => {});
}

async function handleTgWebhook(req, env) {
  const gotSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (env.TELEGRAM_WEBHOOK_SECRET && gotSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  let update;
  try { update = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return new Response('ok');
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const startMatch = text.match(/^\/start(?:\s+(\d{6}))?$/i);
  if (startMatch) {
    const code = startMatch[1];
    if (code) {
      await env.FB_KV.put(
        `codes:${code}`,
        JSON.stringify({ chatId, createdAt: Date.now() }),
        { expirationTtl: 600 },
      );
      await sendTelegramMessage(env, chatId, `✅ Kode *${code}* diterima.`);
    } else {
      await sendTelegramMessage(env, chatId, `👋 Hai! Aku *Cash Flow Bot*. Kirim \`/start <kode>\` dengan kode 6-digit dari website.`);
    }
    return new Response('ok');
  }
  const userId = await env.FB_KV.get(`chat2user:${chatId}`);
  if (!userId) {
    await sendTelegramMessage(env, chatId, `ℹ️ Chat belum terhubung. Kirim \`/start <kode>\` dulu.`);
    return new Response('ok');
  }
  const queueKey = `queue:${userId}`;
  const existing = JSON.parse((await env.FB_KV.get(queueKey)) || '[]');
  existing.push({ ts: Date.now(), text });
  await env.FB_KV.put(queueKey, JSON.stringify(existing.slice(-50)), { expirationTtl: 86400 });
  return new Response('ok');
}

async function handleTgLink(req, env) {
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON body' }, 400, req); }
  const { code, userId } = payload || {};
  if (!code || !userId) return json({ ok: false, error: 'Missing code or userId' }, 400, req);
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: 'Code must be 6 digits' }, 400, req);
  const raw = await env.FB_KV.get(`codes:${code}`);
  if (!raw) return json({ ok: false, error: 'Kode tidak ditemukan atau kadaluarsa' }, 404, req);
  const { chatId } = JSON.parse(raw);
  await env.FB_KV.put(`user2chat:${userId}`, chatId);
  await env.FB_KV.put(`chat2user:${chatId}`, userId);
  await env.FB_KV.delete(`codes:${code}`);
  await sendTelegramMessage(env, chatId, `🔗 Akun terhubung!`);
  return json({ ok: true, chatId }, 200, req);
}

async function handleTgPending(req, env, userId) {
  if (!userId) return json({ ok: false, error: 'Missing userId' }, 400, req);
  const queueKey = `queue:${userId}`;
  const raw = await env.FB_KV.get(queueKey);
  const items = JSON.parse(raw || '[]');
  await env.FB_KV.delete(queueKey);
  return json({ ok: true, items }, 200, req);
}

function checkIngestAuth(req, env) {
  if (!env.INGEST_SECRET) return { ok: false, status: 500, error: 'Server missing INGEST_SECRET' };
  const header = req.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== env.INGEST_SECRET) return { ok: false, status: 401, error: 'Unauthorized' };
  return { ok: true };
}

async function handleTgRegisterCode(req, env) {
  const auth = checkIngestAuth(req, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, req);
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON body' }, 400, req); }
  const { code, chatId } = payload || {};
  if (!code || !chatId) return json({ ok: false, error: 'Missing code or chatId' }, 400, req);
  if (!/^\d{6}$/.test(String(code))) return json({ ok: false, error: 'Code must be 6 digits' }, 400, req);
  await env.FB_KV.put(
    `codes:${code}`,
    JSON.stringify({ chatId: String(chatId), createdAt: Date.now() }),
    { expirationTtl: 600 },
  );
  return json({ ok: true }, 200, req);
}

async function handleIngest(req, env) {
  const auth = checkIngestAuth(req, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status, req);
  let payload;
  try { payload = await req.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON body' }, 400, req); }
  const { chatId, text, transaction } = payload || {};
  if (!chatId) return json({ ok: false, error: 'Missing chatId' }, 400, req);
  if (!text && !transaction) return json({ ok: false, error: 'Provide text and/or transaction' }, 400, req);
  const userId = await env.FB_KV.get(`chat2user:${String(chatId)}`);
  if (!userId) return json({ ok: false, error: 'chat not linked to any user' }, 404, req);
  const queueKey = `queue:${userId}`;
  const existing = JSON.parse((await env.FB_KV.get(queueKey)) || '[]');
  existing.push({ ts: Date.now(), text: text || '', transaction: transaction || null });
  await env.FB_KV.put(queueKey, JSON.stringify(existing.slice(-50)), { expirationTtl: 86400 });
  return json({ ok: true, userId, queued: true }, 200, req);
}

// ===========================================================================
// Router
// ===========================================================================
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return handleOptions(req);
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      return json({ ok: true, service: 'inputin-worker', version: 4 }, 200, req);
    }

    // Auth
    if (req.method === 'POST' && path === '/api/auth/request-link') return handleAuthRequestLink(req, env);
    if (req.method === 'POST' && path === '/api/auth/verify')       return handleAuthVerify(req, env);
    if (req.method === 'GET'  && path === '/api/auth/me')           return handleAuthMe(req, env);
    if (req.method === 'POST' && path === '/api/auth/signout')      return handleAuthSignout(req, env);
    if (req.method === 'POST' && path === '/api/auth/signout-all')  return handleAuthSignoutAll(req, env);

    // Sync (Phase 9: userId body/query also accepted, Bearer still works)
    if (req.method === 'POST' && path === '/api/sync/push')   return handleSyncPush(req, env);
    if (req.method === 'GET'  && path === '/api/sync/pull')   return handleSyncPull(req, env);
    if (req.method === 'GET'  && path === '/api/sync/status') return handleSyncStatus(req, env);

    // Phase 9: Device pairing
    if (req.method === 'POST' && path === '/api/pair/create') return handlePairCreate(req, env);
    if (req.method === 'POST' && path === '/api/pair/claim')  return handlePairClaim(req, env);

    // Phase 9: Admin gate
    if (req.method === 'POST' && path === '/api/admin/verify') return handleAdminVerify(req, env);

    // AI (now auth-gated + plan-tiered)
    if (req.method === 'POST' && path === '/api/ai/parse') return handleAiParse(req, env);

    // Telegram (kept server-side; UI removed client-side)
    if (req.method === 'POST' && path === '/api/tg/webhook') return handleTgWebhook(req, env);
    if (req.method === 'POST' && path === '/api/tg/link') return handleTgLink(req, env);
    if (req.method === 'GET'  && path.startsWith('/api/tg/pending/')) {
      const userId = decodeURIComponent(path.slice('/api/tg/pending/'.length));
      return handleTgPending(req, env, userId);
    }
    if (req.method === 'POST' && path === '/api/tg/register-code') return handleTgRegisterCode(req, env);
    if (req.method === 'POST' && path === '/api/ingest') return handleIngest(req, env);

    return json({ ok: false, error: 'Not found', path }, 404, req);
  },
};
