const { getAdminServices, verifyUser, isAdmin } = require('../lib/firebase-admin');

const clean = (v, n = 180) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const json = (res, status, data) => res.status(status).json(data);
const bounded = (v, min, max, fallback) => Math.min(max, Math.max(min, Number(v) || fallback));

module.exports = async function (req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Gunakan POST.' });
  try {
    const { auth, db } = getAdminServices();
    const user = await verifyUser(req, auth, true);
    const uid = user.uid;
    const admin = isAdmin(user);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '');
    const now = Date.now();
    const requireAdmin = () => { if (!admin) { const e = new Error('Akses admin diperlukan.'); e.status = 403; throw e; } };

    if (action === 'set-title') {
      requireAdmin();
      const target = clean(body.uid, 128);
      const allowed = ['member', 'moderator', 'developer', 'founder', 'verified', 'helper', 'support', 'designer', 'contributor', 'eventhost', 'vip'];
      if (!target || target === uid || !allowed.includes(body.title)) return json(res, 400, { error: 'Target atau title tidak valid.' });
      await db.ref('users/' + target + '/title').set(body.title);
      await db.ref('moderation/logs').push({ uid: target, action: 'set-title', reason: body.title, source: 'admin', createdAt: now });
      return json(res, 200, { success: true });
    }

    if (action === 'poll-create') {
      requireAdmin();
      const question = clean(body.question, 180);
      const options = Array.isArray(body.options) ? body.options.map(v => clean(v, 80)).filter(Boolean).slice(0, 8) : [];
      if (!question || options.length < 2) return json(res, 400, { error: 'Pertanyaan dan minimal dua pilihan wajib diisi.' });
      const minutes = bounded(body.minutes, 1, 10080, 60);
      await db.ref('polls/current').set({ id: String(now), question, options, createdAt: now, endsAt: now + minutes * 60000, closed: false, createdBy: uid });
      await db.ref('polls/votes').remove();
      return json(res, 200, { success: true });
    }
    if (action === 'poll-close') {
      requireAdmin();
      await db.ref('polls/current/closed').set(true);
      await db.ref('polls/current/closedAt').set(now);
      return json(res, 200, { success: true });
    }
    if (action === 'poll-vote') {
      const snap = await db.ref('polls/current').get();
      const poll = snap.val();
      const index = Number(body.option);
      if (!poll || poll.closed || Number(poll.endsAt) <= now) return json(res, 410, { error: 'Polling sudah berakhir.' });
      if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) return json(res, 400, { error: 'Pilihan tidak valid.' });
      const voteRef = db.ref('polls/votes/' + uid);
      if ((await voteRef.get()).exists()) return json(res, 409, { error: 'Kamu sudah memberikan suara.' });
      await voteRef.set({ option: index, createdAt: now });
      return json(res, 200, { success: true });
    }

    if (action.startsWith('event-')) {
      const eventRef = db.ref('events/current');
      if (action === 'event-create') {
        requireAdmin();
        const name = clean(body.name, 80);
        const rows = Array.isArray(body.questions) ? body.questions.map(q => ({ question: clean(q.question, 240), answer: clean(q.answer, 120).toLowerCase() })).filter(q => q.question && q.answer).slice(0, 30) : [];
        if (!name || !rows.length) return json(res, 400, { error: 'Nama dan pertanyaan event wajib diisi.' });
        const wait = bounded(body.waitMinutes, 1, 60, 3);
        const duration = bounded(body.durationMinutes, 1, 180, 10);
        const id = String(now);
        const publicQuestions = rows.map(q => ({ question: q.question }));
        await eventRef.set({ id, name, status: 'waiting', createdAt: now, registrationEndsAt: now + wait * 60000, durationMinutes: duration, questions: publicQuestions, players: {}, createdBy: uid });
        await db.ref('eventAnswers/' + id).set(rows.map(q => q.answer));
        return json(res, 200, { success: true, id });
      }
      const snap = await eventRef.get();
      const ev = snap.val();
      if (!ev) return json(res, 404, { error: 'Event tidak ditemukan.' });
      if (action === 'event-start') {
        requireAdmin();
        if (ev.status === 'ended') return json(res, 410, { error: 'Event sudah berakhir.' });
        if (now < Number(ev.registrationEndsAt || 0)) return json(res, 409, { error: 'Waktu pendaftaran belum selesai.' });
        const duration = bounded(ev.durationMinutes, 1, 180, 10);
        await eventRef.update({ status: 'active', startedAt: now, endsAt: now + duration * 60000 });
        return json(res, 200, { success: true });
      }
      if (action === 'event-finish') {
        requireAdmin();
        await finishEvent(db, eventRef, ev, now);
        return json(res, 200, { success: true });
      }
      if (ev.status === 'waiting' && Number(ev.registrationEndsAt) <= now) {
        // Event tetap menunggu tombol mulai admin; pendaftaran ditutup setelah waktunya.
        await eventRef.child('registrationClosed').set(true);
      }
      if (ev.status === 'active' && Number(ev.endsAt) <= now) {
        await finishEvent(db, eventRef, ev, now);
        return json(res, 410, { error: 'Waktu event sudah habis.' });
      }
      if (ev.status === 'ended') return json(res, 410, { error: 'Event sudah berakhir dan tidak bisa diakses.' });
      if (action === 'event-state') {
        const playerSnap = await eventRef.child('players/' + uid).get();
        const player = playerSnap.val();
        const index = player ? Number(player.index) || 0 : 0;
        return json(res, 200, { id: ev.id, name: ev.name, status: ev.status, registrationEndsAt: ev.registrationEndsAt || null, endsAt: ev.endsAt || null, joined: !!player, score: player ? Number(player.score) || 0 : 0, question: ev.questions && ev.questions[index] ? ev.questions[index].question : null, completed: !!player && !(ev.questions && ev.questions[index]), winners: ev.winners || {} });
      }
      if (action === 'event-join') {
        if (ev.status !== 'waiting' || ev.registrationClosed || now >= Number(ev.registrationEndsAt || 0)) return json(res, 410, { error: 'Pendaftaran event sudah ditutup.' });
        await eventRef.child('players/' + uid).transaction(v => v || { name: clean(user.name || user.email?.split('@')[0] || 'Pemain', 24), score: 0, index: 0, joinedAt: now });
        return json(res, 200, { success: true });
      }
      if (action === 'event-answer') {
        if (ev.status !== 'active') return json(res, 409, { error: 'Event belum dimulai.' });
        const playerRef = eventRef.child('players/' + uid);
        const playerSnap = await playerRef.get();
        if (!playerSnap.exists()) return json(res, 403, { error: 'Gabung event terlebih dahulu.' });
        const player = playerSnap.val();
        const answerSnap = await db.ref('eventAnswers/' + ev.id + '/' + player.index).get();
        const expected = String(answerSnap.val() || '').trim().toLowerCase();
        const answer = clean(body.answer, 120).toLowerCase();
        const correct = !!answer && answer === expected;
        if (correct) await playerRef.update({ score: (Number(player.score) || 0) + 1, index: (Number(player.index) || 0) + 1, lastCorrectAt: now });
        const nextIndex = correct ? Number(player.index || 0) + 1 : Number(player.index || 0);
        const nextQuestion = ev.questions && ev.questions[nextIndex] ? ev.questions[nextIndex].question : null;
        return json(res, 200, { success: true, correct, completed: !nextQuestion, nextQuestion, score: (Number(player.score) || 0) + (correct ? 1 : 0) });
      }
    }
    return json(res, 400, { error: 'Aksi tidak dikenal.' });
  } catch (error) {
    console.error('events API:', error);
    return json(res, error.status || 500, { error: error.message || 'Server gagal memproses permintaan.' });
  }
};

async function finishEvent(db, eventRef, ev, now) {
  const players = ev.players || {};
  const ranked = Object.entries(players).sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0) || (Number(a[1].joinedAt) || 0) - (Number(b[1].joinedAt) || 0));
  const winners = {};
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const [uid, player] = ranked[i];
    const title = ['event1', 'event2', 'event3'][i];
    winners[uid] = { name: player.name || 'Pemain', score: Number(player.score) || 0, rank: i + 1, title };
    await db.ref('users/' + uid + '/title').set(title);
  }
  await eventRef.update({ status: 'ended', endedAt: now, winners });
  await db.ref('eventAnswers/' + ev.id).remove();
}
