
const { getAdminServices, verifyUser, verifyAdmin, isAdmin } = require('../lib/firebase-admin');

const DAY = 86400000;
const EDIT_WINDOW = 15 * 60 * 1000;
const MAX_DATA_CHARS = 1000000;
const MAX_FILE_BYTES = 750000;

function reply(res, status, data) {
  return res.status(status).json(data);
}

function cleanText(value, max = 2000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function scan(text, extraWords = []) {
  const normalized = text.toLowerCase().normalize('NFKC');
  const patterns = [
    { re: /\b(kontol|memek|ngentot|jancuk|anjing|bangsat|bajingan|goblok|tolol|asu)\b/gi, weight: 1, reason: 'Bahasa kasar atau penghinaan' },
    { re: /\b(mati(kan)? kamu|bunuh kamu|akan membunuh|ancam(an)? bunuh)\b/gi, weight: 3, reason: 'Ancaman terhadap pengguna' },
    { re: /(.)\1{9,}/g, weight: 1, reason: 'Spam karakter berulang' }
  ];

  let score = 0;
  const reasons = [];

  for (const p of patterns) {
    if (p.re.test(normalized)) {
      score += p.weight;
      reasons.push(p.reason);
    }
  }

  if (extraWords.some(word => word && normalized.includes(word))) {
    score += 1;
    reasons.push('Kata terlarang');
  }

  return { score, reasons: [...new Set(reasons)] };
}

function activeBan(value, now) {
  return !!(value && (!value.expiresAt || Number(value.expiresAt) > now));
}

function activeJail(value, now) {
  return !!(value && Number(value.until) > now);
}

function validId(value) {
  return /^[-\w]{10,40}$/.test(String(value || ''));
}

async function checkRestrictions(db, uid, now, admin) {
  if (admin) return;

  const [banSnap, jailSnap, lockSnap] = await Promise.all([
    db.ref('banned/' + uid).get(),
    db.ref('jail/' + uid).get(),
    db.ref('settings/locked').get()
  ]);

  if (activeBan(banSnap.val(), now)) {
    const error = new Error('Akun sedang diblokir.');
    error.status = 403;
    error.payload = { status: 'banned', record: banSnap.val() };
    throw error;
  }

  if (activeJail(jailSnap.val(), now)) {
    const error = new Error('Akun sedang dalam Jail.');
    error.status = 403;
    error.payload = { status: 'jailed', record: jailSnap.val() };
    throw error;
  }

  if (lockSnap.val() === true) {
    const error = new Error('Chat sedang dikunci admin.');
    error.status = 403;
    throw error;
  }
}

async function getExtraWords(db) {
  const snap = await db.ref('settings/badwords').get();

  return String(snap.val() || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);
}

async function moderateMessage(db, uid, messageId, text, now) {
  if (!text) return null;

  const extra = await getExtraWords(db);
  const result = scan(text, extra);

  if (!result.score) return null;

  const historyRef = db.ref('moderation/users/' + uid);
  const historySnap = await historyRef.get();
  const history = historySnap.val() || {};

  const warnings = Math.max(0, Number(history.warnings) || 0) + 1;

  const record = {
    uid,
    messageId,
    reason: result.reasons.join(', '),
    createdAt: now,
    warnings,
    score: result.score
  };

  let level = 'warning';

  if (result.score >= 3) {
    level = 'jail';
    record.until = now + 10 * 60 * 1000;

    await db.ref('jail/' + uid).set({
      ...record,
      source: 'bot'
    });
  } else if (warnings >= 3) {
    level = 'ban';
    record.expiresAt = now + DAY;

    await db.ref('banned/' + uid).set({
      ...record,
      source: 'bot',
      type: 'temporary'
    });
  } else if (warnings >= 2) {
    level = 'jail';
    record.until = now + 5 * 60 * 1000;

    await db.ref('jail/' + uid).set({
      ...record,
      source: 'bot'
    });
  }

  await historyRef.update({
    warnings,
    lastAction: level,
    lastAt: now
  });

  await db.ref('moderation/logs').push({
    ...record,
    action: level
  });

  return {
    action: level,
    reason: record.reason,
    until: record.until || record.expiresAt || null
  };
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return reply(res, 405, { error: 'Gunakan POST.' });
  }

  try {
    const { auth, db } = getAdminServices();
    const user = await verifyUser(req, auth, true);
    const uid = user.uid;
    const admin = isAdmin(user);

    const body = req.body && typeof req.body === 'object'
      ? req.body
      : {};

    const action = String(body.action || 'send');
    const now = Date.now();

    if (action === 'send') {
      await checkRestrictions(db, uid, now, admin);

      const type = ['text', 'image', 'file'].includes(body.type)
        ? body.type
        : 'text';

      const text = cleanText(body.text, 2000);
      const data = typeof body.data === 'string' ? body.data : '';
      const fname = String(body.fname || '')
        .replace(/[\\/]/g, '_')
        .slice(0, 120);

      const size = Math.max(0, Number(body.size) || 0);
      const mime = String(body.mime || '').slice(0, 120);

      if (type === 'text' && !text) {
        return reply(res, 400, { error: 'Pesan kosong.' });
      }

      if ((type === 'image' || type === 'file') && !data) {
        return reply(res, 400, { error: 'Lampiran tidak ditemukan.' });
      }

      if (data.length > MAX_DATA_CHARS) {
        return reply(res, 413, { error: 'Lampiran terlalu besar.' });
      }

      if (
        type === 'image' &&
        !/^data:image\/(jpeg|png|webp);base64,/i.test(data)
      ) {
        return reply(res, 400, {
          error: 'Format gambar tidak didukung.'
        });
      }

      if (type === 'file') {
        if (size > MAX_FILE_BYTES) {
          return reply(res, 413, { error: 'File terlalu besar.' });
        }

        if (!/^data:[\w.+-]+\/[\w.+-]+;base64,/i.test(data)) {
          return reply(res, 400, {
            error: 'Format file tidak valid.'
          });
        }
      }

      const replyId = validId(body.replyTo)
        ? String(body.replyTo)
        : null;

      const [profileSnap, replySnap] = await Promise.all([
        db.ref('users/' + uid).get(),
        replyId
          ? db.ref('messages/' + replyId).get()
          : Promise.resolve(null)
      ]);

      const profile = profileSnap.val() || {};

      if (
        profile.managed === true &&
        profile.expiresAt &&
        Number(profile.expiresAt) <= now
      ) {
        return reply(res, 403, {
          error: 'Masa berlaku akun sudah habis.'
        });
      }

      let quote = null;

      if (replySnap && replySnap.exists()) {
        const original = replySnap.val() || {};

        quote = {
          id: replyId,
          name: cleanText(original.name || 'Pengguna', 24),
          text: original.type === 'image'
            ? 'Foto'
            : original.type === 'file'
              ? 'File: ' + cleanText(original.fname || '', 60)
              : cleanText(original.text || '', 80)
        };
      }

      const payload = {
        uid,
        name: cleanText(
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

      const moderation = admin
        ? null
        : await moderateMessage(db, uid, messageRef.key, text, now);

      return reply(res, 200, {
        success: true,
        id: messageRef.key,
        ...(moderation ? { moderation } : {})
      });
    }

    if (action === 'edit') {
      const id = String(body.id || '');

      if (!validId(id)) {
        return reply(res, 400, { error: 'ID pesan tidak valid.' });
      }

      const text = cleanText(body.text, 2000);

      if (!text) {
        return reply(res, 400, { error: 'Pesan kosong.' });
      }

      const messageRef = db.ref('messages/' + id);
      const snapshot = await messageRef.get();

      if (!snapshot.exists()) {
        return reply(res, 404, { error: 'Pesan tidak ditemukan.' });
      }

      const message = snapshot.val() || {};

      if (message.uid !== uid && !admin) {
        return reply(res, 403, {
          error: 'Tidak boleh mengedit pesan ini.'
        });
      }

      if (message.type !== 'text') {
        return reply(res, 400, {
          error: 'Hanya pesan teks yang bisa diedit.'
        });
      }

      if (!admin && now - Number(message.ts || 0) > EDIT_WINDOW) {
        return reply(res, 403, {
          error: 'Waktu mengedit sudah lewat (15 menit).'
        });
      }

      await checkRestrictions(db, uid, now, admin);

      if (!admin && scan(text, await getExtraWords(db)).score > 0) {
        return reply(res, 400, {
          error: 'Pesan mengandung kata yang tidak diizinkan.'
        });
      }

      await messageRef.update({
        text,
        edited: true,
        editedAt: now
      });

      return reply(res, 200, { success: true });
    }

    if (action === 'delete') {
      const id = String(body.id || '');

      if (!validId(id)) {
        return reply(res, 400, { error: 'ID pesan tidak valid.' });
      }

      const messageRef = db.ref('messages/' + id);
      const snap = await messageRef.get();

      if (!snap.exists()) {
        return reply(res, 404, { error: 'Pesan tidak ditemukan.' });
      }

      if (snap.val().uid !== uid && !admin) {
        return reply(res, 403, {
          error: 'Tidak boleh menghapus pesan ini.'
        });
      }

      await messageRef.remove();

      return reply(res, 200, { success: true });
    }

    if (action === 'report') {
      const id = String(body.id || '');
      const reason = cleanText(body.reason, 120);

      if (!validId(id) || !reason) {
        return reply(res, 400, {
          error: 'ID pesan dan alasan laporan wajib diisi.'
        });
      }

      const snap = await db.ref('messages/' + id).get();

      if (!snap.exists()) {
        return reply(res, 404, { error: 'Pesan tidak ditemukan.' });
      }

      const message = snap.val() || {};

      if (message.uid === uid) {
        return reply(res, 400, {
          error: 'Kamu tidak bisa melaporkan pesan sendiri.'
        });
      }

      const reportRef = db.ref('reports').push();

      await reportRef.set({
        msgId: id,
        msgUid: String(message.uid || ''),
        msgName: cleanText(message.name || 'Pengguna', 24),
        msgText: cleanText(
          message.text ||
          (message.type === 'image' ? 'Foto' : 'Lampiran'),
          120
        ),
        by: uid,
        byName: cleanText(
          user.name || (user.email || '').split('@')[0],
          24
        ),
        reason,
        ts: now
      });

      return reply(res, 200, { success: true });
    }

    if (
      action === 'purge' ||
      action === 'dismiss-report' ||
      action === 'delete-report-message' ||
      action === 'ban' ||
      action === 'unban' ||
      action === 'jail' ||
      action === 'unjail' ||
      action === 'reset-warnings'
    ) {
      if (!admin) {
        return reply(res, 403, {
          error: 'Akses admin diperlukan.'
        });
      }
    }

    if (action === 'purge') {
      await db.ref('messages').remove();
      await db.ref('broadcast/purge').remove();

      await db.ref('moderation/logs').push({
        uid,
        action: 'purge',
        source: 'admin',
        createdAt: now
      });

      return reply(res, 200, { success: true });
    }

    if (
      action === 'dismiss-report' ||
      action === 'delete-report-message'
    ) {
      const reportId = String(body.reportId || '');

      if (!/^[-\w]{8,40}$/.test(reportId)) {
        return reply(res, 400, {
          error: 'ID laporan tidak valid.'
        });
      }

      const reportRef = db.ref('reports/' + reportId);
      const reportSnap = await reportRef.get();

      if (!reportSnap.exists()) {
        return reply(res, 404, {
          error: 'Laporan tidak ditemukan.'
        });
      }

      const report = reportSnap.val() || {};

      if (
        action === 'delete-report-message' &&
        validId(report.msgId)
      ) {
        await db.ref('messages/' + report.msgId).remove();
      }

      await reportRef.remove();

      await db.ref('moderation/logs').push({
        uid: String(report.msgUid || ''),
        action: action === 'dismiss-report'
          ? 'dismiss-report'
          : 'delete-report-message',
        reason: cleanText(report.reason || '', 120),
        source: 'admin',
        createdAt: now
      });

      return reply(res, 200, { success: true });
    }

    const target = String(body.uid || '');

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(target)) {
      return reply(res, 400, {
        error: 'ID pengguna tidak valid.'
      });
    }

    if (target === uid) {
      return reply(res, 400, {
        error: 'Admin tidak dapat memoderasi akunnya sendiri.'
      });
    }

    const reason = cleanText(
      body.reason || 'Tindakan moderator',
      240
    );

    if (action === 'ban') {
      const permanent = body.permanent === true;
      const hours = Math.min(
        Math.max(Number(body.hours) || 24, 1),
        720
      );

      await db.ref('banned/' + target).set({
        source: 'admin',
        reason,
        createdAt: now,
        expiresAt: permanent ? null : now + hours * 3600000,
        type: permanent ? 'permanent' : 'temporary'
      });
    } else if (action === 'unban') {
      await db.ref('banned/' + target).remove();
    } else if (action === 'jail') {
      const minutes = Math.min(
        Math.max(Number(body.minutes) || 10, 1),
        1440
      );

      await db.ref('jail/' + target).set({
        source: 'admin',
        reason,
        createdAt: now,
        until: now + minutes * 60000
      });
    } else if (action === 'unjail') {
      await db.ref('jail/' + target).remove();
    } else if (action === 'reset-warnings') {
      await db.ref('moderation/users/' + target).update({
        warnings: 0,
        lastAction: 'reset',
        lastAt: now
      });
    } else {
      return reply(res, 400, {
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

    return reply(res, 200, { success: true });

  } catch (error) {
    console.error('moderation API:', error);

    return reply(res, error.status || 500, {
      error: error.message || 'Server gagal memproses moderasi.',
      ...(error.payload || {})
    });
  }
};
