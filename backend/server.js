const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MONGO_URI = process.env.MONGO_URI; 

// --- DATABASE SCHEMAS ---
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
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
  text: String,
  edited: { type: Boolean, default: false },
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

// --- REAL-TIME LOGIC ---
const onlineUsers = new Map(); 

function broadcastOnlineUsers(serverCode) {
  const users = [];
  for (const [id, info] of onlineUsers.entries()) {
    if (info.serverCode === serverCode) {
      // If user is an Admin, ONLY show them if they explicitly joined this server or are in Global.
      const isVisible = info.role !== 'admin' || info.joinedServers.includes(serverCode) || serverCode === 'global';
      if (isVisible) users.push(info.username);
    }
  }
  io.to(serverCode).emit('online_users', [...new Set(users)]);
}

io.on('connection', (socket) => {
  socket.serverCode = null;
  socket.joinedServers = [];

  socket.on('register', async (data, callback) => {
    try {
      const cleanUser = data.username.trim().substring(0, 20);
      if (cleanUser.toLowerCase() === 'nyzhang1') return callback({ error: 'Reserved name.' });
      const existing = await User.findOne({ username: { $regex: new RegExp(`^${cleanUser}$`, 'i') } }); 
      if (existing) return callback({ error: 'Username taken.' });

      const hashedPassword = await bcrypt.hash(data.password, 10);
      await User.create({ username: cleanUser, password: hashedPassword, servers: ['global'] });
      callback({ success: true });
    } catch (err) { callback({ error: 'Registration failed.' }); }
  });

  socket.on('login', async (data, callback) => {
    try {
      const user = await User.findOne({ username: { $regex: new RegExp(`^${data.username.trim()}$`, 'i') } });
      if (!user) return callback({ error: 'User not found.' });
      if (!(await bcrypt.compare(data.password, user.password))) return callback({ error: 'Incorrect password.' });

      if (!user.servers || user.servers.length === 0) {
          user.servers = ['global'];
          await user.save();
      }

      socket.username = user.username;
      socket.role = user.role || 'user';
      socket.serverCode = 'global'; 
      socket.joinedServers = user.servers;
      
      socket.join('global');
      onlineUsers.set(socket.id, { username: user.username, role: socket.role, serverCode: 'global', joinedServers: user.servers });
      broadcastOnlineUsers('global');

      const isVisible = socket.role !== 'admin' || socket.joinedServers.includes('global');
      if (isVisible) socket.to('global').emit('system_message', `${user.username} joined.`);

      const servers = socket.role === 'admin' 
        ? await ChatServer.find() 
        : await ChatServer.find({ code: { $in: user.servers } });

      const history = await Message.find({ 
          $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] 
      }).sort({ timestamp: -1 }).limit(100);

      callback({ 
          success: true, 
          username: user.username, 
          role: socket.role, 
          servers: servers || [], 
          joinedServers: user.servers, 
          history: history.reverse() 
      });
    } catch (err) { callback({ error: 'Login failed.' }); }
  });

  // --- SERVER MANAGEMENT ---
  socket.on('create_server', async (name, callback) => {
    if (!socket.username) return;
    try {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase(); 
      const srv = await ChatServer.create({ code, name: name.substring(0, 30), owner: socket.username });
      
      const user = await User.findOne({ username: socket.username });
      if (!user.servers) user.servers = ['global'];
      if (!user.servers.includes(code)) {
        user.servers.push(code);
        await user.save();
        socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;
      }

      callback({ success: true, server: srv });
      
      const sockets = await io.fetchSockets();
      sockets.forEach(s => { if (s.role === 'admin') s.emit('admin_new_server', srv); });
    } catch (err) { callback({ error: 'Creation failed.' }); }
  });

  socket.on('join_server', async (code, callback) => {
    if (!socket.username) return;
    try {
      const srv = await ChatServer.findOne({ code: code.toUpperCase() });
      if (!srv) return callback({ error: 'Invalid invite code.' });

      const user = await User.findOne({ username: socket.username });
      if (!user.servers) user.servers = ['global'];
      if (!user.servers.includes(srv.code)) {
        user.servers.push(srv.code);
        await user.save();
        socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;
        
        // Notify others if they joined while looking at the channel
        if (socket.serverCode === srv.code) {
           socket.to(srv.code).emit('system_message', `${socket.username} joined.`);
           broadcastOnlineUsers(srv.code);
        }
      }
      callback({ success: true, server: srv });
    } catch (err) { callback({ error: 'Join failed.' }); }
  });

  socket.on('leave_server', async (code, callback) => {
    if (!socket.username || code === 'global') return callback({ error: 'Cannot leave global.' });
    try {
      const user = await User.findOne({ username: socket.username });
      if (user.servers.includes(code)) {
        user.servers = user.servers.filter(s => s !== code);
        await user.save();
        socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;

        if (socket.serverCode === code) {
           socket.to(code).emit('system_message', `${socket.username} left the server.`);
           broadcastOnlineUsers(code);
        }
      }
      callback({ success: true });
    } catch (err) { callback({ error: 'Failed to leave.' }); }
  });

  socket.on('switch_server', async (code, callback) => {
    if (!socket.username) return;
    try {
      const oldCode = socket.serverCode;
      if (oldCode) {
         socket.leave(oldCode);
         const oldVisible = socket.role !== 'admin' || socket.joinedServers.includes(oldCode) || oldCode === 'global';
         if (oldVisible) socket.to(oldCode).emit('system_message', `${socket.username} left.`);
         broadcastOnlineUsers(oldCode);
      }

      socket.serverCode = code;
      socket.join(code);
      if (onlineUsers.has(socket.id)) {
          let session = onlineUsers.get(socket.id);
          session.serverCode = code;
          session.joinedServers = socket.joinedServers;
      }
      
      broadcastOnlineUsers(code);
      const newVisible = socket.role !== 'admin' || socket.joinedServers.includes(code) || code === 'global';
      if (newVisible) socket.to(code).emit('system_message', `${socket.username} joined.`);

      let query = { serverCode: code };
      if (code === 'global') query = { $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] };

      const history = await Message.find(query).sort({ timestamp: -1 }).limit(100);
      if(callback) callback({ history: history.reverse() });
    } catch (err) { console.error(err); }
  });

  // --- MESSAGES ---
  socket.on('chat_message', async (text) => {
    if (!socket.username || !socket.serverCode) return;
    const cleanText = text.trim().substring(0, 1000);
    if (!cleanText) return;
    try {
      const msg = await Message.create({ serverCode: socket.serverCode, username: socket.username, text: cleanText });
      io.to(socket.serverCode).emit('chat_message', { _id: msg._id, username: msg.username, text: msg.text, timestamp: msg.timestamp, edited: false });
    } catch (err) {}
  });

  socket.on('edit_message', async (data) => {
    if (!socket.username || !data.id || typeof data.text !== 'string') return;
    try {
      const cleanText = data.text.trim().substring(0, 1000);
      if (!cleanText) return;
      const msg = await Message.findById(data.id);
      if (msg && (msg.username === socket.username || socket.role === 'admin') && msg.text !== cleanText) {
        msg.history.push({ text: msg.text, timestamp: new Date() });
        msg.text = cleanText;
        msg.edited = true;
        await msg.save();
        io.to(socket.serverCode).emit('message_edited', { id: msg._id, text: cleanText });
      }
    } catch (err) {}
  });

  socket.on('get_edit_history', async (msgId, callback) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg && (msg.username === socket.username || socket.role === 'admin')) {
        callback({ success: true, history: msg.history });
      } else {
        callback({ error: 'Permission denied.' });
      }
    } catch (err) { callback({ error: 'Failed to load history.' }); }
  });

  socket.on('delete_message', async (msgId) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg && (msg.username === socket.username || socket.role === 'admin')) {
        await Message.findByIdAndDelete(msgId);
        io.to(msg.serverCode).emit('message_deleted', msgId);
      }
    } catch (err) {}
  });

  socket.on('typing', (isTyping) => {
    if (!socket.username || !socket.serverCode) return;
    const isVisible = socket.role !== 'admin' || socket.joinedServers.includes(socket.serverCode) || socket.serverCode === 'global';
    if (isVisible) {
      socket.to(socket.serverCode).emit('typing', { username: socket.username, isTyping });
    }
  });

  socket.on('disconnect', () => {
    if (socket.username && socket.serverCode) {
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers(socket.serverCode);
      const isVisible = socket.role !== 'admin' || socket.joinedServers.includes(socket.serverCode) || socket.serverCode === 'global';
      if (isVisible) io.to(socket.serverCode).emit('system_message', `${socket.username} left.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));