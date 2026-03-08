const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===== DATABASE =====
let db = null;
let useDB = false;

async function initDB() {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          password VARCHAR(64) NOT NULL,
          rank VARCHAR(30) DEFAULT 'member',
          points INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          is_banned BOOLEAN DEFAULT FALSE
        );
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          room VARCHAR(50) NOT NULL,
          username VARCHAR(50),
          text TEXT,
          type VARCHAR(20) DEFAULT 'chat',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS profiles (
          username VARCHAR(50) PRIMARY KEY,
          avatar TEXT DEFAULT NULL,
          music_url TEXT DEFAULT NULL,
          music_name VARCHAR(100) DEFAULT NULL,
          bio VARCHAR(200) DEFAULT NULL,
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      const adminPass = hashPassword(process.env.ADMIN_PASSWORD || 'admin123');
      await db.query(`INSERT INTO users (username,password,rank) VALUES ('admin',$1,'owner') ON CONFLICT (username) DO NOTHING`, [adminPass]);
      useDB = true;
      console.log('Database connected');
    } catch(e) { console.log('No DB - using memory:', e.message); }
  }
}

const memUsers = {
  admin: { username:'admin', password:hashPassword('admin123'), rank:'owner', is_banned:false, points:0 }
};
const memMessages = {};
const memProfiles = {}; // { username: { avatar, music_url, music_name, bio } }
function hashPassword(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

// ===== ROOMS =====
let ROOMS = {
  general:      { name:'الغرفة العامة',   icon:'🌍', color:'#1565c0' },
  iraq:         { name:'غرفة العراق',     icon:'🇮🇶', color:'#c62828' },
  youth:        { name:'غرفة الشباب',     icon:'🔥', color:'#e65100' },
  feelings:     { name:'غرفة المشاعر',    icon:'💕', color:'#c2185b' },
  music:        { name:'غرفة الموسيقى',   icon:'🎵', color:'#6a1b9a' },
  sports:       { name:'غرفة الرياضة',    icon:'⚽', color:'#2e7d32' },
  fun:          { name:'غرفة الفكاهة',    icon:'😂', color:'#f57f17' },
  elders:       { name:'غرفة كبار السن',  icon:'🌹', color:'#37474f' },
  competitions: { name:'غرفة المسابقات',  icon:'🏆', color:'#f9a825', isQuiz:true },
};
Object.keys(ROOMS).forEach(r => memMessages[r] = []);

function slugify(text) {
  return text.toLowerCase().replace(/\s+/g,'-').replace(/[^\w\-]/g,'') || 'room-' + Date.now();
}

// ===== 10-RANK SYSTEM =====
const RANKS = {
  owner:       { label:'👑 مالك',        color:'#ff4444', fontSize:'22px', fontWeight:'900', glow:'0 0 10px #ff4444', canBan:true,  canMute:true,  canKick:true,  canSetRank:true,  canManageRooms:true,  canManageBadWords:true,  bigName:true  },
  owner_admin: { label:'💼 أونر إداري',  color:'#ff8c00', fontSize:'20px', fontWeight:'800', glow:'0 0 8px #ff8c00',  canBan:true,  canMute:true,  canKick:true,  canSetRank:true,  canManageRooms:true,  canManageBadWords:true,  bigName:true  },
  owner_vip:   { label:'⭐ أونر',         color:'#ffd700', fontSize:'19px', fontWeight:'700', glow:'0 0 8px #ffd700',  canBan:true,  canMute:true,  canKick:true,  canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:true  },
  super_admin: { label:'🔱 سوبر أدمن',   color:'#b044ff', fontSize:'18px', fontWeight:'700', glow:'0 0 6px #b044ff',  canBan:true,  canMute:true,  canKick:true,  canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:true  },
  admin:       { label:'⚙️ أدمن',        color:'#00bfff', fontSize:'17px', fontWeight:'700', glow:'0 0 5px #00bfff',  canBan:false, canMute:true,  canKick:true,  canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:false },
  premium:     { label:'💎 بريميوم',     color:'#00e5ff', fontSize:'16px', fontWeight:'600', glow:'none',             canBan:false, canMute:false, canKick:false, canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:false },
  vip:         { label:'🌟 عضو مميز',    color:'#ce93d8', fontSize:'16px', fontWeight:'600', glow:'none',             canBan:false, canMute:false, canKick:false, canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:false },
  gold:        { label:'🥇 عضو ذهبي',    color:'#ffc107', fontSize:'15px', fontWeight:'500', glow:'none',             canBan:false, canMute:false, canKick:false, canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:false },
  member:      { label:'👤 عضو مسجل',    color:'#90caf9', fontSize:'14px', fontWeight:'400', glow:'none',             canBan:false, canMute:false, canKick:false, canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:false },
  visitor:     { label:'👁️ زائر',        color:'#b0bec5', fontSize:'13px', fontWeight:'400', glow:'none',             canBan:false, canMute:false, canKick:false, canSetRank:false, canManageRooms:false, canManageBadWords:false, bigName:false },
};

const RANK_ORDER = ['owner','owner_admin','owner_vip','super_admin','admin','premium','vip','gold','member','visitor'];
function rankLevel(r) { return RANK_ORDER.indexOf(r); }
function canManage(actorRank, targetRank) { return rankLevel(actorRank) < rankLevel(targetRank); }
function hasPermission(rank, perm) { return RANKS[rank]?.[perm] === true; }

function adminAuth(req,res,next) {
  if (req.headers['x-admin-token'] !== (process.env.ADMIN_TOKEN||'ghazal-admin-2024')) return res.json({ok:false,msg:'غير مصرح'});
  next();
}

// ===== ROOM MANAGEMENT =====
app.post('/api/admin/addroom', adminAuth, (req,res) => {
  const { name, icon, color, isQuiz } = req.body;
  if (!name||!icon) return res.json({ok:false,msg:'الاسم والأيقونة مطلوبان'});
  if (Object.keys(ROOMS).length >= 20) return res.json({ok:false,msg:'الحد الأقصى 20 غرفة'});
  const id = slugify(name)+'-'+Date.now().toString().slice(-4);
  ROOMS[id] = { name, icon, color:color||'#1565c0', isQuiz:isQuiz||false };
  memMessages[id] = [];
  io.emit('rooms-updated', ROOMS);
  res.json({ok:true,id});
});
app.post('/api/admin/editroom', adminAuth, (req,res) => {
  const {id,name,icon,color} = req.body;
  if (!ROOMS[id]) return res.json({ok:false,msg:'الغرفة غير موجودة'});
  if (name) ROOMS[id].name=name;
  if (icon) ROOMS[id].icon=icon;
  if (color) ROOMS[id].color=color;
  io.emit('rooms-updated', ROOMS);
  res.json({ok:true});
});
app.post('/api/admin/deleteroom', adminAuth, (req,res) => {
  const {id} = req.body;
  if (id==='general') return res.json({ok:false,msg:'لا يمكن حذف الغرفة العامة'});
  if (!ROOMS[id]) return res.json({ok:false,msg:'الغرفة غير موجودة'});
  Object.values(chatUsers).forEach(u => {
    if (u.room===id) {
      io.to(u.id).emit('room-deleted','تم حذف الغرفة، تم نقلك للغرفة العامة');
      const sock = io.sockets.sockets.get(u.id);
      if (sock) { sock.leave(id); sock.join('general'); }
      u.room='general';
    }
  });
  delete ROOMS[id]; delete memMessages[id];
  io.emit('rooms-updated', ROOMS);
  res.json({ok:true});
});
app.get('/api/rooms', (req,res) => res.json({ok:true,rooms:ROOMS}));

// ===== PROFANITY FILTER =====
let BAD_WORDS = [
  'كلب','كلبة','حمار','حمارة','غبي','غبية','احمق','معتوه','وقح','وقحة',
  'منافق','كذاب','لعين','يلعن','العن','تبا','ملعون','خنزير','قرد',
  'تفو','خرا','زبالة','نجس','وسخ','بهيم',
  'ابن الكلب','ابن الحرام','بنت الكلب','بنت الحرام',
  'شرموطة','شرموط','عاهرة','عاهر','زانية','زاني','فاجرة','فاجر',
  'قحبة','قحب','متناكة','منيوك','مخنث','شاذ','لوطي','ابن زنا','بنت زنا',
  'زب','كس','كسك','كسها','طيز','طيزك','طيزها',
  'نيك','انيك','ينيك','تنيك','ناكني','ناكها','بزاز','متناك','تناك',
  'خول','خولات','سكس','بورن','بورنو','إباحي',
  'fuck','fucker','fucking','shit','bitch','bastard','asshole','jackass',
  'motherfucker','porn','nude','naked','dick','cock','pussy','cunt','tits','whore','slut','xxx',
  'كس امك','كس اختك','كسمك','ممحون','ممحونة','ديوث','غندور','معرص',
  'عيري','عيرك','طيزج','كسج','انيج','أنيچ',
  'orospu','sikim','kahpe','lanet',
];
let BAD_USERNAMES = [
  'زب','كس','طيز','نيك','شرموط','شرموطة','عاهر','عاهرة','قحبة','قحب',
  'زاني','زانية','مخنث','شاذ','لوطي','سكسي','سكس','خول','متناك',
  'sex','sexy','porn','horny','naked','nude','slut','whore','dick','cock',
  'pussy','tits','xxx','fuck','fucker','bitch','asshole','69',
  'قواد','خنيث','ديوث','غندور','معرص','ممحون',
];
let customBadWords = [];
function getAllBadWords() { return [...BAD_WORDS,...customBadWords]; }
function normalizeAr(t) {
  return t.replace(/أ|إ|آ/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/\s+/g,' ').trim();
}
function containsBadWordFull(text) {
  const n=normalizeAr(text.toLowerCase());
  const c=n.replace(/[\s\.\-_\*]+/g,'');
  for (const w of getAllBadWords()) {
    const nw=normalizeAr(w.toLowerCase());
    if (n.includes(nw)||c.includes(nw.replace(/\s/g,''))) return {found:true,word:w};
  }
  return {found:false};
}
function containsBadUsername(name) {
  const n=normalizeAr(name.toLowerCase()).replace(/\s+/g,'');
  for (const w of BAD_USERNAMES) if (n.includes(normalizeAr(w.toLowerCase()))) return true;
  return false;
}

// ===== AD DETECTION & AUTO-BAN =====
function detectAdLink(text) {
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const urls = text.match(urlPattern)||[];
  const ownDomain = process.env.SITE_DOMAIN||'ghazal-iraq';
  for (const url of urls) { if (!url.includes(ownDomain)) return true; }
  const adPatterns = [/دردشة\s*\S+/i, /موقع\s*\S+/i, /تواصل\s*معنا/i, /واتس\s*اب/i, /رابط\s*موقع/i];
  const mentionPatterns = [/iraq1\.chat/i, /swalf\.chat/i, /كيبورد\.com/i];
  for (const p of [...adPatterns,...mentionPatterns]) { if (p.test(text)) return true; }
  return false;
}

// ===== BAD WORDS ADMIN ROUTES =====
app.get('/api/admin/badwords', adminAuth, (req,res) => res.json({ok:true,default:BAD_WORDS,custom:customBadWords}));
app.post('/api/admin/badwords/add', adminAuth, (req,res) => {
  const {word}=req.body;
  if (!word||word.trim().length<2) return res.json({ok:false,msg:'الكلمة قصيرة جداً'});
  const w=word.trim().toLowerCase();
  if (customBadWords.includes(w)) return res.json({ok:false,msg:'موجودة مسبقاً'});
  customBadWords.push(w); res.json({ok:true,custom:customBadWords});
});
app.post('/api/admin/badwords/remove', adminAuth, (req,res) => {
  customBadWords=customBadWords.filter(w=>w!==req.body.word?.trim().toLowerCase());
  res.json({ok:true,custom:customBadWords});
});
app.post('/api/admin/badwords/removedefault', adminAuth, (req,res) => {
  BAD_WORDS=BAD_WORDS.filter(w=>w!==req.body.word); res.json({ok:true});
});

// ===== AUTH ROUTES =====
app.post('/api/register', async (req,res) => {
  const {username,password,gender,age}=req.body;
  if (!username||!password||username.length<3) return res.json({ok:false,msg:'بيانات غير صحيحة'});
  if (containsBadUsername(username)||containsBadWordFull(username).found)
    return res.json({ok:false,msg:'❌ اسم المستخدم غير مقبول'});
  const hashed=hashPassword(password);
  if (useDB) {
    try { await db.query('INSERT INTO users (username,password) VALUES ($1,$2)',[username,hashed]); res.json({ok:true}); }
    catch(e) { res.json({ok:false,msg:'الاسم مستخدم مسبقاً'}); }
  } else {
    if (memUsers[username]) return res.json({ok:false,msg:'الاسم مستخدم مسبقاً'});
    memUsers[username]={username,password:hashed,rank:'member',is_banned:false,gender,age,points:0};
    res.json({ok:true});
  }
});
app.post('/api/login', async (req,res) => {
  const {username,password}=req.body;
  const hashed=hashPassword(password);
  if (useDB) {
    const r=await db.query('SELECT * FROM users WHERE username=$1 AND password=$2',[username,hashed]);
    if (!r.rows.length) return res.json({ok:false,msg:'اسم المستخدم أو كلمة المرور خاطئة'});
    const u=r.rows[0];
    if (u.is_banned) return res.json({ok:false,msg:'تم حظرك'});
    res.json({ok:true,user:{username:u.username,rank:u.rank,points:u.points||0}});
  } else {
    const u=memUsers[username];
    if (!u||u.password!==hashed) return res.json({ok:false,msg:'اسم المستخدم أو كلمة المرور خاطئة'});
    if (u.is_banned) return res.json({ok:false,msg:'تم حظرك'});
    res.json({ok:true,user:{username:u.username,rank:u.rank,points:u.points||0}});
  }
});

// ===== ADMIN ROUTES =====
app.get('/api/admin/users', adminAuth, async (req,res) => {
  if (useDB) {
    const r=await db.query('SELECT id,username,rank,is_banned,points,created_at FROM users ORDER BY created_at DESC');
    res.json({ok:true,users:r.rows});
  } else { res.json({ok:true,users:Object.values(memUsers).map(u=>({...u,password:undefined}))}); }
});
app.post('/api/admin/ban', adminAuth, async (req,res) => {
  const {username}=req.body;
  if (useDB) await db.query('UPDATE users SET is_banned=TRUE WHERE username=$1',[username]);
  else if (memUsers[username]) memUsers[username].is_banned=true;
  kickUser(username,'تم حظرك من الموقع'); res.json({ok:true});
});
app.post('/api/admin/unban', adminAuth, async (req,res) => {
  const {username}=req.body;
  if (useDB) await db.query('UPDATE users SET is_banned=FALSE WHERE username=$1',[username]);
  else if (memUsers[username]) memUsers[username].is_banned=false;
  res.json({ok:true});
});
app.post('/api/admin/setrank', adminAuth, async (req,res) => {
  const {username,rank}=req.body;
  if (!RANKS[rank]) return res.json({ok:false,msg:'رتبة غير صحيحة'});
  if (useDB) await db.query('UPDATE users SET rank=$1 WHERE username=$2',[rank,username]);
  else if (memUsers[username]) memUsers[username].rank=rank;
  const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===username);
  if (sid) { chatUsers[sid].rank=rank; io.to(sid).emit('rank-changed',{rank,rankInfo:RANKS[rank]}); }
  io.emit('user-rank-updated',{username,rank,rankInfo:RANKS[rank]});
  res.json({ok:true});
});
app.post('/api/changepass', async (req,res) => {
  const {username,oldpassword,newpassword}=req.body;
  if (!username||!oldpassword||!newpassword) return res.json({ok:false,msg:'بيانات ناقصة'});
  if (newpassword.length<4) return res.json({ok:false,msg:'كلمة المرور الجديدة قصيرة'});
  const oldHashed=hashPassword(oldpassword); const newHashed=hashPassword(newpassword);
  if (useDB) {
    const check=await db.query('SELECT id FROM users WHERE username=$1 AND password=$2',[username,oldHashed]);
    if (!check.rows.length) return res.json({ok:false,msg:'كلمة المرور القديمة خاطئة'});
    await db.query('UPDATE users SET password=$1 WHERE username=$2',[newHashed,username]);
  } else {
    const u=memUsers[username];
    if (!u||u.password!==oldHashed) return res.json({ok:false,msg:'كلمة المرور القديمة خاطئة'});
    u.password=newHashed;
  }
  res.json({ok:true});
});
app.post('/api/admin/resetpass', adminAuth, async (req,res) => {
  const {username,newpassword}=req.body;
  if (!username||!newpassword||newpassword.length<4) return res.json({ok:false,msg:'كلمة المرور قصيرة'});
  const hashed=hashPassword(newpassword);
  if (useDB) { const r=await db.query('UPDATE users SET password=$1 WHERE username=$2',[hashed,username]); if (r.rowCount===0) return res.json({ok:false,msg:'المستخدم غير موجود'}); }
  else { if (!memUsers[username]) return res.json({ok:false,msg:'المستخدم غير موجود'}); memUsers[username].password=hashed; }
  res.json({ok:true});
});
app.post('/api/admin/clearroom', adminAuth, async (req,res) => {
  const {room}=req.body;
  if (useDB) await db.query('DELETE FROM messages WHERE room=$1',[room]);
  memMessages[room]=[]; io.to(room).emit('room-cleared',room); res.json({ok:true});
});
app.get('/api/messages/:room', async (req,res) => {
  const room=req.params.room;
  if (!ROOMS[room]) return res.json({ok:false});
  if (useDB) { const r=await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50',[room]); res.json({ok:true,messages:r.rows.reverse()}); }
  else { res.json({ok:true,messages:memMessages[room]||[]}); }
});
app.get('/api/leaderboard', async (req,res) => {
  if (useDB) { const r=await db.query('SELECT username,rank,points FROM users ORDER BY points DESC LIMIT 20'); res.json({ok:true,users:r.rows}); }
  else { const users=Object.values(memUsers).map(u=>({username:u.username,rank:u.rank,points:u.points||0})).sort((a,b)=>b.points-a.points).slice(0,20); res.json({ok:true,users}); }
});

// ===== ADMIN QUIZ QUESTIONS MANAGEMENT =====
let adminQuizQuestions = []; // custom questions added by admin at runtime

app.get('/api/admin/quiz-questions', adminAuth, (req,res) => {
  res.json({ ok:true, questions: adminQuizQuestions });
});

app.post('/api/admin/quiz-questions/add', adminAuth, (req,res) => {
  const { q, a, hint, points } = req.body;
  if (!q || !a) return res.json({ ok:false, msg:'السؤال والإجابة مطلوبان' });
  const newQ = { q: q.trim(), a: a.trim(), hint: hint||'', points: parseInt(points)||50 };
  adminQuizQuestions.push(newQ);
  // Inject into active quiz pools immediately
  Object.keys(quizState).forEach(roomId => {
    if (quizState[roomId]) quizState[roomId].pool.push({...newQ});
  });
  res.json({ ok:true, questions: adminQuizQuestions });
});

app.post('/api/admin/quiz-questions/remove', adminAuth, (req,res) => {
  const { idx } = req.body;
  if (idx === undefined || idx < 0 || idx >= adminQuizQuestions.length)
    return res.json({ ok:false, msg:'السؤال غير موجود' });
  adminQuizQuestions.splice(idx, 1);
  res.json({ ok:true, questions: adminQuizQuestions });
});

// ===== PROFILE API =====
// Get profile
app.get('/api/profile/:username', async (req,res) => {
  const { username } = req.params;
  let user, profile;
  if (useDB) {
    const ur = await db.query('SELECT username,rank,points FROM users WHERE username=$1',[username]);
    // If not in DB, check live users (visitors)
    if (!ur.rows.length) {
      const liveUser = Object.values(chatUsers).find(u=>u.name===username);
      if (!liveUser) return res.json({ok:false,msg:'المستخدم غير موجود'});
      user = { username: liveUser.name, rank: liveUser.rank, points: liveUser.points||0 };
    } else {
      user = ur.rows[0];
    }
    const pr = await db.query('SELECT * FROM profiles WHERE username=$1',[username]);
    profile = pr.rows[0] || {};
  } else {
    // Check registered users first, then live visitors
    user = memUsers[username];
    if (!user) {
      const liveUser = Object.values(chatUsers).find(u=>u.name===username);
      if (!liveUser) return res.json({ok:false,msg:'المستخدم غير موجود'});
      user = { username: liveUser.name, rank: liveUser.rank, points: liveUser.points||0 };
    }
    profile = memProfiles[username] || {};
  }
  res.json({ok:true, profile:{
    username: user.username,
    rank: user.rank,
    points: user.points||0,
    avatar: profile.avatar||null,
    music_url: profile.music_url||null,
    music_name: profile.music_name||null,
    bio: profile.bio||null,
  }});
});

// Update profile (avatar as base64, music as youtube/soundcloud URL)
app.post('/api/profile/update', async (req,res) => {
  const { username, avatar, music_url, music_name, bio } = req.body;
  if (!username) return res.json({ok:false,msg:'مطلوب اسم المستخدم'});
  // base64 size check: 4MB base64 ≈ 3MB actual
  if (avatar && avatar.length > 4 * 1024 * 1024) return res.json({ok:false,msg:'الصورة كبيرة جداً، الحد الأقصى 3MB'});
  if (useDB) {
    await db.query(`INSERT INTO profiles (username,avatar,music_url,music_name,bio,updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (username) DO UPDATE SET
        avatar=COALESCE($2,profiles.avatar),
        music_url=COALESCE($3,profiles.music_url),
        music_name=COALESCE($4,profiles.music_name),
        bio=COALESCE($5,profiles.bio),
        updated_at=NOW()`,
      [username, avatar||null, music_url||null, music_name||null, bio||null]);
  } else {
    memProfiles[username] = memProfiles[username] || {};
    if (avatar) memProfiles[username].avatar = avatar;
    if (music_url) memProfiles[username].music_url = music_url;
    if (music_name) memProfiles[username].music_name = music_name;
    if (bio !== undefined) memProfiles[username].bio = bio;
  }
  // Update live socket user avatar + broadcast to room
  const sid = Object.keys(chatUsers).find(id=>chatUsers[id].name===username);
  if (sid) {
    if (avatar) chatUsers[sid].avatar = avatar;
    const room = chatUsers[sid].room;
    if (room) io.to(room).emit('room-users', getRoomUsers(room));
  }
  res.json({ok:true});
});

// ===== QUIZ BOT =====
const QUIZ_QUESTIONS = [
  {q:'ما اسم الحيوان الذي يستخرج منه المسك ذو الرائحة العطرة؟',a:'الغزال',hint:'ا _ غ _ ا _',points:50},
  {q:'ما هو أعلى جبل في أفريقيا؟',a:'كيليمانجارو',hint:'ك _ ل _ م _ ن _ ا _ و',points:100},
  {q:'ما عاصمة المملكة العربية السعودية؟',a:'الرياض',hint:'ا _ ر _ ي _ ا _ ض',points:30},
  {q:'ما أكبر دولة في العالم مساحةً؟',a:'روسيا',hint:'ر _ و _ س _ ي _ ا',points:40},
  {q:'ما أطول نهر في العالم؟',a:'النيل',hint:'ا _ ن _ ي _ ل',points:40},
  {q:'في أي دولة تقع برج إيفل؟',a:'فرنسا',hint:'ف _ ر _ ن _ س _ ا',points:30},
  {q:'ما عاصمة اليابان؟',a:'طوكيو',hint:'ط _ و _ ك _ ي _ و',points:30},
  {q:'ما هو المحيط الأكبر في العالم؟',a:'الهادئ',hint:'ا _ ل _ ه _ ا _ د _ ئ',points:50},
  {q:'من هو أقوى الحيوانات في الذاكرة؟',a:'الجمل',hint:'ا _ ج _ ل',points:50},
  {q:'ما هو أسرع حيوان على اليابسة؟',a:'الفهد',hint:'ا _ ل _ ف _ ه _ د',points:40},
  {q:'كم عدد أيام السنة؟',a:'365',hint:'3 _ 5',points:20},
  {q:'ما هو الكوكب الأقرب للشمس؟',a:'عطارد',hint:'ع _ ط _ ا _ ر _ د',points:50},
  {q:'ما العنصر الكيميائي الذي رمزه O؟',a:'الأكسجين',hint:'ا _ ك _ س _ ج _ ي _ ن',points:60},
  {q:'كم عدد أسنان الإنسان البالغ؟',a:'32',hint:'_ 2',points:30},
  {q:'في أي عام فتحت القسطنطينية؟',a:'1453',hint:'1 _ 5 _',points:80},
  {q:'ما هي عاصمة العراق؟',a:'بغداد',hint:'ب _ غ _ د _ ا _ د',points:20},
  {q:'كم عدد محافظات العراق؟',a:'18',hint:'1 _',points:30},
  {q:'ما اسم أطول نهر في العراق؟',a:'دجلة',hint:'د _ ج _ ل _ ه',points:30},
  {q:'بعثرة حروف: وسن',a:'سون',type:'scramble',points:90},
  {q:'بعثرة حروف: ابحر',a:'حرب',type:'scramble',points:70},
  {q:'بعثرة حروف: لامج',a:'جمال',type:'scramble',points:70},
  {q:'بعثرة حروف: نيدم',a:'مدين',type:'scramble',points:70},
  {q:'بعثرة حروف: رحس',a:'سحر',type:'scramble',points:60},
  {q:'بعثرة حروف: كلم',a:'ملك',type:'scramble',points:60},
  {q:'كم هو ناتج 15 × 15؟',a:'225',hint:'2 _ 5',points:50},
  {q:'كم هو جذر 144؟',a:'12',hint:'1 _',points:40},
];

const quizState = {};
function shuffleArr(arr) { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function startQuiz(roomId) {
  if (!quizState[roomId]) quizState[roomId]={active:false,current:null,timer:null,hintTimer:null,pool:shuffleArr(QUIZ_QUESTIONS),idx:0};
  const s=quizState[roomId];
  if (s.active) return;
  s.active=true;
  nextQuestion(roomId);
}
function stopQuiz(roomId) {
  const s=quizState[roomId]; if (!s) return;
  s.active=false;
  if (s.timer) clearTimeout(s.timer);
  if (s.hintTimer) clearTimeout(s.hintTimer);
  s.current=null;
}
async function addPoints(username,pts) {
  if (useDB) await db.query('UPDATE users SET points=points+$1 WHERE username=$2',[pts,username]);
  else if (memUsers[username]) memUsers[username].points=(memUsers[username].points||0)+pts;
  const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===username);
  if (sid) { chatUsers[sid].points=(chatUsers[sid].points||0)+pts; io.to(sid).emit('points-updated',{points:chatUsers[sid].points}); }
}
function nextQuestion(roomId) {
  const s=quizState[roomId]; if (!s||!s.active) return;
  s.timer=setTimeout(async()=>{
    if (!s.active) return;
    if (s.idx>=s.pool.length){s.pool=shuffleArr(QUIZ_QUESTIONS);s.idx=0;}
    const q=s.pool[s.idx++]; s.current={...q,answered:false};
    const qMsg=await saveMessage(roomId,'مسابقات',`سؤآل : ${q.q}`,'quiz');
    io.to(roomId).emit('message',{...qMsg,user:{name:'مسابقات',rank:'owner',color:'#ffd700',label:'🏆 مسابقات'},isBot:true});
    if (q.hint&&q.type!=='scramble') {
      s.hintTimer=setTimeout(async()=>{
        if (s.current&&!s.current.answered){
          const hMsg=await saveMessage(roomId,'مسابقات',`مساعده : ${q.hint}`,'quiz');
          io.to(roomId).emit('message',{...hMsg,user:{name:'مسابقات',rank:'owner',color:'#ffd700',label:'🏆 مسابقات'},isBot:true});
        }
      },20000);
    }
    s.timer=setTimeout(async()=>{
      if (s.current&&!s.current.answered){
        s.current.answered=true;
        const noMsg=await saveMessage(roomId,'مسابقات',`نأسف لم يتم الإجآبة على هذا السؤال : الإجآبة هي ${q.a}`,'quiz');
        io.to(roomId).emit('message',{...noMsg,user:{name:'مسابقات',rank:'owner',color:'#ffd700',label:'🏆 مسابقات'},isBot:true});
        nextQuestion(roomId);
      }
    },40000);
  },6000);
}
function checkAnswer(roomId,username,text) {
  const s=quizState[roomId];
  if (!s||!s.current||s.current.answered) return false;
  const a=normalizeAr(s.current.a.toLowerCase().trim());
  const u=normalizeAr(text.toLowerCase().trim());
  if (a===u) { s.current.answered=true; if (s.hintTimer) clearTimeout(s.hintTimer); if (s.timer) clearTimeout(s.timer); return s.current; }
  return false;
}
setTimeout(()=>{ if (ROOMS['competitions']) startQuiz('competitions'); },3000);

// ===== SOCKET =====
const chatUsers = {};
const mutedUsers = new Set();
const voiceRooms = {};

function kickUser(username,reason) {
  const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===username);
  if (sid) { io.to(sid).emit('kicked',reason); setTimeout(()=>io.sockets.sockets.get(sid)?.disconnect(),500); }
}
function getTime() { const n=new Date(); return `${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`; }
function getRoomUsers(r) {
  return Object.values(chatUsers).filter(u=>u.room===r).map(u => {
    const avatar = (memProfiles[u.name] && memProfiles[u.name].avatar) || u.avatar || null;
    return { ...u, avatar };
  });
}
async function saveMessage(room,username,text,type='chat') {
  const msg={room,username,text,type,time:getTime()};
  if (useDB) await db.query('INSERT INTO messages (room,username,text,type) VALUES ($1,$2,$3,$4)',[room,username,text,type]);
  else { memMessages[room]=memMessages[room]||[]; memMessages[room].push(msg); if (memMessages[room].length>50) memMessages[room].shift(); }
  return msg;
}
function broadcastRoomCounts() {
  const counts={}; Object.keys(ROOMS).forEach(r=>{counts[r]=getRoomUsers(r).length;}); io.emit('room-counts',counts);
}

io.on('connection', (socket) => {
  socket.on('join', async (data) => {
    const nameCheck=data.name||'';
    if (containsBadUsername(nameCheck)||containsBadWordFull(nameCheck).found) { socket.emit('username-rejected','❌ الاسم غير مقبول'); return; }
    if (nameCheck.trim().length<2||nameCheck.trim().length>20) { socket.emit('username-rejected','❌ الاسم يجب أن يكون بين 2 و 20 حرف'); return; }
    const rank=data.rank||'visitor';
    const rankInfo=RANKS[rank]||RANKS['visitor'];
    const user={id:socket.id,name:data.name,gender:data.gender||'ذكر',age:data.age||22,rank,rankInfo,room:'general',points:data.points||0};
    chatUsers[socket.id]=user;
    socket.join('general');
    let history=[];
    if (useDB){const r=await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50',['general']);history=r.rows.reverse();}
    else history=memMessages['general']||[];
    const roomCounts={}; Object.keys(ROOMS).forEach(r=>{roomCounts[r]=getRoomUsers(r).length;});
    socket.emit('init',{rooms:ROOMS,user,messages:history,onlineCount:Object.keys(chatUsers).length,roomCounts,ranks:RANKS});
    io.emit('online-count',Object.keys(chatUsers).length);
    broadcastRoomCounts();
    const joinText=`انضم للغرفة (# ${rankInfo.label} #)`;
    const sysMsg=await saveMessage('general',null,joinText,'system');
    io.to('general').emit('message',{...sysMsg});
    io.to('general').emit('room-users',getRoomUsers('general'));
  });

  socket.on('switch-room', async (roomId) => {
    const user=chatUsers[socket.id]; if (!user||!ROOMS[roomId]) return;
    const oldRoom=user.room; socket.leave(oldRoom);
    const leaveMsg=await saveMessage(oldRoom,null,`👋 ${user.name} غادر الغرفة`,'system');
    io.to(oldRoom).emit('message',leaveMsg); io.to(oldRoom).emit('room-users',getRoomUsers(oldRoom));
    user.room=roomId; socket.join(roomId);
    let history=[];
    if (useDB){const r=await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50',[roomId]);history=r.rows.reverse();}
    else history=memMessages[roomId]||[];
    socket.emit('room-history',{roomId,messages:history,users:getRoomUsers(roomId)});
    const rankInfo=RANKS[user.rank]||RANKS['visitor'];
    const joinText=`انضم للغرفة (# ${rankInfo.label} #)`;
    const joinMsg=await saveMessage(roomId,null,joinText,'system');
    io.to(roomId).emit('message',joinMsg); io.to(roomId).emit('room-users',getRoomUsers(roomId));
    broadcastRoomCounts();
  });

  const rateLimits={}; const lastMessages={}; const warnCount={};

  socket.on('chat-message', async (data) => {
    const user=chatUsers[socket.id]; if (!user) return;
    if (mutedUsers.has(user.name)){socket.emit('muted','أنت مكتوم');return;}
    const text=(data.text||'').trim().substring(0,300); if (!text) return;
    const now=Date.now(); const sid=socket.id;
    if (!rateLimits[sid]) rateLimits[sid]=[];
    rateLimits[sid]=rateLimits[sid].filter(t=>now-t<3000);
    if (rateLimits[sid].length>=3){socket.emit('spam-warning','⚠️ أنت ترسل رسائل بسرعة كبيرة');return;}
    rateLimits[sid].push(now);
    if (lastMessages[sid]&&lastMessages[sid].text===text&&now-lastMessages[sid].time<5000){socket.emit('spam-warning','⚠️ لا تكرر نفس الرسالة');return;}
    lastMessages[sid]={text,time:now};
    if (/<script|javascript:|on\w+=/i.test(text)){socket.emit('spam-warning','⚠️ رسالة غير مسموح بها');return;}

    // AD DETECTION
    if (detectAdLink(text)) {
      socket.emit('ad-warning','🚫 تم حذف رسالتك وتم حظرك بسبب الإشهار');
      mutedUsers.add(user.name);
      io.to(user.room).emit('system-notice',`🚫 تم حظر ${user.name} بسبب الإشهار`);
      if (user.rank!=='visitor'){
        if (useDB) await db.query('UPDATE users SET is_banned=TRUE WHERE username=$1',[user.name]);
        else if (memUsers[user.name]) memUsers[user.name].is_banned=true;
        kickUser(user.name,'🚫 تم حظرك بسبب الإشهار في الموقع');
      }
      return;
    }

    // QUIZ ANSWER
    if (ROOMS[user.room]?.isQuiz) {
      const correct=checkAnswer(user.room,user.name,text);
      if (correct) {
        const pts=correct.points||50;
        await addPoints(user.name,pts);
        user.points=(user.points||0)+pts;
        const rankInfo=RANKS[user.rank]||RANKS['visitor'];
        // أولاً: رسالة العضو تظهر
        const uMsg=await saveMessage(user.room,user.name,text);
        io.to(user.room).emit('message',{...uMsg,user:{name:user.name,gender:user.gender,age:user.age,rank:user.rank,...rankInfo}});
        // ثانياً: رسالة الروبوت "أحسنت" بعدها مباشرة
        const successMsg=await saveMessage(user.room,'مسابقات',`🎉 أحسنت ${user.name}! الإجابة الصحيحة هي: ${correct.a} — حصلت على ${pts} نقطة 🏆 المجموع: ${user.points} نقطة`,'quiz');
        io.to(user.room).emit('message',{...successMsg,user:{name:'مسابقات',rank:'owner',color:'#ffd700',label:'🏆 مسابقات'},isBot:true});
        nextQuestion(user.room); return;
      }
    }

    // PROFANITY
    const badCheck=containsBadWordFull(text);
    if (badCheck.found) {
      warnCount[user.name]=(warnCount[user.name]||0)+1;
      if (warnCount[user.name]>=3){mutedUsers.add(user.name);socket.emit('muted','تم كتمك تلقائياً');io.to(user.room).emit('system-notice',`⚠️ تم كتم ${user.name}`);warnCount[user.name]=0;return;}
      socket.emit('profanity-warning',{msg:`⚠️ تحذير ${warnCount[user.name]}/3`,remaining:3-warnCount[user.name]});
      return;
    }

  const rankInfo = RANKS[user.rank] || RANKS['visitor'];
  const msg = await saveMessage(user.room, user.name, text);
  io.to(user.room).emit('message',{...msg,user:{name:user.name,gender:user.gender,age:user.age,rank:user.rank,...rankInfo}});
  });

  // ADMIN ACTIONS
  socket.on('admin-mute',(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canMute')) return;
    const t=Object.values(chatUsers).find(u=>u.name===data.username); if (t&&!canManage(a.rank,t.rank)) return;
    mutedUsers.add(data.username);
    const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===data.username);
    if (sid) io.to(sid).emit('muted',`تم كتمك من قبل ${a.name}`);
    io.emit('system-notice',`🔇 تم كتم ${data.username}`);
  });
  socket.on('admin-unmute',(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canMute')) return;
    mutedUsers.delete(data.username);
    const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===data.username);
    if (sid) io.to(sid).emit('unmuted','تم رفع الكتم عنك');
  });
  socket.on('admin-kick',(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canKick')) return;
    const t=Object.values(chatUsers).find(u=>u.name===data.username); if (t&&!canManage(a.rank,t.rank)) return;
    kickUser(data.username,`تم طردك من قبل ${a.name}`); io.emit('system-notice',`🚫 تم طرد ${data.username}`);
  });
  socket.on('admin-ban',async(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canBan')) return;
    const t=Object.values(chatUsers).find(u=>u.name===data.username); if (t&&!canManage(a.rank,t.rank)) return;
    if (useDB) await db.query('UPDATE users SET is_banned=TRUE WHERE username=$1',[data.username]);
    else if (memUsers[data.username]) memUsers[data.username].is_banned=true;
    kickUser(data.username,`تم حظرك من قبل ${a.name}`); io.emit('system-notice',`🚫 تم حظر ${data.username}`);
  });
  socket.on('admin-resetwarn',(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canMute')) return;
    delete warnCount[data.username]; mutedUsers.delete(data.username);
    const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===data.username);
    if (sid) io.to(sid).emit('unmuted','تم رفع الكتم وإعادة تعيين تحذيراتك');
  });

  // PRIVATE MESSAGES
  // Admin adds quiz question via socket (fallback)
  // ===== VOICE MESSAGES (relay) =====
  socket.on('voice-message', (data) => {
    const user = chatUsers[socket.id];
    if (!user || !data.room || !data.data) return;
    if (data.data.length > 5 * 1024 * 1024) return; // max 5MB base64 (~1min audio)
    // Broadcast to room (except sender)
    socket.to(data.room).emit('voice-message', {
      room: data.room,
      data: data.data,
      duration: Math.min(data.duration || 0, 60),
      from: user.name
    });
  });

  socket.on('pm-voice-message', (data) => {
    const user = chatUsers[socket.id];
    if (!user || !data.to || !data.data) return;
    if (data.data.length > 5 * 1024 * 1024) return;
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) {
      io.to(toSid).emit('pm-voice-message', {
        from: user.name,
        to: data.to,
        data: data.data,
        duration: Math.min(data.duration || 0, 60)
      });
    }
  });

  // ===== WebRTC CALLS (relay) =====
  socket.on('call-offer', (data) => {
    const user = chatUsers[socket.id];
    if (!user || !data.to) return;
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-offer', { ...data, from: user.name });
  });
  socket.on('call-answer', (data) => {
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-answer', data);
  });
  socket.on('call-ice', (data) => {
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-ice', data);
  });
  socket.on('call-reject', (data) => {
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-reject', {});
  });
  socket.on('call-end', (data) => {
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-end', {});
  });

  socket.on('admin-add-quiz-q', (data) => {
    const user = chatUsers[socket.id];
    if (!user || !['owner','owner_admin','super_admin','admin'].includes(user.rank)) return;
    if (!data.q || !data.a) return;
    const newQ = { q: data.q.trim(), a: data.a.trim(), hint: data.hint||'', points: parseInt(data.points)||50 };
    adminQuizQuestions.push(newQ);
    Object.keys(quizState).forEach(roomId => {
      if (quizState[roomId]) quizState[roomId].pool.push({...newQ});
    });
    socket.emit('quiz-q-added', { ok:true, count: adminQuizQuestions.length });
  });

  socket.on('private-message',(data)=>{
    const sender=chatUsers[socket.id]; if (!sender) return;
    const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===data.to); if (!sid) return;
    const pm={type:'private',from:sender.name,to:data.to,text:data.text,time:getTime(),fromRank:sender.rank,fromRankInfo:RANKS[sender.rank]};
    socket.emit('private-message',pm); io.to(sid).emit('private-message',pm);
  });

  // WEBRTC VOICE/VIDEO SIGNALING
  socket.on('voice-join',(roomId)=>{
    const user=chatUsers[socket.id]; if (!user) return;
    if (!voiceRooms[roomId]) voiceRooms[roomId]=[];
    voiceRooms[roomId].forEach(pid=>{
      io.to(pid).emit('voice-user-joined',{peerId:socket.id,username:user.name});
      socket.emit('voice-user-joined',{peerId:pid,username:chatUsers[pid]?.name});
    });
    voiceRooms[roomId].push(socket.id);
    io.to(roomId).emit('voice-room-update',{roomId,users:voiceRooms[roomId].map(id=>chatUsers[id]?.name).filter(Boolean)});
  });
  socket.on('voice-leave',(roomId)=>{
    if (voiceRooms[roomId]){
      voiceRooms[roomId]=voiceRooms[roomId].filter(id=>id!==socket.id);
      io.to(roomId).emit('voice-user-left',{peerId:socket.id});
      io.to(roomId).emit('voice-room-update',{roomId,users:voiceRooms[roomId].map(id=>chatUsers[id]?.name).filter(Boolean)});
    }
  });
  socket.on('rtc-offer',(data)=>io.to(data.to).emit('rtc-offer',{from:socket.id,offer:data.offer}));
  socket.on('rtc-answer',(data)=>io.to(data.to).emit('rtc-answer',{from:socket.id,answer:data.answer}));
  socket.on('rtc-ice',(data)=>io.to(data.to).emit('rtc-ice',{from:socket.id,candidate:data.candidate}));

  socket.on('disconnect', async () => {
    const user=chatUsers[socket.id]; if (!user) return;
    const room=user.room;
    Object.keys(voiceRooms).forEach(vr=>{
      if (voiceRooms[vr].includes(socket.id)){
        voiceRooms[vr]=voiceRooms[vr].filter(id=>id!==socket.id);
        io.to(vr).emit('voice-user-left',{peerId:socket.id});
      }
    });
    delete chatUsers[socket.id];
    const msg=await saveMessage(room,null,`👋 ${user.name} غادر الموقع`,'system');
    io.to(room).emit('message',msg); io.to(room).emit('room-users',getRoomUsers(room));
    io.emit('online-count',Object.keys(chatUsers).length); broadcastRoomCounts();
  });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => server.listen(PORT, () => console.log(`غزل عراقي يعمل على المنفذ ${PORT}`)));
