const crypto = require('node:crypto');
const { getAdminServices, verifyAdmin } = require('../lib/firebase-admin');

const EMAIL_DOMAIN = process.env.MANAGED_ACCOUNT_EMAIL_DOMAIN || 'akun.ruang-obrol.app';
const DAY_MS = 24 * 60 * 60 * 1000;

function send(res, status, body) {
  res.status(status).json(body);
}

function makePassword() {
  return crypto.randomBytes(12).toString('base64url') + 'A1!';
}

function safeBase(value) {
  const base = String(value || '').trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 18);
  if (!base) {
    const error = new Error('Nama dasar hanya boleh berisi huruf dan angka.');
    error.status = 400;
    throw error;
  }
  return base;
}

async function createAccounts(auth, db, body) {
  const base = safeBase(body.base);
  const count = Number(body.count);
  const durationDays = Number(body.durationDays);
  const sharedPassword = body.password ? String(body.password) : null;

  if (!Number.isInteger(count) || count < 1 || count > 50) {
    const error = new Error('Jumlah akun harus 1 sampai 50.'); error.status = 400; throw error;
  }
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
    const error = new Error('Masa berlaku harus 1 sampai 3650 hari.'); error.status = 400; throw error;
  }
  if (sharedPassword && sharedPassword.length < 6) {
    const error = new Error('Password minimal 6 karakter.'); error.status = 400; throw error;
  }

  const expiresAt = Date.now() + durationDays * DAY_MS;
  const accounts = [];
  let suffix = 1;
  try {
    while (accounts.length < count) {
      if (suffix > 100000) throw new Error('Tidak berhasil menemukan nama akun yang tersedia.');
      const name = `${base}${suffix++}`;
      const username = name.toLowerCase();
      const email = `${username}@${EMAIL_DOMAIN}`;

      try {
        await auth.getUserByEmail(email);
        continue;
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
      }

      const password = sharedPassword || makePassword();
      const user = await auth.createUser({
        email,
        password,
        displayName: name,
        emailVerified: true,
        disabled: false
      });

      try {
        await Promise.all([
          db.ref(`users/${user.uid}`).set({
            name,
            managed: true,
            username,
            expiresAt,
            createdAt: Date.now()
          }),
          db.ref(`private/${user.uid}`).set({ email, managed: true })
        ]);
      } catch (error) {
        await auth.deleteUser(user.uid).catch(() => {});
        throw error;
      }

      accounts.push({ uid: user.uid, name, username, email, password, expiresAt });
    }
  } catch (error) {
    await Promise.all(accounts.map(async account => {
      await auth.deleteUser(account.uid).catch(() => {});
      await Promise.all([
        db.ref(`users/${account.uid}`).remove().catch(() => {}),
        db.ref(`private/${account.uid}`).remove().catch(() => {})
      ]);
    }));
    throw error;
  }
  return accounts;
}

async function deleteManagedAccount(auth, db, uid) {
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(uid)) {
    const error = new Error('ID akun tidak valid.'); error.status = 400; throw error;
  }
  const snap = await db.ref(`users/${uid}`).get();
  if (!snap.exists() || snap.val().managed !== true) {
    const error = new Error('Akun ini bukan akun hasil generator.'); error.status = 409; throw error;
  }
  await auth.deleteUser(uid).catch(error => {
    if (error.code !== 'auth/user-not-found') throw error;
  });
  await Promise.all([
    db.ref(`users/${uid}`).remove(),
    db.ref(`private/${uid}`).remove(),
    db.ref(`banned/${uid}`).remove()
  ]);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Gunakan metode POST.' });
  try {
    const { auth, db } = getAdminServices();
    await verifyAdmin(req, auth);
    const action = String(req.body && req.body.action || '');

    if (action === 'create') {
      const accounts = await createAccounts(auth, db, req.body || {});
      return send(res, 200, { accounts });
    }
    if (action === 'delete') {
      await deleteManagedAccount(auth, db, String(req.body && req.body.uid || ''));
      return send(res, 200, { success: true });
    }
    return send(res, 400, { error: 'Aksi tidak dikenal.' });
  } catch (error) {
    const status = Number(error.status) || 500;
    return send(res, status, {
      error: status >= 500 ? 'Server gagal memproses permintaan. Periksa Environment Variables dan Vercel Function Logs.' : error.message,
      code: error.code || 'SERVER_ERROR'
    });
  }
};
