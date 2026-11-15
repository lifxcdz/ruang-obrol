// Simpan sebagai: api/moderation.js  (ganti file lama sepenuhnya)
const { getAdminServices } = require('../lib/firebase-admin');
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'lifxcdz@gmail.com').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const DAY = 86400000;
const EDIT_WINDOW = 15 * 60 * 1000;
const ROLES = ['admin','moderator'];
function isOwnerEmail(email){ return !!email && ADMIN_EMAILS.includes(String(email).toLowerCase()); }
function cleanText(v){ return String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').trim().slice(0,2000); }
function scan(text, extraWords){
  const t=text.toLowerCase().normalize('NFKC');
  const patterns=[
    {re:/\b(kontol|memek|ngentot|jancuk|anjing|bangsat|bajingan|goblok|tolol|asu)\b/gi,weight:1,reason:'Bahasa kasar atau penghinaan'},
    {re:/\b(mati(kan)? kamu|bunuh kamu|akan membunuh|ancam(an)? bunuh)\b/gi,weight:3,reason:'Ancaman terhadap pengguna'},
    {re:/(.)\1{9,}/g,weight:1,reason:'Spam karakter berulang'}
  ];
  let score=0,reasons=[];
  for(const p of patterns){ if(p.re.test(t)){score+=p.weight; reasons.push(p.reason);} }
  if(Array.isArray(extraWords) && extraWords.some(w=>w && t.includes(w))){ score+=1; reasons.push('Kata terlarang'); }
  return {score,reasons:[...new Set(reasons)]};
}
function reply(res,status,data){return res.status(status).json(data);}
module.exports=async function(req,res){
 if(req.method!=='POST') return reply(res,405,{error:'Gunakan POST.'});
 try{
  const {auth,db}=getAdminServices();
  const header=req.headers.authorization||''; const token=(header.match(/^Bearer\s+(.+)$/i)||[])[1];
  if(!token) return reply(res,401,{error:'Sesi login tidak ditemukan.'});
  const user=await auth.verifyIdToken(token,true); const uid=user.uid;
  const body=req.body||{}; const action=String(body.action||'send'); const now=Date.now();

  // Peran pemanggil: pemilik (dari ADMIN_EMAILS), admin, atau moderator (dari roles/{uid})
  const owner=isOwnerEmail(user.email);
  const roleVal=(await db.ref('roles/'+uid).get()).val();
  const admin=owner||roleVal==='admin';      // akses penuh
  const mod=!admin&&roleVal==='moderator';   // jail dan hapus pesan saja
  const staff=admin||mod;                    // dikecualikan dari bot dan kunci chat

  // Kata terlarang buatan admin (disimpan sebagai teks dipisah koma)
  const loadExtra = async () => {
    const s=(await db.ref('settings/badwords').get()).val();
    return String(s||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).slice(0,200);
  };

  if(action==='send'){
   if(!user.email_verified) return reply(res,403,{error:'Verifikasi email terlebih dahulu.'});
   const type=['text','image','file'].includes(body.type)?body.type:'text';
   const text=cleanText(body.text); const data=typeof body.data==='string'?body.data:'';
   if(type==='text'&&!text) return reply(res,400,{error:'Pesan kosong.'});
   if(data.length>1000000) return reply(res,413,{error:'Lampiran terlalu besar.'});
   const replyId=/^[-\w]{10,40}$/.test(String(body.replyTo||''))?String(body.replyTo):null;

   // Semua pembacaan dijalankan bersamaan supaya lebih cepat
   const [banSnap,jailSnap,profileSnap,lockSnap,replySnap,extra]=await Promise.all([
    db.ref('banned/'+uid).get(),
    db.ref('jail/'+uid).get(),
    db.ref('users/'+uid).get(),
    db.ref('settings/locked').get(),
    replyId?db.ref('messages/'+replyId).get():Promise.resolve(null),
    staff?Promise.resolve([]):loadExtra()
   ]);
   if(banSnap.exists() && (!banSnap.val().expiresAt || Number(banSnap.val().expiresAt)>now)) return reply(res,403,{error:'Akun sedang diblokir.',status:'banned',record:banSnap.val()});
   if(jailSnap.exists() && Number((jailSnap.val()||{}).until)>now) return reply(res,403,{error:'Akun sedang dalam Jail.',status:'jailed',record:jailSnap.val()});
   if(!staff && lockSnap.val()===true) return reply(res,403,{error:'Chat sedang dikunci admin.'});

   const profile=profileSnap.val()||{};
   let quote=null;
   if(replySnap&&replySnap.exists()){
    const o=replySnap.val()||{};
    quote={id:replyId,name:String(o.name||'Pengguna').slice(0,24),text:o.type==='image'?'Foto':o.type==='file'?'File: '+String(o.fname||'').slice(0,60):String(o.text||'').slice(0,80)};
   }
   const payload={uid,name:String(profile.name||user.name||user.email.split('@')[0]).slice(0,24),ts:now,type, ...(text?{text}:{}), ...(data?{data}:{}), ...(admin?{admin:true,role:'admin'}:{}), ...(mod?{role:'moderator'}:{}), ...(quote?{reply:quote}:{})};
   const msgRef=db.ref('messages').push(); await msgRef.set(payload);
   if(!staff && text){
    const result=scan(text,extra);
    if(result.score>0){
     const histRef=db.ref('moderation/users/'+uid); const histSnap=await histRef.get(); const hist=histSnap.val()||{}; const warnings=Number(hist.warnings||0)+1;
     let record={uid, messageId:msgRef.key, reason:result.reasons.join(', '), createdAt:now, warnings, score:result.score};
     let level='warning';
     if(result.score>=3){ level='jail'; record.until=now+10*60*1000; await db.ref('jail/'+uid).set({...record,source:'bot'}); }
     else if(warnings>=3){ level='ban'; record.expiresAt=now+DAY; await db.ref('banned/'+uid).set({...record,source:'bot',type:'temporary'}); }
     else if(warnings>=2){ level='jail'; record.until=now+5*60*1000; await db.ref('jail/'+uid).set({...record,source:'bot'}); }
     await histRef.update({warnings,lastAction:level,lastAt:now});
     await db.ref('moderation/logs').push({...record,action:level});
     return reply(res,200,{success:true,id:msgRef.key,moderation:{action:level,reason:record.reason,until:record.until||record.expiresAt||null}});
    }
   }
   return reply(res,200,{success:true,id:msgRef.key});
  }

  // Edit pesan sendiri (maksimal 15 menit, hanya pesan teks)
  if(action==='edit'){
   if(!user.email_verified) return reply(res,403,{error:'Verifikasi email terlebih dahulu.'});
   const id=String(body.id||''); if(!/^[-\w]{10,40}$/.test(id)) return reply(res,400,{error:'ID pesan tidak valid.'});
   const text=cleanText(body.text); if(!text) return reply(res,400,{error:'Pesan kosong.'});
   const msgRef=db.ref('messages/'+id); const snap=await msgRef.get();
   if(!snap.exists()) return reply(res,404,{error:'Pesan tidak ditemukan.'});
   const m=snap.val()||{};
   if(m.uid!==uid) return reply(res,403,{error:'Hanya pemilik pesan yang bisa mengedit.'});
   if(m.type!=='text') return reply(res,400,{error:'Hanya pesan teks yang bisa diedit.'});
   if(now-Number(m.ts||0)>EDIT_WINDOW) return reply(res,403,{error:'Waktu mengedit sudah lewat (15 menit).'});
   if(!staff){
    const [banSnap,jailSnap,lockSnap,extra]=await Promise.all([db.ref('banned/'+uid).get(),db.ref('jail/'+uid).get(),db.ref('settings/locked').get(),loadExtra()]);
    if(banSnap.exists() && (!banSnap.val().expiresAt || Number(banSnap.val().expiresAt)>now)) return reply(res,403,{error:'Akun sedang diblokir.'});
    if(jailSnap.exists() && Number((jailSnap.val()||{}).until)>now) return reply(res,403,{error:'Akun sedang dalam Jail.'});
    if(lockSnap.val()===true) return reply(res,403,{error:'Chat sedang dikunci admin.'});
    if(scan(text,extra).score>0) return reply(res,400,{error:'Pesan mengandung kata yang tidak diizinkan.'});
   }
   await msgRef.update({text,edited:true,editedAt:now});
   return reply(res,200,{success:true});
  }

  // ====== Aksi moderasi: hanya staf ======
  if(!staff) return reply(res,403,{error:'Akses staf diperlukan.'});
  const target=String(body.uid||''); if(!/^[A-Za-z0-9_-]{10,128}$/.test(target)) return reply(res,400,{error:'ID pengguna tidak valid.'});
  const reason=String(body.reason||'Tindakan moderator').slice(0,240);

  // Aksi yang hanya boleh admin/pemilik
  const adminOnly=['ban','unban','setRole'];
  if(adminOnly.includes(action) && !admin) return reply(res,403,{error:'Aksi ini hanya untuk admin.'});
  if(target===uid && ['ban','jail','setRole'].includes(action)) return reply(res,400,{error:'Tidak bisa dilakukan pada akunmu sendiri.'});

  // Lindungi target: pemilik kebal, admin hanya bisa disentuh pemilik, moderator tidak bisa menyentuh staf
  const tUser=await auth.getUser(target).catch(()=>null);
  if(!tUser) return reply(res,404,{error:'Akun tidak ditemukan.'});
  const tRole=(await db.ref('roles/'+target).get()).val()||null;
  if(isOwnerEmail(tUser.email)) return reply(res,403,{error:'Pemilik tidak bisa diubah atau dimoderasi.'});
  if(tRole==='admin' && !owner) return reply(res,403,{error:'Hanya pemilik yang bisa mengelola admin.'});
  if(mod && tRole) return reply(res,403,{error:'Moderator tidak bisa memoderasi staf.'});

  if(action==='setRole'){
   const newRole=String(body.role||'');
   if(!ROLES.includes(newRole)&&newRole!=='none') return reply(res,400,{error:'Peran tidak valid.'});
   // Mengangkat admin hanya boleh pemilik (mencabut admin sudah dicegah di atas)
   if(newRole==='admin' && !owner) return reply(res,403,{error:'Hanya pemilik yang bisa mengangkat admin.'});
   if(newRole==='none') await db.ref('roles/'+target).remove();
   else await db.ref('roles/'+target).set(newRole);
   await db.ref('moderation/logs').push({uid:target,action:'setRole:'+newRole,reason:'Oleh '+(user.email||uid),source:'admin',createdAt:now});
   return reply(res,200,{success:true});
  }

  if(action==='ban') await db.ref('banned/'+target).set({source:'admin',reason,createdAt:now,expiresAt:body.permanent?null:now+Math.min(Math.max(Number(body.hours)||24,1),720)*3600000,type:body.permanent?'permanent':'temporary'});
  else if(action==='unban') await db.ref('banned/'+target).remove();
  else if(action==='jail') await db.ref('jail/'+target).set({source:admin?'admin':'moderator',reason,createdAt:now,until:now+Math.min(Math.max(Number(body.minutes)||10,1),1440)*60000});
  else if(action==='unjail') await db.ref('jail/'+target).remove();
  else if(action==='reset-warnings') await db.ref('moderation/users/'+target).update({warnings:0,lastAction:'reset',lastAt:now});
  else return reply(res,400,{error:'Aksi tidak dikenal.'});
  await db.ref('moderation/logs').push({uid:target,action,reason,source:admin?'admin':'moderator',createdAt:now});
  return reply(res,200,{success:true});
 }catch(e){ console.error('moderation api:',e); return reply(res,500,{error:'Server gagal memproses moderasi.'}); }
};
