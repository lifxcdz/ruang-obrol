// Vercel serverless: kirim email verifikasi dengan TOMBOL (bukan link mentah).
// Env yang dibutuhkan di Vercel:
//   FIREBASE_SERVICE_ACCOUNT = isi JSON service account (satu baris)
//   RESEND_API_KEY           = API key dari resend.com
//   MAIL_FROM                = contoh: Ruang Obrol <noreply@domainmu.com> (domain harus terverifikasi di Resend)
// Paket: npm i firebase-admin resend
import admin from 'firebase-admin';
import { Resend } from 'resend';

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const resend = new Resend(process.env.RESEND_API_KEY);
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const decoded = await admin.auth().verifyIdToken(token);
    const user = await admin.auth().getUser(decoded.uid);
    if (!user.email) return res.status(400).json({ error: 'Akun tidak punya email.' });
    if (user.emailVerified) return res.json({ ok: true, already: true });

    const link = await admin.auth().generateEmailVerificationLink(user.email);
    const name = esc(user.displayName || '');

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f6fc">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6fc;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:440px;background:#ffffff;border-radius:20px;padding:32px 26px;font-family:Arial,Helvetica,sans-serif;text-align:center">
<tr><td style="font-size:24px;font-weight:700;color:#142038;padding-bottom:6px">Ruang Obrol</td></tr>
<tr><td style="font-size:16px;color:#142038;padding-bottom:8px">Halo${name ? ', ' + name : ''}!</td></tr>
<tr><td style="font-size:14px;line-height:1.6;color:#5b6b88;padding-bottom:24px">Ketuk tombol di bawah untuk memverifikasi email dan mengaktifkan akunmu.</td></tr>
<tr><td align="center" style="padding-bottom:24px">
<a href="${link}" style="display:inline-block;background:#2868e8;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:15px 38px;border-radius:13px">Verifikasi Email</a>
</td></tr>
<tr><td style="font-size:12px;line-height:1.6;color:#8a97b0">Kalau bukan kamu yang mendaftar, abaikan email ini.</td></tr>
</table></td></tr></table></body></html>`;

    const { error } = await resend.emails.send({
      from: process.env.MAIL_FROM || 'Ruang Obrol <onboarding@resend.dev>',
      to: user.email,
      subject: 'Verifikasi akun Ruang Obrol',
      html,
      text: 'Verifikasi akun Ruang Obrol: ' + link
    });
    if (error) throw new Error(error.message || 'kirim gagal');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Gagal mengirim email verifikasi.' });
  }
}
