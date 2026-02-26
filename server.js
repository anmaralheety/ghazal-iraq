const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ===== DATA =====
const rooms = {
  'general':   { name: 'الغرفة العامة',   icon: '🌍', color: '#1565c0' },
  'iraq':      { name: 'غرفة العراق',     icon: '🇮🇶', color: '#c62828' },
  'youth':     { name: 'غرفة الشباب',     icon: '🔥', color: '#e65100' },
  'feelings':  { name: 'غرفة المشاعر',    icon: '💕', color: '#c2185b' },
  'music':     { name: 'غرفة الموسيقى',   icon: '🎵', color: '#6a1b9a' },
  'sports':    { name: 'غرفة الرياضة',    icon: '⚽', color: '#2e7d32' },
  'fun':       { name: 'غرفة الفكاهة',    icon: '😂', color: '#f57f17' },
  'elders':    { name: 'غرفة كبار السن',  icon: '🌹', color: '#37474f' },
};

// Connected users: socketId -> user info
const users = {};

// Room messages history (last 50 per room)
const roomMessages = {};
Object.keys(rooms).forEach(r => roomMessages[r] = []);

function getRoomUsers(roomId) {
  return Object.values(users).filter(u => u.room === roomId);
}

function getTotalOnline() {
  return Object.keys(users).length;
}

// ===== SOCKET EVENTS =====
io.on('connection', (socket) => {

  // User joins
  socket.on('join', (data) => {
    const user = {
      id: socket.id,
      name: data.name || 'زائر',
      gender: data.gender || 'ذكر',
      age: data.age || 22,
      role: data.role || 'visitor',
      room: 'general',
      color: data.color || '#1565c0',
    };
    users[socket.id] = user;
    socket.join('general');

    // Send rooms list & initial data
    socket.emit('init', {
      rooms,
      user,
      messages: roomMessages['general'],
      onlineCount: getTotalOnline(),
    });

    // Notify room about new user
    io.to('general').emit('room-users', getRoomUsers('general'));
    io.emit('online-count', getTotalOnline());

    // System message
    const sysMsg = {
      type: 'system',
      text: `🌟 ${user.name} انضم إلى الغرفة`,
      time: getTime(),
      room: 'general',
    };
    roomMessages['general'].push(sysMsg);
    if (roomMessages['general'].length > 50) roomMessages['general'].shift();
    io.to('general').emit('message', sysMsg);
  });

  // Switch room
  socket.on('switch-room', (roomId) => {
    const user = users[socket.id];
    if (!user || !rooms[roomId]) return;

    const oldRoom = user.room;
    socket.leave(oldRoom);

    // Notify old room
    const leaveMsg = {
      type: 'system',
      text: `👋 ${user.name} غادر الغرفة`,
      time: getTime(),
      room: oldRoom,
    };
    roomMessages[oldRoom].push(leaveMsg);
    if (roomMessages[oldRoom].length > 50) roomMessages[oldRoom].shift();
    io.to(oldRoom).emit('message', leaveMsg);
    io.to(oldRoom).emit('room-users', getRoomUsers(oldRoom));

    // Join new room
    user.room = roomId;
    socket.join(roomId);

    // Send history
    socket.emit('room-history', {
      roomId,
      messages: roomMessages[roomId],
      users: getRoomUsers(roomId),
    });

    // Notify new room
    const joinMsg = {
      type: 'system',
      text: `🌟 ${user.name} انضم إلى الغرفة`,
      time: getTime(),
      room: roomId,
    };
    roomMessages[roomId].push(joinMsg);
    if (roomMessages[roomId].length > 50) roomMessages[roomId].shift();
    io.to(roomId).emit('message', joinMsg);
    io.to(roomId).emit('room-users', getRoomUsers(roomId));
  });

  // Chat message
  socket.on('chat-message', (data) => {
    const user = users[socket.id];
    if (!user) return;

    const text = (data.text || '').trim().substring(0, 300);
    if (!text) return;

    const msg = {
      type: 'chat',
      user: {
        name: user.name,
        gender: user.gender,
        age: user.age,
        role: user.role,
        color: user.color,
      },
      text,
      time: getTime(),
      room: user.room,
    };

    roomMessages[user.room].push(msg);
    if (roomMessages[user.room].length > 50) roomMessages[user.room].shift();
    io.to(user.room).emit('message', msg);
  });

  // Private message
  socket.on('private-message', (data) => {
    const sender = users[socket.id];
    if (!sender) return;

    const targetSocket = Object.keys(users).find(id => users[id].name === data.to);
    if (!targetSocket) return;

    const pm = {
      type: 'private',
      from: sender.name,
      to: data.to,
      text: data.text,
      time: getTime(),
    };

    socket.emit('private-message', pm);
    io.to(targetSocket).emit('private-message', pm);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (!user) return;

    const room = user.room;
    delete users[socket.id];

    const leaveMsg = {
      type: 'system',
      text: `👋 ${user.name} غادر الموقع`,
      time: getTime(),
      room,
    };
    roomMessages[room].push(leaveMsg);
    if (roomMessages[room].length > 50) roomMessages[room].shift();
    io.to(room).emit('message', leaveMsg);
    io.to(room).emit('room-users', getRoomUsers(room));
    io.emit('online-count', getTotalOnline());
  });
});

function getTime() {
  const now = new Date();
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ غزل عراقي يعمل على المنفذ ${PORT}`);
});
