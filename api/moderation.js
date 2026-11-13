const { getAdminServices, verifyAdmin } = require('../lib/firebase-admin');
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'lifxcdz@gmail.com').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const DAY = 86400000;
function isAdmin(user){ return !!user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()); }
function cleanText(v){ return String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').trim().slice(0,2000); }
function scan(text){
  const t=text.toLowerCase().normalize('NFKC');
  const patterns=[
    {re:/\b(kontol|memek|ngentot|jancuk|anjing|bangsat|bajingan|goblok|tolol|asu)\b/gi,weight:1,reason:'Bahasa kasar atau penghinaan'},
    {re:/\b(mati(kan)? kamu|bunuh kamu|akan membunuh|ancam(an)? bunuh)\b/gi,weight:3,reason:'Ancaman terhadap pengguna'},
    {re:/(.)\1{9,}/g,weight:1,reason:'Spam karakter berulang'}
  ];
  let score=0,reasons=[];
  for(const p of patterns){ if(p.re.test(t)){score+=p.weight; reasons.push(p.reason);} }
  return {score,reasons:[...new Set(reasons)]};
}
function reply(res,status,data){return res.status(status).json(data);}
module.exports=async function(req,res){
 if(req.method!=='POST') return reply(res,405,{error:'Gunakan POST.'});
 try{
  const {auth,db}=getAdminServices();
  const header=req.headers.authorization||''; const token=(header.match(/^Bearer\s+(.+)$/i)||[])[1];
  if(!token) return reply(res,401,{error:'Sesi login tidak ditemukan.'});
  const user=await auth.verifyIdToken(token,true); const uid=user.uid; const admin=isAdmin(user);
  const body=req.body||{}; const action=String(body.action||'send'); const now=Date.now();
  if(action==='send'){
   if(!user.email_verified) return reply(res,403,{error:'Verifikasi email terlebih dahulu.'});
   const banSnap=await db.ref('banned/'+uid).get();
   if(banSnap.exists() && (!banSnap.val().expiresAt || Number(banSnap.val().expiresAt)>now)) return reply(res,403,{error:'Akun sedang diblokir.',status:'banned',record:banSnap.val()});
   const jailSnap=await db.ref('jail/'+uid).get();
   if(jailSnap.exists() && Number((jailSnap.val()||{}).until)>now) return reply(res,403,{error:'Akun sedang dalam Jail.',status:'jailed',record:jailSnap.val()});
   const type=['text','image','file'].includes(body.type)?body.type:'text';
   const text=cleanText(body.text); const data=typeof body.data==='string'?body.data:'';
   if(type==='text'&&!text) return reply(res,400,{error:'Pesan kosong.'});
   if(data.length>1000000) return reply(res,413,{error:'Lampiran terlalu besar.'});
   const profile=(await db.ref('users/'+uid).get()).val()||{};
   const payload={uid,name:String(profile.name||user.name||user.email.split('@')[0]).slice(0,24),ts:now,type, ...(text?{text}:{}), ...(data?{data}:{}), ...(admin?{admin:true}:{})};
   const msgRef=db.ref('messages').push(); await msgRef.set(payload);
   if(!admin && text){
    const result=scan(text);
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
  if(!admin) return reply(res,403,{error:'Akses admin diperlukan.'});
  const target=String(body.uid||''); if(!/^[A-Za-z0-9_-]{10,128}$/.test(target)) return reply(res,400,{error:'ID pengguna tidak valid.'});
  const reason=String(body.reason||'Tindakan moderator').slice(0,240);
  if(action==='ban') await db.ref('banned/'+target).set({source:'admin',reason,createdAt:now,expiresAt:body.permanent?null:now+Math.min(Math.max(Number(body.hours)||24,1),720)*3600000,type:body.permanent?'permanent':'temporary'});
  else if(action==='unban') await db.ref('banned/'+target).remove();
  else if(action==='jail') await db.ref('jail/'+target).set({source:'admin',reason,createdAt:now,until:now+Math.min(Math.max(Number(body.minutes)||10,1),1440)*60000});
  else if(action==='unjail') await db.ref('jail/'+target).remove();
  else if(action==='reset-warnings') await db.ref('moderation/users/'+target).update({warnings:0,lastAction:'reset',lastAt:now});
  else return reply(res,400,{error:'Aksi tidak dikenal.'});
  await db.ref('moderation/logs').push({uid:target,action,reason,source:'admin',createdAt:now});
  return reply(res,200,{success:true});
 }catch(e){ console.error('moderation api:',e); return reply(res,500,{error:'Server gagal memproses moderasi.'}); }
};
