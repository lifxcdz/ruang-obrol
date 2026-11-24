// Vercel serverless: grup chat privat Ruang Obrol.
// Pasang sebagai api/groups.js. Env: FIREBASE_SERVICE_ACCOUNT (wajib), FIREBASE_DATABASE_URL (opsional).
const admin = require('firebase-admin');
const crypto = require('crypto');

const DB_URL = process.env.FIREBASE_DATABASE_URL || 'https://ruang-obrol-default-rtdb.asia-southeast1.firebasedatabase.app';
const MAX_GROUPS_PER_USER = 20;

function init() {
  if (!admin.apps.length) {
    const sa = JSON.parse((process.env.FIREBASE_SERVICE_ACCOUNT || '').trim());
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: DB_URL });
  }
}
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const rand = n => Array.from(crypto.randomBytes(n)).map(b => CH[b % CH.length]).join('');
const fail = (res, code, msg) => res.status(code).json({ error: msg });

async function newCode(db) {
  for (let i = 0; i < 5; i++) {
    const c = rand(10);
    if (!(await db.ref('groupCodes/' + c).get()).exists()) return c;
  }
  throw new Error('Gagal membuat kode.');
}
async function wipe(db, gid, g) {
  const up = {};
  up['groups/' + gid] = null;
  up['groupMsgs/' + gid] = null;
  if (g.code) up['groupCodes/' + g.code] = null;
  Object.keys(g.members || {}).forEach(u => { up['userGroups/' + u + '/' + gid] = null; });
  await db.ref().update(up);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  try {
    init();
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const uid = (await admin.auth().verifyIdToken(token)).uid;
    const db = admin.database();
    const b = req.body || {};
    const act = b.action;

    if (act === 'create') {
      const name = String(b.name || '').trim().slice(0, 40);
      const max = Math.min(200, Math.max(2, Math.floor(Number(b.max) || 20)));
      if (!name) return fail(res, 400, 'Isi nama grup.');
      const mine = (await db.ref('userGroups/' + uid).get()).val() || {};
      if (Object.keys(mine).length >= MAX_GROUPS_PER_USER) return fail(res, 400, 'Kamu sudah mencapai batas ' + MAX_GROUPS_PER_USER + ' grup.');
      const gid = db.ref('groups').push().key;
      const code = await newCode(db);
      await db.ref().update({
        ['groups/' + gid]: { name, owner: uid, max, code, createdAt: admin.database.ServerValue.TIMESTAMP, members: { [uid]: true } },
        ['groupCodes/' + code]: gid,
        ['userGroups/' + uid + '/' + gid]: true
      });
      return res.json({ ok: true, gid, code });
    }

    if (act === 'preview' || act === 'join') {
      const code = String(b.code || '').replace(/[^A-Za-z0-9]/g, '');
      const gid = code && (await db.ref('groupCodes/' + code).get()).val();
      if (!gid) return fail(res, 404, 'Link undangan tidak valid atau sudah diganti.');
      const g = (await db.ref('groups/' + gid).get()).val();
      if (!g) return fail(res, 404, 'Grup tidak ditemukan.');
      const count = Object.keys(g.members || {}).length;
      if (act === 'preview') return res.json({ ok: true, name: g.name, count, max: g.max });
      if (g.members && g.members[uid]) return res.json({ ok: true, gid, already: true });
      const mine = (await db.ref('userGroups/' + uid).get()).val() || {};
      if (Object.keys(mine).length >= MAX_GROUPS_PER_USER) return fail(res, 400, 'Kamu sudah mencapai batas ' + MAX_GROUPS_PER_USER + ' grup.');
      const tr = await db.ref('groups/' + gid + '/members').transaction(m => {
        m = m || {};
        if (m[uid]) return m;
        if (Object.keys(m).length >= g.max) return;
        m[uid] = true;
        return m;
      });
      if (!tr.committed) return fail(res, 400, 'Grup sudah penuh.');
      await db.ref('userGroups/' + uid + '/' + gid).set(true);
      return res.json({ ok: true, gid });
    }

    const gid = String(b.gid || '');
    const g = gid && (await db.ref('groups/' + gid).get()).val();
    if (!g) return fail(res, 404, 'Grup tidak ditemukan.');
    const isMember = !!(g.members && g.members[uid]);
    if (!isMember) return fail(res, 403, 'Kamu bukan anggota grup ini.');
    const isOwner = g.owner === uid;

    if (act === 'send') {
      const text = String(b.text || '').trim().slice(0, 1000);
      if (!text) return fail(res, 400, 'Pesan kosong.');
      const bad = String((await db.ref('settings/badwords').get()).val() || '').split(',').map(x => x.trim().toLowerCase()).filter(w => w.length > 1);
      const low = text.toLowerCase();
      if (bad.some(w => low.includes(w))) return fail(res, 400, 'Pesan mengandung kata terlarang.');
      const name = (await db.ref('users/' + uid + '/name').get()).val() || 'Pengguna';
      await db.ref('groupMsgs/' + gid).push({ uid, name, text, ts: admin.database.ServerValue.TIMESTAMP });
      return res.json({ ok: true });
    }

    if (act === 'leave') {
      const others = Object.keys(g.members).filter(u => u !== uid);
      if (!others.length) { await wipe(db, gid, g); return res.json({ ok: true, deleted: true }); }
      const up = { ['groups/' + gid + '/members/' + uid]: null, ['userGroups/' + uid + '/' + gid]: null };
      if (isOwner) up['groups/' + gid + '/owner'] = others[0];
      await db.ref().update(up);
      return res.json({ ok: true });
    }

    if (!isOwner) return fail(res, 403, 'Hanya pemilik grup yang bisa melakukan ini.');

    if (act === 'kick') {
      const t = String(b.uid || '');
      if (!g.members[t] || t === uid) return fail(res, 400, 'Anggota tidak valid.');
      await db.ref().update({ ['groups/' + gid + '/members/' + t]: null, ['userGroups/' + t + '/' + gid]: null });
      return res.json({ ok: true });
    }
    if (act === 'rotate') {
      const code = await newCode(db);
      await db.ref().update({ ['groupCodes/' + g.code]: null, ['groupCodes/' + code]: gid, ['groups/' + gid + '/code']: code });
      return res.json({ ok: true, code });
    }
    if (act === 'setmax') {
      const max = Math.min(200, Math.max(2, Math.floor(Number(b.max) || 0)));
      if (max < Object.keys(g.members).length) return fail(res, 400, 'Batas tidak boleh di bawah jumlah anggota sekarang.');
      await db.ref('groups/' + gid + '/max').set(max);
      return res.json({ ok: true });
    }
    if (act === 'delete') {
      await wipe(db, gid, g);
      return res.json({ ok: true });
    }
    return fail(res, 400, 'Aksi tidak dikenal.');
  } catch (e) {
    console.error('groups gagal:', e && e.message);
    return fail(res, 400, 'Permintaan gagal.');
  }
};
