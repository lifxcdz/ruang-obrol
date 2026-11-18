
const { getAdminServices, verifyUser, isAdmin } = require('../lib/firebase-admin');

const DAY = 86400000;
const EDIT_WINDOW = 15 * 60 * 1000;
const MAX_DATA_CHARS = 1000000;
const MAX_FILE_BYTES = 750000;

const send = (res, status, data) => res.status(status).json(data);

const clean = (v, max = 2000) =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);

const validId = v => /^[-\w]{8,40}$/.test(String(v || ''));

function scan(text, words = []) {
  const normalized = String(text || '').toLowerCase().normalize('NFKC');

  const defaults = [
    'kontol', 'memek', 'ngentot', 'jancuk', 'anjing',
    'bangsat', 'bajingan', 'goblok', 'tolol', 'asu'
  ];

  const all = [...defaults, ...words]
    .map(x => String(x).toLowerCase())
    .filter(Boolean);

  const found = all.some(word => {
    const escaped = word
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s*');

    return new RegExp(
      '(^|[^a-z0-9])' + escaped + '($|[^a-z0-9])',
      'i'
    ).test(normalized);
  });

  const threat =
    /\b(mati(kan)? kamu|bunuh kamu|akan membunuh|ancam(an)? bunuh)\b/i.test(normalized);

  const spam = /(.)\1{9,}/.test(normalized);

  return {
    blocked: found || threat || spam,
    reason: threat
      ? 'Ancaman terhadap pengguna'
      : spam
        ? 'Spam karakter berulang'
        : 'Bahasa kasar atau kata terlarang',
    score: threat ? 3 : (found || spam ? 1 : 0)
  };
}

async function extraWords(db) {
  const s = await db.ref('settings/badwords').get();

  return String(s.val() || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 200);
}

async function restrictions(db, uid, now, admin) {
  if (admin) return;

  const [b, j, lock] = await Promise.all([
    db.ref('banned/' + uid).get(),
    db.ref('jail/' + uid).get(),
    db.ref('settings/locked').get()
  ]);

  const ban = b.val();
  const jail = j.val();

  if (ban && (!ban.expiresAt || Number(ban.expiresAt) > now)) {
    const e = new Error('Akun sedang diblokir.');
    e.status = 403;
    throw e;
  }

  if (jail && Number(jail.until) > now) {
    const e = new Error('Akun sedang dalam Jail.');
    e.status = 403;
    throw e;
  }

  if (lock.val() === true) {
    const e = new Error('Chat sedang dikunci admin.');
    e.status = 403;
    throw e;
  }
}

async function recordViolation(db, uid, reason, score, now) {
  const ref = db.ref('moderation/users/' + uid);
  const snap = await ref.get();

  const warnings =
    (Number((snap.val() || {}).warnings) || 0) + 1;

  let action = 'warning';
  let until = null;

  const record = {
    uid,
    reason,
    score,
    warnings,
    createdAt: now,
    source: 'bot'
  };

  if (score >= 3 || warnings >= 3) {
    action = score >= 3 ? 'jail' : 'ban';

    until = now + (
      action === 'jail'
        ? 10 * 60000
        : DAY
    );

    if (action === 'jail') {
      await db.ref('jail/' + uid).set({
        ...record,
        until
      });
    } else {
      await db.ref('banned/' + uid).set({
        ...record,
        expiresAt: until,
        type: 'temporary'
      });
    }
  } else if (warnings >= 2) {
    action = 'jail';
    until = now + 5 * 60000;

    await db.ref('jail/' + uid).set({
      ...record,
      until
    });
  }

  await ref.update({
    warnings,
    lastAction: action,
    lastAt: now
  });

  await db.ref('moderation/logs').push({
    ...record,
    action,
    until
  });

  return { action, reason, until };
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Gunakan POST.' });
  }

  try {
    const { auth, db } = getAdminServices();

    const user = await verifyUser(req, auth, true);
    const uid = user.uid;
    const admin = isAdmin(user);

    const body =
      req.body && typeof req.body === 'object'
        ? req.body
        : {};

    const action = String(body.action || 'send');
    const now = Date.now();

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

    if (adminOnly.includes(action) && !admin) {
      return send(res, 403, {
        error: 'Akses admin diperlukan.'
      });
    }

    // KIRIM PESAN
    if (action === 'send') {
      await restrictions(db, uid, now, admin);

      const type = ['text', 'image', 'file'].includes(body.type)
        ? body.type
        : 'text';

      const text = clean(body.text, 2000);
      const data = typeof body.data === 'string' ? body.data : '';

      const fname = clean(body.fname, 120)
        .replace(/[\\/]/g, '_');

      const size = Math.max(0, Number(body.size) || 0);
      const mime = clean(body.mime, 120);

      if (type === 'text' && !text) {
        return send(res, 400, { error: 'Pesan kosong.' });
      }

      if ((type === 'image' || type === 'file') && !data) {
        return send(res, 400, {
          error: 'Lampiran tidak ditemukan.'
        });
      }

      if (data.length > MAX_DATA_CHARS) {
        return send(res, 413, {
          error: 'Lampiran terlalu besar.'
        });
      }

      if (
        type === 'image' &&
        !/^data:image\/(jpeg|png|webp);base64,/i.test(data)
      ) {
        return send(res, 400, {
          error: 'Format gambar tidak didukung.'
        });
      }

      if (
        type === 'file' &&
        (
          size > MAX_FILE_BYTES ||
          !/^data:[\w.+-]+\/[\w.+-]+;base64,/i.test(data)
        )
      ) {
        return send(res, 413, {
          error: 'File terlalu besar atau format tidak valid.'
        });
      }

      if (!admin && text) {
        const result = scan(text, await extraWords(db));

        if (result.blocked) {
          const moderation = await recordViolation(
            db,
            uid,
            result.reason,
            result.score || 1,
            now
          );

          return send(res, 422, {
            error: 'Pesan tidak dikirim karena mengandung kata yang tidak diizinkan. Silakan ubah pesanmu.',
            moderation
          });
        }
      }

      const profile =
        (await db.ref('users/' + uid).get()).val() || {};

      if (
        profile.managed === true &&
        profile.expiresAt &&
        Number(profile.expiresAt) <= now
      ) {
        return send(res, 403, {
          error: 'Masa berlaku akun sudah habis.'
        });
      }

      let quote = null;

      if (validId(body.replyTo)) {
        const rs = await db.ref('messages/' + body.replyTo).get();

        if (rs.exists()) {
          const m = rs.val();

          quote = {
            id: body.replyTo,
            name: clean(m.name || 'Pengguna', 24),
            text: clean(
              m.text || (m.type === 'image' ? 'Foto' : 'Lampiran'),
              80
            )
          };
        }
      }

      const payload = {
        uid,
        name: clean(
          profile.name ||
          user.name ||
          (user.email || 'pengguna').split('@')[0],
          24
        ),
        ts: now,
        type,
        ...(text ? { text } : {}),
        ...(data ? { data } : {}),
        ...(type === 'file' ? { fname, size, mime } : {}),
        ...(admin ? { admin: true } : {}),
        ...(quote ? { reply: quote } : {})
      };

      const messageRef = db.ref('messages').push();

      await messageRef.set(payload);

      return send(res, 200, {
        success: true,
        id: messageRef.key
      });
    }

    // EDIT DAN HAPUS PESAN
    if (action === 'edit' || action === 'delete') {
      const id = String(body.id || '');

      if (!validId(id)) {
        return send(res, 400, {
          error: 'ID pesan tidak valid.'
        });
      }

      const ref = db.ref('messages/' + id);
      const snap = await ref.get();

      if (!snap.exists()) {
        return send(res, 404, {
          error: 'Pesan tidak ditemukan.'
        });
      }

      const msg = snap.val();

      if (msg.uid !== uid && !admin) {
        return send(res, 403, {
          error: 'Tidak boleh mengubah pesan ini.'
        });
      }

      if (action === 'delete') {
        await ref.remove();

        return send(res, 200, { success: true });
      }

      const text = clean(body.text, 2000);

      if (!text) {
        return send(res, 400, { error: 'Pesan kosong.' });
      }

      if (
        !admin &&
        now - Number(msg.ts || 0) > EDIT_WINDOW
      ) {
        return send(res, 403, {
          error: 'Waktu mengedit sudah lewat (15 menit).'
        });
      }

      await restrictions(db, uid, now, admin);

      if (!admin && scan(text, await extraWords(db)).blocked) {
        return send(res, 422, {
          error: 'Pesan mengandung kata yang tidak diizinkan.'
        });
      }

      await ref.update({
        text,
        edited: true,
        editedAt: now
      });

      return send(res, 200, { success: true });
    }

    // LAPORAN
    if (action === 'report') {
      const id = String(body.id || '');
      const reason = clean(body.reason, 120);

      if (!validId(id) || !reason) {
        return send(res, 400, {
          error: 'ID pesan dan alasan laporan wajib diisi.'
        });
      }

      const snap = await db.ref('messages/' + id).get();

      if (!snap.exists()) {
        return send(res, 404, {
          error: 'Pesan tidak ditemukan.'
        });
      }

      const m = snap.val();

      if (m.uid === uid) {
        return send(res, 400, {
          error: 'Kamu tidak bisa melaporkan pesan sendiri.'
        });
      }

      await db.ref('reports').push({
        msgId: id,
        msgUid: m.uid,
        msgName: clean(m.name, 24),
        msgText: clean(
          m.text || (m.type === 'image' ? 'Foto' : 'Lampiran'),
          120
        ),
        by: uid,
        byName: clean(
          user.name || (user.email || '').split('@')[0],
          24
        ),
        reason,
        ts: now
      });

      return send(res, 200, { success: true });
    }

    // HAPUS SEMUA PESAN
    if (action === 'purge') {
      await db.ref('messages').remove();
      await db.ref('broadcast/purge').remove();

      await db.ref('moderation/logs').push({
        uid,
        action,
        source: 'admin',
        createdAt: now
      });

      return send(res, 200, { success: true });
    }

    // MODERASI LAPORAN
    if (
      action === 'dismiss-report' ||
      action === 'delete-report-message'
    ) {
      const id = String(body.reportId || '');

      if (!validId(id)) {
        return send(res, 400, {
          error: 'ID laporan tidak valid.'
        });
      }

      const ref = db.ref('reports/' + id);
      const snap = await ref.get();

      if (!snap.exists()) {
        return send(res, 404, {
          error: 'Laporan tidak ditemukan.'
        });
      }

      const report = snap.val();

      if (
        action === 'delete-report-message' &&
        validId(report.msgId)
      ) {
        await db.ref('messages/' + report.msgId).remove();
      }

      await ref.remove();

      await db.ref('moderation/logs').push({
        uid: report.msgUid || '',
        action,
        reason: clean(report.reason, 120),
        source: 'admin',
        createdAt: now
      });

      return send(res, 200, { success: true });
    }

    // VALIDASI TARGET
    const target = String(body.uid || '');

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(target)) {
      return send(res, 400, {
        error: 'ID pengguna tidak valid.'
      });
    }

    if (target === uid) {
      return send(res, 400, {
        error: 'Admin tidak dapat memoderasi akunnya sendiri.'
      });
    }

    const reason = clean(body.reason || 'Tindakan admin', 240);

    // FITUR TITLE ADMIN
    if (action === 'set-title') {
      const title = clean(body.title, 40);

      const userRef = db.ref('users/' + target);
      const userSnap = await userRef.get();

      if (!userSnap.exists()) {
        return send(res, 404, {
          error: 'Pengguna tidak ditemukan.'
        });
      }

      await userRef.update({
        title: title || null,
        titleUpdatedAt: now,
        titleUpdatedBy: uid
      });

      await db.ref('moderation/logs').push({
        uid: target,
        action: 'set-title',
        title: title || 'Member',
        source: 'admin',
        adminUid: uid,
        createdAt: now
      });

      return send(res, 200, {
        success: true,
        title: title || 'Member'
      });
    }

    // BAN
    if (action === 'ban') {
      const permanent = body.permanent === true;

      const hours = Math.min(
        720,
        Math.max(1, Number(body.hours) || 24)
      );

      await db.ref('banned/' + target).set({
        source: 'admin',
        reason,
        createdAt: now,
        expiresAt: permanent ? null : now + hours * 3600000,
        type: permanent ? 'permanent' : 'temporary'
      });
    }

    // UNBAN
    else if (action === 'unban') {
      await db.ref('banned/' + target).remove();
    }

    // JAIL
    else if (action === 'jail') {
      const minutes = Math.min(
        10080,
        Math.max(1, Number(body.minutes) || 10)
      );

      await db.ref('jail/' + target).set({
        source: 'admin',
        reason,
        createdAt: now,
        until: now + minutes * 60000
      });
    }

    // UNJAIL
    else if (action === 'unjail') {
      await db.ref('jail/' + target).remove();
    }

    // RESET WARNING
    else if (action === 'reset-warnings') {
      await db.ref('moderation/users/' + target).update({
        warnings: 0,
        lastAction: 'reset',
        lastAt: now
      });
    }

    else {
      return send(res, 400, {
        error: 'Aksi tidak dikenal.'
      });
    }

    await db.ref('moderation/logs').push({
      uid: target,
      action,
      reason,
      source: 'admin',
      createdAt: now
    });

    return send(res, 200, { success: true });

  } catch (error) {
    console.error('moderation API:', error);

    return send(res, error.status || 500, {
      error: error.message || 'Server gagal memproses moderasi.'
    });
  }
};
