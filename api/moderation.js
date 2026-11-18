
const { getAdminServices } = require('../lib/firebase-admin');

const DAY = 86400000;
const EDIT_WINDOW = 15 * 60 * 1000;
const MAX_DATA_CHARS = 1000000;
const MAX_FILE_BYTES = 750000;

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'lifxcdz@gmail.com')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

const TITLE_KEYS = [
  'member',
  'moderator',
  'developer',
  'founder',
  'verified',
  'helper',
  'support',
  'designer',
  'contributor',
  'eventhost',
  'vip'
];

function send(res, status, data) {
  return res.status(status).json(data);
}

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function validId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(value || ''));
}

function scan(value, depth = 0) {
  if (depth > 8) return 0;

  if (typeof value === 'string') {
    return value.length;
  }

  if (Array.isArray(value)) {
    return value.reduce((n, item) => n + scan(item, depth + 1), 0);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (n, [key, item]) => n + key.length + scan(item, depth + 1),
      0
    );
  }

  return 0;
}

function extraWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function restrictions(user, ban, jail) {
  const now = Date.now();

  if (ban && (!ban.expiresAt || Number(ban.expiresAt) > now)) {
    return {
      type: 'ban',
      reason: ban.reason || 'Akun diblokir oleh admin.',
      expiresAt: ban.expiresAt || null
    };
  }

  if (jail && Number(jail.until) > now) {
    return {
      type: 'jail',
      reason: jail.reason || 'Akun sedang dalam Jail.',
      until: jail.until
    };
  }

  return null;
}

async function recordViolation(db, uid, reason, now) {
  const ref = db.ref('moderation/warnings/' + uid);
  const snap = await ref.get();
  const old = snap.val() || {};

  const count = Number(old.count || 0) + 1;

  const data = {
    count,
    reason: clean(reason || 'Pelanggaran aturan', 200),
    updatedAt: now
  };

  await ref.set(data);

  return data;
}

function getDurationMinutes(value, fallback = 10) {
  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;

  return Math.max(1, Math.min(43200, Math.floor(number)));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method tidak diizinkan.' });
  }

  try {
    const services = getAdminServices();
    const db = services.db;
    const adminAuth = services.auth;

    if (!db || !adminAuth) {
      return send(res, 500, {
        error: 'Firebase Admin belum siap.'
      });
    }

    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';

    if (!token) {
      return send(res, 401, { error: 'Token login tidak ditemukan.' });
    }

    let user;

    try {
      user = await adminAuth.verifyIdToken(token);
    } catch (error) {
      return send(res, 401, { error: 'Sesi login tidak valid.' });
    }

    const uid = user.uid;
    const email = String(user.email || '').toLowerCase();
    const emailVerified = user.email_verified === true;

    const isAdmin = emailVerified && ADMIN_EMAILS.includes(email);

    const body = req.body || {};
    const action = clean(body.action, 60).toLowerCase();
    const now = Date.now();

    if (!action) {
      return send(res, 400, { error: 'Action tidak ditemukan.' });
    }

    const adminOnly = [
      'purge',
      'dismiss-report',
      'delete-report-message',
      'ban',
      'unban',
      'jail',
      'unjail',
      'reset-warnings',
      'set-title'
    ];

    if (adminOnly.includes(action) && !isAdmin) {
      return send(res, 403, { error: 'Khusus admin utama.' });
    }

    const target = clean(body.uid, 128);

    if (
      [
        'ban',
        'unban',
        'jail',
        'unjail',
        'reset-warnings',
        'set-title'
      ].includes(action)
    ) {
      if (!validId(target)) {
        return send(res, 400, { error: 'UID pengguna tidak valid.' });
      }

      if (target === uid) {
        return send(res, 400, {
          error: 'Kamu tidak dapat melakukan tindakan ini pada akun sendiri.'
        });
      }
    }

    // Kirim pesan
    if (action === 'send') {
      const text = clean(body.text, 2000);
      const type = clean(body.type || 'text', 30);

      const allowedTypes = [
        'text',
        'image',
        'file',
        'audio',
        'video'
      ];

      if (!allowedTypes.includes(type)) {
        return send(res, 400, { error: 'Jenis pesan tidak valid.' });
      }

      if (scan(body) > MAX_DATA_CHARS) {
        return send(res, 413, { error: 'Data pesan terlalu besar.' });
      }

      if (!text && !body.data) {
        return send(res, 400, { error: 'Pesan tidak boleh kosong.' });
      }

      if (body.data && String(body.data).length > MAX_FILE_BYTES * 2) {
        return send(res, 413, { error: 'File terlalu besar.' });
      }

      const [userSnap, banSnap, jailSnap] = await Promise.all([
        db.ref('users/' + uid).get(),
        db.ref('banned/' + uid).get(),
        db.ref('jail/' + uid).get()
      ]);

      const profile = userSnap.val() || {};
      const restriction = restrictions(
        user,
        banSnap.val(),
        jailSnap.val()
      );

      if (restriction) {
        return send(res, 403, {
          error: restriction.reason,
          moderation: restriction
        });
      }

      const message = {
        uid,
        name: clean(profile.name || user.name || 'Pengguna', 60),
        type,
        text,
        ts: now
      };

      if (body.data) message.data = body.data;
      if (body.fname) message.fname = clean(body.fname, 180);
      if (body.size) message.size = Math.max(0, Number(body.size) || 0);

      if (body.replyTo && validId(body.replyTo)) {
        message.reply = body.replyTo;
      }

      const badSnap = await db.ref('settings/badwords').get();
      const badWords = String(badSnap.val() || '')
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);

      const words = extraWords(text);
      const foundBadWord = words.some(word =>
        badWords.includes(word)
      );

      if (foundBadWord) {
        const warning = await recordViolation(
          db,
          uid,
          'Menggunakan kata yang masuk filter.',
          now
        );

        return send(res, 400, {
          error: 'Pesan mengandung kata yang tidak diperbolehkan.',
          moderation: {
            type: 'warning',
            count: warning.count,
            reason: warning.reason
          }
        });
      }

      const messageRef = db.ref('messages').push();
      await messageRef.set(message);

      return send(res, 200, {
        success: true,
        id: messageRef.key
      });
    }

    // Edit pesan
    if (action === 'edit') {
      const id = clean(body.id, 128);
      const text = clean(body.text, 2000);

      if (!validId(id) || !text) {
        return send(res, 400, { error: 'Data pesan tidak valid.' });
      }

      const messageRef = db.ref('messages/' + id);
      const snap = await messageRef.get();

      if (!snap.exists()) {
        return send(res, 404, { error: 'Pesan tidak ditemukan.' });
      }

      const message = snap.val() || {};

      if (message.uid !== uid && !isAdmin) {
        return send(res, 403, { error: 'Tidak memiliki izin mengedit.' });
      }

      if (
        !isAdmin &&
        now - Number(message.ts || 0) > EDIT_WINDOW
      ) {
        return send(res, 403, {
          error: 'Waktu untuk mengedit pesan sudah habis.'
        });
      }

      await messageRef.update({
        text,
        edited: true,
        editedAt: now
      });

      return send(res, 200, { success: true });
    }

    // Hapus pesan
    if (action === 'delete') {
      const id = clean(body.id, 128);

      if (!validId(id)) {
        return send(res, 400, { error: 'ID pesan tidak valid.' });
      }

      const messageRef = db.ref('messages/' + id);
      const snap = await messageRef.get();

      if (!snap.exists()) {
        return send(res, 404, { error: 'Pesan tidak ditemukan.' });
      }

      const message = snap.val() || {};

      if (message.uid !== uid && !isAdmin) {
        return send(res, 403, { error: 'Tidak memiliki izin menghapus.' });
      }

      await messageRef.remove();

      return send(res, 200, { success: true });
    }

    // Laporkan pesan
    if (action === 'report') {
      const id = clean(body.id, 128);
      const reason = clean(body.reason, 120);

      if (!validId(id) || !reason) {
        return send(res, 400, { error: 'Laporan tidak lengkap.' });
      }

      const messageSnap = await db.ref('messages/' + id).get();

      if (!messageSnap.exists()) {
        return send(res, 404, { error: 'Pesan tidak ditemukan.' });
      }

      const message = messageSnap.val() || {};

      if (message.uid === uid) {
        return send(res, 400, {
          error: 'Kamu tidak dapat melaporkan pesan sendiri.'
        });
      }

      const duplicate = await db.ref('reports')
        .orderByChild('by')
        .equalTo(uid)
        .get();

      let alreadyReported = false;

      duplicate.forEach(item => {
        const report = item.val() || {};
        if (report.msgId === id) alreadyReported = true;
      });

      if (alreadyReported) {
        return send(res, 409, {
          error: 'Pesan ini sudah pernah kamu laporkan.'
        });
      }

      const reportRef = db.ref('reports').push();

      await reportRef.set({
        msgId: id,
        msgUid: message.uid || '',
        msgName: clean(message.name || 'Pengguna', 60),
        msgText: clean(message.text || '', 500),
        by: uid,
        byName: clean(user.name || email || 'Pengguna', 60),
        reason,
        ts: now
      });

      return send(res, 200, {
        success: true,
        reportId: reportRef.key
      });
    }

    // Hapus semua pesan
    if (action === 'purge') {
      const messagesRef = db.ref('messages');
      const snap = await messagesRef.get();

      if (!snap.exists()) {
        return send(res, 200, {
          success: true,
          deleted: 0
        });
      }

      const data = snap.val() || {};
      const updates = {};
      let deleted = 0;

      Object.keys(data).forEach(id => {
        updates[id] = null;
        deleted++;
      });

      await messagesRef.update(updates);

      await db.ref('moderation/logs').push({
        action: 'purge',
        adminUid: uid,
        deleted,
        createdAt: now
      });

      return send(res, 200, {
        success: true,
        deleted
      });
    }

    // Abaikan laporan
    if (action === 'dismiss-report') {
      const reportId = clean(body.reportId, 128);

      if (!validId(reportId)) {
        return send(res, 400, { error: 'ID laporan tidak valid.' });
      }

      await db.ref('reports/' + reportId).remove();

      await db.ref('moderation/logs').push({
        action: 'dismiss-report',
        reportId,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, { success: true });
    }

    // Hapus pesan melalui laporan
    if (action === 'delete-report-message') {
      const reportId = clean(body.reportId, 128);

      if (!validId(reportId)) {
        return send(res, 400, { error: 'ID laporan tidak valid.' });
      }

      const reportRef = db.ref('reports/' + reportId);
      const reportSnap = await reportRef.get();

      if (!reportSnap.exists()) {
        return send(res, 404, { error: 'Laporan tidak ditemukan.' });
      }

      const report = reportSnap.val() || {};

      if (validId(report.msgId)) {
        await db.ref('messages/' + report.msgId).remove();
      }

      await reportRef.remove();

      await db.ref('moderation/logs').push({
        action: 'delete-report-message',
        reportId,
        messageId: report.msgId || null,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, { success: true });
    }

    // Ban akun
    if (action === 'ban') {
      const minutes = getDurationMinutes(body.minutes, 1440);
      const reason = clean(body.reason || 'Pelanggaran aturan', 200);
      const expiresAt = body.permanent === true
        ? null
        : now + minutes * 60000;

      const banData = {
        reason,
        by: uid,
        createdAt: now,
        expiresAt
      };

      await db.ref('banned/' + target).set(banData);

      await db.ref('moderation/logs').push({
        action: 'ban',
        uid: target,
        reason,
        expiresAt,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, {
        success: true,
        expiresAt
      });
    }

    // Buka ban
    if (action === 'unban') {
      await db.ref('banned/' + target).remove();

      await db.ref('moderation/logs').push({
        action: 'unban',
        uid: target,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, { success: true });
    }

    // Jail akun
    if (action === 'jail') {
      const minutes = getDurationMinutes(body.minutes, 10);
      const reason = clean(body.reason || 'Pelanggaran aturan', 200);
      const until = now + minutes * 60000;

      await db.ref('jail/' + target).set({
        reason,
        by: uid,
        createdAt: now,
        until
      });

      await db.ref('moderation/logs').push({
        action: 'jail',
        uid: target,
        reason,
        until,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, {
        success: true,
        until
      });
    }

    // Lepas Jail
    if (action === 'unjail') {
      await db.ref('jail/' + target).remove();

      await db.ref('moderation/logs').push({
        action: 'unjail',
        uid: target,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, { success: true });
    }

    // Reset peringatan
    if (action === 'reset-warnings') {
      await db.ref('moderation/warnings/' + target).remove();

      await db.ref('moderation/logs').push({
        action: 'reset-warnings',
        uid: target,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, { success: true });
    }

    // Tambah atau cabut title
    if (action === 'set-title') {
      const title = clean(body.title, 40).toLowerCase();

      if (!TITLE_KEYS.includes(title)) {
        return send(res, 400, { error: 'Title tidak valid.' });
      }

      const userRef = db.ref('users/' + target);
      const userSnap = await userRef.get();

      if (!userSnap.exists()) {
        return send(res, 404, { error: 'Pengguna tidak ditemukan.' });
      }

      const profile = userSnap.val() || {};
      const titles = {
        ...(profile.titles || {})
      };

      // Migrasikan title lama ke struktur titles.
      if (profile.title && profile.title !== 'member') {
        titles[profile.title] = true;
      }

      if (body.revoke === true) {
        delete titles[title];
      } else if (title !== 'member') {
        titles[title] = true;
      }

      await userRef.update({
        title: null,
        titles: Object.keys(titles).length ? titles : null,
        titleUpdatedAt: now,
        titleUpdatedBy: uid
      });

      await db.ref('moderation/logs').push({
        uid: target,
        action: body.revoke === true ? 'revoke-title' : 'set-title',
        title,
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, {
        success: true,
        revoked: body.revoke === true,
        title
      });
    }

    return send(res, 400, {
      error: 'Action tidak dikenal: ' + action
    });

  } catch (error) {
    console.error('[moderation]', error);

    return send(res, 500, {
      error: 'Terjadi kesalahan pada server moderasi.'
    });
  }
};
