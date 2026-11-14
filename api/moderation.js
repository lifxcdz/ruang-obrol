
// Moderasi Ruang Obrol: kirim pesan, edit, ban, unban, jail, dan riwayat.
const { getAdminServices } = require('../lib/firebase-admin');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'lifxcdz@gmail.com')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const DAY = 86400000;
const EDIT_WINDOW = 15 * 60 * 1000;

function isAdmin(user) {
  return !!user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
}

function cleanText(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim().slice(0, 2000);
}

function scan(text, extraWords) {
  const normalized = text.toLowerCase().normalize('NFKC');
  const patterns = [
    { re: /\b(kontol|memek|ngentot|jancuk|anjing|bangsat|bajingan|goblok|tolol|asu)\b/gi, weight: 1, reason: 'Bahasa kasar atau penghinaan' },
    { re: /\b(mati(kan)? kamu|bunuh kamu|akan membunuh|ancam(an)? bunuh)\b/gi, weight: 3, reason: 'Ancaman terhadap pengguna' },
    { re: /(.)\1{9,}/g, weight: 1, reason: 'Spam karakter berulang' }
  ];

  let score = 0;
  const reasons = [];

  for (const pattern of patterns) {
    if (pattern.re.test(normalized)) {
      score += pattern.weight;
      reasons.push(pattern.reason);
    }
  }

  if (Array.isArray(extraWords) && extraWords.some(word => word && normalized.includes(word))) {
    score += 1;
    reasons.push('Kata terlarang');
  }

  return { score, reasons: [...new Set(reasons)] };
}

function reply(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return reply(res, 405, { error: 'Gunakan POST.' });
  }

  try {
    const { auth, db } = getAdminServices();
    const header = req.headers.authorization || '';
    const token = (header.match(/^Bearer\s+(.+)$/i) || [])[1];

    if (!token) {
      return reply(res, 401, { error: 'Sesi login tidak ditemukan.' });
    }

    const user = await auth.verifyIdToken(token, true);
    const uid = user.uid;
    const admin = isAdmin(user);
    const body = req.body || {};
    const action = String(body.action || 'send');
    const now = Date.now();

    const loadExtra = async () => {
      const snapshot = await db.ref('settings/badwords').get();
      return String(snapshot.val() || '')
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 200);
    };

    const isBanActive = value =>
      !!(value && (!value.expiresAt || Number(value.expiresAt) > now));

    const isJailActive = value =>
      !!(value && Number(value.until) > now);

    if (action === 'send') {
      if (!user.email_verified) {
        return reply(res, 403, { error: 'Verifikasi email terlebih dahulu.' });
      }

      const type = ['text', 'image', 'file'].includes(body.type)
        ? body.type : 'text';

      const text = cleanText(body.text);
      const data = typeof body.data === 'string' ? body.data : '';
      const fname = String(body.fname || '')
        .replace(/[\\/]/g, '_').slice(0, 120);
      const size = Math.max(0, Number(body.size) || 0);
      const mime = String(body.mime || '').slice(0, 120);

      if (type === 'text' && !text) {
        return reply(res, 400, { error: 'Pesan kosong.' });
      }

      if ((type === 'image' || type === 'file') && !data) {
        return reply(res, 400, { error: 'Lampiran tidak ditemukan.' });
      }

      if (data.length > 1000000) {
        return reply(res, 413, { error: 'Lampiran terlalu besar.' });
      }

      if (type === 'file' && size > 750000) {
        return reply(res, 413, { error: 'File terlalu besar.' });
      }

      const replyId = /^[-\w]{10,40}$/.test(String(body.replyTo || ''))
        ? String(body.replyTo) : null;

      const [
        banSnap,
        jailSnap,
        profileSnap,
        lockSnap,
        replySnap,
        extra
      ] = await Promise.all([
        db.ref('banned/' + uid).get(),
        db.ref('jail/' + uid).get(),
        db.ref('users/' + uid).get(),
        db.ref('settings/locked').get(),
        replyId ? db.ref('messages/' + replyId).get() : Promise.resolve(null),
        admin ? Promise.resolve([]) : loadExtra()
      ]);

      if (!admin && isBanActive(banSnap.val())) {
        return reply(res, 403, {
          error: 'Akun sedang diblokir.',
          status: 'banned',
          record: banSnap.val()
        });
      }

      if (!admin && isJailActive(jailSnap.val())) {
        return reply(res, 403, {
          error: 'Akun sedang dalam Jail.',
          status: 'jailed',
          record: jailSnap.val()
        });
      }

      if (!admin && lockSnap.val() === true) {
        return reply(res, 403, { error: 'Chat sedang dikunci admin.' });
      }

      const profile = profileSnap.val() || {};
      let quote = null;

      if (replySnap && replySnap.exists()) {
        const original = replySnap.val() || {};

        quote = {
          id: replyId,
          name: String(original.name || 'Pengguna').slice(0, 24),
          text: original.type === 'image'
            ? 'Foto'
            : original.type === 'file'
              ? 'File: ' + String(original.fname || '').slice(0, 60)
              : String(original.text || '').slice(0, 80)
        };
      }

      const payload = {
        uid,
        name: String(
          profile.name ||
          user.name ||
          (user.email || 'pengguna').split('@')[0]
        ).slice(0, 24),
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

      if (!admin && text) {
        const result = scan(text, extra);

        if (result.score > 0) {
          const historyRef = db.ref('moderation/users/' + uid);
          const historySnapshot = await historyRef.get();
          const history = historySnapshot.val() || {};
          const warnings = Number(history.warnings || 0) + 1;

          const record = {
            uid,
            messageId: messageRef.key,
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

          return reply(res, 200, {
            success: true,
            id: messageRef.key,
            moderation: {
              action: level,
              reason: record.reason,
              until: record.until || record.expiresAt || null
            }
          });
        }
      }

      return reply(res, 200, {
        success: true,
        id: messageRef.key
      });
    }

    if (action === 'edit') {
      if (!user.email_verified) {
        return reply(res, 403, { error: 'Verifikasi email terlebih dahulu.' });
      }

      const id = String(body.id || '');

      if (!/^[-\w]{10,40}$/.test(id)) {
        return reply(res, 400, { error: 'ID pesan tidak valid.' });
      }

      const text = cleanText(body.text);

      if (!text) {
        return reply(res, 400, { error: 'Pesan kosong.' });
      }

      const messageRef = db.ref('messages/' + id);
      const snapshot = await messageRef.get();

      if (!snapshot.exists()) {
        return reply(res, 404, { error: 'Pesan tidak ditemukan.' });
      }

      const message = snapshot.val() || {};

      if (message.uid !== uid) {
        return reply(res, 403, {
          error: 'Hanya pemilik pesan yang bisa mengedit.'
        });
      }

      if (message.type !== 'text') {
        return reply(res, 400, {
          error: 'Hanya pesan teks yang bisa diedit.'
        });
      }

      if (now - Number(message.ts || 0) > EDIT_WINDOW) {
        return reply(res, 403, {
          error: 'Waktu mengedit sudah lewat (15 menit).'
        });
      }

      if (!admin) {
        const [
          banSnap,
          jailSnap,
          lockSnap,
          extra
        ] = await Promise.all([
          db.ref('banned/' + uid).get(),
          db.ref('jail/' + uid).get(),
          db.ref('settings/locked').get(),
          loadExtra()
        ]);

        if (isBanActive(banSnap.val())) {
          return reply(res, 403, { error: 'Akun sedang diblokir.' });
        }

        if (isJailActive(jailSnap.val())) {
          return reply(res, 403, { error: 'Akun sedang dalam Jail.' });
        }

        if (lockSnap.val() === true) {
          return reply(res, 403, { error: 'Chat sedang dikunci admin.' });
        }

        if (scan(text, extra).score > 0) {
          return reply(res, 400, {
            error: 'Pesan mengandung kata yang tidak diizinkan.'
          });
        }
      }

      await messageRef.update({
        text,
        edited: true,
        editedAt: now
      });

      return reply(res, 200, { success: true });
    }

    if (!admin) {
      return reply(res, 403, { error: 'Akses admin diperlukan.' });
    }

    const target = String(body.uid || '');

    if (!/^[A-Za-z0-9_-]{10,128}$/.test(target)) {
      return reply(res, 400, { error: 'ID pengguna tidak valid.' });
    }

    if (target === uid) {
      return reply(res, 400, {
        error: 'Admin tidak dapat memoderasi akunnya sendiri.'
      });
    }

    const reason = cleanText(body.reason || 'Tindakan moderator').slice(0, 240);

    if (action === 'ban') {
      const permanent = body.permanent === true;
      const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 720);

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
      const minutes = Math.min(Math.max(Number(body.minutes) || 10, 1), 1440);

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
      return reply(res, 400, { error: 'Aksi tidak dikenal.' });
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
    console.error('moderation api:', error);
    return reply(res, 500, {
      error: 'Server gagal memproses moderasi.'
    });
  }
};
