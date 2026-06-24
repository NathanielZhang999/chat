const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
const server = http.createServer(app);

// INCREASED PAYLOAD LIMIT TO 10MB FOR IMAGE UPLOADS
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e7 
});

const MONGO_URI = process.env.MONGO_URI; 

// --- SECURITY: REGEX ESCAPE (PREVENT ReDOS) ---
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

// --- SECURITY: RATE LIMITING ---
const authAttempts = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    const attempts = authAttempts.get(ip) || [];
    const recent = attempts.filter(time => now - time < 15 * 60 * 1000); // 15 mins window
    if (recent.length >= 10) { // Limit 10 attempts
        return false;
    }
    recent.push(now);
    authAttempts.set(ip, recent);
    return true;
}

function clearRateLimit(ip) {
    authAttempts.delete(ip);
}

// Clean up stale IP limits memory every 15 mins
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of authAttempts.entries()) {
        const recent = attempts.filter(time => now - time < 15 * 60 * 1000);
        if (recent.length === 0) authAttempts.delete(ip);
        else authAttempts.set(ip, recent);
    }
}, 15 * 60 * 1000);

// --- DATABASE SCHEMAS ---
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  color: { type: String, default: '' },      
  avatarUrl: { type: String, default: '' },  
  servers: { type: [String], default: ['global'] } 
});
const User = mongoose.model('User', UserSchema);

const ChatServerSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true, maxLength: 30 },
  owner: { type: String, required: true }
});
const ChatServer = mongoose.model('ChatServer', ChatServerSchema);

const MessageSchema = new mongoose.Schema({
  serverCode: { type: String, required: true, default: 'global' },
  username: String,
  role: { type: String, default: 'user' }, 
  color: { type: String, default: '' },      
  avatarUrl: { type: String, default: '' },  
  text: { type: String, default: '' },
  attachment: { type: String, default: null }, // Stores Base64 Compressed Images
  replyTo: { type: Object, default: null },
  reactions: { type: Object, default: {} }, // NEW FEATURE: Mixed JS Object map of Emoji Reactions
  edited: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  history: [{ text: String, timestamp: Date }], 
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- AUTO-SETUP SYSTEM ---
async function seedSystem() {
  try {
    const adminUser = 'NYZhang1';
    const hashed = await bcrypt.hash('DragonNYZ0924', 10);
    await User.findOneAndUpdate(
      { username: { $regex: new RegExp(`^${adminUser}$`, 'i') } },
      { username: adminUser, password: hashed, role: 'admin' },
      { upsert: true }
    );
    await ChatServer.findOneAndUpdate(
      { code: 'global' },
      { code: 'global', name: 'Global Chat', owner: 'System' },
      { upsert: true }
    );
    console.log('👑 Admin & Global Server ready.');
  } catch (err) { console.error("Seeding error:", err); }
}
if (MONGO_URI) mongoose.connect(MONGO_URI).then(seedSystem).catch(console.error);

const onlineUsers = new Map(); 

function broadcastOnlineUsers(serverCode) {
  if (!serverCode) return;
  const usersMap = new Map();
  for (const info of onlineUsers.values()) {
    if (info.serverCode === serverCode) {
      const isVisible = info.role !== 'admin' || info.joinedServers.includes(serverCode) || serverCode === 'global';
      if (isVisible && !usersMap.has(info.username)) {
        usersMap.set(info.username, { username: info.username, role: info.role, color: info.color, avatarUrl: info.avatarUrl });
      }
    }
  }
  io.to(serverCode).emit('online_users', Array.from(usersMap.values()));
}

io.on('connection', (socket) => {
  socket.serverCode = null;
  socket.joinedServers = [];
  
  let lastMessageTime = 0; // State for spam filter

  socket.on('register', async (data, callback) => {
    try {
      if (!data || typeof data.username !== 'string' || typeof data.password !== 'string') {
        return callback({ error: 'Invalid input format.' });
      }

      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (!checkRateLimit(ip)) return callback({ error: 'Too many requests. Try again later.' });

      const cleanUser = data.username.trim().substring(0, 20);
      if (cleanUser.length < 3) return callback({ error: 'Username must be at least 3 characters.' });
      if (cleanUser.toLowerCase() === 'nyzhang1') return callback({ error: 'Reserved name.' });
      if (data.password.length < 6) return callback({ error: 'Password must be at least 6 characters.' });

      const escapedUser = escapeRegExp(cleanUser);
      const existing = await User.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } }); 
      if (existing) return callback({ error: 'Username taken.' });

      const hashedPassword = await bcrypt.hash(data.password, 10);
      await User.create({ username: cleanUser, password: hashedPassword, servers: ['global'] });
      
      clearRateLimit(ip);
      callback({ success: true });
    } catch (err) { callback({ error: 'Registration failed.' }); }
  });

  socket.on('login', async (data, callback) => {
    try {
      if (!data || typeof data.username !== 'string' || typeof data.password !== 'string') {
        return callback({ error: 'Invalid input format.' });
      }

      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (!checkRateLimit(ip)) return callback({ error: 'Too many login attempts. Try again later.' });

      const escapedUser = escapeRegExp(data.username.trim());
      const user = await User.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } });
      if (!user) return callback({ error: 'User not found.' });
      if (!(await bcrypt.compare(data.password, user.password))) return callback({ error: 'Incorrect password.' });

      if (!user.servers || user.servers.length === 0) { user.servers = ['global']; await user.save(); }

      socket.username = user.username;
      socket.role = user.role || 'user';
      socket.color = user.color || '';
      socket.avatarUrl = user.avatarUrl || '';
      socket.serverCode = 'global'; 
      socket.joinedServers = user.servers;
      
      socket.join('global');
      onlineUsers.set(socket.id, { username: user.username, role: socket.role, color: socket.color, avatarUrl: socket.avatarUrl, serverCode: 'global', joinedServers: user.servers });
      
      broadcastOnlineUsers('global');

      const isVisible = socket.role !== 'admin' || socket.joinedServers.includes('global');
      if (isVisible) socket.to('global').emit('system_message', `${user.username} joined the app.`);
      
      clearRateLimit(ip);

      const servers = socket.role === 'admin' ? await ChatServer.find() : await ChatServer.find({ code: { $in: user.servers } });
      callback({ success: true, username: user.username, role: socket.role, color: socket.color, avatarUrl: socket.avatarUrl, servers: servers || [], joinedServers: user.servers });
    } catch (err) { callback({ error: 'Login failed.' }); }
  });

  socket.on('change_password', async (data, callback) => {
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data.oldPassword !== 'string' || typeof data.newPassword !== 'string') {
        return callback({ error: 'Invalid data format.' });
    }
    
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (!checkRateLimit(ip)) return callback({ error: 'Too many attempts. Try again later.' });

    try {
      const user = await User.findOne({ username: socket.username });
      if (!user) return callback({ error: 'User not found.' });

      const isMatch = await bcrypt.compare(data.oldPassword, user.password);
      if (!isMatch) return callback({ error: 'Incorrect current password.' });

      if (data.newPassword.length < 6) return callback({ error: 'New password must be at least 6 characters long.' });

      user.password = await bcrypt.hash(data.newPassword, 10);
      await user.save();
      
      clearRateLimit(ip);
      callback({ success: true });
    } catch (err) {
      callback({ error: 'Failed to update password.' });
    }
  });

  socket.on('logout_all_devices', async (callback) => {
      if (!socket.username) return;
      try {
          const sockets = await io.fetchSockets();
          sockets.forEach(s => {
              if (s.username === socket.username && s.id !== socket.id) {
                  s.emit('force_logout', "You have been logged out because 'Logout All Devices' was triggered remotely.");
                  s.disconnect(true); // Close socket immediately
              }
          });
          callback({ success: true });
      } catch(err) {
          callback({ error: 'Failed to execute remote logout.'});
      }
  });

  socket.on('update_profile', async (data, callback) => {
      if (!socket.username) return;
      try {
          const color = data.color ? data.color.trim().substring(0, 30) : '';
          const url = data.avatarUrl ? data.avatarUrl.trim().substring(0, 1000) : '';

          const user = await User.findOne({ username: socket.username });
          user.color = color; user.avatarUrl = url; await user.save();
          
          await Message.updateMany({ username: socket.username }, { $set: { color: color, avatarUrl: url } });

          socket.color = color; socket.avatarUrl = url;
          if(onlineUsers.has(socket.id)) { let session = onlineUsers.get(socket.id); session.color = color; session.avatarUrl = url; }
          
          io.emit('profile_updated', { username: socket.username, color: color, avatarUrl: url });
          socket.joinedServers.forEach(code => broadcastOnlineUsers(code));
          if (!socket.joinedServers.includes('global')) broadcastOnlineUsers('global');
          
          callback({ success: true, color: color, avatarUrl: url });
      } catch(err) { callback({ error: 'Failed to update profile.' }); }
  });

  socket.on('create_server', async (name, callback) => {
    if (!socket.username) return;
    try {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase(); 
      const srv = await ChatServer.create({ code, name: name.substring(0, 30), owner: socket.username });
      const user = await User.findOne({ username: socket.username });
      if (!user.servers.includes(code)) {
        user.servers.push(code); await user.save(); socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;
      }
      callback({ success: true, server: srv });
      const sockets = await io.fetchSockets();
      sockets.forEach(s => { if (onlineUsers.has(s.id) && onlineUsers.get(s.id).role === 'admin') s.emit('admin_new_server', srv); });
    } catch (err) { callback({ error: 'Creation failed.' }); }
  });

  socket.on('join_server', async (code, callback) => {
    if (!socket.username) return;
    try {
      const srv = await ChatServer.findOne({ code: code.toUpperCase() });
      if (!srv) return callback({ error: 'Invalid invite code.' });
      const user = await User.findOne({ username: socket.username });
      if (!user.servers.includes(srv.code)) {
        user.servers.push(srv.code); await user.save(); socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;
        if (socket.serverCode === srv.code) { socket.to(srv.code).emit('system_message', `${socket.username} joined.`); broadcastOnlineUsers(srv.code); }
      }
      callback({ success: true, server: srv });
    } catch (err) { callback({ error: 'Join failed.' }); }
  });

  socket.on('leave_server', async (code, callback) => {
    if (!socket.username || code === 'global') return callback({ error: 'Cannot leave global.' });
    try {
      const user = await User.findOne({ username: socket.username });
      if (user.servers.includes(code)) {
        user.servers = user.servers.filter(s => s !== code); await user.save();
        socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;
        if (socket.serverCode === code) { socket.to(code).emit('system_message', `${socket.username} left the server.`); broadcastOnlineUsers(code); }
      }
      callback({ success: true });
    } catch (err) { callback({ error: 'Failed to leave.' }); }
  });

  socket.on('delete_server', async (code, callback) => {
    if (!socket.username || code === 'global') return callback({ error: 'Cannot delete global.' });
    try {
      const srv = await ChatServer.findOne({ code: code });
      if (!srv) return callback({ error: 'Server not found.' });

      if (socket.role === 'admin' || srv.owner.toLowerCase() === socket.username.toLowerCase()) {
        await ChatServer.deleteOne({ code: code });
        await Message.deleteMany({ serverCode: code });
        await User.updateMany({}, { $pull: { servers: code } }); 
        io.emit('server_deleted', code); 
        const sockets = await io.fetchSockets();
        sockets.forEach(s => {
          if (s.joinedServers && s.joinedServers.includes(code)) {
             s.joinedServers = s.joinedServers.filter(c => c !== code);
             if (onlineUsers.has(s.id)) onlineUsers.get(s.id).joinedServers = s.joinedServers;
          }
          if (s.serverCode === code) { s.leave(code); s.serverCode = 'global'; s.join('global'); }
        });
        broadcastOnlineUsers('global'); callback({ success: true });
      } else { callback({ error: 'Permission denied.' }); }
    } catch (err) { callback({ error: 'Deletion failed.' }); }
  });

  socket.on('switch_server', async (code, callback) => {
    if (!socket.username) return;
    try {
      const oldCode = socket.serverCode;
      if (oldCode) { socket.leave(oldCode); broadcastOnlineUsers(oldCode); }

      socket.serverCode = code; socket.join(code);
      if (onlineUsers.has(socket.id)) onlineUsers.get(socket.id).serverCode = code;
      broadcastOnlineUsers(code);
      
      let query = { serverCode: code };
      if (code === 'global') query = { $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] };

      const history = await Message.find(query).sort({ timestamp: -1 }).limit(100).lean();
      
      const safeHistory = history.map(msg => {
          if (msg.deleted && socket.role !== 'admin' && msg.username !== socket.username) {
              msg.text = ''; msg.attachment = null; msg.reactions = {};
          }
          if (!msg.reactions) msg.reactions = {};
          return msg;
      });
      if(callback) callback({ history: safeHistory.reverse() });
    } catch (err) {}
  });

  socket.on('chat_message', async (payload) => {
    if (!socket.username || !socket.serverCode) return;
    
    // SECURITY: Message Spam Rate Limiter (500ms cooldown for non-admin users)
    const now = Date.now();
    if (socket.role !== 'admin' && now - lastMessageTime < 500) {
        return socket.emit('system_message', '⚠️ Slow down! You are sending messages too fast.');
    }
    lastMessageTime = now;

    if (typeof payload !== 'string' && typeof payload !== 'object') return;
    
    const rawText = typeof payload === 'string' ? payload : (payload.text || '');
    const attachment = typeof payload === 'object' ? payload.attachment : null; 
    const replyTo = typeof payload === 'object' ? payload.replyTo : null;
    
    if (attachment && (typeof attachment !== 'string' || attachment.length > 15000000)) return;

    let cleanText = rawText.trim().substring(0, 2000);
    
    if (!cleanText && !attachment) return; // Prevent empty sends
    if (socket.role !== 'admin') cleanText = cleanText.replace(/@everyone/gi, 'everyone');

    try {
      const msg = await Message.create({ 
          serverCode: socket.serverCode, username: socket.username, role: socket.role, 
          color: socket.color, avatarUrl: socket.avatarUrl, text: cleanText, attachment: attachment, replyTo: replyTo,
          reactions: {} // New messages start with 0 reactions
      });
      
      io.to(socket.serverCode).emit('chat_message', { 
          _id: msg._id, username: msg.username, role: socket.role, color: msg.color, avatarUrl: msg.avatarUrl,
          text: msg.text, attachment: msg.attachment, replyTo: msg.replyTo, reactions: {}, timestamp: msg.timestamp, edited: false, deleted: false 
      });
    } catch (err) {}
  });

  // --- NEW FEATURE: TOGGLE MESSAGE EMOJI REACTION ---
  socket.on('toggle_reaction', async (data) => {
      if (!socket.username || !socket.serverCode) return;
      try {
          const { id, emoji } = data;
          if (!id || !emoji) return;

          const msg = await Message.findById(id);
          if (!msg || msg.deleted) return;

          // Standardize reactions storage
          let rx = msg.reactions || {};
          let users = rx[emoji] || [];

          // Toggle logic
          if (users.includes(socket.username)) {
              users = users.filter(u => u !== socket.username); // Remove user
              if (users.length === 0) delete rx[emoji];
              else rx[emoji] = users;
          } else {
              users.push(socket.username); // Add user
              rx[emoji] = users;
          }

          msg.reactions = rx;
          msg.markModified('reactions'); // Tell mongoose that the Mixed field changed
          await msg.save();

          // Push updated reactions array map to clients in this room
          io.to(msg.serverCode).emit('reaction_updated', {
              id: msg._id,
              reactions: msg.reactions
          });
      } catch (err) {}
  });

  socket.on('edit_message', async (data) => {
    if (!socket.username || !data.id || typeof data.text !== 'string') return;
    try {
      let cleanText = data.text.trim().substring(0, 2000);
      if (!cleanText) return;
      if (socket.role !== 'admin') cleanText = cleanText.replace(/@everyone/gi, 'everyone');

      const msg = await Message.findById(data.id);
      if (msg && !msg.deleted && (msg.username === socket.username || socket.role === 'admin') && msg.text !== cleanText) {
        if (!msg.history) msg.history = []; 
        msg.history.push({ text: msg.text, timestamp: new Date() });
        msg.text = cleanText; msg.edited = true; msg.markModified('history'); 
        await msg.save();
        io.to(socket.serverCode).emit('message_edited', { id: msg._id, username: msg.username, role: msg.role, text: cleanText });
      }
    } catch (err) {}
  });

  socket.on('delete_message', async (msgId) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg && !msg.deleted && (msg.username === socket.username || socket.role === 'admin')) {
        msg.deleted = true; await msg.save();
        io.to(msg.serverCode).emit('message_deleted', msgId);
      }
    } catch (err) {}
  });

  socket.on('get_edit_history', async (msgId, callback) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg && (msg.username === socket.username || socket.role === 'admin')) callback({ success: true, history: msg.history || [] });
      else callback({ error: 'Permission denied.' });
    } catch (err) { callback({ error: 'Failed to load history.' }); }
  });

  socket.on('get_deleted_message', async (msgId, callback) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg && msg.deleted && (msg.username === socket.username || socket.role === 'admin')) {
        callback({ success: true, text: msg.text, attachment: msg.attachment });
      } else { callback({ error: 'Permission denied.' }); }
    } catch (err) { callback({ error: 'Failed to load deleted message.' }); }
  });

  socket.on('typing', (isTyping) => {
    if (!socket.username || !socket.serverCode) return;
    const isVisible = socket.role !== 'admin' || socket.joinedServers.includes(socket.serverCode) || socket.serverCode === 'global';
    if (isVisible) socket.to(socket.serverCode).emit('typing', { username: socket.username, isTyping });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      const serverCode = onlineUsers.get(socket.id)?.serverCode;
      onlineUsers.delete(socket.id);
      if (serverCode) {
        broadcastOnlineUsers(serverCode);
        const isVisible = socket.role !== 'admin' || (socket.joinedServers && socket.joinedServers.includes(serverCode)) || serverCode === 'global';
        if (isVisible) io.to(serverCode).emit('system_message', `${socket.username} disconnected.`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));