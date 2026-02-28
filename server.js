const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
          rank VARCHAR(20) DEFAULT 'member',
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
      `);
      const adminPass = hashPassword(process.env.ADMIN_PASSWORD || 'admin123');
      await db.query(`INSERT INTO users (username,password,rank) VALUES ('admin',$1,'owner') ON CONFLICT (username) DO NOTHING`, [adminPass]);
      useDB = true;
      console.log('✅ Database connected');
    } catch(e) { console.log('⚠️ No DB - using memory:', e.message); }
  }
}

// In-memory fallback
const memUsers = {
  admin: { username:'admin', password:hashPassword('admin123'), rank:'owner', is_banned:false }
};
const memMessages = {};

function hashPassword(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

// ===== ROOMS (dynamic) =====
let ROOMS = {
  general:  { name:'الغرفة العامة',  icon:'🌍', color:'#1565c0' },
  iraq:     { name:'غرفة العراق',    icon:'🇮🇶', color:'#c62828' },
  youth:    { name:'غرفة الشباب',    icon:'🔥', color:'#e65100' },
  feelings: { name:'غرفة المشاعر',   icon:'💕', color:'#c2185b' },
  music:    { name:'غرفة الموسيقى',  icon:'🎵', color:'#6a1b9a' },
  sports:   { name:'غرفة الرياضة',   icon:'⚽', color:'#2e7d32' },
  fun:      { name:'غرفة الفكاهة',   icon:'😂', color:'#f57f17' },
  elders:   { name:'غرفة كبار السن', icon:'🌹', color:'#37474f' },
};
Object.keys(ROOMS).forEach(r => memMessages[r] = []);

// Room slug generator
function slugify(text) {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-]/g, '') || 'room-' + Date.now();
}

// ===== ROOM MANAGEMENT ROUTES =====
// Add room
app.post('/api/admin/addroom', adminAuth, (req,res) => {
  const { name, icon, color } = req.body;
  if (!name || !icon) return res.json({ ok:false, msg:'الاسم والأيقونة مطلوبان' });
  if (Object.keys(ROOMS).length >= 20) return res.json({ ok:false, msg:'الحد الأقصى 20 غرفة' });
  const id = slugify(name) + '-' + Date.now().toString().slice(-4);
  ROOMS[id] = { name, icon, color: color || '#1565c0' };
  memMessages[id] = [];
  io.emit('rooms-updated', ROOMS);
  res.json({ ok:true, id });
});

// Edit room
app.post('/api/admin/editroom', adminAuth, (req,res) => {
  const { id, name, icon, color } = req.body;
  if (!ROOMS[id]) return res.json({ ok:false, msg:'الغرفة غير موجودة' });
  if (name) ROOMS[id].name = name;
  if (icon) ROOMS[id].icon = icon;
  if (color) ROOMS[id].color = color;
  io.emit('rooms-updated', ROOMS);
  io.to(id).emit('room-info-updated', { id, ...ROOMS[id] });
  res.json({ ok:true });
});

// Delete room
app.post('/api/admin/deleteroom', adminAuth, (req,res) => {
  const { id } = req.body;
  const protectedRooms = ['general'];
  if (protectedRooms.includes(id)) return res.json({ ok:false, msg:'لا يمكن حذف الغرفة العامة' });
  if (!ROOMS[id]) return res.json({ ok:false, msg:'الغرفة غير موجودة' });
  // Move users in that room to general
  Object.values(chatUsers).forEach(u => {
    if (u.room === id) {
      const sid = u.id;
      io.to(sid).emit('room-deleted', 'تم حذف الغرفة، تم نقلك للغرفة العامة');
      const socket = io.sockets.sockets.get(sid);
      if (socket) { socket.leave(id); socket.join('general'); }
      u.room = 'general';
    }
  });
  delete ROOMS[id];
  delete memMessages[id];
  io.emit('rooms-updated', ROOMS);
  res.json({ ok:true });
});

// Get all rooms
app.get('/api/rooms', (req,res) => {
  res.json({ ok:true, rooms: ROOMS });
});

// ===== PROFANITY FILTER =====
let BAD_WORDS = [
  // ===== عربية - سب وشتم =====
  'كلب','كلبة','حمار','حمارة','غبي','غبية','احمق','احمقة','معتوه',
  'وقح','وقحة','منافق','منافقة','كذاب','كذابة','لعين','لعينة',
  'يلعن','العن','تبا','ملعون','ملعونة','خنزير','خنزيرة','قرد','قردة',
  'تفو','خرا','خراء','زبالة','نجس','نجسة','وسخ','وسخة','بهيم',
  'ابو زبالة','ابن الكلب','ابن الحرام','بنت الكلب','بنت الحرام',
  'يمك','يفك','يلعن دينك','يلعن اهلك',
  'ثور','بقرة','حقير','حقيرة','نذل','نذلة','خسيس','خسيسة',

  // ===== عربية - جنسية =====
  'شرموطة','شرموط','عاهرة','عاهر','زانية','زاني','فاجرة','فاجر',
  'قحبة','قحب','متناكة','منيوك','مخنث','شاذ','لوطي','ابن زنا','بنت زنا',
  'زب','زبي','كس','كسك','كسها','كسي','طيز','طيزك','طيزها',
  'نيك','انيك','انيكك','ينيك','تنيك','نايك','ناكني','ناكها',
  'بزاز','بزازها','بزازك','متناك','تناك','يتناك',
  'خول','خولات','مفعول به','يمارس','جنس','ممارسة الجنس',
  'سكس','بورن','بورنو','إباحي','إباحية',

  // ===== English - profanity =====
  'fuck','fucker','fucking','fucked','fucks','shit','bitch','bastard',
  'asshole','jackass','dumbass','damn','crap','idiot','stupid','moron',
  'retard','retarded','loser','jerk','prick','wanker','tosser',
  'motherfucker','son of a bitch','son of bitch',

  // ===== English - sexual =====
  'sex','sexy','porn','porno','pornography','nude','naked','boobs',
  'penis','vagina','dick','cock','pussy','cunt','tits','ass',
  'whore','slut','prostitute','escort','horny','masturbate','orgasm',
  'blowjob','handjob','anal','erotic','xxx','18+',

  // ===== ناقصة من القائمة السابقة =====
  'قواد','قوادة','خنيث','خناثة','منيك',
  'كس امك','كس اختك','كسمك','ممحون','ممحونة','زق','متزوق',
  'مقود','مقودة','ديوث','ديوثة','قرناء',

  // ===== لهجة عراقية =====
  'چوني','گاي','چخي','تعال اناكك','يعني اناكك',
  'خنيك','خنيكة','بيه','بيها','عيري','عيرك','عيرها',
  'كسج','كسها','كسه','طيزج','طيزها','طيزه',
  'أنيچ','أنيكج','أنيكك','انيج','روح انتاك','روح تنتاك',
  'ولد متناك','بنت متناكة','خوش ناكت','شكو ماكو تنيك',
  'حبوبي تعال','حبيبي تعال ناكني','منيوچ','منيوج',
  'گلبي','مو گلبي بس','ولد القحبة','بنت القحبة',
  'ابن الشرموطة','ابن الغندور','غندور','غندورة',
  'معرص','معرصة','مخنوق بيها','مخنوق بيه',
  'روح العب','روح اللعب بنفسك',

  // ===== تركية / فارسية =====
  'lanet','kahpe','orospu','sikim','amk','sik','got','oç',
  'kos','jende','harami',
];

// ===== SEXUAL USERNAMES FILTER =====
let BAD_USERNAMES = [
  // عربية - أسماء جنسية
  'زب','كس','طيز','نيك','شرموط','شرموطة','عاهر','عاهرة','قحبة','قحب',
  'زاني','زانية','مخنث','شاذ','لوطي','سكسي','سكس','ناكر','ناكت',
  'خول','متناك','فاجر','فاجرة','عشيق','عشيقة',

  // English - sexual usernames  
  'sex','sexy','porn','horny','naked','nude','slut','whore',
  'dick','cock','pussy','boobs','tits','ass','xxx','hot69',
  'fuck','fucker','bitch','bastard','asshole',

  // أرقام جنسية شائعة في الأسماء
  '69','18sex','sex18','porn69',

  // إضافات عراقية للأسماء
  'قواد','خنيث','ديوث','غندور','معرص','ممحون','كسمك','زق',
];

// ===== CUSTOM WORDS MANAGEMENT =====
// Store admin-added words separately
let customBadWords = [];

// Merge function - combine default + custom
function getAllBadWords() {
  return [...BAD_WORDS, ...customBadWords];
}

// Override containsBadWord to use merged list
function containsBadWordFull(text) {
  const normalized = normalizeAr(text.toLowerCase());
  const compact = normalized.replace(/[\s\.\-_\*]+/g, '');
  const allWords = getAllBadWords();
  for (const word of allWords) {
    const normWord = normalizeAr(word.toLowerCase());
    if (normalized.includes(normWord)) return { found: true, word };
    if (compact.includes(normWord.replace(/\s/g,''))) return { found: true, word };
  }
  return { found: false };
}

// Admin: get all bad words
app.get('/api/admin/badwords', adminAuth, (req,res) => {
  res.json({ ok:true, default: BAD_WORDS, custom: customBadWords });
});

// Admin: add custom word
app.post('/api/admin/badwords/add', adminAuth, (req,res) => {
  const { word } = req.body;
  if (!word || word.trim().length < 2) return res.json({ ok:false, msg:'الكلمة قصيرة جداً' });
  const w = word.trim().toLowerCase();
  if (customBadWords.includes(w)) return res.json({ ok:false, msg:'الكلمة موجودة مسبقاً' });
  customBadWords.push(w);
  res.json({ ok:true, custom: customBadWords });
});

// Admin: remove custom word
app.post('/api/admin/badwords/remove', adminAuth, (req,res) => {
  const { word } = req.body;
  customBadWords = customBadWords.filter(w => w !== word.trim().toLowerCase());
  res.json({ ok:true, custom: customBadWords });
});

// Admin: remove from default list too
app.post('/api/admin/badwords/removedefault', adminAuth, (req,res) => {
  const { word } = req.body;
  BAD_WORDS = BAD_WORDS.filter(w => w !== word);
  res.json({ ok:true });
});

function containsBadUsername(name) {
  const normalized = normalizeAr(name.toLowerCase()).replace(/\s+/g,'');
  const compact = normalized.replace(/[\.\-_\*0-9]/g,'');
  for (const word of BAD_USERNAMES) {
    const normWord = normalizeAr(word.toLowerCase());
    if (normalized.includes(normWord)) return true;
    if (compact.includes(normWord)) return true;
  }
  return false;
}

// Normalize Arabic text for better matching
function normalizeAr(text) {
  return text
    .replace(/أ|إ|آ/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsBadWord(text) {
  const normalized = normalizeAr(text.toLowerCase());
  // Remove spaces and special chars for bypass detection
  const compact = normalized.replace(/[\s\.\-_\*]+/g, '');
  
  for (const word of BAD_WORDS) {
    const normWord = normalizeAr(word.toLowerCase());
    if (normalized.includes(normWord)) return { found: true, word };
    if (compact.includes(normWord.replace(/\s/g,''))) return { found: true, word };
  }
  return { found: false };
}

// Censor the message instead of blocking (replace bad word with ***)
function censorText(text) {
  let result = text;
  const normalized = normalizeAr(text.toLowerCase());
  for (const word of BAD_WORDS) {
    const normWord = normalizeAr(word.toLowerCase());
    if (normalized.includes(normWord)) {
      // Replace in original text (case insensitive)
      const regex = new RegExp(word.replace(/[-\/\^$*+?.()|[\]{}]/g, '\$&'), 'gi');
      result = result.replace(regex, '*'.repeat(word.length));
    }
  }
  return result;
}

// Warn counter per user
const warnCount = {};
const MAX_WARNS = 3;

// Rank colors & labels
const RANK_COLORS = { owner:'#ff6b35', admin:'#ffd54f', vip:'#ce93d8', member:'#90caf9', visitor:'#b0bec5' };
const RANK_LABELS = { owner:'👑 مالك', admin:'⚙️ إداري', vip:'💎 VIP', member:'👤 عضو', visitor:'👁️ زائر' };

// ===== AUTH ROUTES =====
app.post('/api/register', async (req,res) => {
  const { username, password, gender, age } = req.body;
  if (!username || !password || username.length < 3) return res.json({ ok:false, msg:'بيانات غير صحيحة' });
  // Check for bad/sexual username
  if (containsBadUsername(username) || containsBadWordFull(username).found) {
    return res.json({ ok:false, msg:'❌ اسم المستخدم غير مقبول - يحتوي على كلمات غير لائقة' });
  }
  const hashed = hashPassword(password);
  if (useDB) {
    try {
      await db.query('INSERT INTO users (username,password) VALUES ($1,$2)', [username, hashed]);
      res.json({ ok:true });
    } catch(e) { res.json({ ok:false, msg:'الاسم مستخدم مسبقاً' }); }
  } else {
    if (memUsers[username]) return res.json({ ok:false, msg:'الاسم مستخدم مسبقاً' });
    memUsers[username] = { username, password:hashed, rank:'member', is_banned:false, gender, age };
    res.json({ ok:true });
  }
});

app.post('/api/login', async (req,res) => {
  const { username, password } = req.body;
  const hashed = hashPassword(password);
  if (useDB) {
    const r = await db.query('SELECT * FROM users WHERE username=$1 AND password=$2', [username, hashed]);
    if (!r.rows.length) return res.json({ ok:false, msg:'اسم المستخدم أو كلمة المرور خاطئة' });
    const u = r.rows[0];
    if (u.is_banned) return res.json({ ok:false, msg:'تم حظرك' });
    res.json({ ok:true, user:{ username:u.username, rank:u.rank } });
  } else {
    const u = memUsers[username];
    if (!u || u.password !== hashed) return res.json({ ok:false, msg:'اسم المستخدم أو كلمة المرور خاطئة' });
    if (u.is_banned) return res.json({ ok:false, msg:'تم حظرك' });
    res.json({ ok:true, user:{ username:u.username, rank:u.rank } });
  }
});

// ===== ADMIN ROUTES =====
function adminAuth(req,res,next) {
  if (req.headers['x-admin-token'] !== (process.env.ADMIN_TOKEN||'ghazal-admin-2024')) return res.json({ok:false,msg:'غير مصرح'});
  next();
}

app.get('/api/admin/users', adminAuth, async (req,res) => {
  if (useDB) {
    const r = await db.query('SELECT id,username,rank,is_banned,created_at FROM users ORDER BY created_at DESC');
    res.json({ ok:true, users:r.rows });
  } else {
    res.json({ ok:true, users:Object.values(memUsers).map(u=>({...u,password:undefined})) });
  }
});

app.post('/api/admin/ban', adminAuth, async (req,res) => {
  const { username } = req.body;
  if (useDB) await db.query('UPDATE users SET is_banned=TRUE WHERE username=$1', [username]);
  else if (memUsers[username]) memUsers[username].is_banned = true;
  kickUser(username, 'تم حظرك من الموقع');
  res.json({ ok:true });
});

app.post('/api/admin/unban', adminAuth, async (req,res) => {
  const { username } = req.body;
  if (useDB) await db.query('UPDATE users SET is_banned=FALSE WHERE username=$1', [username]);
  else if (memUsers[username]) memUsers[username].is_banned = false;
  res.json({ ok:true });
});

app.post('/api/admin/setrank', adminAuth, async (req,res) => {
  const { username, rank } = req.body;
  if (useDB) await db.query('UPDATE users SET rank=$1 WHERE username=$2', [rank, username]);
  else if (memUsers[username]) memUsers[username].rank = rank;
  res.json({ ok:true });
});

// Member changes their own password
app.post('/api/changepass', async (req,res) => {
  const { username, oldpassword, newpassword } = req.body;
  if (!username || !oldpassword || !newpassword) return res.json({ ok:false, msg:'بيانات ناقصة' });
  if (newpassword.length < 4) return res.json({ ok:false, msg:'كلمة المرور الجديدة قصيرة جداً' });
  if (oldpassword === newpassword) return res.json({ ok:false, msg:'كلمة المرور الجديدة مطابقة للقديمة' });

  const oldHashed = hashPassword(oldpassword);
  const newHashed = hashPassword(newpassword);

  if (useDB) {
    // Verify old password first
    const check = await db.query('SELECT id FROM users WHERE username=$1 AND password=$2', [username, oldHashed]);
    if (!check.rows.length) return res.json({ ok:false, msg:'كلمة المرور القديمة خاطئة' });
    await db.query('UPDATE users SET password=$1 WHERE username=$2', [newHashed, username]);
  } else {
    const u = memUsers[username];
    if (!u || u.password !== oldHashed) return res.json({ ok:false, msg:'كلمة المرور القديمة خاطئة' });
    u.password = newHashed;
  }
  res.json({ ok:true });
});

app.post('/api/admin/resetpass', adminAuth, async (req,res) => {
  const { username, newpassword } = req.body;
  if (!username || !newpassword || newpassword.length < 4) return res.json({ ok:false, msg:'كلمة المرور قصيرة' });
  const hashed = hashPassword(newpassword);
  if (useDB) {
    const r = await db.query('UPDATE users SET password=$1 WHERE username=$2', [hashed, username]);
    if (r.rowCount === 0) return res.json({ ok:false, msg:'المستخدم غير موجود' });
  } else {
    if (!memUsers[username]) return res.json({ ok:false, msg:'المستخدم غير موجود' });
    memUsers[username].password = hashed;
  }
  res.json({ ok:true });
});

app.post('/api/admin/clearroom', adminAuth, async (req,res) => {
  const { room } = req.body;
  if (useDB) await db.query('DELETE FROM messages WHERE room=$1', [room]);
  memMessages[room] = [];
  io.to(room).emit('room-cleared', room);
  res.json({ ok:true });
});

app.get('/api/messages/:room', async (req,res) => {
  const room = req.params.room;
  if (!ROOMS[room]) return res.json({ ok:false });
  if (useDB) {
    const r = await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50', [room]);
    res.json({ ok:true, messages:r.rows.reverse() });
  } else {
    res.json({ ok:true, messages: memMessages[room] || [] });
  }
});

// ===== SOCKET =====
const chatUsers = {};
const mutedUsers = new Set();

function kickUser(username, reason) {
  const sid = Object.keys(chatUsers).find(id => chatUsers[id].name === username);
  if (sid) {
    io.to(sid).emit('kicked', reason);
    setTimeout(() => io.sockets.sockets.get(sid)?.disconnect(), 500);
  }
}

function getTime() {
  const n = new Date();
  return `${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`;
}

function getRoomUsers(roomId) {
  return Object.values(chatUsers).filter(u => u.room === roomId);
}

async function saveMessage(room, username, text, type='chat') {
  const msg = { room, username, text, type, time: getTime() };
  if (useDB) {
    await db.query('INSERT INTO messages (room,username,text,type) VALUES ($1,$2,$3,$4)', [room, username, text, type]);
  } else {
    memMessages[room] = memMessages[room] || [];
    memMessages[room].push(msg);
    if (memMessages[room].length > 50) memMessages[room].shift();
  }
  return msg;
}

function broadcastRoomCounts() {
  const counts = {};
  Object.keys(ROOMS).forEach(r => {
    counts[r] = getRoomUsers(r).length;
  });
  io.emit('room-counts', counts);
}

io.on('connection', (socket) => {

  socket.on('join', async (data) => {
    // Check username for bad/sexual content
    const nameCheck = data.name || '';
    if (containsBadUsername(nameCheck) || containsBadWordFull(nameCheck).found) {
      socket.emit('username-rejected', '❌ الاسم غير مقبول - يحتوي على كلمات غير لائقة');
      return;
    }
    // Check username length
    if (nameCheck.trim().length < 2 || nameCheck.trim().length > 20) {
      socket.emit('username-rejected', '❌ الاسم يجب أن يكون بين 2 و 20 حرف');
      return;
    }

    const user = {
      id: socket.id,
      name: data.name,
      gender: data.gender || 'ذكر',
      age: data.age || 22,
      rank: data.rank || 'visitor',
      room: 'general',
    };
    chatUsers[socket.id] = user;
    socket.join('general');

    // Load history
    let history = [];
    if (useDB) {
      const r = await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50', ['general']);
      history = r.rows.reverse();
    } else {
      history = memMessages['general'] || [];
    }

    socket.emit('init', { rooms: ROOMS, user, messages: history, onlineCount: Object.keys(chatUsers).length });
    io.emit('online-count', Object.keys(chatUsers).length);
    // Broadcast room counts to all
    broadcastRoomCounts();

    const sysMsg = await saveMessage('general', null, `🌟 ${user.name} انضم إلى الغرفة`, 'system');
    io.to('general').emit('message', { ...sysMsg, rank: user.rank });
    io.to('general').emit('room-users', getRoomUsers('general'));
  });

  socket.on('switch-room', async (roomId) => {
    const user = chatUsers[socket.id];
    if (!user || !ROOMS[roomId]) return;
    const oldRoom = user.room;
    socket.leave(oldRoom);

    const leaveMsg = await saveMessage(oldRoom, null, `👋 ${user.name} غادر الغرفة`, 'system');
    io.to(oldRoom).emit('message', leaveMsg);
    io.to(oldRoom).emit('room-users', getRoomUsers(oldRoom));

    user.room = roomId;
    socket.join(roomId);

    let history = [];
    if (useDB) {
      const r = await db.query('SELECT * FROM messages WHERE room=$1 ORDER BY created_at DESC LIMIT 50', [roomId]);
      history = r.rows.reverse();
    } else {
      history = memMessages[roomId] || [];
    }

    socket.emit('room-history', { roomId, messages: history, users: getRoomUsers(roomId) });

    const joinMsg = await saveMessage(roomId, null, `🌟 ${user.name} انضم إلى الغرفة`, 'system');
    io.to(roomId).emit('message', joinMsg);
    io.to(roomId).emit('room-users', getRoomUsers(roomId));
    broadcastRoomCounts();
  });

  // Rate limiting per socket
  const rateLimits = {};
  const lastMessages = {};

  socket.on('chat-message', async (data) => {
    const user = chatUsers[socket.id];
    if (!user) return;
    if (mutedUsers.has(user.name)) { socket.emit('muted', 'أنت مكتوم'); return; }

    const text = (data.text || '').trim().substring(0, 300);
    if (!text) return;

    // 1. Block spam - max 3 messages per 3 seconds
    const now = Date.now();
    const sid = socket.id;
    if (!rateLimits[sid]) rateLimits[sid] = [];
    rateLimits[sid] = rateLimits[sid].filter(t => now - t < 3000);
    if (rateLimits[sid].length >= 3) {
      socket.emit('spam-warning', '⚠️ أنت ترسل رسائل بسرعة كبيرة، انتظر قليلاً');
      return;
    }
    rateLimits[sid].push(now);

    // 2. Block duplicate messages
    const lastMsg = lastMessages[sid];
    if (lastMsg && lastMsg.text === text && now - lastMsg.time < 5000) {
      socket.emit('spam-warning', '⚠️ لا تكرر نفس الرسالة');
      return;
    }
    lastMessages[sid] = { text, time: now };

    // 3. Block harmful content / XSS
    const dangerous = /<script|javascript:|on\w+=/i;
    if (dangerous.test(text)) {
      socket.emit('spam-warning', '⚠️ رسالة غير مسموح بها');
      return;
    }

    // 4. Profanity filter
    const badCheck = containsBadWordFull(text);
    if (badCheck.found) {
      const uid = user.name;
      warnCount[uid] = (warnCount[uid] || 0) + 1;
      const remaining = MAX_WARNS - warnCount[uid];
      
      if (warnCount[uid] >= MAX_WARNS) {
        // Auto-mute after 3 warnings
        mutedUsers.add(uid);
        socket.emit('muted', `تم كتمك تلقائياً بسبب استخدام كلمات مسيئة`);
        io.to(user.room).emit('system-notice', `⚠️ تم كتم ${uid} بسبب الإساءة`);
        warnCount[uid] = 0;
        return;
      }
      
      socket.emit('profanity-warning', {
        msg: `⚠️ تحذير ${warnCount[uid]}/${MAX_WARNS}: رسالتك تحتوي على كلمات غير لائقة`,
        remaining
      });
      return;
    }

    const msg = await saveMessage(user.room, user.name, text);
    io.to(user.room).emit('message', {
      ...msg,
      user: { name:user.name, gender:user.gender, age:user.age, rank:user.rank,
               color: RANK_COLORS[user.rank] || '#b0bec5',
               label: RANK_LABELS[user.rank] || '👁️ زائر' }
    });
  });

  socket.on('admin-resetwarn', (data) => {
    const admin = chatUsers[socket.id];
    if (!admin || !['owner','admin'].includes(admin.rank)) return;
    delete warnCount[data.username];
    // Unmute if was auto-muted
    mutedUsers.delete(data.username);
    const sid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.username);
    if (sid) io.to(sid).emit('unmuted', 'تم رفع الكتم وإعادة تعيين تحذيراتك');
  });

  socket.on('admin-mute', (data) => {
    const admin = chatUsers[socket.id];
    if (!admin || !['owner','admin'].includes(admin.rank)) return;
    mutedUsers.add(data.username);
    const sid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.username);
    if (sid) io.to(sid).emit('muted', `تم كتمك من قبل ${admin.name}`);
    io.emit('system-notice', `🔇 تم كتم ${data.username}`);
  });

  socket.on('admin-unmute', (data) => {
    const admin = chatUsers[socket.id];
    if (!admin || !['owner','admin'].includes(admin.rank)) return;
    mutedUsers.delete(data.username);
    const sid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.username);
    if (sid) io.to(sid).emit('unmuted', 'تم رفع الكتم عنك');
  });

  socket.on('admin-kick', (data) => {
    const admin = chatUsers[socket.id];
    if (!admin || !['owner','admin'].includes(admin.rank)) return;
    kickUser(data.username, `تم طردك من قبل ${admin.name}`);
    io.emit('system-notice', `🚫 تم طرد ${data.username}`);
  });

  socket.on('private-message', (data) => {
    const sender = chatUsers[socket.id];
    if (!sender) return;
    const sid = Object.keys(chatUsers).find(id => chatUsers[id].name === data.to);
    if (!sid) return;
    const pm = { type:'private', from:sender.name, to:data.to, text:data.text, time:getTime() };
    socket.emit('private-message', pm);
    io.to(sid).emit('private-message', pm);
  });

  socket.on('disconnect', async () => {
    const user = chatUsers[socket.id];
    if (!user) return;
    const room = user.room;
    delete chatUsers[socket.id];
    delete warnCount[user.name];
    const msg = await saveMessage(room, null, `👋 ${user.name} غادر الموقع`, 'system');
    io.to(room).emit('message', msg);
    io.to(room).emit('room-users', getRoomUsers(room));
    io.emit('online-count', Object.keys(chatUsers).length);
    broadcastRoomCounts();
  });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => server.listen(PORT, () => console.log(`✅ غزل عراقي يعمل على المنفذ ${PORT}`)));
