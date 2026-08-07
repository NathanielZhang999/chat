const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e7 
});

const MONGO_URI = process.env.MONGO_URI; 

// --- SECURITY: REGEX ESCAPE ---
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

// --- SECURITY: RATE LIMITING ---
const authAttempts = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const attempts = authAttempts.get(ip) || [];
    const recent = attempts.filter(time => now - time < 15 * 60 * 1000); 
    if (recent.length >= 10) return false;
    recent.push(now);
    authAttempts.set(ip, recent);
    return true;
}
function clearRateLimit(ip) { authAttempts.delete(ip); }
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
  displayName: { type: String, default: '' },
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
  owner: { type: String, required: true },
  moderators: { type: [String], default: [] }
});
const ChatServer = mongoose.model('ChatServer', ChatServerSchema);

const MessageSchema = new mongoose.Schema({
  serverCode: { type: String, required: true, default: 'global' },
  username: String,
  displayName: { type: String, default: '' },
  role: { type: String, default: 'user' }, 
  roomRole: { type: String, default: 'user' },
  color: { type: String, default: '' },      
  avatarUrl: { type: String, default: '' },  
  text: { type: String, default: '' },
  attachment: { type: String, default: null },
  replyTo: { type: Object, default: null },
  reactions: { type: Object, default: {} }, 
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
      { username: adminUser, displayName: 'Bacon', password: hashed, role: 'admin' },
      { upsert: true }
    );
    await ChatServer.findOneAndUpdate(
      { code: 'global' },
      { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] },
      { upsert: true }
    );
    console.log('👑 Admin & Global Server ready.');
  } catch (err) { console.error("Seeding error:", err); }
}
if (MONGO_URI) mongoose.connect(MONGO_URI).then(seedSystem).catch(console.error);

const onlineUsers = new Map(); 

// --- DYNAMIC ROOM PERMISSION UTILITY ---
async function getRoomRole(serverCode, username) {
    if (serverCode === 'global') return 'user';
    const srv = await ChatServer.findOne({ code: serverCode }).lean();
    if (!srv) return 'user';
    
    // Moderators strictly based on the moderators list
    if (srv.moderators && srv.moderators.includes(username)) return 'mod';
    return 'user';
}

// --- SECURE BACKEND PING RESOLVER ENGINE ---
// Converts `@username` or `@DisplayName` securely into the `{{PING:username|DisplayName}}` format
async function resolvePings(text, serverCode, senderRole, senderRoomRole, senderUsername) {
    let processed = text;
    if (!processed.includes('@')) return processed;

    const isAdminOrMod = senderRole === 'admin' || senderRoomRole === 'mod' || senderUsername.toLowerCase() === 'nyzhang1';

    if (isAdminOrMod && /(^|\s)@everyone(?=\s|$|[.,!?<])/i.test(processed)) {
        processed = processed.replace(/(^|\s)@everyone(?=\s|$|[.,!?<])/gi, '$1{{PING:everyone|everyone}}');
    } else {
        processed = processed.replace(/@everyone/gi, 'everyone');
    }

    if (processed.includes('@')) {
        const roomUsers = await User.find({ servers: serverCode }, 'username displayName');
        
        // Build search array mapping every possible matching handle
        const searchList = [];
        for (let u of roomUsers) {
            const dn = u.displayName || u.username;
            searchList.push({ search: dn, username: u.username, display: dn });
            if (u.username.toLowerCase() !== dn.toLowerCase()) {
                searchList.push({ search: u.username, username: u.username, display: dn });
            }
        }
        
        // Sort by longest string length to correctly catch Display Names containing Usernames
        searchList.sort((a, b) => b.search.length - a.search.length);

        for (let {search, username, display} of searchList) {
            const regex = new RegExp(`(^|\\s)@${escapeRegExp(search)}(?![a-zA-Z0-9_-])`, 'gi');
            processed = processed.replace(regex, `$1{{PING:${username}|${display}}}`);
        }
    }
    
    return processed;
}

// --- UPDATED ONLINE PRESENCE ENGINE ---
async function broadcastOnlineUsers(serverCode) {
  if (!serverCode) return;
  
  const globalOnlineMap = new Map();
  for (const info of onlineUsers.values()) {
      if (!globalOnlineMap.has(info.username)) globalOnlineMap.set(info.username, info);
  }

  let usersList = [];

  if (serverCode === 'global') {
      for (const info of globalOnlineMap.values()) {
          const isVisible = info.role !== 'admin' || info.joinedServers.includes('global') || serverCode === 'global';
          if (isVisible) {
              usersList.push({ 
                  username: info.username, displayName: info.displayName, role: info.role, color: info.color, 
                  avatarUrl: info.avatarUrl, online: true, roomRole: 'user'
              });
          }
      }
      usersList.sort((a, b) => (a.displayName||a.username).localeCompare(b.displayName||b.username));
  } else {
      try {
          const srv = await ChatServer.findOne({ code: serverCode }).lean();
          const roomMods = srv ? (srv.moderators || []) : [];
          
          const members = await User.find({ servers: serverCode }).lean();
          
          for (const member of members) {
              const isOnline = globalOnlineMap.has(member.username);
              const activeData = globalOnlineMap.get(member.username);
              
              let rRole = roomMods.includes(member.username) ? 'mod' : 'user';

              usersList.push({
                  username: member.username,
                  displayName: activeData ? activeData.displayName : (member.displayName || member.username),
                  role: activeData ? activeData.role : member.role, 
                  roomRole: rRole,
                  color: activeData ? activeData.color : member.color,
                  avatarUrl: activeData ? activeData.avatarUrl : member.avatarUrl,
                  online: isOnline
              });
          }
          
          usersList.sort((a, b) => {
              if (a.online === b.online) return (a.displayName||a.username).localeCompare(b.displayName||b.username);
              return a.online ? -1 : 1; 
          });
      } catch (err) { console.error(err); }
  }

  io.to(serverCode).emit('online_users', usersList);
}

io.on('connection', (socket) => {
  socket.serverCode = null;
  socket.joinedServers = [];
  
  let lastMessageTime = 0; 

  socket.on('register', async (data, callback) => {
    try {
      if (!data || typeof data.username !== 'string' || typeof data.password !== 'string') return callback({ error: 'Invalid input format.' });
      
      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (!checkRateLimit(ip)) return callback({ error: 'Too many requests. Try again later.' });

      const cleanUser = data.username.trim().substring(0, 20);
      let cleanDisp = (data.displayName || '').trim().replace(/[^a-zA-Z0-9_ -]/g, '').substring(0, 30);
      
      if (!cleanDisp) cleanDisp = cleanUser;

      if (!/^[a-zA-Z0-9_-]+$/.test(cleanUser)) return callback({error: 'Username can only contain letters, numbers, dashes, and underscores.'});

      if (cleanUser.toLowerCase() === 'nyzhang1' || cleanDisp.toLowerCase() === 'nyzhang1') return callback({ error: 'Reserved name.' });
      if (data.password.length < 6) return callback({ error: 'Password must be at least 6 characters.' });

      const escapedUser = escapeRegExp(cleanUser);
      const existing = await User.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } }); 
      if (existing) return callback({ error: 'Username taken.' });

      const escapedDisp = escapeRegExp(cleanDisp);
      const existingDisp = await User.findOne({ displayName: { $regex: new RegExp(`^${escapedDisp}$`, 'i') } }); 
      if (existingDisp && cleanDisp.toLowerCase() !== cleanUser.toLowerCase()) return callback({ error: 'Display Name is already taken.' });

      const hashedPassword = await bcrypt.hash(data.password, 10);
      await User.create({ username: cleanUser, displayName: cleanDisp, password: hashedPassword, servers: ['global'] });
      
      clearRateLimit(ip);
      callback({ success: true });
    } catch (err) { callback({ error: 'Registration failed.' }); }
  });

  socket.on('login', async (data, callback) => {
    try {
      if (!data || typeof data.username !== 'string' || typeof data.password !== 'string') return callback({ error: 'Invalid input format.' });
      
      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (!checkRateLimit(ip)) return callback({ error: 'Too many login attempts. Try again later.' });

      const escapedUser = escapeRegExp(data.username.trim());
      const user = await User.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } });
      if (!user) return callback({ error: 'User not found.' });
      if (!(await bcrypt.compare(data.password, user.password))) return callback({ error: 'Incorrect password.' });

      if (!user.servers || user.servers.length === 0) { user.servers = ['global']; await user.save(); }
      if (!user.displayName) { user.displayName = user.username; await user.save(); }

      socket.username = user.username;
      socket.displayName = user.displayName;
      socket.role = user.role || 'user';
      socket.color = user.color || '';
      socket.avatarUrl = user.avatarUrl || '';
      socket.serverCode = 'global'; 
      socket.joinedServers = user.servers;
      
      socket.join('global');
      onlineUsers.set(socket.id, { username: user.username, displayName: socket.displayName, role: socket.role, color: socket.color, avatarUrl: socket.avatarUrl, serverCode: 'global', joinedServers: user.servers });
      
      const serversToUpdate = new Set(user.servers);
      serversToUpdate.add('global');
      serversToUpdate.forEach(c => broadcastOnlineUsers(c));

      const isVisible = socket.role !== 'admin' || socket.joinedServers.includes('global');
      if (isVisible) socket.to('global').emit('system_message', `${socket.displayName} joined the app.`);
      
      clearRateLimit(ip);

      const servers = socket.role === 'admin' ? await ChatServer.find() : await ChatServer.find({ code: { $in: user.servers } });
      callback({ success: true, username: user.username, displayName: socket.displayName, role: socket.role, color: socket.color, avatarUrl: socket.avatarUrl, servers: servers || [], joinedServers: user.servers });
    } catch (err) { callback({ error: 'Login failed.' }); }
  });

  socket.on('change_password', async (data, callback) => {
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data.oldPassword !== 'string' || typeof data.newPassword !== 'string') return callback({ error: 'Invalid data format.' });
    
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
                  s.disconnect(true); 
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
          const dName = data.displayName ? data.displayName.replace(/[^a-zA-Z0-9_ -]/g, '').substring(0, 30).trim() : socket.username;

          if (dName.toLowerCase() !== socket.displayName.toLowerCase()) {
              const existingDisp = await User.findOne({ displayName: { $regex: new RegExp(`^${escapeRegExp(dName)}$`, 'i') } });
              if (existingDisp) return callback({ error: 'Display Name is already taken.' });
          }

          const user = await User.findOne({ username: socket.username });
          user.color = color; user.avatarUrl = url; user.displayName = dName; await user.save();
          
          await Message.updateMany({ username: socket.username }, { $set: { color: color, avatarUrl: url, displayName: dName } });

          socket.color = color; socket.avatarUrl = url; socket.displayName = dName;
          if(onlineUsers.has(socket.id)) { let session = onlineUsers.get(socket.id); session.color = color; session.avatarUrl = url; session.displayName = dName; }
          
          io.emit('profile_updated', { username: socket.username, displayName: dName, color: color, avatarUrl: url });
          
          const serversToUpdate = new Set(socket.joinedServers);
          serversToUpdate.add('global');
          serversToUpdate.forEach(c => broadcastOnlineUsers(c));
          
          callback({ success: true, displayName: dName, color: color, avatarUrl: url });
      } catch(err) { callback({ error: 'Failed to update profile.' }); }
  });

  socket.on('manage_role', async (data, callback) => {
    if (!socket.username) return;
    const { targetUser, action, serverCode } = data; 
    
    try {
        const targetUserDoc = await User.findOne({ username: targetUser });
        if (!targetUserDoc) return callback({ error: 'User not found.' });

        const targetDisp = targetUserDoc.displayName || targetUserDoc.username;
        const isGlobalAdmin = socket.role === 'admin';

        // Manage Global Admins
        if (action === 'promote_global_admin' || action === 'demote_global_admin') {
            if (!isGlobalAdmin) return callback({ error: 'Only Global Admins can modify global roles.' });
            if (action === 'demote_global_admin' && targetUser.toLowerCase() === 'nyzhang1') return callback({ error: 'Cannot modify system owner.' });
            
            targetUserDoc.role = (action === 'promote_global_admin') ? 'admin' : 'user';
            await targetUserDoc.save();

            const sockets = await io.fetchSockets();
            sockets.forEach(s => {
                if (s.username === targetUser) {
                    s.role = targetUserDoc.role;
                    if (onlineUsers.has(s.id)) onlineUsers.get(s.id).role = targetUserDoc.role;
                    s.emit('global_role_updated', { username: targetUser, role: targetUserDoc.role });
                }
            });
            
            io.emit('system_message', `${socket.displayName} ${action === 'promote_global_admin' ? 'promoted' : 'demoted'} ${targetDisp} ${action === 'promote_global_admin' ? 'to' : 'from'} Global Admin.`);
            const roomsToUpdate = new Set(targetUserDoc.servers); roomsToUpdate.add('global');
            roomsToUpdate.forEach(c => broadcastOnlineUsers(c));
            
            return callback({ success: true });
        }

        // Manage Room Moderators
        if (serverCode && serverCode !== 'global') {
            const srv = await ChatServer.findOne({ code: serverCode });
            if (!srv) return callback({ error: 'Server not found.' });

            const isRoomMod = srv.moderators.includes(socket.username) || isGlobalAdmin;

            if (action === 'promote_mod') {
                if (!isGlobalAdmin && !isRoomMod) return callback({ error: 'Only Global Admins and Room Moderators can promote to Room Moderator.' });
                
                if (!srv.moderators) srv.moderators = [];
                if (!srv.moderators.includes(targetUser)) {
                    srv.moderators.push(targetUser);
                    await srv.save();
                    io.to(serverCode).emit('system_message', `${socket.displayName} promoted ${targetDisp} to Room Moderator.`);
                }
                broadcastOnlineUsers(serverCode);
                io.to(serverCode).emit('room_role_updated', { username: targetUser, targetServer: serverCode });
                return callback({ success: true });
            } else if (action === 'demote_mod') {
                if (!isGlobalAdmin) return callback({ error: 'Only Global Admins can remove moderator roles.' });
                
                if (srv.moderators) {
                    srv.moderators = srv.moderators.filter(u => u !== targetUser);
                    await srv.save();
                    io.to(serverCode).emit('system_message', `${socket.displayName} removed ${targetDisp}'s Room Moderator role.`);
                }
                broadcastOnlineUsers(serverCode);
                io.to(serverCode).emit('room_role_updated', { username: targetUser, targetServer: serverCode });
                return callback({ success: true });
            }
        }
        callback({ error: 'Invalid action.' });
    } catch (err) {
        callback({ error: 'Failed to manage role.' });
    }
  });

  socket.on('create_server', async (name, callback) => {
    if (!socket.username) return;
    try {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase(); 
      // The creator is registered as owner AND is given mod status implicitly
      const srv = await ChatServer.create({ 
          code, 
          name: name.substring(0, 30), 
          owner: socket.username, 
          moderators: [socket.username] 
      });
      const user = await User.findOne({ username: socket.username });
      
      if (!user.servers.includes(code)) {
        user.servers.push(code); await user.save(); socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;
        broadcastOnlineUsers(code);
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
        
        broadcastOnlineUsers(srv.code);

        if (socket.serverCode === srv.code) { 
            socket.to(srv.code).emit('system_message', `${socket.displayName} joined.`); 
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
        user.servers = user.servers.filter(s => s !== code); await user.save();
        socket.joinedServers = user.servers;
        if(onlineUsers.has(socket.id)) onlineUsers.get(socket.id).joinedServers = user.servers;
        
        broadcastOnlineUsers(code);

        if (socket.serverCode === code) { 
            socket.to(code).emit('system_message', `${socket.displayName} left the server.`); 
        }
      }
      callback({ success: true });
    } catch (err) { callback({ error: 'Failed to leave.' }); }
  });

  socket.on('delete_server', async (code, callback) => {
    if (!socket.username || code === 'global') return callback({ error: 'Cannot delete global.' });
    try {
      const srv = await ChatServer.findOne({ code: code });
      if (!srv) return callback({ error: 'Server not found.' });

      // ONLY Global Admins or the actual Room Creator can completely delete a server
      if (socket.role === 'admin' || srv.owner === socket.username) {
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
      broadcastOnlineUsers('global');
      
      let query = { serverCode: code };
      if (code === 'global') query = { $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] };

      const history = await Message.find(query).sort({ timestamp: -1 }).limit(100).lean();
      
      const roomRole = await getRoomRole(code, socket.username);

      const safeHistory = history.map(msg => {
          if (msg.deleted && msg.username !== socket.username && socket.role !== 'admin' && roomRole !== 'mod') {
              msg.text = ''; msg.attachment = null; msg.reactions = {};
          }
          if (!msg.reactions) msg.reactions = {};
          return msg;
      });
      if(callback) callback({ history: safeHistory.reverse(), roomRole });
    } catch (err) {}
  });

  socket.on('chat_message', async (payload) => {
    if (!socket.username || !socket.serverCode) return;
    
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
    
    if (!cleanText && !attachment) return; 

    const roomRole = await getRoomRole(socket.serverCode, socket.username);

    cleanText = await resolvePings(cleanText, socket.serverCode, socket.role, roomRole, socket.username);

    try {
      const msg = await Message.create({ 
          serverCode: socket.serverCode, username: socket.username, displayName: socket.displayName, 
          role: socket.role, roomRole: roomRole, color: socket.color, avatarUrl: socket.avatarUrl, 
          text: cleanText, attachment: attachment, replyTo: replyTo, reactions: {} 
      });
      
      io.to(socket.serverCode).emit('chat_message', { 
          _id: msg._id, username: msg.username, displayName: msg.displayName, role: socket.role, roomRole: roomRole, color: msg.color, avatarUrl: msg.avatarUrl,
          text: msg.text, attachment: msg.attachment, replyTo: msg.replyTo, reactions: {}, timestamp: msg.timestamp, edited: false, deleted: false 
      });
    } catch (err) {}
  });

  socket.on('toggle_reaction', async (data) => {
      if (!socket.username || !socket.serverCode) return;
      try {
          const { id, emoji } = data;
          if (!id || !emoji) return;

          const msg = await Message.findById(id);
          if (!msg || msg.deleted) return;

          let rx = msg.reactions || {};
          let users = rx[emoji] || [];

          if (users.includes(socket.username)) {
              users = users.filter(u => u !== socket.username); 
              if (users.length === 0) delete rx[emoji];
              else rx[emoji] = users;
          } else {
              users.push(socket.username); 
              rx[emoji] = users;
          }

          msg.reactions = rx;
          msg.markModified('reactions'); 
          await msg.save();

          io.to(msg.serverCode).emit('reaction_updated', { id: msg._id, reactions: msg.reactions });
      } catch (err) {}
  });

  socket.on('edit_message', async (data) => {
    if (!socket.username || !data.id || typeof data.text !== 'string') return;
    try {
      let cleanText = data.text.trim().substring(0, 2000);
      if (!cleanText) return;

      const msg = await Message.findById(data.id);
      if (msg && !msg.deleted) {
        const roomRole = await getRoomRole(msg.serverCode, socket.username);

        // Edit allowed for Sender, Global Admin, or Room Mod
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
          
          cleanText = await resolvePings(cleanText, msg.serverCode, socket.role, roomRole, socket.username);

          if (msg.text !== cleanText) {
              if (!msg.history) msg.history = []; 
              msg.history.push({ text: msg.text, timestamp: new Date() });
              msg.text = cleanText; msg.edited = true; msg.markModified('history'); 
              await msg.save();
              io.to(socket.serverCode).emit('message_edited', { id: msg._id, username: msg.username, role: msg.role, roomRole: msg.roomRole, text: cleanText });
          }
        }
      }
    } catch (err) {}
  });

  socket.on('delete_message', async (msgId) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg && !msg.deleted) {
        const roomRole = await getRoomRole(msg.serverCode, socket.username);
        
        // Sender, SysAdmin, or RoomMod can delete it
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
          msg.deleted = true; await msg.save();
          io.to(msg.serverCode).emit('message_deleted', msgId);
        }
      }
    } catch (err) {}
  });

  socket.on('get_edit_history', async (msgId, callback) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg) {
        const roomRole = await getRoomRole(msg.serverCode, socket.username);
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
            return callback({ success: true, history: msg.history || [] });
        }
      }
      callback({ error: 'Permission denied.' });
    } catch (err) { callback({ error: 'Failed to load history.' }); }
  });

  socket.on('get_deleted_message', async (msgId, callback) => {
    if (!socket.username) return;
    try {
      const msg = await Message.findById(msgId);
      if (msg && msg.deleted) {
        const roomRole = await getRoomRole(msg.serverCode, socket.username);
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
            return callback({ success: true, text: msg.text, attachment: msg.attachment });
        }
      }
      callback({ error: 'Permission denied.' });
    } catch (err) { callback({ error: 'Failed to load deleted message.' }); }
  });

  socket.on('typing', (isTyping) => {
    if (!socket.username || !socket.serverCode) return;
    const isVisible = socket.role !== 'admin' || socket.joinedServers.includes(socket.serverCode) || socket.serverCode === 'global';
    
    if (isVisible) socket.to(socket.serverCode).emit('typing', { username: socket.username, isTyping });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      const session = onlineUsers.get(socket.id);
      const serverCode = session?.serverCode;
      const joinedServers = session?.joinedServers || [];
      const dName = session?.displayName || socket.username;
      
      onlineUsers.delete(socket.id);
      
      const serversToUpdate = new Set(joinedServers || []);
      serversToUpdate.add('global');
      serversToUpdate.forEach(code => broadcastOnlineUsers(code));

      if (serverCode) {
        const isVisible = socket.role !== 'admin' || (joinedServers && joinedServers.includes(serverCode)) || serverCode === 'global';
        if (isVisible) {
            io.to(serverCode).emit('system_message', `${dName} disconnected.`);
            io.to(serverCode).emit('typing', { username: socket.username, isTyping: false });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));