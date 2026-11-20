// Vercel Serverless: kirim email verifikasi bertema (bukan template bawaan Firebase)
// Env: FIREBASE_SERVICE_ACCOUNT (JSON), SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM_NAME (opsional)
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html(name, link) {
  return `<!doctype html><html><body style="margin:0;background:#070f35;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:460px;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#070f35;padding:26px;text-align:center;color:#9bd000;font-size:22px;font-weight:800;letter-spacing:.5px">Ruang Obrol</td></tr>
<tr><td style="padding:28px 26px;color:#070f35;text-align:center">
<h2 style="margin:0 0 10px;font-size:20px">Verifikasi email kamu</h2>
<p style="margin:0 0 22px;color:#4b5a7a;font-size:15px;line-height:1.5">Halo ${esc(name) || 'teman'}, ketuk tombol di bawah untuk mengaktifkan akun Ruang Obrol kamu.</p>
<a href="${link}" style="display:inline-block;background:#9bd000;color:#070f35;text-decoration:none;font-weight:800;font-size:16px;padding:14px 34px;border-radius:12px">Verifikasi</a>
<p style="margin:22px 0 0;color:#8a96b0;font-size:12px;line-height:1.5">Jika kamu tidak mendaftar di Ruang Obrol, abaikan saja email ini.</p>
</td></tr></table></td></tr></table></body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method tidak diizinkan.' });
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const dec = await admin.auth().verifyIdToken(token);
    const user = await admin.auth().getUser(dec.uid);
    if (!user.email) return res.status(400).json({ error: 'Akun tidak punya email.' });
    if (user.emailVerified) return res.status(200).json({ ok: true });

    const link = await admin.auth().generateEmailVerificationLink(user.email);
    const tr = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await tr.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'Ruang Obrol'}" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: 'Verifikasi akun Ruang Obrol',
      text: `Halo ${user.displayName || ''}, verifikasi akun kamu di sini: ${link}`,
      html: html(user.displayName, link)
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('send-verification', e);
    res.status(500).json({ error: 'Email verifikasi gagal dikirim.' });
  }
};
