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

const USERNAME_RE = /^[A-Za-z0-9_-]{1,20}$/;
const DISPLAY_NAME_RE = /^[A-Za-z0-9_ -]{1,30}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9_ -]{1,30}$/;
const SERVER_CODE_RE = /^[A-Z0-9]{6}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const ATTACHMENT_RE = /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const REACTION_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)+$/u;

function safeAck(callback) {
  return typeof callback === 'function' ? callback : () => {};
}

function normalizeWith(value, pattern) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return pattern.test(normalized) ? normalized : null;
}

function normalizeUsername(value) { return normalizeWith(value, USERNAME_RE); }
function normalizeDisplayName(value) { return normalizeWith(value, DISPLAY_NAME_RE); }
function normalizeServerName(value) { return normalizeWith(value, SERVER_NAME_RE); }

function normalizeServerCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.toLowerCase() === 'global') return 'global';
  const upper = normalized.toUpperCase();
  return SERVER_CODE_RE.test(upper) ? upper : null;
}

function isValidPassword(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 128;
}

function normalizeColor(value) {
  if (value === '' || value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return COLOR_RE.test(normalized) ? normalized.toLowerCase() : null;
}

function normalizeAvatarUrl(value) {
  if (value === '' || value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length > 1000) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? normalized : null;
  } catch {
    return null;
  }
}

function isValidAttachment(value) {
  return value === null || value === undefined || value === '' ||
    (typeof value === 'string' && value.length <= 8_000_000 && ATTACHMENT_RE.test(value));
}

function isValidReaction(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && REACTION_RE.test(value);
}

function isValidObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

function neutralizePingTokens(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\{\{PING:([^|{}]*)\|([^{}]*)\}\}/gi, (_match, username, displayName) => {
    return `@${displayName || username}`;
  });
}

function canAccessRoom(identity, serverCode) {
  if (serverCode === 'global') return true;
  if (!identity || !Array.isArray(identity.joinedServers)) return false;
  return identity.role === 'admin' || identity.joinedServers.includes(serverCode);
}

function appendBoundedHistory(history, entry, limit = 20) {
  return [...(Array.isArray(history) ? history : []), entry].slice(-limit);
}

function createReplySnapshot(message) {
  const text = typeof message.text === 'string' ? message.text.slice(0, 100) : '';
  return {
    id: String(message._id),
    displayname: message.displayName || message.username,
    text: text || (message.attachment ? 'Image Attachment' : '')
  };
}

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
}, 15 * 60 * 1000).unref();

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
async function seedSystem({
  UserModel = User,
  ChatServerModel = ChatServer,
  bcryptImpl = bcrypt,
  adminPassword = process.env.ADMIN_PASSWORD
} = {}) {
  await ChatServerModel.findOneAndUpdate(
    { code: 'global' },
    { $setOnInsert: { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  if (!adminPassword) return;
  if (!isValidPassword(adminPassword)) throw new Error('ADMIN_PASSWORD must contain 6 to 128 characters.');
  const existing = await UserModel.findOne({ username: /^NYZhang1$/i });
  if (!existing) {
    await UserModel.create({
      username: 'NYZhang1',
      displayName: 'Bacon',
      password: await bcryptImpl.hash(adminPassword, 10),
      role: 'admin',
      servers: ['global']
    });
  }
}
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

function createConnectionHandler({
  ioInstance = io,
  UserModel = User,
  ChatServerModel = ChatServer,
  MessageModel = Message,
  bcryptImpl = bcrypt,
  onlineUsersMap = onlineUsers,
  broadcastOnlineUsersFn = broadcastOnlineUsers,
  getRoomRoleFn = getRoomRole,
  resolvePingsFn = resolvePings
} = {}) {
  return socket => {
  socket.serverCode = null;
  socket.joinedServers = [];
  
  let lastMessageTime = 0; 

  socket.on('register', async (data, callback) => {
    callback = safeAck(callback);
    try {
      if (!data) return callback({ error: 'Invalid input format.' });
      const cleanUser = normalizeUsername(data.username);
      const cleanDisp = normalizeDisplayName(data.displayName || data.username);
      if (!cleanUser || !cleanDisp || !isValidPassword(data.password)) return callback({ error: 'Invalid input format.' });
      
      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (!checkRateLimit(ip)) return callback({ error: 'Too many requests. Try again later.' });

      if (cleanUser.toLowerCase() === 'nyzhang1' || cleanDisp.toLowerCase() === 'nyzhang1') return callback({ error: 'Reserved name.' });

      const escapedUser = escapeRegExp(cleanUser);
      const existing = await UserModel.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } });
      if (existing) return callback({ error: 'Username taken.' });

      const escapedDisp = escapeRegExp(cleanDisp);
      const existingDisp = await UserModel.findOne({ displayName: { $regex: new RegExp(`^${escapedDisp}$`, 'i') } });
      if (existingDisp) return callback({ error: 'Display Name is already taken.' });

      const hashedPassword = await bcryptImpl.hash(data.password, 10);
      await UserModel.create({ username: cleanUser, displayName: cleanDisp, password: hashedPassword, servers: ['global'] });
      
      clearRateLimit(ip);
      callback({ success: true });
    } catch (err) { callback({ error: 'Registration failed.' }); }
  });

  socket.on('login', async (data, callback) => {
    callback = safeAck(callback);
    try {
      if (socket.username) return callback({ error: 'Already authenticated.' });
      if (!data) return callback({ error: 'Invalid input format.' });
      const username = normalizeUsername(data.username);
      if (!username || !isValidPassword(data.password)) return callback({ error: 'Invalid input format.' });
      
      const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
      if (!checkRateLimit(ip)) return callback({ error: 'Too many login attempts. Try again later.' });

      const escapedUser = escapeRegExp(username);
      const user = await UserModel.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } });
      if (!user) return callback({ error: 'User not found.' });
      if (!(await bcryptImpl.compare(data.password, user.password))) return callback({ error: 'Incorrect password.' });

      if (!user.servers || user.servers.length === 0) { user.servers = ['global']; await user.save(); }
      if (!user.displayName) { user.displayName = user.username; await user.save(); }

      const role = user.role || 'user';
      const servers = role === 'admin'
        ? await ChatServerModel.find()
        : await ChatServerModel.find({ code: { $in: user.servers } });

      socket.username = user.username;
      socket.displayName = user.displayName;
      socket.role = role;
      socket.color = user.color || '';
      socket.avatarUrl = user.avatarUrl || '';
      socket.serverCode = 'global'; 
      socket.joinedServers = user.servers;
      
      socket.join('global');
      onlineUsersMap.set(socket.id, { username: user.username, displayName: socket.displayName, role: socket.role, color: socket.color, avatarUrl: socket.avatarUrl, serverCode: 'global', joinedServers: user.servers });
      
      const serversToUpdate = new Set(user.servers);
      serversToUpdate.add('global');
      serversToUpdate.forEach(c => broadcastOnlineUsersFn(c));

      const isVisible = socket.role !== 'admin' || socket.joinedServers.includes('global');
      if (isVisible) socket.to('global').emit('system_message', `${socket.displayName} joined the app.`);
      
      clearRateLimit(ip);

      callback({ success: true, username: user.username, displayName: socket.displayName, role: socket.role, color: socket.color, avatarUrl: socket.avatarUrl, servers: servers || [], joinedServers: user.servers });
    } catch (err) { callback({ error: 'Login failed.' }); }
  });

  socket.on('change_password', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data.oldPassword !== 'string' || typeof data.newPassword !== 'string') return callback({ error: 'Invalid data format.' });
    
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (!checkRateLimit(ip)) return callback({ error: 'Too many attempts. Try again later.' });

    try {
      const user = await UserModel.findOne({ username: socket.username });
      if (!user) return callback({ error: 'User not found.' });

      const isMatch = await bcryptImpl.compare(data.oldPassword, user.password);
      if (!isMatch) return callback({ error: 'Incorrect current password.' });

      if (!isValidPassword(data.newPassword)) return callback({ error: 'New password must be at least 6 characters long.' });

      user.password = await bcryptImpl.hash(data.newPassword, 10);
      await user.save();
      
      clearRateLimit(ip);
      callback({ success: true });
    } catch (err) {
      callback({ error: 'Failed to update password.' });
    }
  });

  socket.on('logout_all_devices', async (callback) => {
      callback = safeAck(callback);
      if (!socket.username) return callback({ error: 'Not authenticated.' });
      try {
          const sockets = await ioInstance.fetchSockets();
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
      callback = safeAck(callback);
      if (!socket.username) return callback({ error: 'Not authenticated.' });
      try {
          const color = normalizeColor(data && data.color);
          const url = normalizeAvatarUrl(data && data.avatarUrl);
          const dName = normalizeDisplayName(data && data.displayName);
          if (!dName || color === null || url === null) return callback({ error: 'Invalid profile data.' });
          if (dName.toLowerCase() === 'nyzhang1') return callback({ error: 'Reserved name.' });

          if (dName.toLowerCase() !== socket.displayName.toLowerCase()) {
              const existingDisp = await UserModel.findOne({ displayName: { $regex: new RegExp(`^${escapeRegExp(dName)}$`, 'i') } });
              if (existingDisp) return callback({ error: 'Display Name is already taken.' });
          }

          const user = await UserModel.findOne({ username: socket.username });
          user.color = color; user.avatarUrl = url; user.displayName = dName; await user.save();
          
          await MessageModel.updateMany({ username: socket.username }, { $set: { color: color, avatarUrl: url, displayName: dName } });

          socket.color = color; socket.avatarUrl = url; socket.displayName = dName;
          if(onlineUsersMap.has(socket.id)) { let session = onlineUsersMap.get(socket.id); session.color = color; session.avatarUrl = url; session.displayName = dName; }
          
          ioInstance.emit('profile_updated', { username: socket.username, displayName: dName, color: color, avatarUrl: url });
          
          const serversToUpdate = new Set(socket.joinedServers);
          serversToUpdate.add('global');
          serversToUpdate.forEach(c => broadcastOnlineUsersFn(c));
          
          callback({ success: true, displayName: dName, color: color, avatarUrl: url });
      } catch(err) { callback({ error: 'Failed to update profile.' }); }
  });

  socket.on('manage_role', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object') return callback({ error: 'Invalid action.' });
    const { action } = data;
    const targetUser = normalizeUsername(data.targetUser);
    const validActions = new Set(['promote_global_admin', 'demote_global_admin', 'promote_mod', 'demote_mod']);
    if (!targetUser || !validActions.has(action)) return callback({ error: 'Invalid action.' });
    
    try {
        const targetUserDoc = await UserModel.findOne({ username: targetUser });
        if (!targetUserDoc) return callback({ error: 'User not found.' });

        const targetDisp = targetUserDoc.displayName || targetUserDoc.username;
        const isGlobalAdmin = socket.role === 'admin';

        // Manage Global Admins
        if (action === 'promote_global_admin' || action === 'demote_global_admin') {
            if (!isGlobalAdmin) return callback({ error: 'Only Global Admins can modify global roles.' });
            if (action === 'demote_global_admin' && targetUser.toLowerCase() === 'nyzhang1') return callback({ error: 'Cannot modify system owner.' });
            
            targetUserDoc.role = (action === 'promote_global_admin') ? 'admin' : 'user';
            await targetUserDoc.save();

            const sockets = await ioInstance.fetchSockets();
            sockets.forEach(s => {
                if (s.username === targetUser) {
                    s.role = targetUserDoc.role;
                    if (onlineUsersMap.has(s.id)) onlineUsersMap.get(s.id).role = targetUserDoc.role;
                    s.emit('global_role_updated', { username: targetUser, role: targetUserDoc.role });
                }
            });
            
            ioInstance.emit('system_message', `${socket.displayName} ${action === 'promote_global_admin' ? 'promoted' : 'demoted'} ${targetDisp} ${action === 'promote_global_admin' ? 'to' : 'from'} Global Admin.`);
            const roomsToUpdate = new Set(targetUserDoc.servers); roomsToUpdate.add('global');
            roomsToUpdate.forEach(c => broadcastOnlineUsersFn(c));
            
            return callback({ success: true });
        }

        // Manage Room Moderators
        const serverCode = normalizeServerCode(data.serverCode);
        if (!serverCode || serverCode === 'global') return callback({ error: 'Invalid action.' });
        if (serverCode) {
            const srv = await ChatServerModel.findOne({ code: serverCode });
            if (!srv) return callback({ error: 'Server not found.' });

            const isRoomMod = srv.moderators.includes(socket.username) || isGlobalAdmin;

            if (action === 'promote_mod') {
                if (!isGlobalAdmin && !isRoomMod) return callback({ error: 'Only Global Admins and Room Moderators can promote to Room Moderator.' });
                if (!Array.isArray(targetUserDoc.servers) || !targetUserDoc.servers.includes(serverCode)) return callback({ error: 'Target user is not a room member.' });
                
                if (!srv.moderators) srv.moderators = [];
                if (!srv.moderators.includes(targetUser)) {
                    srv.moderators.push(targetUser);
                    await srv.save();
                    ioInstance.to(serverCode).emit('system_message', `${socket.displayName} promoted ${targetDisp} to Room Moderator.`);
                }
                broadcastOnlineUsersFn(serverCode);
                ioInstance.to(serverCode).emit('room_role_updated', { username: targetUser, targetServer: serverCode });
                return callback({ success: true });
            } else if (action === 'demote_mod') {
                if (!isGlobalAdmin) return callback({ error: 'Only Global Admins can remove moderator roles.' });
                
                if (srv.moderators) {
                    srv.moderators = srv.moderators.filter(u => u !== targetUser);
                    await srv.save();
                    ioInstance.to(serverCode).emit('system_message', `${socket.displayName} removed ${targetDisp}'s Room Moderator role.`);
                }
                broadcastOnlineUsersFn(serverCode);
                ioInstance.to(serverCode).emit('room_role_updated', { username: targetUser, targetServer: serverCode });
                return callback({ success: true });
            }
        }
        callback({ error: 'Invalid action.' });
    } catch (err) {
        callback({ error: 'Failed to manage role.' });
    }
  });

  socket.on('create_server', async (name, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const cleanName = normalizeServerName(name);
    if (!cleanName) return callback({ error: 'Invalid server name.' });
    try {
      let srv;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        try {
          srv = await ChatServerModel.create({
            code,
            name: cleanName,
            owner: socket.username,
            moderators: [socket.username]
          });
          break;
        } catch (err) {
          if (!err || err.code !== 11000 || attempt === 4) throw err;
        }
      }
      const user = await UserModel.findOne({ username: socket.username });
      
      if (!user.servers.includes(srv.code)) {
        user.servers.push(srv.code); await user.save(); socket.joinedServers = user.servers;
        if(onlineUsersMap.has(socket.id)) onlineUsersMap.get(socket.id).joinedServers = user.servers;
        broadcastOnlineUsersFn(srv.code);
      }
      callback({ success: true, server: srv });
      
      try {
        const sockets = await ioInstance.fetchSockets();
        sockets.forEach(s => { if (onlineUsersMap.has(s.id) && onlineUsersMap.get(s.id).role === 'admin') s.emit('admin_new_server', srv); });
      } catch (err) {}
    } catch (err) { callback({ error: 'Creation failed.' }); }
  });

  socket.on('join_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode) return callback({ error: 'Invalid invite code.' });
    try {
      const srv = await ChatServerModel.findOne({ code: serverCode });
      if (!srv) return callback({ error: 'Invalid invite code.' });
      
      const user = await UserModel.findOne({ username: socket.username });
      if (!user.servers.includes(srv.code)) {
        user.servers.push(srv.code); await user.save(); socket.joinedServers = user.servers;
        if(onlineUsersMap.has(socket.id)) onlineUsersMap.get(socket.id).joinedServers = user.servers;
        
        broadcastOnlineUsersFn(srv.code);

        if (socket.serverCode === srv.code) { 
            socket.to(srv.code).emit('system_message', `${socket.displayName} joined.`); 
        }
      }
      callback({ success: true, server: srv });
    } catch (err) { callback({ error: 'Join failed.' }); }
  });

  socket.on('leave_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode || serverCode === 'global') return callback({ error: 'Cannot leave global.' });
    try {
      const user = await UserModel.findOne({ username: socket.username });
      const isMember = user.servers.includes(serverCode);
      if (isMember) {
        user.servers = user.servers.filter(s => s !== serverCode); await user.save();
        socket.joinedServers = user.servers;
        if(onlineUsersMap.has(socket.id)) onlineUsersMap.get(socket.id).joinedServers = user.servers;
        await ChatServerModel.updateOne({ code: serverCode }, { $pull: { moderators: socket.username } });
      }

      const wasActive = socket.serverCode === serverCode;
      if (wasActive) {
          socket.to(serverCode).emit('system_message', `${socket.displayName} left the server.`);
          socket.leave(serverCode);
          socket.serverCode = 'global';
          socket.join('global');
          if (onlineUsersMap.has(socket.id)) onlineUsersMap.get(socket.id).serverCode = 'global';
      }
      if (isMember || wasActive) {
        broadcastOnlineUsersFn(serverCode);
      }
      if (wasActive) {
        broadcastOnlineUsersFn('global');
      }
      callback({ success: true });
    } catch (err) { callback({ error: 'Failed to leave.' }); }
  });

  socket.on('delete_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode || serverCode === 'global') return callback({ error: 'Cannot delete global.' });
    try {
      const srv = await ChatServerModel.findOne({ code: serverCode });
      if (!srv) return callback({ error: 'Server not found.' });

      // ONLY Global Admins or the actual Room Creator can completely delete a server
      if (socket.role === 'admin' || srv.owner === socket.username) {
        await ChatServerModel.deleteOne({ code: serverCode });
        await MessageModel.deleteMany({ serverCode });
        await UserModel.updateMany({}, { $pull: { servers: serverCode } });
        ioInstance.emit('server_deleted', serverCode);
        const sockets = await ioInstance.fetchSockets();
        sockets.forEach(s => {
          if (s.joinedServers && s.joinedServers.includes(serverCode)) {
             s.joinedServers = s.joinedServers.filter(c => c !== serverCode);
             if (onlineUsersMap.has(s.id)) onlineUsersMap.get(s.id).joinedServers = s.joinedServers;
          }
          if (s.serverCode === serverCode) {
            s.leave(serverCode);
            s.serverCode = 'global';
            s.join('global');
            if (onlineUsersMap.has(s.id)) onlineUsersMap.get(s.id).serverCode = 'global';
          }
        });
        broadcastOnlineUsersFn('global'); callback({ success: true });
      } else { callback({ error: 'Permission denied.' }); }
    } catch (err) { callback({ error: 'Deletion failed.' }); }
  });

  socket.on('switch_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode) return callback({ error: 'Invalid server code.' });
    try {
      const room = await ChatServerModel.findOne({ code: serverCode });
      if (!room) return callback({ error: 'Server not found.' });
      if (!canAccessRoom(socket, serverCode)) return callback({ error: 'Permission denied.' });
      const oldCode = socket.serverCode;
      if (oldCode && oldCode !== serverCode) { socket.leave(oldCode); broadcastOnlineUsersFn(oldCode); }

      socket.serverCode = serverCode; socket.join(serverCode);
      if (onlineUsersMap.has(socket.id)) onlineUsersMap.get(socket.id).serverCode = serverCode;
      
      broadcastOnlineUsersFn(serverCode);
      broadcastOnlineUsersFn('global');
      
      let query = { serverCode };
      if (serverCode === 'global') query = { $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] };

      const history = await MessageModel.find(query).sort({ timestamp: -1 }).limit(100).lean();
      
      const roomRole = await getRoomRoleFn(serverCode, socket.username);

      const safeHistory = history.map(msg => {
          if (msg.deleted && msg.username !== socket.username && socket.role !== 'admin' && roomRole !== 'mod') {
              msg.text = ''; msg.attachment = null; msg.reactions = {};
          }
          if (!msg.reactions) msg.reactions = {};
          return msg;
      });
      callback({ history: safeHistory.reverse(), roomRole });
    } catch (err) { callback({ error: 'Failed to switch server.' }); }
  });

  socket.on('chat_message', async (payload) => {
    try {
      const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
      if (!socket.username || !socket.serverCode || !canAccessRoom(identity, socket.serverCode)) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.text !== 'string') return;
      if (!isValidAttachment(payload.attachment)) return;

      const now = Date.now();
      if (socket.role !== 'admin' && now - lastMessageTime < 500) {
        return socket.emit('system_message', '⚠️ Slow down! You are sending messages too fast.');
      }
      lastMessageTime = now;

      const attachment = payload.attachment || null;
      let cleanText = payload.text.trim().substring(0, 2000);
      if (!cleanText && !attachment) return;

      let replyTo = null;
      if (payload.replyTo && typeof payload.replyTo === 'object' && isValidObjectId(payload.replyTo.id)) {
        const referenced = await MessageModel.findById(payload.replyTo.id);
        if (referenced && !referenced.deleted && referenced.serverCode === socket.serverCode) {
          replyTo = createReplySnapshot(referenced);
        }
      }

      const roomRole = await getRoomRoleFn(socket.serverCode, socket.username);
      cleanText = neutralizePingTokens(cleanText);
      cleanText = await resolvePingsFn(cleanText, socket.serverCode, socket.role, roomRole, socket.username);

      const msg = await MessageModel.create({
          serverCode: socket.serverCode, username: socket.username, displayName: socket.displayName, 
          role: socket.role, roomRole: roomRole, color: socket.color, avatarUrl: socket.avatarUrl, 
          text: cleanText, attachment: attachment, replyTo: replyTo, reactions: {} 
      });
      
      ioInstance.to(socket.serverCode).emit('chat_message', {
          _id: msg._id, username: msg.username, displayName: msg.displayName, role: socket.role, roomRole: roomRole, color: msg.color, avatarUrl: msg.avatarUrl,
          text: msg.text, attachment: msg.attachment, replyTo: msg.replyTo, reactions: {}, timestamp: msg.timestamp, edited: false, deleted: false 
      });
    } catch (err) { console.error('chat_message failed:', err); }
  });

  socket.on('toggle_reaction', async (data) => {
      try {
          if (!socket.username || !data || typeof data !== 'object' || Array.isArray(data)) return;
          const { id, emoji } = data;
          if (!isValidObjectId(id) || !isValidReaction(emoji)) return;

          const msg = await MessageModel.findById(id);
          if (!msg || msg.deleted) return;
          const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
          if (!canAccessRoom(identity, msg.serverCode)) return;

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

          ioInstance.to(msg.serverCode).emit('reaction_updated', { id: msg._id, reactions: msg.reactions });
      } catch (err) { console.error('toggle_reaction failed:', err); }
  });

  socket.on('edit_message', async (data) => {
    try {
      if (!socket.username || !data || typeof data !== 'object' || Array.isArray(data) ||
          !isValidObjectId(data.id) || typeof data.text !== 'string') return;
      let cleanText = data.text.trim().substring(0, 2000);
      if (!cleanText) return;

      const msg = await MessageModel.findById(data.id);
      if (msg && !msg.deleted) {
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (!canAccessRoom(identity, msg.serverCode)) return;
        const roomRole = await getRoomRoleFn(msg.serverCode, socket.username);

        // Edit allowed for Sender, Global Admin, or Room Mod
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
          
          cleanText = await resolvePingsFn(cleanText, msg.serverCode, socket.role, roomRole, socket.username);

          if (msg.text !== cleanText) {
              msg.history = appendBoundedHistory(msg.history, { text: msg.text, timestamp: new Date() });
              msg.text = cleanText; msg.edited = true; msg.markModified('history'); 
              await msg.save();
              ioInstance.to(msg.serverCode).emit('message_edited', { id: msg._id, username: msg.username, role: msg.role, roomRole: msg.roomRole, text: cleanText });
          }
        }
      }
    } catch (err) { console.error('edit_message failed:', err); }
  });

  socket.on('delete_message', async (msgId) => {
    try {
      if (!socket.username || !isValidObjectId(msgId)) return;
      const msg = await MessageModel.findById(msgId);
      if (msg && !msg.deleted) {
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (!canAccessRoom(identity, msg.serverCode)) return;
        const roomRole = await getRoomRoleFn(msg.serverCode, socket.username);
        
        // Sender, SysAdmin, or RoomMod can delete it
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
          msg.deleted = true; await msg.save();
          ioInstance.to(msg.serverCode).emit('message_deleted', msgId);
        }
      }
    } catch (err) { console.error('delete_message failed:', err); }
  });

  socket.on('get_edit_history', async (msgId, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    try {
      if (!isValidObjectId(msgId)) return callback({ error: 'Permission denied.' });
      const msg = await MessageModel.findById(msgId);
      if (msg) {
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (!canAccessRoom(identity, msg.serverCode)) return callback({ error: 'Permission denied.' });
        const roomRole = await getRoomRoleFn(msg.serverCode, socket.username);
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
            return callback({ success: true, history: (Array.isArray(msg.history) ? msg.history : []).slice(-20) });
        }
      }
      callback({ error: 'Permission denied.' });
    } catch (err) { console.error('get_edit_history failed:', err); callback({ error: 'Failed to load history.' }); }
  });

  socket.on('get_deleted_message', async (msgId, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    try {
      if (!isValidObjectId(msgId)) return callback({ error: 'Permission denied.' });
      const msg = await MessageModel.findById(msgId);
      if (msg && msg.deleted) {
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (!canAccessRoom(identity, msg.serverCode)) return callback({ error: 'Permission denied.' });
        const roomRole = await getRoomRoleFn(msg.serverCode, socket.username);
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
            return callback({ success: true, text: msg.text, attachment: msg.attachment });
        }
      }
      callback({ error: 'Permission denied.' });
    } catch (err) { console.error('get_deleted_message failed:', err); callback({ error: 'Failed to load deleted message.' }); }
  });

  socket.on('typing', (isTyping) => {
    const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
    if (!socket.username || !socket.serverCode || typeof isTyping !== 'boolean' || !canAccessRoom(identity, socket.serverCode)) return;
    socket.to(socket.serverCode).emit('typing', {
      username: socket.username,
      displayName: socket.displayName || socket.username,
      isTyping
    });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      const session = onlineUsersMap.get(socket.id);
      const serverCode = session?.serverCode;
      const joinedServers = session?.joinedServers || [];
      const dName = session?.displayName || socket.username;
      
      onlineUsersMap.delete(socket.id);
      
      const serversToUpdate = new Set(joinedServers || []);
      serversToUpdate.add('global');
      serversToUpdate.forEach(code => broadcastOnlineUsersFn(code));

      if (serverCode) {
        const isVisible = socket.role !== 'admin' || (joinedServers && joinedServers.includes(serverCode)) || serverCode === 'global';
        if (isVisible) {
            ioInstance.to(serverCode).emit('system_message', `${dName} disconnected.`);
            ioInstance.to(serverCode).emit('typing', { username: socket.username, isTyping: false });
        }
      }
    }
  });
  };
}

io.on('connection', createConnectionHandler());

const PORT = process.env.PORT || 3000;

async function start() {
  if (MONGO_URI) {
    await mongoose.connect(MONGO_URI);
    await seedSystem();
  }
  return new Promise(resolve => {
    server.listen(PORT, () => {
      console.log(`🚀 Server on port ${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error('Database startup failed:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  server,
  start,
  seedSystem,
  createConnectionHandler,
  safeAck,
  normalizeUsername,
  normalizeDisplayName,
  normalizeServerName,
  normalizeServerCode,
  isValidPassword,
  normalizeColor,
  normalizeAvatarUrl,
  isValidAttachment,
  isValidReaction,
  isValidObjectId,
  neutralizePingTokens,
  canAccessRoom,
  appendBoundedHistory,
  createReplySnapshot
};
