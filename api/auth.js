// Simpan sebagai: api/auth.js  (ganti file lama sepenuhnya)
// Memverifikasi Cloudflare Turnstile di server, membatasi percobaan, lalu masuk/daftar.
// Env yang dibutuhkan di Vercel: TURNSTILE_SECRET_KEY (wajib), FIREBASE_API_KEY (opsional)
const { getAdminServices } = require('../lib/firebase-admin');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyB7J4HeunqD28G_GdvIGgKdVIxniP48K08';
const BLOCKED_SIGNUP_DOMAIN = '@akun.ruang-obrol.app';
const WINDOW = 15 * 60 * 1000;
const COMMON_PW = ['password','password1','password123','12345678','123456789','1234567890','qwerty123','qwertyuiop','11111111','iloveyou1','admin123','abc12345','ruangobrol'];

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

// Pembatas percobaan memakai Realtime Database (tetap bekerja di serverless).
// Mengembalikan true jika masih boleh. Jika pembatas error, dibiarkan lolos agar login tidak mati.
async function rateLimit(db, key, max) {
  try {
    const safe = Buffer.from(String(key)).toString('base64url').slice(0, 120);
    const now = Date.now();
    let allowed = true;
    await db.ref('ratelimit/' + safe).transaction(cur => {
      cur = cur && now - cur.start < WINDOW ? cur : { start: now, n: 0 };
      cur.n += 1;
      allowed = cur.n <= max;
      return cur;
    });
    return allowed;
  } catch (e) {
    console.error('rateLimit:', e);
    return true;
  }
}

function passwordIssue(p, email) {
  if (p.length < 8) return 'Password minimal 8 karakter.';
  if (p.length > 128) return 'Password terlalu panjang.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password harus berisi huruf dan angka.';
  if (COMMON_PW.includes(p.toLowerCase())) return 'Password terlalu umum, pilih yang lain.';
  const local = String(email).split('@')[0];
  if (local.length >= 4 && p.toLowerCase().includes(local)) return 'Password tidak boleh mengandung emailmu.';
  return '';
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'Gunakan POST.' });
  try {
    const b = req.body || {};
    const mode = b.mode === 'up' ? 'up' : 'in';
    const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(b.password || '');
    const name = String(b.name || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 24);
    const cf = String(b.cf || '');
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

    const { auth, db } = getAdminServices();

    // 1) Batas percobaan per IP (sebelum memanggil Cloudflare)
    if (!(await rateLimit(db, 'auth-ip:' + ip, 20))) {
      return reply(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' });
    }

    // 2) Verifikasi Cloudflare Turnstile
    if (!cf) return reply(res, 400, { error: 'Selesaikan verifikasi Cloudflare dulu.' });
    const human = await verifyTurnstile(cf, ip);
    if (!human) return reply(res, 403, { error: 'Verifikasi Cloudflare gagal. Coba lagi.' });

    if (!email || !password) return reply(res, 400, { error: 'Isi email dan password.' });
    if (password.length > 128) return reply(res, 400, { error: 'Password terlalu panjang.' });

    if (mode === 'up') {
      if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.endsWith(BLOCKED_SIGNUP_DOMAIN)) {
        return reply(res, 400, { error: 'Format email tidak valid.' });
      }
      const pi = passwordIssue(password, email);
      if (pi) return reply(res, 400, { error: pi });
      if (name.length < 2) return reply(res, 400, { error: 'Nama harus 2 sampai 24 karakter.' });
      let user;
      try {
        user = await auth.createUser({ email, password, displayName: name, emailVerified: false });
      } catch (e) {
        if (e && e.code === 'auth/email-already-exists') return reply(res, 400, { error: 'Email sudah terdaftar. Silakan masuk.' });
        if (e && e.code === 'auth/invalid-password') return reply(res, 400, { error: 'Password terlalu lemah.' });
        if (e && e.code === 'auth/invalid-email') return reply(res, 400, { error: 'Format email tidak valid.' });
        throw e;
      }
      const token = await auth.createCustomToken(user.uid);
      return reply(res, 200, { token });
    }

    // Masuk: batas percobaan per akun (mencegah tebak password dari banyak IP)
    if (!(await rateLimit(db, 'auth-login:' + email, 8))) {
      return reply(res, 429, { error: 'Terlalu banyak percobaan untuk akun ini. Coba lagi beberapa menit lagi.' });
    }

    // Cek email + password ke Firebase, lalu buat custom token
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

    // Akun bermasa berlaku (managed) yang sudah habis ditolak di server juga
    try {
      const p = (await db.ref('users/' + d.localId).get()).val() || {};
      if (p.managed === true && p.expiresAt && Number(p.expiresAt) <= Date.now()) {
        return reply(res, 403, { error: 'Masa berlaku akun sudah habis.' });
      }
    } catch (e) { console.warn('cek masa berlaku:', e); }

    const token = await auth.createCustomToken(d.localId);
    return reply(res, 200, { token });
  } catch (e) {
    console.error('auth api:', e);
    const m = String((e && e.message) || '');
    if (m.includes('TURNSTILE_SECRET_KEY')) return reply(res, 500, { error: 'Server belum dikonfigurasi: TURNSTILE_SECRET_KEY kosong.' });
    if (m.includes('Cannot find module')) return reply(res, 500, { error: 'Server belum lengkap: file lib/firebase-admin tidak ditemukan.' });
    if (String((e && e.code) || '').includes('auth/') || m.includes('createCustomToken') || m.includes('signBlob') || m.includes('iam')) {
      return reply(res, 500, { error: 'Server tidak punya izin membuat token login (cek service account Firebase).' });
    }
    return reply(res, 500, { error: 'Server gagal memproses. Coba lagi.' });
  }
};
