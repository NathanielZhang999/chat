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
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const MAX_REACTION_KEYS = 20;
const MAX_REACTION_USERS = 200;
const MAX_REACTIONS_PER_USER = 20;
const MODERATION_ACTIONS = new Set(['kick', 'timeout', 'clear_timeout', 'ban', 'unban']);
const MODERATION_DURATIONS = Object.freeze({
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
});
const PROTECTED_USERNAMES = new Set(['nyzhang1', 'system']);

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

function normalizeModerationAction(value) {
  if (typeof value !== 'string') return null;
  const action = value.trim().toLowerCase();
  return MODERATION_ACTIONS.has(action) ? action : null;
}

function normalizeModerationReason(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const reason = value.normalize('NFKC').trim();
  return reason.length >= 1 && reason.length <= maxLength ? reason : null;
}

function normalizeAccountKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function normalizeAutoModSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.blockedKeywords)) return null;
  const boundedIntegers = [
    ['mentionLimit', 1, 20],
    ['repeatLimit', 2, 10],
    ['repeatWindowSeconds', 5, 300]
  ];
  if (boundedIntegers.some(([key, min, max]) => !Number.isInteger(value[key]) || value[key] < min || value[key] > max)) return null;

  const blockedKeywords = [];
  const seen = new Set();
  for (const candidate of value.blockedKeywords) {
    if (typeof candidate !== 'string') return null;
    const keyword = candidate.normalize('NFKC').trim().toLowerCase();
    if (keyword.length < 1 || keyword.length > 40) return null;
    if (!seen.has(keyword)) {
      seen.add(keyword);
      blockedKeywords.push(keyword);
    }
  }
  if (blockedKeywords.length > 50) return null;
  return {
    blockedKeywords,
    mentionLimit: value.mentionLimit,
    repeatLimit: value.repeatLimit,
    repeatWindowSeconds: value.repeatWindowSeconds
  };
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

function sanitizeAttachment(value) {
  return typeof value === 'string' && value.length > 0 && isValidAttachment(value) ? value : null;
}

function isValidReaction(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 &&
    REACTION_RE.test(value) && /\p{Extended_Pictographic}/u.test(value);
}

function isValidObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

function neutralizePingTokens(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\{\{PING:/gi, '{{ PING:');
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

async function findUserByUsername(UserModel, value) {
  const username = normalizeUsername(value);
  if (!username) return null;
  const escaped = escapeRegExp(username);
  return UserModel.findOne({ username: { $regex: new RegExp(`^${escaped}$`, 'i') } });
}

// --- SECURITY: RATE LIMITING ---
function normalizeTransportAddress(value) {
  let address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return (address || 'unknown').slice(0, 128);
}

function createRateLimiter({
  maxEntries = MAX_RATE_LIMIT_KEYS,
  maxAttempts = 10,
  windowMs = RATE_LIMIT_WINDOW_MS,
  now = () => Date.now()
} = {}) {
  const attemptsByKey = new Map();

  function prune(currentTime = now()) {
    for (const [key, attempts] of attemptsByKey.entries()) {
      const recent = attempts.filter(time => currentTime - time < windowMs);
      if (recent.length === 0) attemptsByKey.delete(key);
      else attemptsByKey.set(key, recent);
    }
  }

  function check(key) {
    const currentTime = now();
    const existing = attemptsByKey.get(key);
    const recent = (existing || []).filter(time => currentTime - time < windowMs);
    if (recent.length >= maxAttempts) return false;

    if (!existing && attemptsByKey.size >= maxEntries) {
      prune(currentTime);
      while (attemptsByKey.size >= maxEntries) {
        const oldestKey = attemptsByKey.keys().next().value;
        attemptsByKey.delete(oldestKey);
      }
    }

    recent.push(currentTime);
    attemptsByKey.set(key, recent);
    return true;
  }

  return {
    check,
    clear(key) { attemptsByKey.delete(key); },
    prune
  };
}

function authRateLimitKey(socket, action, account) {
  const address = normalizeTransportAddress(socket && socket.handshake && socket.handshake.address);
  const normalizedAccount = typeof account === 'string' && account
    ? account.toLowerCase().slice(0, 30)
    : '-';
  return `${action}:${normalizedAccount}:${address}`;
}

function logUnexpectedError(logger, event, error) {
  if (!logger || typeof logger.error !== 'function') return;
  const candidate = error instanceof Error ? error.name : 'UnknownError';
  const errorType = /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : 'Error';
  logger.error('Chat operation failed.', { event, errorType });
}

// Combined mutations lock in this order: identity allocation -> account transition -> room mutation; never reverse.
let identityMutationTail = Promise.resolve();
async function withIdentityMutationLock(operation) {
  const previous = identityMutationTail;
  let release;
  identityMutationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

const accountTransitionTails = new Map();

async function withAccountTransitionLock(username, operation) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return operation();
  const previous = accountTransitionTails.get(key);
  let release;
  const current = new Promise(resolve => { release = resolve; });
  accountTransitionTails.set(key, current);
  if (previous) await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (accountTransitionTails.get(key) === current) accountTransitionTails.delete(key);
  }
}

async function withAccountTransitionLocks(usernames, operation) {
  const keys = [...new Set((Array.isArray(usernames) ? usernames : [])
    .map(normalizeAccountKey).filter(Boolean))].sort();
  async function acquire(index) {
    if (index >= keys.length) return operation();
    return withAccountTransitionLock(keys[index], () => acquire(index + 1));
  }
  return acquire(0);
}

function isCurrentRoomModerator(room, username) {
  const key = normalizeAccountKey(username);
  return Boolean(room && Array.isArray(room.moderators) &&
    room.moderators.some(candidate => normalizeAccountKey(candidate) === key));
}

function canModerateTarget({ serverCode, action, actorUser, targetUser, room }) {
  if (!actorUser || !targetUser || !room || room.code !== serverCode) return false;
  const normalizedAction = normalizeModerationAction(action);
  if (!normalizedAction) return false;
  const actorKey = normalizeAccountKey(actorUser.username);
  const targetKey = normalizeAccountKey(targetUser.username);
  if (!actorKey || !targetKey || actorKey === targetKey || PROTECTED_USERNAMES.has(targetKey)) return false;
  if (serverCode === 'global' && normalizedAction === 'kick') return false;
  const actorIsAdmin = actorUser.role === 'admin';
  const actorIsRoomMod = serverCode !== 'global' && isCurrentRoomModerator(room, actorUser.username);
  if (!actorIsAdmin && !actorIsRoomMod) return false;
  if (targetUser.role === 'admin') return false;
  if (!actorIsAdmin && isCurrentRoomModerator(room, targetUser.username)) return false;
  return true;
}

function activeRestrictionState(restriction, now = new Date()) {
  const timeoutUntil = restriction && restriction.timeoutUntil instanceof Date && restriction.timeoutUntil > now
    ? restriction.timeoutUntil : null;
  return { banned: Boolean(restriction && restriction.bannedAt), timedOut: Boolean(timeoutUntil), timeoutUntil };
}

async function getActiveRoomRestriction(RoomRestrictionModel, serverCode, username, now = new Date()) {
  const row = await RoomRestrictionModel.findOne({ serverCode, username: normalizeAccountKey(username) });
  const state = activeRestrictionState(row, now);
  return { row, ...state };
}

function chooseAccessibleRoom({ user, rooms, restrictions }) {
  const blocked = new Set((restrictions || []).filter(item => item.banned).map(item => item.serverCode));
  if (!blocked.has('global')) return 'global';
  const roomCodes = new Set((rooms || []).map(room => room.code));
  for (const code of user && Array.isArray(user.servers) ? user.servers : []) {
    if (code !== 'global' && roomCodes.has(code) && !blocked.has(code)) return code;
  }
  return null;
}

async function loadRoomAccessState({ UserModel, ChatServerModel, RoomRestrictionModel, username, serverCode, now = new Date() }) {
  const [user, room, restriction] = await Promise.all([
    findUserByUsername(UserModel, username),
    ChatServerModel.findOne({ code: serverCode }),
    getActiveRoomRestriction(RoomRestrictionModel, serverCode, username, now)
  ]);
  const memberships = user && Array.isArray(user.servers) ? user.servers : [];
  return {
    allowed: Boolean(user && room) && !restriction.banned &&
      (serverCode === 'global' || user.role === 'admin' || memberships.includes(serverCode)),
    user,
    room,
    restriction
  };
}

const roomMutationTails = new Map();
async function withRoomMutationLock(serverCode, operation) {
  const previous = roomMutationTails.get(serverCode) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  roomMutationTails.set(serverCode, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (roomMutationTails.get(serverCode) === current) roomMutationTails.delete(serverCode);
  }
}

const authRateLimiter = createRateLimiter();
setInterval(() => {
  authRateLimiter.prune();
}, RATE_LIMIT_WINDOW_MS).unref();

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
  moderators: { type: [String], default: [] },
  autoMod: {
    blockedKeywords: {
      type: [{ type: String, maxLength: 40 }],
      default: [],
      validate: value => Array.isArray(value) && value.length <= 50
    },
    mentionLimit: { type: Number, min: 1, max: 20, default: 8 },
    repeatLimit: { type: Number, min: 2, max: 10, default: 3 },
    repeatWindowSeconds: { type: Number, min: 5, max: 300, default: 30 }
  }
});
const ChatServer = mongoose.model('ChatServer', ChatServerSchema);

const RoomRestrictionSchema = new mongoose.Schema({
  serverCode: { type: String, required: true, maxLength: 6 },
  username: { type: String, required: true, maxLength: 20 },
  bannedAt: { type: Date, default: null },
  bannedBy: { type: String, default: null, maxLength: 20 },
  banReason: { type: String, default: null, maxLength: 200 },
  timeoutUntil: { type: Date, default: null },
  timeoutBy: { type: String, default: null, maxLength: 20 },
  timeoutReason: { type: String, default: null, maxLength: 200 }
}, { timestamps: true });
RoomRestrictionSchema.index({ serverCode: 1, username: 1 }, { unique: true });
RoomRestrictionSchema.index({ username: 1, serverCode: 1 });
RoomRestrictionSchema.index(
  { serverCode: 1, bannedAt: -1 },
  { partialFilterExpression: { bannedAt: { $type: 'date' } } }
);
RoomRestrictionSchema.index(
  { serverCode: 1, timeoutUntil: 1 },
  { partialFilterExpression: { timeoutUntil: { $type: 'date' } } }
);
const RoomRestriction = mongoose.model('RoomRestriction', RoomRestrictionSchema);

function rejectAuditMutation(next) {
  const error = new Error('ModerationAudit is append-only.');
  if (typeof next === 'function') return next(error);
  throw error;
}

const ModerationAuditSchema = new mongoose.Schema({
  correlationId: { type: String, required: true, unique: true, maxLength: 64 },
  action: { type: String, required: true, maxLength: 40 },
  serverCode: { type: String, required: true, maxLength: 6 },
  actorUsername: { type: String, required: true, maxLength: 20 },
  actorRole: { type: String, required: true, maxLength: 20 },
  actorRoomRole: { type: String, required: true, maxLength: 20 },
  targetUsername: { type: String, default: null, maxLength: 20 },
  targetRole: { type: String, default: null, maxLength: 20 },
  targetRoomRole: { type: String, default: null, maxLength: 20 },
  reason: { type: String, required: true, maxLength: 300 },
  duration: { type: String, default: null, maxLength: 8 },
  expiresAt: { type: Date, default: null },
  messageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  reportId: { type: mongoose.Schema.Types.ObjectId, default: null },
  metadata: { type: Object, default: {} }
}, { timestamps: { createdAt: true, updatedAt: false } });
ModerationAuditSchema.index({ serverCode: 1, createdAt: -1, _id: -1 });
ModerationAuditSchema.pre('updateOne', rejectAuditMutation);
ModerationAuditSchema.pre('updateMany', rejectAuditMutation);
ModerationAuditSchema.pre('findOneAndUpdate', rejectAuditMutation);
ModerationAuditSchema.pre('replaceOne', rejectAuditMutation);
ModerationAuditSchema.pre('deleteOne', rejectAuditMutation);
ModerationAuditSchema.pre('deleteMany', rejectAuditMutation);
ModerationAuditSchema.pre('findOneAndDelete', rejectAuditMutation);
ModerationAuditSchema.pre('save', function rejectAuditSave(next) {
  if (!this.isNew) return rejectAuditMutation(next);
  next();
});
ModerationAuditSchema.pre('deleteOne', { document: true, query: false }, rejectAuditMutation);
const ModerationAudit = mongoose.model('ModerationAudit', ModerationAuditSchema);

const ModerationReportSchema = new mongoose.Schema({
  serverCode: { type: String, required: true, maxLength: 6 },
  reporterUsername: { type: String, required: true, maxLength: 20 },
  targetUsername: { type: String, required: true, maxLength: 20 },
  messageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  reason: { type: String, required: true, maxLength: 300 },
  status: { type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open' },
  resolvedBy: { type: String, default: null, maxLength: 20 },
  resolution: { type: String, default: null, maxLength: 300 },
  resolvedAt: { type: Date, default: null }
}, { timestamps: true });
ModerationReportSchema.index({ serverCode: 1, status: 1, createdAt: -1, _id: -1 });
ModerationReportSchema.index({ reporterUsername: 1, createdAt: -1 });
ModerationReportSchema.index(
  { reporterUsername: 1, serverCode: 1, targetUsername: 1, messageId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);
const ModerationReport = mongoose.model('ModerationReport', ModerationReportSchema);

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
  const bannedAccounts = new Set();
  for (const info of onlineUsers.values()) {
      const accountKey = normalizeAccountKey(info.username);
      if (Array.isArray(info.bannedRooms) && info.bannedRooms.includes(serverCode)) {
          bannedAccounts.add(accountKey);
          globalOnlineMap.delete(accountKey);
          continue;
      }
      if (!bannedAccounts.has(accountKey) && !globalOnlineMap.has(accountKey)) globalOnlineMap.set(accountKey, info);
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
              const accountKey = normalizeAccountKey(member.username);
              if (bannedAccounts.has(accountKey)) continue;
              const isOnline = globalOnlineMap.has(accountKey);
              const activeData = globalOnlineMap.get(accountKey);
              
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
      } catch (err) { logUnexpectedError(console, 'broadcast_online_users', err); }
  }

  io.to(serverCode).emit('online_users', usersList);
}

function createConnectionHandler({
  ioInstance = io,
  UserModel = User,
  ChatServerModel = ChatServer,
  MessageModel = Message,
  RoomRestrictionModel = RoomRestriction,
  ModerationAuditModel = ModerationAudit,
  ModerationReportModel = ModerationReport,
  bcryptImpl = bcrypt,
  onlineUsersMap = onlineUsers,
  broadcastOnlineUsersFn = broadcastOnlineUsers,
  getRoomRoleFn = getRoomRole,
  resolvePingsFn = resolvePings,
  rateLimiter = authRateLimiter,
  logger = console
} = {}) {
  return socket => {
  socket.serverCode = null;
  socket.joinedServers = [];
  
  let lastMessageTime = 0; 
  let suppressDisconnectPresence = false;
  let terminallyClosed = false;

  async function fetchLiveSockets() {
    const fetched = await ioInstance.fetchSockets();
    const byId = new Map((Array.isArray(fetched) ? fetched : []).map(live => [live.id, live]));
    byId.set(socket.id, socket);
    return [...byId.values()];
  }

  async function evictLiveSocket(live, session, serverCode) {
    const activeRoom = live.serverCode || session?.serverCode;
    try {
      await Promise.resolve(live.leave(serverCode));
      if (activeRoom === serverCode) {
        live.serverCode = 'global';
        await Promise.resolve(live.join('global'));
        if (session) session.serverCode = 'global';
      }
      return true;
    } catch (err) {
      logUnexpectedError(logger, 'room_transport_eviction', err);
      live.serverCode = 'global';
      if (session) session.serverCode = 'global';
      try {
        await Promise.resolve(live.disconnect(true));
      } catch (disconnectError) {
        logUnexpectedError(logger, 'room_transport_disconnect', disconnectError);
      }
      return false;
    }
  }

  async function synchronizeMembership(sockets, username, joinedServers, evictedRoom = null) {
    const authoritativeServers = [...new Set(Array.isArray(joinedServers) ? joinedServers : ['global'])];
    if (!authoritativeServers.includes('global')) authoritativeServers.unshift('global');
    const normalizedUsername = String(username || '').trim().toLowerCase();
    let synchronized = true;
    const accountSockets = [];

    for (const live of sockets) {
      const session = onlineUsersMap.get(live.id);
      const liveUsername = String(live.username || session?.username || '').trim().toLowerCase();
      if (liveUsername !== normalizedUsername) continue;

      live.joinedServers = [...authoritativeServers];
      if (session) session.joinedServers = [...authoritativeServers];
      accountSockets.push({ live, session });
    }

    const liveSessionIds = new Set(accountSockets.map(({ live }) => live.id));
    for (const [id, session] of onlineUsersMap.entries()) {
      if (String(session?.username || '').trim().toLowerCase() !== normalizedUsername) continue;
      session.joinedServers = [...authoritativeServers];
      if (evictedRoom && !liveSessionIds.has(id) && session.serverCode === evictedRoom) session.serverCode = 'global';
    }

    for (const { live, session } of accountSockets) {
      if (evictedRoom) {
        synchronized = (await evictLiveSocket(live, session, evictedRoom)) && synchronized;
      }

      try {
        live.emit('room_access_updated', {
          username,
          joinedServers: [...authoritativeServers],
          serverCode: live.serverCode || session?.serverCode || 'global'
        });
      } catch (err) {
        synchronized = false;
        logUnexpectedError(logger, 'room_access_notification', err);
      }
    }
    return synchronized;
  }

  async function synchronizeProfile(sockets, username, profile) {
    const normalizedUsername = String(username || '').trim().toLowerCase();
    for (const live of sockets) {
      const session = onlineUsersMap.get(live.id);
      const liveUsername = String(live.username || session?.username || '').trim().toLowerCase();
      if (liveUsername !== normalizedUsername) continue;
      live.displayName = profile.displayName;
      live.color = profile.color;
      live.avatarUrl = profile.avatarUrl;
      if (session) {
        session.displayName = profile.displayName;
        session.color = profile.color;
        session.avatarUrl = profile.avatarUrl;
      }
    }

    for (const session of onlineUsersMap.values()) {
      if (String(session?.username || '').trim().toLowerCase() !== normalizedUsername) continue;
      session.displayName = profile.displayName;
      session.color = profile.color;
      session.avatarUrl = profile.avatarUrl;
    }
  }

  async function roomExists(serverCode) {
    return Boolean(await ChatServerModel.findOne({ code: serverCode }));
  }

  socket.on('register', async (data, callback) => {
    callback = safeAck(callback);
    if (terminallyClosed) return callback({ error: 'Connection unavailable.' });
    try {
      if (!data) return callback({ error: 'Invalid input format.' });
      const cleanUser = normalizeUsername(data.username);
      const cleanDisp = normalizeDisplayName(data.displayName || data.username);
      if (!cleanUser || !cleanDisp || !isValidPassword(data.password)) return callback({ error: 'Invalid input format.' });
      
      const rateKey = authRateLimitKey(socket, 'register', cleanUser);
      if (!rateLimiter.check(rateKey)) return callback({ error: 'Too many requests. Try again later.' });

      if (cleanUser.toLowerCase() === 'nyzhang1' || cleanDisp.toLowerCase() === 'nyzhang1') return callback({ error: 'Reserved name.' });

      const result = await withIdentityMutationLock(async () => {
        const escapedUser = escapeRegExp(cleanUser);
        const existing = await UserModel.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } });
        if (existing) return { error: 'Username taken.' };

        const escapedDisp = escapeRegExp(cleanDisp);
        const existingDisp = await UserModel.findOne({ displayName: { $regex: new RegExp(`^${escapedDisp}$`, 'i') } });
        if (existingDisp) return { error: 'Display Name is already taken.' };

        const hashedPassword = await bcryptImpl.hash(data.password, 10);
        await UserModel.create({ username: cleanUser, displayName: cleanDisp, password: hashedPassword, servers: ['global'] });
        return { success: true };
      });

      if (result.success) rateLimiter.clear(rateKey);
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'register', err);
      callback({ error: 'Registration failed.' });
    }
  });

  socket.on('login', async (data, callback) => {
    callback = safeAck(callback);
    if (terminallyClosed) return callback({ error: 'Connection unavailable.' });
    try {
      if (socket.username) return callback({ error: 'Already authenticated.' });
      if (!data) return callback({ error: 'Invalid input format.' });
      const username = normalizeUsername(data.username);
      if (!username || !isValidPassword(data.password)) return callback({ error: 'Invalid input format.' });
      
      const rateKey = authRateLimitKey(socket, 'login', username);
      if (!rateLimiter.check(rateKey)) return callback({ error: 'Too many login attempts. Try again later.' });

      const escapedUser = escapeRegExp(username);
      const initialUser = await UserModel.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } });
      if (!initialUser) return callback({ error: 'User not found.' });
      if (!(await bcryptImpl.compare(data.password, initialUser.password))) return callback({ error: 'Incorrect password.' });

      const result = await withAccountTransitionLock(initialUser.username, async () => {
        const user = await UserModel.findOne({ username: { $regex: new RegExp(`^${escapedUser}$`, 'i') } });
        if (!user) return { error: 'User not found.' };
        if (!(await bcryptImpl.compare(data.password, user.password))) return { error: 'Incorrect password.' };

        let needsSave = false;
        if (!Array.isArray(user.servers) || user.servers.length === 0) {
          user.servers = ['global'];
          needsSave = true;
        }
        if (!user.displayName) {
          user.displayName = user.username;
          needsSave = true;
        }
        if (needsSave) await user.save();

        const role = user.role || 'user';
        const [rooms, restrictionRows] = await Promise.all([
          role === 'admin'
            ? ChatServerModel.find()
            : ChatServerModel.find({ code: { $in: user.servers } }),
          RoomRestrictionModel.find({ username: normalizeAccountKey(user.username) })
        ]);
        const restrictions = (restrictionRows || []).map(row => ({
          serverCode: row.serverCode,
          ...activeRestrictionState(row)
        }));
        const bannedRooms = restrictions.filter(item => item.banned).map(item => item.serverCode);
        const blockedRooms = new Set(bannedRooms);
        const existingRoomCodes = new Set((rooms || []).map(room => room.code));
        const joinedServers = user.servers.filter(code =>
          (code === 'global' || existingRoomCodes.has(code)) && !blockedRooms.has(code)
        );
        const visibleRooms = (rooms || []).filter(room => !blockedRooms.has(room.code));
        const defaultServerCode = chooseAccessibleRoom({ user, rooms, restrictions });
        const restriction = defaultServerCode
          ? (restrictions.find(item => item.serverCode === defaultServerCode) || activeRestrictionState(null))
          : activeRestrictionState(null);

        socket.username = user.username;
        socket.displayName = user.displayName;
        socket.role = role;
        socket.color = user.color || '';
        socket.avatarUrl = user.avatarUrl || '';
        socket.serverCode = defaultServerCode;
        socket.joinedServers = [...joinedServers];
        socket.bannedRooms = [...bannedRooms];

        if (defaultServerCode) await Promise.resolve(socket.join(defaultServerCode));
        onlineUsersMap.set(socket.id, {
          username: user.username,
          displayName: socket.displayName,
          role: socket.role,
          color: socket.color,
          avatarUrl: socket.avatarUrl,
          serverCode: defaultServerCode,
          joinedServers: [...joinedServers],
          bannedRooms: [...bannedRooms]
        });

        const serversToUpdate = new Set(joinedServers);
        serversToUpdate.forEach(c => broadcastOnlineUsersFn(c));

        const isVisible = defaultServerCode &&
          (socket.role !== 'admin' || socket.joinedServers.includes(defaultServerCode) || defaultServerCode === 'global');
        if (isVisible) socket.to(defaultServerCode).emit('system_message', `${socket.displayName} joined the app.`);

        return {
          success: true,
          username: user.username,
          displayName: socket.displayName,
          role: socket.role,
          color: socket.color,
          avatarUrl: socket.avatarUrl,
          servers: visibleRooms,
          joinedServers: [...joinedServers],
          defaultServerCode,
          restriction: {
            banned: restriction.banned,
            timedOut: restriction.timedOut,
            timeoutUntil: restriction.timeoutUntil
          },
          bannedRooms: [...bannedRooms]
        };
      });

      if (result.success) rateLimiter.clear(rateKey);
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'login', err);
      callback({ error: 'Login failed.' });
    }
  });

  socket.on('change_password', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data.oldPassword !== 'string' || typeof data.newPassword !== 'string') return callback({ error: 'Invalid input format.' });
    
    const rateKey = authRateLimitKey(socket, 'change_password', socket.username);
    if (!rateLimiter.check(rateKey)) return callback({ error: 'Too many attempts. Try again later.' });

    try {
      const user = await UserModel.findOne({ username: socket.username });
      if (!user) return callback({ error: 'User not found.' });

      const isMatch = await bcryptImpl.compare(data.oldPassword, user.password);
      if (!isMatch) return callback({ error: 'Incorrect current password.' });

      if (!isValidPassword(data.newPassword)) return callback({ error: 'Invalid input format.' });

      user.password = await bcryptImpl.hash(data.newPassword, 10);
      await user.save();
      
      rateLimiter.clear(rateKey);
      callback({ success: true });
    } catch (err) {
      logUnexpectedError(logger, 'change_password', err);
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
          logUnexpectedError(logger, 'logout_all_devices', err);
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
          if (!dName || color === null || url === null) return callback({ error: 'Invalid input format.' });
          if (dName.toLowerCase() === 'nyzhang1') return callback({ error: 'Reserved name.' });

          const result = await withIdentityMutationLock(async () => {
            return withAccountTransitionLock(socket.username, async () => {
              const user = await UserModel.findOne({ username: socket.username });
              if (!user) return { error: 'User not found.' };

              const currentDisplayName = user.displayName || user.username || '';
              if (dName.toLowerCase() !== currentDisplayName.toLowerCase()) {
                  const existingDisp = await UserModel.findOne({ displayName: { $regex: new RegExp(`^${escapeRegExp(dName)}$`, 'i') } });
                  if (existingDisp) return { error: 'Display Name is already taken.' };
              }

              user.color = color;
              user.avatarUrl = url;
              user.displayName = dName;
              await user.save();

              const sockets = await fetchLiveSockets();
              await synchronizeProfile(sockets, socket.username, {
                  color,
                  avatarUrl: url,
                  displayName: dName
              });

              try {
                  await MessageModel.updateMany({ username: socket.username }, { $set: { color: color, avatarUrl: url, displayName: dName } });
              } catch (err) {
                  logUnexpectedError(logger, 'update_profile_message_snapshots', err);
              }

              ioInstance.emit('profile_updated', { username: socket.username, displayName: dName, color: color, avatarUrl: url });

              const serversToUpdate = new Set(socket.joinedServers);
              serversToUpdate.add('global');
              serversToUpdate.forEach(c => broadcastOnlineUsersFn(c));

              return {
                  success: true,
                  displayName: dName,
                  color,
                  avatarUrl: url
              };
            });
          });
          callback(result);
      } catch(err) {
          logUnexpectedError(logger, 'update_profile', err);
          callback({ error: 'Failed to update profile.' });
      }
  });

  socket.on('manage_role', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return callback({ error: 'Invalid input format.' });
    const { action } = data;
    const targetUser = normalizeUsername(data.targetUser);
    const validActions = new Set(['promote_global_admin', 'demote_global_admin', 'promote_mod', 'demote_mod']);
    if (!targetUser || !validActions.has(action)) return callback({ error: 'Invalid input format.' });
    
    try {
        const isGlobalAdmin = socket.role === 'admin';

        // Manage Global Admins
        if (action === 'promote_global_admin' || action === 'demote_global_admin') {
            if (!isGlobalAdmin) return callback({ error: 'Only Global Admins can modify global roles.' });
            if (action === 'demote_global_admin' && targetUser.toLowerCase() === 'nyzhang1') return callback({ error: 'Cannot modify system owner.' });

            const result = await withAccountTransitionLock(targetUser, async () => {
                const targetUserDoc = await UserModel.findOne({ username: targetUser });
                if (!targetUserDoc) return { error: 'User not found.' };

                const targetDisp = targetUserDoc.displayName || targetUserDoc.username;
                targetUserDoc.role = (action === 'promote_global_admin') ? 'admin' : 'user';
                await targetUserDoc.save();

                const sockets = await fetchLiveSockets();
                const normalizedTarget = targetUser.toLowerCase();
                const joinedServers = Array.isArray(targetUserDoc.servers) ? targetUserDoc.servers : ['global'];
                let roleSyncFailed = false;
                const targetSessions = [];
                for (const live of sockets) {
                    const session = onlineUsersMap.get(live.id);
                    const liveUsername = String(live.username || session?.username || '').trim().toLowerCase();
                    if (liveUsername !== normalizedTarget) continue;
                    live.role = targetUserDoc.role;
                    live.joinedServers = [...joinedServers];
                    if (session) {
                        session.role = targetUserDoc.role;
                        session.joinedServers = [...joinedServers];
                    }

                    targetSessions.push({ live, session });
                }

                const liveSessionIds = new Set(targetSessions.map(({ live }) => live.id));
                for (const [id, session] of onlineUsersMap.entries()) {
                    if (String(session?.username || '').trim().toLowerCase() !== normalizedTarget) continue;
                    session.role = targetUserDoc.role;
                    session.joinedServers = [...joinedServers];
                    if (!liveSessionIds.has(id) && targetUserDoc.role !== 'admin' && session.serverCode && session.serverCode !== 'global' && !joinedServers.includes(session.serverCode)) {
                        session.serverCode = 'global';
                    }
                }

                for (const { live, session } of targetSessions) {
                    const activeRoom = live.serverCode || session?.serverCode;
                    let wasEvicted = false;
                    if (targetUserDoc.role !== 'admin' && activeRoom && activeRoom !== 'global' && !joinedServers.includes(activeRoom)) {
                        roleSyncFailed = !(await evictLiveSocket(live, session, activeRoom)) || roleSyncFailed;
                        wasEvicted = true;
                    }

                    try {
                        live.emit('global_role_updated', { username: targetUser, role: targetUserDoc.role });
                        if (wasEvicted) {
                            live.emit('room_access_updated', {
                                username: targetUser,
                                joinedServers: [...joinedServers],
                                serverCode: 'global'
                            });
                        }
                    } catch (err) {
                        roleSyncFailed = true;
                        logUnexpectedError(logger, 'manage_role_notification', err);
                    }
                }

                ioInstance.emit('system_message', `${socket.displayName} ${action === 'promote_global_admin' ? 'promoted' : 'demoted'} ${targetDisp} ${action === 'promote_global_admin' ? 'to' : 'from'} Global Admin.`);
                const roomsToUpdate = new Set(targetUserDoc.servers); roomsToUpdate.add('global');
                roomsToUpdate.forEach(c => broadcastOnlineUsersFn(c));

                return roleSyncFailed ? { error: 'Failed to manage role.' } : { success: true };
            });
            return callback(result);
        }

        // Manage Room Moderators
        const targetUserDoc = await UserModel.findOne({ username: targetUser });
        if (!targetUserDoc) return callback({ error: 'User not found.' });
        const targetDisp = targetUserDoc.displayName || targetUserDoc.username;
        const serverCode = normalizeServerCode(data.serverCode);
        if (!serverCode || serverCode === 'global') return callback({ error: 'Invalid input format.' });
        if (serverCode) {
            const srv = await ChatServerModel.findOne({ code: serverCode });
            if (!srv) return callback({ error: 'Server not found.' });

            const isRoomMod = Array.isArray(srv.moderators) && srv.moderators.includes(socket.username);

            if (action === 'promote_mod') {
                if (!isGlobalAdmin) {
                    const actor = await UserModel.findOne({ username: socket.username });
                    const isCurrentMember = Array.isArray(actor?.servers) && actor.servers.includes(serverCode) &&
                        Array.isArray(socket.joinedServers) && socket.joinedServers.includes(serverCode);
                    if (!isRoomMod || !isCurrentMember) return callback({ error: 'Permission denied.' });
                }
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
        callback({ error: 'Invalid input format.' });
    } catch (err) {
        logUnexpectedError(logger, 'manage_role', err);
        callback({ error: 'Failed to manage role.' });
    }
  });

  socket.on('create_server', async (name, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const cleanName = normalizeServerName(name);
    if (!cleanName) return callback({ error: 'Invalid input format.' });
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
      await withAccountTransitionLock(socket.username, async () => {
        const user = await UserModel.findOne({ username: socket.username });
        if (!user) throw new Error('User not found.');
        if (!Array.isArray(user.servers) || user.servers.length === 0) user.servers = ['global'];

        if (!user.servers.includes(srv.code)) {
          if (typeof user.servers.addToSet === 'function') user.servers.addToSet(srv.code);
          else user.servers.push(srv.code);
          await user.save();

          let sockets = [socket];
          try {
            sockets = await fetchLiveSockets();
          } catch (err) {
            logUnexpectedError(logger, 'create_server_membership_sync', err);
          }
          const bannedRooms = new Set(Array.isArray(socket.bannedRooms) ? socket.bannedRooms : []);
          await synchronizeMembership(sockets, socket.username, user.servers.filter(code => !bannedRooms.has(code)));
          broadcastOnlineUsersFn(srv.code);
        }
      });
      callback({ success: true, server: srv });
      
      try {
        const sockets = await ioInstance.fetchSockets();
        sockets.forEach(s => { if (onlineUsersMap.has(s.id) && onlineUsersMap.get(s.id).role === 'admin') s.emit('admin_new_server', srv); });
      } catch (err) {
        logUnexpectedError(logger, 'create_server_admin_notification', err);
      }
    } catch (err) {
      logUnexpectedError(logger, 'create_server', err);
      callback({ error: 'Creation failed.' });
    }
  });

  socket.on('join_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode) return callback({ error: 'Invalid input format.' });
    try {
      const result = await withAccountTransitionLock(socket.username, async () => {
        return withRoomMutationLock(serverCode, async () => {
          const srv = await ChatServerModel.findOne({ code: serverCode });
          if (!srv) return { error: 'Invalid invite code.' };

          const [user, restriction] = await Promise.all([
            findUserByUsername(UserModel, socket.username),
            getActiveRoomRestriction(RoomRestrictionModel, serverCode, socket.username)
          ]);
          if (!user) return { error: 'User not found.' };
          if (restriction.banned) return { error: 'Permission denied.' };
          if (!Array.isArray(user.servers) || user.servers.length === 0) user.servers = ['global'];
          if (!user.servers.includes(srv.code)) {
            if (typeof user.servers.addToSet === 'function') user.servers.addToSet(srv.code);
            else user.servers.push(srv.code);
            await user.save();

            let sockets = [socket];
            try {
              sockets = await fetchLiveSockets();
            } catch (err) {
              logUnexpectedError(logger, 'join_server_membership_sync', err);
            }
            const bannedRooms = new Set(Array.isArray(socket.bannedRooms) ? socket.bannedRooms : []);
            await synchronizeMembership(sockets, socket.username, user.servers.filter(code => !bannedRooms.has(code)));

            broadcastOnlineUsersFn(srv.code);

            if (socket.serverCode === srv.code) {
                socket.to(srv.code).emit('system_message', `${socket.displayName} joined.`);
            }
          }
          return { success: true, server: srv };
        });
      });
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'join_server', err);
      callback({ error: 'Join failed.' });
    }
  });

  socket.on('leave_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode) return callback({ error: 'Invalid input format.' });
    if (serverCode === 'global') return callback({ error: 'Cannot leave global.' });
    try {
      const result = await withAccountTransitionLock(socket.username, async () => {
        const user = await UserModel.findOne({ username: socket.username });
        if (!user) return { error: 'User not found.' };
        const isMember = Array.isArray(user.servers) && user.servers.includes(serverCode);
        const wasActive = socket.serverCode === serverCode;
        if (isMember) {
          user.servers = user.servers.filter(s => s !== serverCode);
          await user.save();
        }

        const sockets = await fetchLiveSockets();
        if (wasActive) {
            socket.to(serverCode).emit('system_message', `${socket.displayName} left the server.`);
        }
        const transportSynchronized = await synchronizeMembership(sockets, socket.username, user.servers, serverCode);

        let cleanupFailed = !transportSynchronized;
        if (isMember) {
          try {
            await ChatServerModel.updateOne({ code: serverCode }, { $pull: { moderators: socket.username } });
          } catch (err) {
            cleanupFailed = true;
            logUnexpectedError(logger, 'leave_server_moderator_cleanup', err);
          }
        }
        if (isMember || wasActive) {
          broadcastOnlineUsersFn(serverCode);
        }
        if (wasActive) {
          broadcastOnlineUsersFn('global');
        }
        return cleanupFailed ? { error: 'Failed to leave.' } : { success: true };
      });
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'leave_server', err);
      callback({ error: 'Failed to leave.' });
    }
  });

  socket.on('delete_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode) return callback({ error: 'Invalid input format.' });
    if (serverCode === 'global') return callback({ error: 'Cannot delete global.' });
    try {
      const result = await withRoomMutationLock(serverCode, async () => {
        const currentRoom = await ChatServerModel.findOne({ code: serverCode });
        if (!currentRoom) return { error: 'Server not found.' };
        if (socket.role !== 'admin' && currentRoom.owner !== socket.username) return { error: 'Permission denied.' };

        const sockets = await fetchLiveSockets();
        await ChatServerModel.deleteOne({ code: serverCode });

        let cleanupFailed = false;
        const affectedSockets = [];
        for (const live of sockets) {
          const session = onlineUsersMap.get(live.id);
          const currentMemberships = Array.isArray(live.joinedServers)
            ? live.joinedServers
            : (Array.isArray(session?.joinedServers) ? session.joinedServers : ['global']);
          const hadMembership = currentMemberships.includes(serverCode);
          const nextMemberships = currentMemberships.filter(roomCode => roomCode !== serverCode);
          if (!nextMemberships.includes('global')) nextMemberships.unshift('global');
          live.joinedServers = [...nextMemberships];
          if (session) session.joinedServers = [...nextMemberships];

          affectedSockets.push({ live, session, hadMembership, nextMemberships });
        }

        for (const { live, session, hadMembership, nextMemberships } of affectedSockets) {
          const activeRoom = live.serverCode || session?.serverCode;
          cleanupFailed = !(await evictLiveSocket(live, session, serverCode)) || cleanupFailed;
          if (hadMembership || activeRoom === serverCode) {
            try {
              live.emit('room_access_updated', {
                username: live.username || session?.username,
                joinedServers: [...nextMemberships],
                serverCode: live.serverCode || session?.serverCode || 'global'
              });
            } catch (err) {
              cleanupFailed = true;
              logUnexpectedError(logger, 'delete_server_access_notification', err);
            }
          }
        }

        try {
          ioInstance.emit('server_deleted', serverCode);
        } catch (err) {
          cleanupFailed = true;
          logUnexpectedError(logger, 'delete_server_notification', err);
        }
        try {
          await MessageModel.deleteMany({ serverCode });
        } catch (err) {
          cleanupFailed = true;
          logUnexpectedError(logger, 'delete_server_message_cleanup', err);
        }
        try {
          await UserModel.updateMany({}, { $pull: { servers: serverCode } });
        } catch (err) {
          cleanupFailed = true;
          logUnexpectedError(logger, 'delete_server_membership_cleanup', err);
        }
        broadcastOnlineUsersFn('global');
        return cleanupFailed ? { error: 'Deletion failed.' } : { success: true };
      });
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'delete_server', err);
      callback({ error: 'Deletion failed.' });
    }
  });

  socket.on('switch_server', async (code, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    const serverCode = normalizeServerCode(code);
    if (!serverCode) return callback({ error: 'Invalid input format.' });

    let safeHistory;
    let roomRole;
    try {
      const access = await loadRoomAccessState({
        UserModel, ChatServerModel, RoomRestrictionModel,
        username: socket.username, serverCode
      });
      if (!access.room) return callback({ error: 'Server not found.' });
      if (!access.allowed || !canAccessRoom(socket, serverCode)) return callback({ error: 'Permission denied.' });

      let query = { serverCode };
      if (serverCode === 'global') query = { $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] };

      roomRole = await getRoomRoleFn(serverCode, socket.username);
      const history = await MessageModel.find(query).sort({ timestamp: -1 }).limit(100).lean();

      safeHistory = history.map(storedMessage => {
          const msg = { ...storedMessage, attachment: sanitizeAttachment(storedMessage.attachment) };
          if (msg.deleted && msg.username !== socket.username && socket.role !== 'admin' && roomRole !== 'mod') {
              msg.text = ''; msg.attachment = null; msg.reactions = {};
          }
          if (!msg.reactions) msg.reactions = {};
          return msg;
      }).reverse();
    } catch (err) {
      logUnexpectedError(logger, 'switch_server_history', err);
      return callback({ error: 'Failed to switch server.' });
    }

    let result;
    try {
      result = await withAccountTransitionLock(socket.username, () => withRoomMutationLock(serverCode, async () => {
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel,
          username: socket.username, serverCode
        });
        if (!access.room) return { error: 'Server not found.' };
        if (!access.allowed || !canAccessRoom(socket, serverCode)) return { error: 'Permission denied.' };

        const oldCode = socket.serverCode;
        const session = onlineUsersMap.get(socket.id);
        try {
          if (oldCode && oldCode !== serverCode) await Promise.resolve(socket.leave(oldCode));
          await Promise.resolve(socket.join(serverCode));
        } catch (err) {
          terminallyClosed = true;
          socket.username = null;
          socket.displayName = null;
          socket.role = null;
          socket.joinedServers = [];
          socket.serverCode = null;
          if (session) {
            session.username = null;
            session.displayName = null;
            session.role = null;
            session.joinedServers = [];
            session.serverCode = null;
          }
          onlineUsersMap.delete(socket.id);
          suppressDisconnectPresence = true;
          for (const roomCode of new Set([serverCode, oldCode].filter(Boolean))) {
            try {
              await Promise.resolve(socket.leave(roomCode));
            } catch (leaveError) {
              logUnexpectedError(logger, 'switch_server_failure_leave', leaveError);
            }
          }
          try {
            await Promise.resolve(socket.disconnect(true));
          } catch (disconnectError) {
            logUnexpectedError(logger, 'switch_server_failure_disconnect', disconnectError);
          }
          throw err;
        }
        socket.serverCode = serverCode;
        if (session) session.serverCode = serverCode;
        return { success: true, oldCode, restriction: access.restriction };
      }));
    } catch (err) {
      logUnexpectedError(logger, 'switch_server_recheck', err);
      return callback({ error: 'Failed to switch server.' });
    }
    if (result.error) return callback(result);

    callback({
      history: safeHistory,
      roomRole,
      restriction: {
        banned: result.restriction.banned,
        timedOut: result.restriction.timedOut,
        timeoutUntil: result.restriction.timeoutUntil
      }
    });

    const broadcastCodes = [];
    if (result.oldCode && result.oldCode !== serverCode) broadcastCodes.push(result.oldCode);
    broadcastCodes.push(serverCode, 'global');
    [...new Set(broadcastCodes)].forEach(broadcastCode => {
      try {
        Promise.resolve(broadcastOnlineUsersFn(broadcastCode)).catch(err => {
          logUnexpectedError(logger, 'switch_server_presence_broadcast', err);
        });
      } catch (err) {
        logUnexpectedError(logger, 'switch_server_presence_broadcast', err);
      }
    });
  });

  socket.on('chat_message', async (payload) => {
    try {
      const serverCode = socket.serverCode;
      const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
      if (!socket.username || !serverCode || !canAccessRoom(identity, serverCode)) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.text !== 'string') return;
      if (!isValidAttachment(payload.attachment)) return;

      const now = Date.now();
      if (socket.role !== 'admin' && now - lastMessageTime < 500) {
        return socket.emit('system_message', '⚠️ Slow down! You are sending messages too fast.');
      }
      lastMessageTime = now;

      const attachment = sanitizeAttachment(payload.attachment);
      let cleanText = payload.text.trim().substring(0, 2000);
      if (!cleanText && !attachment) return;

      let replyTo = null;
      if (payload.replyTo && typeof payload.replyTo === 'object' && isValidObjectId(payload.replyTo.id)) {
        const referenced = await MessageModel.findById(payload.replyTo.id);
        if (referenced && !referenced.deleted && referenced.serverCode === serverCode) {
          replyTo = createReplySnapshot(referenced);
        }
      }

      const roomRole = await getRoomRoleFn(serverCode, socket.username);
      cleanText = neutralizePingTokens(cleanText);
      cleanText = await resolvePingsFn(cleanText, serverCode, socket.role, roomRole, socket.username);
      if (typeof cleanText !== 'string' || cleanText.length > 2000) return;

      await withRoomMutationLock(serverCode, async () => {
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel,
          username: socket.username, serverCode
        });
        if (!access.allowed || access.restriction.timedOut || !canAccessRoom(socket, serverCode)) return;

        const msg = await MessageModel.create({
            serverCode, username: socket.username, displayName: socket.displayName,
            role: socket.role, roomRole: roomRole, color: socket.color, avatarUrl: socket.avatarUrl,
            text: cleanText, attachment, replyTo, reactions: {}
        });

        ioInstance.to(msg.serverCode || serverCode).emit('chat_message', {
            _id: msg._id, username: msg.username, displayName: msg.displayName, role: msg.role, roomRole: msg.roomRole, color: msg.color, avatarUrl: msg.avatarUrl,
            text: msg.text, attachment: sanitizeAttachment(msg.attachment), replyTo: msg.replyTo, reactions: {}, timestamp: msg.timestamp, edited: false, deleted: false
        });
      });
    } catch (err) {
      logUnexpectedError(logger, 'chat_message', err);
    }
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
          await withRoomMutationLock(msg.serverCode, async () => {
            const access = await loadRoomAccessState({
              UserModel, ChatServerModel, RoomRestrictionModel,
              username: socket.username, serverCode: msg.serverCode
            });
            if (msg.deleted || !access.allowed || access.restriction.timedOut || !canAccessRoom(socket, msg.serverCode)) return;

            let rx = msg.reactions || {};
            let users = Array.isArray(rx[emoji]) ? rx[emoji] : [];

            if (users.includes(socket.username)) {
                users = users.filter(u => u !== socket.username);
                if (users.length === 0) delete rx[emoji];
                else rx[emoji] = users;
            } else {
                const reactionKeys = Object.keys(rx);
                if (!Object.prototype.hasOwnProperty.call(rx, emoji) && reactionKeys.length >= MAX_REACTION_KEYS) return;
                if (users.length >= MAX_REACTION_USERS) return;
                const reactionsByUser = Object.values(rx).filter(reactionUsers =>
                  Array.isArray(reactionUsers) && reactionUsers.includes(socket.username)
                ).length;
                if (reactionsByUser >= MAX_REACTIONS_PER_USER) return;
                users.push(socket.username);
                rx[emoji] = users;
            }

            msg.reactions = rx;
            msg.markModified('reactions');
            await msg.save();

            ioInstance.to(msg.serverCode).emit('reaction_updated', { id: msg._id, reactions: msg.reactions });
          });
      } catch (err) {
          logUnexpectedError(logger, 'toggle_reaction', err);
      }
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
          
          cleanText = neutralizePingTokens(cleanText);
          cleanText = await resolvePingsFn(cleanText, msg.serverCode, socket.role, roomRole, socket.username);
          if (typeof cleanText !== 'string' || cleanText.length > 2000) return;
          await withRoomMutationLock(msg.serverCode, async () => {
            const access = await loadRoomAccessState({
              UserModel, ChatServerModel, RoomRestrictionModel,
              username: socket.username, serverCode: msg.serverCode
            });
            if (msg.deleted || !access.allowed || access.restriction.timedOut || !canAccessRoom(socket, msg.serverCode)) return;
            const currentRoomRole = await getRoomRoleFn(msg.serverCode, socket.username);
            if (msg.username !== socket.username && socket.role !== 'admin' && currentRoomRole !== 'mod') return;

            if (msg.text !== cleanText) {
                msg.history = appendBoundedHistory(msg.history, { text: msg.text, timestamp: new Date() });
                msg.text = cleanText; msg.edited = true; msg.markModified('history');
                await msg.save();
                ioInstance.to(msg.serverCode).emit('message_edited', { id: msg._id, username: msg.username, role: msg.role, roomRole: msg.roomRole, text: cleanText });
            }
          });
        }
      }
    } catch (err) {
      logUnexpectedError(logger, 'edit_message', err);
    }
  });

  socket.on('delete_message', async (msgId) => {
    try {
      if (!socket.username || !isValidObjectId(msgId)) return;
      const msg = await MessageModel.findById(msgId);
      if (msg && !msg.deleted) {
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (!canAccessRoom(identity, msg.serverCode)) return;
        await withRoomMutationLock(msg.serverCode, async () => {
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel,
            username: socket.username, serverCode: msg.serverCode
          });
          if (msg.deleted || !access.allowed || !canAccessRoom(socket, msg.serverCode)) return;
          if (access.restriction.timedOut && msg.username !== socket.username) return;
          const roomRole = await getRoomRoleFn(msg.serverCode, socket.username);

          // Sender, SysAdmin, or RoomMod can delete it
          if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
            msg.deleted = true; await msg.save();
            ioInstance.to(msg.serverCode).emit('message_deleted', msgId);
          }
        });
      }
    } catch (err) {
      logUnexpectedError(logger, 'delete_message', err);
    }
  });

  socket.on('get_edit_history', async (msgId, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    try {
      if (!isValidObjectId(msgId)) return callback({ error: 'Invalid input format.' });
      const msg = await MessageModel.findById(msgId);
      if (msg) {
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (!canAccessRoom(identity, msg.serverCode)) return callback({ error: 'Permission denied.' });
        const restriction = await getActiveRoomRestriction(RoomRestrictionModel, msg.serverCode, socket.username);
        if (restriction.banned) return callback({ error: 'Permission denied.' });
        if (!(await roomExists(msg.serverCode))) return callback({ error: 'Permission denied.' });
        const roomRole = await getRoomRoleFn(msg.serverCode, socket.username);
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
            return callback({ success: true, history: (Array.isArray(msg.history) ? msg.history : []).slice(-20) });
        }
      }
      callback({ error: 'Permission denied.' });
    } catch (err) {
      logUnexpectedError(logger, 'get_edit_history', err);
      callback({ error: 'Failed to load history.' });
    }
  });

  socket.on('get_deleted_message', async (msgId, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    try {
      if (!isValidObjectId(msgId)) return callback({ error: 'Invalid input format.' });
      const msg = await MessageModel.findById(msgId);
      if (msg && msg.deleted) {
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (!canAccessRoom(identity, msg.serverCode)) return callback({ error: 'Permission denied.' });
        const restriction = await getActiveRoomRestriction(RoomRestrictionModel, msg.serverCode, socket.username);
        if (restriction.banned) return callback({ error: 'Permission denied.' });
        if (!(await roomExists(msg.serverCode))) return callback({ error: 'Permission denied.' });
        const roomRole = await getRoomRoleFn(msg.serverCode, socket.username);
        if (msg.username === socket.username || socket.role === 'admin' || roomRole === 'mod') {
            return callback({ success: true, text: msg.text, attachment: sanitizeAttachment(msg.attachment) });
        }
      }
      callback({ error: 'Permission denied.' });
    } catch (err) {
      logUnexpectedError(logger, 'get_deleted_message', err);
      callback({ error: 'Failed to load deleted message.' });
    }
  });

  socket.on('typing', async (isTyping) => {
    try {
      const serverCode = socket.serverCode;
      const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
      if (!socket.username || !serverCode || typeof isTyping !== 'boolean' || !canAccessRoom(identity, serverCode)) return;
      await withRoomMutationLock(serverCode, async () => {
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel,
          username: socket.username, serverCode
        });
        if (!access.allowed || access.restriction.timedOut || !canAccessRoom(socket, serverCode)) return;
        socket.to(serverCode).emit('typing', {
          username: socket.username,
          displayName: socket.displayName || socket.username,
          isTyping
        });
      });
    } catch (err) {
      logUnexpectedError(logger, 'typing', err);
    }
  });

  socket.on('disconnect', () => {
    if (suppressDisconnectPresence) {
      onlineUsersMap.delete(socket.id);
      return;
    }
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

async function start({
  mongoUri = MONGO_URI,
  mongooseImpl = mongoose,
  seedSystemFn = seedSystem,
  serverInstance = server,
  port = PORT,
  logger = console
} = {}) {
  if (!mongoUri) throw new Error('MONGO_URI is required before server startup.');
  await mongooseImpl.connect(mongoUri);
  await seedSystemFn();
  return new Promise(resolve => {
    serverInstance.listen(port, () => {
      if (logger && typeof logger.log === 'function') logger.log(`🚀 Server on port ${port}`);
      resolve(serverInstance);
    });
  });
}

if (require.main === module) {
  start().catch(err => {
    logUnexpectedError(console, 'startup', err);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  server,
  start,
  seedSystem,
  createConnectionHandler,
  withAccountTransitionLock,
  withAccountTransitionLocks,
  safeAck,
  normalizeUsername,
  normalizeDisplayName,
  normalizeServerName,
  normalizeServerCode,
  normalizeModerationAction,
  normalizeModerationReason,
  normalizeAutoModSettings,
  normalizeAccountKey,
  findUserByUsername,
  canModerateTarget,
  activeRestrictionState,
  getActiveRoomRestriction,
  chooseAccessibleRoom,
  loadRoomAccessState,
  rejectAuditMutation,
  MODERATION_DURATIONS,
  RoomRestriction,
  ModerationAudit,
  ModerationReport,
  isValidPassword,
  normalizeColor,
  normalizeAvatarUrl,
  isValidAttachment,
  sanitizeAttachment,
  isValidReaction,
  isValidObjectId,
  neutralizePingTokens,
  normalizeTransportAddress,
  createRateLimiter,
  canAccessRoom,
  appendBoundedHistory,
  createReplySnapshot
};
