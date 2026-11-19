// /api/accounts : cek akun Firebase Auth vs data pengguna di Realtime Database.
// Hanya admin (email di ADMIN_EMAILS atau akun bertitle admin) yang boleh memakai.
//
// Env yang dipakai (samakan dengan yang sudah ada di project kamu):
//   FIREBASE_SERVICE_ACCOUNT  = isi JSON service account (satu baris)
//     atau FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//   FIREBASE_DATABASE_URL     = opsional, default URL database Ruang Obrol
//   ADMIN_EMAILS              = opsional, pisahkan dengan koma (default lifxcdz@gmail.com)
//
// Butuh paket "firebase-admin" di package.json. Jika project memakai "type":"module",
// ganti baris module.exports di bawah menjadi: export default async function handler(req,res){...}

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');

const DB_URL = process.env.FIREBASE_DATABASE_URL || 'https://ruang-obrol-default-rtdb.asia-southeast1.firebasedatabase.app';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'lifxcdz@gmail.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function init() {
  if (getApps().length) return;
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT
    ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    : cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      });
  initializeApp({ credential, databaseURL: DB_URL });
}

async function isAdmin(db, decoded) {
  const email = String(decoded.email || '').toLowerCase();
  if (decoded.email_verified && ADMIN_EMAILS.includes(email)) return true;
  const t = (await db.ref('users/' + decoded.uid + '/titles/admin').get()).val();
  return decoded.email_verified === true && t === true;
}

async function audit(db, auth) {
  const users = (await db.ref('users').get()).val() || {};
  const dbIds = Object.keys(users);

  const authUsers = new Map();
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    page.users.forEach(u => authUsers.set(u.uid, u));
    token = page.pageToken;
  } while (token);

  const orphans = dbIds
    .filter(id => !authUsers.has(id))
    .map(id => ({ uid: id, name: users[id].name || '', joinedAt: users[id].joinedAt || null }));
  const noProfile = [...authUsers.values()]
    .filter(u => !users[u.uid])
    .map(u => ({ uid: u.uid, email: u.email || '', verified: !!u.emailVerified, createdAt: Date.parse(u.metadata.creationTime) || null }));
  return { registered: dbIds.length - orphans.length, orphans, noProfile };
}

async function cleanup(db, uid) {
  const up = {};
  ['users', 'private', 'presence', 'typing', 'reads', 'banned', 'jail', 'userInvites', 'roles'].forEach(p => { up[p + '/' + uid] = null; });

  // percakapan pribadi: hapus juga entri di daftar lawan bicara
  const dmIdx = (await db.ref('dmIndex/' + uid).get()).val() || {};
  Object.keys(dmIdx).forEach(other => { if (other !== uid) up['dmIndex/' + other + '/' + uid] = null; });
  up['dmIndex/' + uid] = null;

  // keanggotaan grup
  const ug = (await db.ref('userGroups/' + uid).get()).val() || {};
  for (const gid of Object.keys(ug)) {
    const info = (await db.ref('groups/' + gid + '/info').get()).val();
    if (!info) continue;
    if (info.owner === uid) {
      // pemilik sudah tidak ada: grup dihapus
      const members = (await db.ref('groups/' + gid + '/members').get()).val() || {};
      up['groups/' + gid] = null;
      up['groupMsgs/' + gid] = null;
      up['groupCodes/' + gid] = null;
      Object.keys(members).forEach(m => { if (m !== uid) up['userGroups/' + m + '/' + gid] = null; });
    } else {
      const cnt = Number((await db.ref('groups/' + gid + '/count').get()).val()) || 1;
      up['groups/' + gid + '/members/' + uid] = null;
      up['groups/' + gid + '/count'] = Math.max(1, cnt - 1);
    }
  }
  up['userGroups/' + uid] = null;
  await db.ref().update(up);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode tidak didukung.' });
  try {
    init();
    const auth = getAuth();
    const db = getDatabase();

    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'Perlu login.' });
    let decoded;
    try { decoded = await auth.verifyIdToken(m[1]); } catch (e) { return res.status(401).json({ error: 'Sesi tidak valid.' }); }
    if (!(await isAdmin(db, decoded))) return res.status(403).json({ error: 'Khusus admin.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.action === 'audit') return res.status(200).json(await audit(db, auth));

    if (body.action === 'purge') {
      // daftar dihitung ulang di server, tidak memakai daftar dari browser
      const { orphans } = await audit(db, auth);
      const purged = [];
      for (const o of orphans) {
        if (o.uid === decoded.uid) continue;
        await cleanup(db, o.uid);
        purged.push(o.uid);
      }
      return res.status(200).json({ ok: true, purged });
    }
    return res.status(400).json({ error: 'Aksi tidak dikenal.' });
  } catch (e) {
    console.error('accounts api', e);
    return res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  }
};
