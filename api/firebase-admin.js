const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');

function getAdminServices() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Environment variable FIREBASE_SERVICE_ACCOUNT belum diatur di Vercel.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT bukan JSON service account yang valid.');
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
        credential: cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://ruang-obrol-default-rtdb.asia-southeast1.firebasedatabase.app'
      });

  return { auth: getAuth(app), db: getDatabase(app) };
}

async function verifyAdmin(req, auth) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Sesi admin tidak ditemukan. Silakan masuk ulang.');
    error.status = 401;
    throw error;
  }

  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1], true);
  } catch {
    const error = new Error('Sesi login tidak valid atau sudah kedaluwarsa.');
    error.status = 401;
    throw error;
  }

  const adminEmails = (process.env.ADMIN_EMAILS || 'lifxcdz@gmail.com')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!decoded.email || !adminEmails.includes(decoded.email.toLowerCase())) {
    const error = new Error('Akses ditolak. Akun ini bukan admin.');
    error.status = 403;
    throw error;
  }
  return decoded;
}

module.exports = { getAdminServices, verifyAdmin };
