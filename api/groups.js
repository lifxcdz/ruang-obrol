// Vercel serverless: grup chat privat Ruang Obrol (api/groups.js).
// Struktur data mengikuti Rules: groups/{gid}/info|count|members, groupCodes/{gid}/code, groupMsgs/{gid}, userGroups/{uid}/{gid}.
// Env: FIREBASE_SERVICE_ACCOUNT (wajib), FIREBASE_DATABASE_URL (opsional).
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
const TS = () => admin.database.ServerValue.TIMESTAMP;

async function wipe(db, gid, members, code) {
  const up = { ['groups/' + gid]: null, ['groupMsgs/' + gid]: null, ['groupCodes/' + gid]: null };
  Object.keys(members || {}).forEach(u => { up['userGroups/' + u + '/' + gid] = null; });
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
    const val = async p => (await db.ref(p).get()).val();

    if (act === 'create') {
      const name = String(b.name || '').trim().slice(0, 30);
      const max = Math.min(200, Math.max(2, Math.floor(Number(b.max) || 20)));
      if (!name) return fail(res, 400, 'Isi nama grup.');
      const mine = (await val('userGroups/' + uid)) || {};
      if (Object.keys(mine).length >= MAX_GROUPS_PER_USER) return fail(res, 400, 'Kamu sudah mencapai batas ' + MAX_GROUPS_PER_USER + ' grup.');
      const gid = db.ref('groups').push().key;
      const code = rand(10);
      await db.ref().update({
        ['groups/' + gid + '/info']: { name, owner: uid, max, createdAt: TS() },
        ['groups/' + gid + '/count']: 1,
        ['groups/' + gid + '/members/' + uid]: 'owner',
        ['groupCodes/' + gid]: { code },
        ['userGroups/' + uid + '/' + gid]: { name, ts: TS() }
      });
      return res.json({ ok: true, gid, code });
    }

    if (act === 'preview' || act === 'join') {
      const raw = String(b.code || '').trim();
      const dot = raw.lastIndexOf('.');
      const gid = dot > 0 ? raw.slice(0, dot) : '';
      const code = dot > 0 ? raw.slice(dot + 1) : '';
      if (!gid || !code || /[.#$\[\]\/]/.test(gid)) return fail(res, 404, 'Link undangan tidak valid.');
      const real = await val('groupCodes/' + gid + '/code');
      const info = await val('groups/' + gid + '/info');
      if (!real || real !== code || !info) return fail(res, 404, 'Link undangan tidak valid atau sudah diganti.');
      const members = (await val('groups/' + gid + '/members')) || {};
      const count = Object.keys(members).length;
      if (act === 'preview') return res.json({ ok: true, name: info.name, count, max: info.max });
      if (members[uid]) return res.json({ ok: true, gid, already: true });
      const mine = (await val('userGroups/' + uid)) || {};
      if (Object.keys(mine).length >= MAX_GROUPS_PER_USER) return fail(res, 400, 'Kamu sudah mencapai batas ' + MAX_GROUPS_PER_USER + ' grup.');
      const tr = await db.ref('groups/' + gid + '/count').transaction(c => {
        c = c || 0;
        if (c >= info.max) return;
        return c + 1;
      });
      if (!tr.committed) return fail(res, 400, 'Grup sudah penuh.');
      await db.ref().update({
        ['groups/' + gid + '/members/' + uid]: code,
        ['userGroups/' + uid + '/' + gid]: { name: info.name, ts: TS() }
      });
      return res.json({ ok: true, gid });
    }

    const gid = String(b.gid || '');
    if (!gid || /[.#$\[\]\/]/.test(gid)) return fail(res, 404, 'Grup tidak ditemukan.');
    const info = await val('groups/' + gid + '/info');
    if (!info) return fail(res, 404, 'Grup tidak ditemukan.');
    const members = (await val('groups/' + gid + '/members')) || {};
    if (!members[uid]) return fail(res, 403, 'Kamu bukan anggota grup ini.');
    const isOwner = info.owner === uid;

    if (act === 'send') {
      const text = String(b.text || '').trim().slice(0, 1000);
      if (!text) return fail(res, 400, 'Pesan kosong.');
      const banned = await val('banned/' + uid);
      if (banned && (!banned.expiresAt || Number(banned.expiresAt) > Date.now())) return fail(res, 403, 'Akunmu sedang diblokir.');
      const jail = await val('jail/' + uid);
      if (jail && Number(jail.until) > Date.now()) return fail(res, 403, 'Akunmu sedang di Jail.');
      const bad = String((await val('settings/badwords')) || '').split(',').map(x => x.trim().toLowerCase()).filter(w => w.length > 1);
      const low = text.toLowerCase();
      if (bad.some(w => low.includes(w))) return fail(res, 400, 'Pesan mengandung kata terlarang.');
      const name = (await val('users/' + uid + '/name')) || 'Pengguna';
      await db.ref('groupMsgs/' + gid).push({ uid, name, text, ts: TS() });
      return res.json({ ok: true });
    }

    if (act === 'leave') {
      const others = Object.keys(members).filter(u => u !== uid);
      if (!others.length) { await wipe(db, gid, members); return res.json({ ok: true, deleted: true }); }
      const up = {
        ['groups/' + gid + '/members/' + uid]: null,
        ['userGroups/' + uid + '/' + gid]: null,
        ['groups/' + gid + '/count']: others.length
      };
      if (isOwner) { up['groups/' + gid + '/info/owner'] = others[0]; up['groups/' + gid + '/members/' + others[0]] = 'owner'; }
      await db.ref().update(up);
      return res.json({ ok: true });
    }

    if (!isOwner) return fail(res, 403, 'Hanya pemilik grup yang bisa melakukan ini.');

    if (act === 'kick') {
      const t = String(b.uid || '');
      if (!members[t] || t === uid) return fail(res, 400, 'Anggota tidak valid.');
      await db.ref().update({
        ['groups/' + gid + '/members/' + t]: null,
        ['userGroups/' + t + '/' + gid]: null,
        ['groups/' + gid + '/count']: Object.keys(members).length - 1
      });
      return res.json({ ok: true });
    }
    if (act === 'rotate') {
      const code = rand(10);
      await db.ref('groupCodes/' + gid).set({ code });
      return res.json({ ok: true, code });
    }
    if (act === 'setmax') {
      const max = Math.min(200, Math.max(2, Math.floor(Number(b.max) || 0)));
      if (max < Object.keys(members).length) return fail(res, 400, 'Batas tidak boleh di bawah jumlah anggota sekarang.');
      await db.ref('groups/' + gid + '/info/max').set(max);
      return res.json({ ok: true });
    }
    if (act === 'delete') {
      await wipe(db, gid, members);
      return res.json({ ok: true });
    }
    return fail(res, 400, 'Aksi tidak dikenal.');
  } catch (e) {
    console.error('groups gagal:', e && e.message);
    return fail(res, 400, 'Permintaan gagal.');
  }
};
