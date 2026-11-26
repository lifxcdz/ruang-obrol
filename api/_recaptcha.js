// Helper verifikasi Google reCAPTCHA (v2). Berawalan "_" jadi tidak menjadi endpoint publik di Vercel.
// Secret key dibaca dari environment variable RECAPTCHA_SECRET_KEY (diatur di Vercel, JANGAN ditulis di kode).
//
// Pemakaian di api/auth.js, ganti blok verifikasi Turnstile (fetch ke challenges.cloudflare.com) dengan:
//   const { verifyRecaptcha } = require('./_recaptcha');
//   const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined;
//   const cap = await verifyRecaptcha(body.cf, ip);
//   if (!cap.ok) return res.status(400).json({ error: cap.error });
// Jika project memakai ES module ("type":"module"), ganti require dan module.exports dengan import dan export.

async function verifyRecaptcha(token, remoteip) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return { ok: false, error: 'RECAPTCHA_SECRET_KEY belum diatur di server.' };
  if (!token || typeof token !== 'string' || token.length > 4096) return { ok: false, error: 'Centang reCAPTCHA dulu.' };

  const params = new URLSearchParams({ secret, response: token });
  if (remoteip) params.set('remoteip', remoteip);

  try {
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const d = await r.json();
    if (d && d.success) return { ok: true };
    // contoh kode: invalid-input-secret (secret salah), timeout-or-duplicate (token dipakai ulang atau kedaluwarsa)
    console.warn('reCAPTCHA ditolak:', d && d['error-codes']);
    return { ok: false, error: 'Verifikasi reCAPTCHA gagal. Coba lagi.', codes: (d && d['error-codes']) || [] };
  } catch (e) {
    console.error('reCAPTCHA error', e);
    return { ok: false, error: 'Tidak bisa menghubungi layanan reCAPTCHA.' };
  }
}

module.exports = { verifyRecaptcha };
