// /api/captcha : cek token reCAPTCHA dari browser (dipakai untuk ganti password).
const { verifyRecaptcha } = require('./_recaptcha');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode tidak didukung.' });
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (e) { /* abaikan */ }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined;
  const r = await verifyRecaptcha(body.token, ip);
  if (!r.ok) return res.status(400).json({ error: r.error });
  return res.status(200).json({ ok: true });
};
