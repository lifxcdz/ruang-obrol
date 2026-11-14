// Simpan sebagai: api/auth.js
// Memverifikasi Cloudflare Turnstile di server, lalu masuk/daftar.
// Env yang dibutuhkan di Vercel: TURNSTILE_SECRET_KEY (wajib), FIREBASE_API_KEY (opsional)
const { getAdminServices } = require('../lib/firebase-admin');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyB7J4HeunqD28G_GdvIGgKdVIxniP48K08';
const BLOCKED_SIGNUP_DOMAIN = '@akun.ruang-obrol.app';

function reply(res, status, data) { return res.status(status).json(data); }

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new Error('TURNSTILE_SECRET_KEY belum diisi.');
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const d = await r.json().catch(() => ({}));
  return !!d.success;
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'Gunakan POST.' });
  try {
    const b = req.body || {};
    const mode = b.mode === 'up' ? 'up' : 'in';
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = String(b.name || '').trim().slice(0, 24);
    const cf = String(b.cf || '');

    if (!cf) return reply(res, 400, { error: 'Selesaikan verifikasi Cloudflare dulu.' });
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const human = await verifyTurnstile(cf, ip);
    if (!human) return reply(res, 403, { error: 'Verifikasi Cloudflare gagal. Coba lagi.' });

    if (!email || !password) return reply(res, 400, { error: 'Isi email dan password.' });
    const { auth } = getAdminServices();

    if (mode === 'up') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith(BLOCKED_SIGNUP_DOMAIN)) {
        return reply(res, 400, { error: 'Format email tidak valid.' });
      }
      if (password.length < 6) return reply(res, 400, { error: 'Password minimal 6 karakter.' });
      if (!name) return reply(res, 400, { error: 'Isi nama.' });
      let user;
      try {
        user = await auth.createUser({ email, password, displayName: name, emailVerified: false });
      } catch (e) {
        if (e && e.code === 'auth/email-already-exists') return reply(res, 400, { error: 'Email sudah terdaftar. Silakan masuk.' });
        if (e && e.code === 'auth/invalid-password') return reply(res, 400, { error: 'Password minimal 6 karakter.' });
        if (e && e.code === 'auth/invalid-email') return reply(res, 400, { error: 'Format email tidak valid.' });
        throw e;
      }
      const token = await auth.createCustomToken(user.uid);
      return reply(res, 200, { token });
    }

    // Masuk: cek email + password ke Firebase, lalu buat custom token
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FIREBASE_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.localId) {
      const msg = String((d.error && d.error.message) || '');
      if (msg.includes('TOO_MANY_ATTEMPTS')) return reply(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' });
      return reply(res, 400, { error: 'Email atau password salah.' });
    }
    const token = await auth.createCustomToken(d.localId);
    return reply(res, 200, { token });
  } catch (e) {
    console.error('auth api:', e);
    return reply(res, 500, { error: 'Server gagal memproses. Coba lagi.' });
  }
};
