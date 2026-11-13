const { getAdminServices } = require('../lib/firebase-admin');

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const { auth, db } = getAdminServices();
    const now = Date.now();
    const snapshot = await db.ref('users').orderByChild('expiresAt').endAt(now).get();
    let deleted = 0;
    const jobs = [];

    snapshot.forEach(child => {
      const user = child.val() || {};
      if (user.managed !== true || !Number(user.expiresAt) || Number(user.expiresAt) > now) return;
      const uid = child.key;
      jobs.push((async () => {
        await auth.deleteUser(uid).catch(error => {
          if (error.code !== 'auth/user-not-found') throw error;
        });
        await Promise.all([
          db.ref(`users/${uid}`).remove(),
          db.ref(`private/${uid}`).remove(),
          db.ref(`banned/${uid}`).remove()
        ]);
        deleted += 1;
      })());
    });

    await Promise.all(jobs);
    return res.status(200).json({ success: true, deleted, checkedAt: now });
  } catch (error) {
    console.error('cleanup-expired failed:', error);
    return res.status(500).json({ error: 'Pembersihan akun kedaluwarsa gagal.' });
  }
};
