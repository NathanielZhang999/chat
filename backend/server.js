const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { createHash } = require('node:crypto');

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
const MAX_AUTOMOD_KEYS = 10_000;
const DEFAULT_AUTOMOD_MESSAGE_LIMIT = 5;
const DEFAULT_AUTOMOD_MESSAGE_WINDOW_SECONDS = 5;
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRoomText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim();
  return normalized.length <= maxLength ? normalized : null;
}

function normalizeNotificationLevel(value) {
  return ['all', 'mentions', 'none'].includes(value) ? value : null;
}

function authorKeyForMessage(message) {
  const direct = normalizeAccountKey(message && message.authorKey);
  if (direct && normalizeUsername(direct)) return direct;
  const legacy = normalizeUsername(message && message.username);
  return legacy ? normalizeAccountKey(legacy) : null;
}

function extractNotificationMentions(text) {
  if (typeof text !== 'string') return [];
  const mentions = [];
  const seen = new Set();
  const tokenPattern = /\{\{PING:([^|{}]{1,20})\|([^|{}]{1,30})\}\}/g;
  for (const match of text.matchAll(tokenPattern)) {
    const [, usernameValue, displayValue] = match;
    if (usernameValue === 'everyone' && displayValue === 'everyone') {
      if (!seen.has('*')) {
        seen.add('*');
        mentions.push('*');
      }
      continue;
    }
    const username = normalizeUsername(usernameValue);
    const displayName = normalizeDisplayName(displayValue);
    if (!username || username !== usernameValue || !displayName || displayName !== displayValue) continue;
    const key = normalizeAccountKey(username);
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push(key);
    }
  }
  return mentions;
}

function isNotificationMention(message, usernameKey) {
  const readerKey = normalizeAccountKey(usernameKey);
  if (!readerKey || !normalizeUsername(readerKey) || !Array.isArray(message?.notificationMentions)) {
    return false;
  }
  return message.notificationMentions.some(value => {
    if (value === '*') return true;
    return typeof value === 'string' && value === readerKey && normalizeUsername(value) === value;
  });
}

function roomMessageQuery(serverCode) {
  return serverCode === 'global'
    ? { $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] }
    : { serverCode };
}

async function newestRoomMessage(MessageModel, serverCode, { session = null } = {}) {
  const query = MessageModel.find(roomMessageQuery(serverCode))
    .sort({ timestamp: -1, _id: -1 })
    .limit(1);
  const rows = await applyQuerySession(query, session);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function cursorFromMessage(message) {
  if (!message || !isValidObjectId(String(message._id))) return null;
  const lastReadAt = new Date(message.timestamp);
  if (Number.isNaN(lastReadAt.getTime())) return null;
  return { lastReadAt, lastReadMessageId: String(message._id) };
}

function compareCursor(left, right) {
  const leftTime = left && left.lastReadAt instanceof Date ? left.lastReadAt.getTime() : NaN;
  const rightTime = right && right.lastReadAt instanceof Date ? right.lastReadAt.getTime() : NaN;
  const leftValid = !Number.isNaN(leftTime);
  const rightValid = !Number.isNaN(rightTime);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return -1;
  if (!rightValid) return 1;
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  const leftId = String(left.lastReadMessageId || '').toLowerCase();
  const rightId = String(right.lastReadMessageId || '').toLowerCase();
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function normalizedBlockedUserKeys(blockedUserKeys) {
  const values = blockedUserKeys instanceof Set || Array.isArray(blockedUserKeys) ? blockedUserKeys : [];
  const normalized = new Set();
  for (const value of values) {
    const key = normalizeAccountKey(value);
    if (key && normalizeUsername(key)) normalized.add(key);
  }
  return normalized;
}

function safeReplyForViewer(reply, blockedUserKeys = new Set()) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const blocked = normalizedBlockedUserKeys(blockedUserKeys);
  const authorKey = normalizeAccountKey(reply.authorKey);
  if (!authorKey || !normalizeUsername(authorKey)) return blocked.size === 0 ? {
    id: String(reply.id || ''), displayname: typeof reply.displayname === 'string' ? reply.displayname : '',
    text: typeof reply.text === 'string' ? reply.text : ''
  } : null;
  if (blocked.has(authorKey)) return null;
  return {
    id: String(reply.id || ''), authorKey,
    displayname: typeof reply.displayname === 'string' ? reply.displayname : '',
    text: typeof reply.text === 'string' ? reply.text : ''
  };
}

function safeReactionsForViewer(reactions, blockedUserKeys = new Set()) {
  const blocked = normalizedBlockedUserKeys(blockedUserKeys);
  const safe = {};
  if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return safe;
  for (const [reaction, users] of Object.entries(reactions)) {
    if (!Array.isArray(users)) continue;
    const allowed = users.filter(username => {
      const key = normalizeAccountKey(username);
      return key && normalizeUsername(key) && !blocked.has(key);
    });
    if (allowed.length > 0) Object.defineProperty(safe, reaction, {
      value: allowed, enumerable: true, configurable: true, writable: true
    });
  }
  return safe;
}

function safeMessageForViewer(message, { blockedUserKeys = new Set() } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const authorKey = authorKeyForMessage(message);
  if (!authorKey) return null;
  const blocked = normalizedBlockedUserKeys(blockedUserKeys);
  const username = normalizeUsername(message.username) || authorKey;
  if (blocked.has(authorKey)) {
    return {
      _id: message._id,
      serverCode: message.serverCode,
      username,
      authorKey,
      timestamp: message.timestamp,
      blocked: true
    };
  }
  const deleted = Boolean(message.deleted);
  return {
    _id: message._id,
    serverCode: message.serverCode,
    username,
    displayName: typeof message.displayName === 'string' ? message.displayName : '',
    authorKey,
    role: typeof message.role === 'string' ? message.role : 'user',
    roomRole: typeof message.roomRole === 'string' ? message.roomRole : 'user',
    color: typeof message.color === 'string' ? message.color : '',
    avatarUrl: typeof message.avatarUrl === 'string' ? message.avatarUrl : '',
    text: deleted ? '' : (typeof message.text === 'string' ? message.text : ''),
    attachment: deleted ? null : sanitizeAttachment(message.attachment),
    replyTo: deleted ? null : safeReplyForViewer(message.replyTo, blocked),
    reactions: deleted ? {} : safeReactionsForViewer(message.reactions, blocked),
    edited: Boolean(message.edited),
    deleted,
    timestamp: message.timestamp
  };
}

function safeBlockedMessageReveal(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const authorKey = authorKeyForMessage(message);
  if (!authorKey) return null;
  const deleted = Boolean(message.deleted);
  return {
    _id: message._id,
    serverCode: message.serverCode,
    username: normalizeUsername(message.username) || authorKey,
    displayName: typeof message.displayName === 'string' ? message.displayName : '',
    authorKey,
    timestamp: message.timestamp,
    text: deleted ? '' : (typeof message.text === 'string' ? message.text : ''),
    attachment: deleted ? null : sanitizeAttachment(message.attachment),
    edited: Boolean(message.edited),
    deleted
  };
}

function safeRoomDetails(room, canEdit) {
  return {
    serverCode: room && room.code,
    description: room && typeof room.description === 'string' ? room.description : '',
    rules: room && typeof room.rules === 'string' ? room.rules : '',
    metadataVersion: Number.isInteger(room && room.metadataVersion) && room.metadataVersion >= 0
      ? room.metadataVersion : 0,
    canEdit: Boolean(canEdit)
  };
}

function safeRoomState(row, counts = {}) {
  const countedThroughAt = counts.countedThroughAt ? new Date(counts.countedThroughAt) : null;
  const countedThroughMessageId = counts.countedThroughMessageId
    ? String(counts.countedThroughMessageId) : null;
  const hasCountedThrough = countedThroughAt && !Number.isNaN(countedThroughAt.getTime()) &&
    isValidObjectId(countedThroughMessageId);
  return {
    serverCode: row && row.serverCode,
    usernameKey: row && row.usernameKey,
    notificationLevel: normalizeNotificationLevel(row && row.notificationLevel) || 'all',
    lastReadAt: row && row.lastReadAt ? new Date(row.lastReadAt) : null,
    lastReadMessageId: row && row.lastReadMessageId ? String(row.lastReadMessageId) : null,
    unreadCount: Number.isInteger(counts.unreadCount) && counts.unreadCount >= 0 ? counts.unreadCount : 0,
    mentionCount: Number.isInteger(counts.mentionCount) && counts.mentionCount >= 0 ? counts.mentionCount : 0,
    version: Number.isInteger(row && row.version) && row.version >= 0 ? row.version : 0,
    blockVersion: Number.isInteger(counts.blockVersion) && counts.blockVersion >= 0 ? counts.blockVersion : 0,
    ...(hasCountedThrough ? { countedThroughAt, countedThroughMessageId } : {})
  };
}

function safeBlockState(row) {
  const blockedUsers = Array.isArray(row && row.blockedUsers) ? row.blockedUsers.reduce((safe, entry) => {
    const usernameKey = normalizeAccountKey(entry && entry.usernameKey);
    if (!usernameKey || !normalizeUsername(usernameKey)) return safe;
    safe.push({
      usernameKey,
      username: normalizeUsername(entry.username) || usernameKey
    });
    return safe;
  }, []) : [];
  return {
    blockedUsers,
    blockVersion: Number.isInteger(row && row.blockVersion) && row.blockVersion >= 0 ? row.blockVersion : 0
  };
}

function blockSetFromState(row) {
  return new Set(safeBlockState(row).blockedUsers.map(item => item.usernameKey));
}

function replaceAccountBlockCaches(sockets, usernameKey, state, onlineUsersMap = onlineUsers) {
  const accountKey = normalizeAccountKey(usernameKey);
  const safeState = safeBlockState(state);
  const blockedUsers = safeState.blockedUsers.map(item => item.usernameKey);
  for (const live of Array.isArray(sockets) ? sockets : []) {
    const session = onlineUsersMap.get(live.id);
    if (normalizeAccountKey(live.username || session?.username) !== accountKey) continue;
    live.blockedUserKeys = new Set(blockedUsers);
    live.blockVersion = safeState.blockVersion;
    if (session) {
      session.blockedUsers = [...blockedUsers];
      session.blockVersion = safeState.blockVersion;
    }
  }
}

function normalizeAutoModSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.blockedKeywords)) return null;
  const boundedIntegers = [
    ['mentionLimit', 1, 20],
    ['repeatLimit', 2, 10],
    ['repeatWindowSeconds', 5, 300],
    ['messageLimit', 1, 20],
    ['messageWindowSeconds', 1, 60]
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
    repeatWindowSeconds: value.repeatWindowSeconds,
    messageLimit: value.messageLimit,
    messageWindowSeconds: value.messageWindowSeconds
  };
}

function normalizeStoredAutoModSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeAutoModSettings({
    ...value,
    messageLimit: value.messageLimit === undefined ? DEFAULT_AUTOMOD_MESSAGE_LIMIT : value.messageLimit,
    messageWindowSeconds: value.messageWindowSeconds === undefined
      ? DEFAULT_AUTOMOD_MESSAGE_WINDOW_SECONDS
      : value.messageWindowSeconds
  });
}

function normalizeAutoModText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function createAutoModTracker({ maxKeys = MAX_AUTOMOD_KEYS, now = () => Date.now() } = {}) {
  const boundedMaxKeys = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : MAX_AUTOMOD_KEYS;
  const statesByAccountRoom = new Map();

  function pruneMessages(messages, currentTime, windowMs) {
    for (const [normalizedText, timestamps] of messages.entries()) {
      const recent = timestamps.filter(timestamp => currentTime - timestamp < windowMs);
      if (recent.length === 0) messages.delete(normalizedText);
      else messages.set(normalizedText, recent);
    }
  }

  function pruneState(state, currentTime, fallbackWindowMs = 0) {
    const repeatWindowMs = state.repeatWindowMs || fallbackWindowMs;
    if (repeatWindowMs) pruneMessages(state.repeatedTextTimestamps, currentTime, repeatWindowMs);
    const rateWindowMs = state.rateWindowMs || fallbackWindowMs;
    if (rateWindowMs) {
      state.acceptedMessageTimestamps = state.acceptedMessageTimestamps
        .filter(timestamp => currentTime - timestamp < rateWindowMs);
    }
    return state.repeatedTextTimestamps.size === 0 && state.acceptedMessageTimestamps.length === 0;
  }

  function prune(windowMs) {
    const currentTime = now();
    for (const [key, state] of statesByAccountRoom.entries()) {
      if (pruneState(state, currentTime, windowMs)) statesByAccountRoom.delete(key);
    }
  }

  function makeState() {
    return {
      repeatedTextTimestamps: new Map(),
      acceptedMessageTimestamps: [],
      rateWindowMs: 0,
      repeatWindowMs: 0,
      rateAuditRecorded: false
    };
  }

  function stateFor(key, currentTime, fallbackWindowMs) {
    let state = statesByAccountRoom.get(key);
    if (state && pruneState(state, currentTime, fallbackWindowMs)) {
      statesByAccountRoom.delete(key);
      state = null;
    }
    if (!state) {
      if (statesByAccountRoom.size >= boundedMaxKeys) prune(fallbackWindowMs);
      while (statesByAccountRoom.size >= boundedMaxKeys) {
        statesByAccountRoom.delete(statesByAccountRoom.keys().next().value);
      }
      state = makeState();
      statesByAccountRoom.set(key, state);
    }
    return state;
  }

  function recordAndCheck(key, normalizedText, limit, windowMs) {
    const currentTime = now();
    const state = stateFor(key, currentTime, windowMs);
    state.repeatWindowMs = windowMs;
    pruneMessages(state.repeatedTextTimestamps, currentTime, windowMs);
    const timestamps = state.repeatedTextTimestamps.get(normalizedText) || [];
    timestamps.push(currentTime);
    state.repeatedTextTimestamps.set(normalizedText, timestamps);
    return timestamps.length >= limit;
  }

  function recordMessageAttempt(key, limit, windowMs) {
    const currentTime = now();
    const state = stateFor(key, currentTime, windowMs);
    state.rateWindowMs = windowMs;
    state.acceptedMessageTimestamps = state.acceptedMessageTimestamps
      .filter(timestamp => currentTime - timestamp < windowMs);
    if (state.acceptedMessageTimestamps.length > limit) {
      state.acceptedMessageTimestamps = state.acceptedMessageTimestamps.slice(-limit);
    }
    if (state.acceptedMessageTimestamps.length >= limit) {
      const shouldAudit = !state.rateAuditRecorded;
      state.rateAuditRecorded = true;
      return { allowed: false, shouldAudit };
    }
    state.acceptedMessageTimestamps.push(currentTime);
    state.rateAuditRecorded = false;
    return { allowed: true, shouldAudit: false };
  }

  return {
    recordAndCheck,
    recordMessageAttempt,
    prune,
    size() { return statesByAccountRoom.size; },
    messageAttemptCount(key) {
      const state = statesByAccountRoom.get(key);
      return state ? state.acceptedMessageTimestamps.length : 0;
    },
    hasKey(key) { return statesByAccountRoom.has(key); }
  };
}

function evaluateAutoMod({ text, resolvedText, username, serverCode, role, settings, tracker }) {
  const normalizedRawText = normalizeAutoModText(text);
  if (role !== 'admin' && settings.blockedKeywords.some(keyword =>
    normalizedRawText.includes(normalizeAutoModText(keyword)))) {
    return { allowed: false, rule: 'blocked_keyword' };
  }

  const canonicalMentions = typeof resolvedText === 'string'
    ? resolvedText.match(/\{\{PING:[^}|]{1,20}\|[^}]{1,30}\}\}/g) || []
    : [];
  if (canonicalMentions.length > settings.mentionLimit) {
    return { allowed: false, rule: 'mention_limit' };
  }

  if (role !== 'admin') {
    const key = `${serverCode}\0${normalizeAccountKey(username)}`;
    const repeated = tracker.recordAndCheck(
      key,
      normalizedRawText,
      settings.repeatLimit,
      settings.repeatWindowSeconds * 1000
    );
    if (repeated) return { allowed: false, rule: 'repeat_message' };
  }

  return { allowed: true };
}

function evaluateMessageRate({ username, serverCode, settings, tracker }) {
  const key = `${serverCode}\0${normalizeAccountKey(username)}`;
  const result = tracker.recordMessageAttempt(
    key,
    settings.messageLimit,
    settings.messageWindowSeconds * 1000
  );
  return result.allowed
    ? { allowed: true }
    : { allowed: false, rule: 'message_rate', shouldAudit: result.shouldAudit };
}

const serverAutoModTracker = createAutoModTracker();
const DEFAULT_AUTOMOD_SETTINGS = Object.freeze({
  blockedKeywords: Object.freeze([]),
  mentionLimit: 8,
  repeatLimit: 3,
  repeatWindowSeconds: 30,
  messageLimit: DEFAULT_AUTOMOD_MESSAGE_LIMIT,
  messageWindowSeconds: DEFAULT_AUTOMOD_MESSAGE_WINDOW_SECONDS
});

function roomAutoModSettings(room) {
  const normalized = normalizeStoredAutoModSettings(room && room.autoMod);
  if (normalized) return normalized;
  return room && room.autoMod === undefined ? DEFAULT_AUTOMOD_SETTINGS : null;
}

function currentRoomRole(room, username) {
  return isCurrentRoomModerator(room, username) ? 'mod' : 'user';
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

function normalizeClientContextId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function encodeCursor(date, id) {
  return Buffer.from(JSON.stringify([new Date(date).toISOString(), String(id)]), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !isValidObjectId(parsed[1])) return null;
    const date = new Date(parsed[0]);
    return Number.isNaN(date.getTime()) ? null : { date, id: parsed[1] };
  } catch {
    return null;
  }
}

function normalizePageLimit(value) {
  if (value === undefined) return 20;
  if (!Number.isInteger(value)) return null;
  return Math.min(50, Math.max(1, value));
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
  const authorKey = authorKeyForMessage(message);
  if (!authorKey) return null;
  const text = typeof message.text === 'string' ? message.text.slice(0, 100) : '';
  return {
    id: String(message._id),
    authorKey,
    displayname: message.displayName || message.username,
    text: text || (message.attachment ? 'Image Attachment' : '')
  };
}

// --- SECURITY: REGEX ESCAPE ---
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

function applyQuerySession(query, session) {
  if (session && query && typeof query.session === 'function') return query.session(session);
  return query;
}

function sharedTransactionConnection(models) {
  const candidates = Array.isArray(models) ? models : [];
  if (candidates.length === 0) return null;
  const connection = candidates[0] && candidates[0].db;
  return connection && typeof connection.transaction === 'function' &&
    candidates.every(model => model && model.db === connection)
    ? connection
    : null;
}

function isUnsupportedTransactionTopologyError(error) {
  return Boolean(error && error.code === 20 &&
    String(error.message || '').includes(
      'Transaction numbers are only allowed on a replica set member or mongos'
    ));
}

async function runPersistence(operation, connection, { unsupportedTopologyFallback = null } = {}) {
  if (!connection) {
    return typeof unsupportedTopologyFallback === 'function'
      ? unsupportedTopologyFallback()
      : operation(null);
  }
  try {
    return await connection.transaction(session => operation(session));
  } catch (error) {
    // Code 20 with this server message rejects transaction topology before any write can commit.
    if (typeof unsupportedTopologyFallback === 'function' &&
        isUnsupportedTransactionTopologyError(error)) {
      return unsupportedTopologyFallback();
    }
    throw error;
  }
}

async function findUserByUsername(UserModel, value, { session = null } = {}) {
  const username = normalizeUsername(value);
  if (!username) return null;
  const escaped = escapeRegExp(username);
  return applyQuerySession(
    UserModel.findOne({ username: { $regex: new RegExp(`^${escaped}$`, 'i') } }),
    session
  );
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

function canEditRoomDetails({ serverCode, access }) {
  if (!access || !access.allowed || access.restriction?.banned || access.restriction?.timedOut ||
    !access.user || !access.room) return false;
  if (access.user.role === 'admin') return true;
  return serverCode !== 'global' && normalizeAccountKey(access.room.owner) === normalizeAccountKey(access.user.username);
}

function canManagePins({ serverCode, access }) {
  if (!access || !access.allowed || access.restriction?.banned || access.restriction?.timedOut ||
    !access.user || !access.room || access.room.code !== serverCode) return false;
  if (serverCode === 'global') return access.user.role === 'admin';
  return access.user.role === 'admin' ||
    normalizeAccountKey(access.room.owner) === normalizeAccountKey(access.user.username) ||
    isCurrentRoomModerator(access.room, access.user.username);
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

function applySessionAccessSnapshot({
  live,
  session,
  joinedServers,
  bannedRooms,
  removedRoom = null,
  fallbackCode = null
}) {
  const authoritativeMemberships = [...new Set(Array.isArray(joinedServers) ? joinedServers : [])];
  const activeBannedRooms = [...new Set(Array.isArray(bannedRooms) ? bannedRooms : [])];
  const activeRoom = live?.serverCode ?? session?.serverCode ?? null;
  if (live) {
    live.joinedServers = [...authoritativeMemberships];
    live.bannedRooms = [...activeBannedRooms];
  }
  if (session) {
    session.joinedServers = [...authoritativeMemberships];
    session.bannedRooms = [...activeBannedRooms];
  }
  if (removedRoom && activeRoom === removedRoom) {
    if (live) live.serverCode = fallbackCode;
    if (session) session.serverCode = fallbackCode;
  }
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

const PinnedMessageSchema = new mongoose.Schema({
  messageId: { type: mongoose.Schema.Types.ObjectId, required: true },
  pinnedAt: { type: Date, required: true },
  pinnedBy: { type: String, required: true, maxLength: 20 }
}, { _id: false });

const ChatServerSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true, maxLength: 30 },
  owner: { type: String, required: true },
  moderators: { type: [String], default: [] },
  description: { type: String, default: '', maxLength: 500 },
  rules: { type: String, default: '', maxLength: 2000 },
  metadataVersion: { type: Number, default: 0, min: 0 },
  pinnedMessages: {
    type: [PinnedMessageSchema], default: [],
    validate: { validator: value => Array.isArray(value) && value.length <= 20 }
  },
  pinVersion: { type: Number, default: 0, min: 0 },
  autoMod: {
    blockedKeywords: {
      type: [{ type: String, maxLength: 40 }],
      default: [],
      validate: value => Array.isArray(value) && value.length <= 50
    },
    mentionLimit: { type: Number, min: 1, max: 20, default: 8 },
    repeatLimit: { type: Number, min: 2, max: 10, default: 3 },
    repeatWindowSeconds: { type: Number, min: 5, max: 300, default: 30 },
    messageLimit: { type: Number, min: 1, max: 20, default: 5 },
    messageWindowSeconds: { type: Number, min: 1, max: 60, default: 5 }
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
ModerationAuditSchema.pre('findOneAndReplace', rejectAuditMutation);
ModerationAuditSchema.pre('replaceOne', rejectAuditMutation);
ModerationAuditSchema.pre('deleteOne', rejectAuditMutation);
ModerationAuditSchema.pre('deleteMany', rejectAuditMutation);
ModerationAuditSchema.pre('findOneAndDelete', rejectAuditMutation);
ModerationAuditSchema.pre('bulkWrite', rejectAuditMutation);
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

const ReplySnapshotSchema = new mongoose.Schema({
  id: { type: String, required: true, maxLength: 24 },
  authorKey: { type: String, default: '', maxLength: 20, immutable: true },
  displayname: { type: String, required: true, maxLength: 30 },
  text: { type: String, required: true, maxLength: 100 }
}, { _id: false });

const MessageSchema = new mongoose.Schema({
  serverCode: { type: String, required: true, default: 'global' },
  username: String,
  displayName: { type: String, default: '' },
  authorKey: { type: String, default: '', maxLength: 20, immutable: true },
  notificationMentions: { type: [String], default: [], immutable: true },
  role: { type: String, default: 'user' }, 
  roomRole: { type: String, default: 'user' },
  color: { type: String, default: '' },      
  avatarUrl: { type: String, default: '' },  
  text: { type: String, default: '' },
  attachment: { type: String, default: null },
  replyTo: { type: ReplySnapshotSchema, default: null },
  reactions: { type: Object, default: {} }, 
  edited: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  history: [{ text: String, timestamp: Date }], 
  timestamp: { type: Date, default: Date.now }
});
MessageSchema.index({ serverCode: 1, timestamp: -1, _id: -1 });
const Message = mongoose.model('Message', MessageSchema);

const RoomMemberStateSchema = new mongoose.Schema({
  usernameKey: { type: String, required: true, maxLength: 20 },
  serverCode: { type: String, required: true, maxLength: 6 },
  notificationLevel: { type: String, enum: ['all', 'mentions', 'none'], default: 'all' },
  lastReadAt: { type: Date, default: null },
  lastReadMessageId: { type: String, default: null, maxLength: 24 },
  version: { type: Number, default: 0, min: 0 }
}, { timestamps: true });
RoomMemberStateSchema.index({ usernameKey: 1, serverCode: 1 }, { unique: true });
RoomMemberStateSchema.index({ serverCode: 1, usernameKey: 1 });
const RoomMemberState = mongoose.model('RoomMemberState', RoomMemberStateSchema);

const BlockedUserSchema = new mongoose.Schema({
  usernameKey: { type: String, required: true, maxLength: 20 },
  username: { type: String, required: true, maxLength: 20 },
  createdAt: { type: Date, required: true }
}, { _id: false });

const UserExperienceStateSchema = new mongoose.Schema({
  usernameKey: { type: String, required: true, maxLength: 20 },
  blockedUsers: {
    type: [BlockedUserSchema], default: [],
    validate: { validator: value => Array.isArray(value) && value.length <= 500 }
  },
  blockVersion: { type: Number, default: 0, min: 0 }
}, { timestamps: true });
UserExperienceStateSchema.index({ usernameKey: 1 }, { unique: true });
const UserExperienceState = mongoose.model('UserExperienceState', UserExperienceStateSchema);

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
  RoomMemberStateModel = RoomMemberState,
  UserExperienceStateModel = UserExperienceState,
  bcryptImpl = bcrypt,
  onlineUsersMap = onlineUsers,
  broadcastOnlineUsersFn = broadcastOnlineUsers,
  getRoomRoleFn = getRoomRole,
  resolvePingsFn = resolvePings,
  rateLimiter = authRateLimiter,
  autoModTracker = serverAutoModTracker,
  logger = console
} = {}) {
  return socket => {
  socket.serverCode = null;
  socket.joinedServers = [];
  
  let suppressDisconnectPresence = false;
  let terminallyClosed = false;

  async function fetchLiveSockets() {
    const fetched = await ioInstance.fetchSockets();
    const byId = new Map((Array.isArray(fetched) ? fetched : []).map(live => [live.id, live]));
    byId.set(socket.id, socket);
    return [...byId.values()];
  }

  async function ensureBlockState(usernameKey, { session = null } = {}) {
    const key = normalizeAccountKey(usernameKey);
    let row = await applyQuerySession(UserExperienceStateModel.findOne({ usernameKey: key }), session);
    if (!row) {
      try {
        row = await UserExperienceStateModel.findOneAndUpdate(
          { usernameKey: key },
          { $setOnInsert: { usernameKey: key, blockedUsers: [], blockVersion: 0 } },
          { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) }
        );
      } catch (err) {
        if (!err || err.code !== 11000) throw err;
      }
    }
    if (!row) row = await applyQuerySession(UserExperienceStateModel.findOne({ usernameKey: key }), session);
    if (!row) throw new Error('Block state initialization failed.');
    return safeBlockState(row);
  }

  async function loadDurableBlockState(usernameKey, { session = null } = {}) {
    const snapshot = await ensureBlockState(usernameKey, { session });
    const blockedUserKeys = blockSetFromState(snapshot);
    blockedUserKeys.blockVersion = snapshot.blockVersion;
    return { snapshot, blockedUserKeys };
  }

  async function countRoomAttention({ usernameKey, serverCode, cursor, blockedUserKeys } = {}) {
    const readerKey = normalizeAccountKey(usernameKey);
    const canonicalRoom = normalizeServerCode(serverCode);
    if (!readerKey || !normalizeUsername(readerKey) || !canonicalRoom) {
      return { unreadCount: 0, mentionCount: 0 };
    }
    const newer = cursor && cursor.lastReadAt
      ? { $or: [
        { timestamp: { $gt: cursor.lastReadAt } },
        { timestamp: cursor.lastReadAt, _id: { $gt: cursor.lastReadMessageId } }
      ] }
      : {};
    const rows = await MessageModel.find({ $and: [roomMessageQuery(canonicalRoom), newer] })
      .select('_id serverCode timestamp username authorKey notificationMentions deleted');
    const blocked = normalizedBlockedUserKeys(blockedUserKeys);
    let unreadCount = 0;
    let mentionCount = 0;
    let countedThrough = null;
    for (const storedMessage of Array.isArray(rows) ? rows : []) {
      const authorKey = authorKeyForMessage(storedMessage);
      if (!authorKey || authorKey === readerKey || blocked.has(authorKey)) continue;
      const messageCursor = cursorFromMessage(storedMessage);
      if (messageCursor && (!countedThrough || compareCursor(countedThrough, messageCursor) < 0)) {
        countedThrough = messageCursor;
      }
      unreadCount += 1;
      if (isNotificationMention(storedMessage, readerKey)) mentionCount += 1;
    }
    return {
      unreadCount,
      mentionCount,
      ...(countedThrough ? {
        countedThroughAt: countedThrough.lastReadAt,
        countedThroughMessageId: countedThrough.lastReadMessageId
      } : {})
    };
  }

  async function ensureRoomState({ usernameKey, serverCode, session = null }) {
    const key = normalizeAccountKey(usernameKey);
    const query = { usernameKey: key, serverCode };
    let row = await applyQuerySession(RoomMemberStateModel.findOne(query), session);
    if (row) return row;

    const newest = await newestRoomMessage(MessageModel, serverCode, { session });
    const cursor = cursorFromMessage(newest) || { lastReadAt: null, lastReadMessageId: null };
    try {
      row = await RoomMemberStateModel.findOneAndUpdate(
        query,
        { $setOnInsert: {
          ...query,
          notificationLevel: 'all',
          lastReadAt: cursor.lastReadAt,
          lastReadMessageId: cursor.lastReadMessageId,
          version: 0
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) }
      );
      if (row) return row;
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
    }
    row = await applyQuerySession(RoomMemberStateModel.findOne(query), session);
    if (!row) throw new Error('Room state initialization failed.');
    return row;
  }

  async function loadRoomStateSnapshot({ usernameKey, serverCode, blockedUserKeys, session = null }) {
    const row = await ensureRoomState({ usernameKey, serverCode, session });
    const counts = await countRoomAttention({
      usernameKey: normalizeAccountKey(usernameKey),
      serverCode,
      cursor: {
        lastReadAt: row.lastReadAt || null,
        lastReadMessageId: row.lastReadMessageId || null
      },
      blockedUserKeys
    });
    return safeRoomState(row, {
      ...counts,
      blockVersion: Number.isInteger(blockedUserKeys && blockedUserKeys.blockVersion)
        ? blockedUserKeys.blockVersion : 0
    });
  }

  async function advanceRoomCursorToNewest({ usernameKey, serverCode, session = null }) {
    const key = normalizeAccountKey(usernameKey);
    let row = await ensureRoomState({ usernameKey: key, serverCode, session });
    const newest = await newestRoomMessage(MessageModel, serverCode, { session });
    const cursor = cursorFromMessage(newest);
    if (!cursor || compareCursor({
      lastReadAt: row.lastReadAt,
      lastReadMessageId: row.lastReadMessageId
    }, cursor) >= 0) return row;

    const currentVersion = Number.isInteger(row.version) && row.version >= 0 ? row.version : 0;
    const versionPredicate = currentVersion === 0
      ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
      : { version: currentVersion };
    const updated = await RoomMemberStateModel.findOneAndUpdate(
      { usernameKey: key, serverCode, ...versionPredicate },
      { $set: {
        lastReadAt: cursor.lastReadAt,
        lastReadMessageId: cursor.lastReadMessageId
      }, $inc: { version: 1 } },
      { new: true, ...(session ? { session } : {}) }
    );
    if (updated) return updated;
    row = await applyQuerySession(RoomMemberStateModel.findOne({ usernameKey: key, serverCode }), session);
    if (!row) throw new Error('Room cursor advance failed.');
    return row;
  }

  function pinVersionForRoom(room) {
    return Number.isInteger(room && room.pinVersion) && room.pinVersion >= 0 ? room.pinVersion : 0;
  }

  async function loadPinCandidates(room) {
    const candidates = [];
    for (const storedPin of Array.isArray(room && room.pinnedMessages) ? room.pinnedMessages : []) {
      const messageId = String(storedPin && storedPin.messageId || '').toLowerCase();
      if (!isValidObjectId(messageId)) continue;
      const storedMessage = await MessageModel.findById(messageId);
      if (!storedMessage || storedMessage.deleted || storedMessage.serverCode !== room.code) continue;
      const authorKey = authorKeyForMessage(storedMessage);
      if (!authorKey) continue;
      const username = normalizeUsername(storedMessage.username) || authorKey;
      const pinnedBy = normalizeUsername(storedPin.pinnedBy) || '';
      const pinnedAt = storedPin.pinnedAt instanceof Date ? storedPin.pinnedAt : new Date(storedPin.pinnedAt);
      const messageTimestamp = storedMessage.timestamp instanceof Date
        ? storedMessage.timestamp : new Date(storedMessage.timestamp);
      if (Number.isNaN(messageTimestamp.getTime())) continue;
      candidates.push({
        messageId,
        authorKey,
        username,
        displayName: typeof storedMessage.displayName === 'string' ? storedMessage.displayName : '',
        text: typeof storedMessage.text === 'string' ? storedMessage.text : '',
        attachmentSummary: sanitizeAttachment(storedMessage.attachment) ? 'Image Attachment' : null,
        messageTimestamp,
        pinnedAt: Number.isNaN(pinnedAt.getTime()) ? null : pinnedAt,
        pinnedBy
      });
    }
    return candidates;
  }

  function visiblePinsFromCandidates(candidates, blockedUserKeys) {
    const blocked = normalizedBlockedUserKeys(blockedUserKeys);
    return candidates.filter(pin => !blocked.has(pin.authorKey));
  }

  async function loadVisiblePins({ room, blockedUserKeys }) {
    return visiblePinsFromCandidates(await loadPinCandidates(room), blockedUserKeys);
  }

  async function visiblePinCountSnapshot({ room, blockedUserKeys, blockVersion }) {
    const pins = await loadVisiblePins({ room, blockedUserKeys });
    return {
      serverCode: room.code,
      pinCount: pins.length,
      pinVersion: pinVersionForRoom(room),
      blockVersion: Number.isInteger(blockVersion) && blockVersion >= 0 ? blockVersion : 0
    };
  }

  async function visiblePinSnapshot({ room, blockedUserKeys, blockVersion }) {
    const pins = await loadVisiblePins({ room, blockedUserKeys });
    return {
      serverCode: room.code,
      pins,
      pinCount: pins.length,
      pinVersion: pinVersionForRoom(room),
      blockVersion: Number.isInteger(blockVersion) && blockVersion >= 0 ? blockVersion : 0
    };
  }

  function safeRoomSummary(room, pin) {
    return {
      code: room.code,
      name: typeof room.name === 'string' ? room.name : '',
      owner: typeof room.owner === 'string' ? room.owner : '',
      metadataVersion: Number.isInteger(room.metadataVersion) && room.metadataVersion >= 0
        ? room.metadataVersion : 0,
      pin
    };
  }

  function blockCacheForLiveSession(live, session) {
    if (live && live.blockedUserKeys instanceof Set) return normalizedBlockedUserKeys(live.blockedUserKeys);
    return normalizedBlockedUserKeys(Array.isArray(session && session.blockedUsers) ? session.blockedUsers : []);
  }

  function blockVersionForLiveSession(live, session) {
    if (Number.isInteger(live?.blockVersion) && live.blockVersion >= 0) return live.blockVersion;
    return Number.isInteger(session?.blockVersion) && session.blockVersion >= 0 ? session.blockVersion : 0;
  }

  async function emitPersonalizedRoomEvent({ serverCode, event, buildPayload }) {
    const canonicalRoom = normalizeServerCode(serverCode);
    if (!canonicalRoom || typeof event !== 'string' || typeof buildPayload !== 'function') return;
    let liveSockets;
    try {
      liveSockets = await fetchLiveSockets();
    } catch (err) {
      logUnexpectedError(logger, 'personalized_socket_discovery', err);
      return;
    }
    const accounts = new Map();
    for (const live of liveSockets) {
      if (normalizeServerCode(live.serverCode) !== canonicalRoom) continue;
      const session = onlineUsersMap.get(live.id);
      const username = normalizeUsername(live.username || session?.username);
      const usernameKey = normalizeAccountKey(username);
      if (!username || !usernameKey) continue;
      if (!accounts.has(usernameKey)) accounts.set(usernameKey, { username, sockets: [] });
      accounts.get(usernameKey).sockets.push(live);
    }
    for (const { username, sockets } of accounts.values()) {
      let access;
      try {
        access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel, username, serverCode: canonicalRoom
        });
      } catch (err) {
        logUnexpectedError(logger, 'personalized_room_access', err);
        continue;
      }
      if (!access.allowed || access.restriction.banned || !access.user || !access.room) continue;
      for (const live of sockets) {
        if (normalizeServerCode(live.serverCode) !== canonicalRoom) continue;
        const session = onlineUsersMap.get(live.id);
        const blockedUserKeys = blockCacheForLiveSession(live, session);
        const blockVersion = blockVersionForLiveSession(live, session);
        let payload = buildPayload({ live, access, blockedUserKeys, blockVersion });
        if (payload && typeof payload.then === 'function') {
          payload = await payload;
          if (blockVersionForLiveSession(live, onlineUsersMap.get(live.id)) !== blockVersion) {
            const freshSession = onlineUsersMap.get(live.id);
            payload = buildPayload({
              live,
              access,
              blockedUserKeys: blockCacheForLiveSession(live, freshSession),
              blockVersion: blockVersionForLiveSession(live, freshSession)
            });
            if (payload && typeof payload.then === 'function') payload = await payload;
          }
        }
        if (payload === null || payload === undefined) continue;
        if (normalizeServerCode(live.serverCode) !== canonicalRoom) continue;
        const freshSession = onlineUsersMap.get(live.id);
        const freshVersion = blockVersionForLiveSession(live, freshSession);
        if (freshVersion !== blockVersion) {
          payload = buildPayload({
            live,
            access,
            blockedUserKeys: blockCacheForLiveSession(live, freshSession),
            blockVersion: freshVersion
          });
          if (payload && typeof payload.then === 'function') payload = await payload;
          if (payload === null || payload === undefined) continue;
        }
        live.emit(event, payload);
      }
    }
  }

  async function emitRoomActivity(message) {
    const serverCode = normalizeServerCode(message?.serverCode);
    const authorKey = authorKeyForMessage(message);
    const messageCursor = cursorFromMessage(message);
    if (!serverCode || !authorKey || !messageCursor) return;
    let liveSockets;
    try {
      liveSockets = await fetchLiveSockets();
    } catch (err) {
      logUnexpectedError(logger, 'room_activity_socket_discovery', err);
      return;
    }
    const accounts = new Map();
    for (const live of liveSockets) {
      const session = onlineUsersMap.get(live.id);
      const username = normalizeUsername(live.username || session?.username);
      const usernameKey = normalizeAccountKey(username);
      if (!username || !usernameKey || usernameKey === authorKey) continue;
      if (!accounts.has(usernameKey)) accounts.set(usernameKey, { username, sockets: [] });
      accounts.get(usernameKey).sockets.push(live);
    }
    for (const [usernameKey, account] of accounts.entries()) {
      let access;
      try {
        access = await loadRoomAccessState({
          UserModel,
          ChatServerModel,
          RoomRestrictionModel,
          username: account.username,
          serverCode
        });
      } catch (err) {
        logUnexpectedError(logger, 'room_activity_access', err);
        continue;
      }
      const actualMember = Array.isArray(access.user?.servers) && access.user.servers.includes(serverCode);
      if (!access.allowed || access.restriction.banned || !access.user || !access.room || !actualMember) continue;
      try {
        await withAccountTransitionLock(usernameKey, async () => {
          const freshAccess = await loadRoomAccessState({
            UserModel,
            ChatServerModel,
            RoomRestrictionModel,
            username: account.username,
            serverCode
          });
          const freshMember = Array.isArray(freshAccess.user?.servers) &&
            freshAccess.user.servers.includes(serverCode);
          if (!freshAccess.allowed || freshAccess.restriction.banned ||
              !freshAccess.user || !freshAccess.room || !freshMember) return;
          for (const live of account.sockets) {
            const session = onlineUsersMap.get(live.id);
            if (normalizeAccountKey(live.username || session?.username) !== usernameKey) continue;
            const blockedUserKeys = blockCacheForLiveSession(live, session);
            const blockVersion = blockVersionForLiveSession(live, session);
            if (blockedUserKeys.has(authorKey)) continue;
            live.emit('room_activity', {
              serverCode,
              messageId: String(message._id),
              timestamp: messageCursor.lastReadAt,
              authorKey,
              mentioned: isNotificationMention(message, usernameKey),
              blockVersion
            });
          }
        });
      } catch (err) {
        logUnexpectedError(logger, 'room_activity_locked_access', err);
      }
    }
  }

  async function emitMessagePinUpdated({ serverCode, messageId, pinned, room, targetAuthorKey }) {
    const candidates = await loadPinCandidates(room);
    await emitPersonalizedRoomEvent({
      serverCode,
      event: 'message_pin_updated',
      buildPayload: ({ blockedUserKeys, blockVersion }) => {
        const pin = {
          serverCode,
          pinCount: visiblePinsFromCandidates(candidates, blockedUserKeys).length,
          pinVersion: pinVersionForRoom(room),
          blockVersion
        };
        if (!targetAuthorKey || blockedUserKeys.has(targetAuthorKey)) return { pin };
        return { messageId, pinned, pin };
      }
    });
  }

  function clearBlockedTypingEntries(live, session, blockedUserKeys) {
    for (const holder of [live, session]) {
      const typing = holder?.typingUsers;
      if (typing instanceof Set || typing instanceof Map) {
        for (const username of [...typing.keys()]) {
          if (blockedUserKeys.has(normalizeAccountKey(username))) typing.delete(username);
        }
      } else if (Array.isArray(typing)) {
        holder.typingUsers = typing.filter(username => !blockedUserKeys.has(normalizeAccountKey(username)));
      } else if (typing && typeof typing === 'object') {
        for (const username of Object.keys(typing)) {
          if (blockedUserKeys.has(normalizeAccountKey(username))) delete typing[username];
        }
      }
    }
  }

  async function refreshBlockerSessions({ usernameKey, state, sockets }) {
    const accountKey = normalizeAccountKey(usernameKey);
    const safeState = safeBlockState(state);
    const blockedUserKeys = blockSetFromState(safeState);
    blockedUserKeys.blockVersion = safeState.blockVersion;
    const actor = await findUserByUsername(UserModel, accountKey);
    if (!actor) return;
    const memberships = [...new Set(Array.isArray(actor.servers) ? actor.servers : [])];
    const roomSnapshots = new Map();
    for (const serverCode of memberships) {
      const access = await loadRoomAccessState({
        UserModel, ChatServerModel, RoomRestrictionModel, username: actor.username, serverCode
      });
      const actualMember = Array.isArray(access.user?.servers) && access.user.servers.includes(serverCode);
      if (!access.allowed || access.restriction.banned || !access.room || !actualMember) continue;
      roomSnapshots.set(serverCode, {
        attention: await loadRoomStateSnapshot({
          usernameKey: accountKey, serverCode, blockedUserKeys
        }),
        pin: await visiblePinCountSnapshot({
          room: access.room, blockedUserKeys, blockVersion: safeState.blockVersion
        })
      });
    }
    for (const live of Array.isArray(sockets) ? sockets : []) {
      const session = onlineUsersMap.get(live.id);
      if (normalizeAccountKey(live.username || session?.username) !== accountKey) continue;
      delete live.pinsCache;
      delete live.pinCache;
      if (session) {
        delete session.pinsCache;
        delete session.pinCache;
      }
      clearBlockedTypingEntries(live, session, blockedUserKeys);
      for (const { attention, pin } of roomSnapshots.values()) {
        live.emit('room_attention_updated', attention);
        live.emit('message_pin_updated', { pin });
      }
      const activeRoom = normalizeServerCode(live.serverCode);
      if (activeRoom && roomSnapshots.has(activeRoom)) {
        live.emit('room_refresh_required', {
          serverCode: activeRoom,
          blockVersion: safeState.blockVersion
        });
      }
    }
  }

  function publicBlockMutationState(target, state) {
    const safeState = safeBlockState(state);
    return {
      success: true,
      usernameKey: normalizeAccountKey(target.username),
      username: normalizeUsername(target.username),
      blockedUsers: safeState.blockedUsers,
      blockVersion: safeState.blockVersion
    };
  }

  async function applyBlockMutation({ usernameKey, target, blocked, sockets }) {
    let observed = await ensureBlockState(usernameKey);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentKeys = blockSetFromState(observed);
      const targetKey = normalizeAccountKey(target.username);
      const alreadyDesired = currentKeys.has(targetKey) === blocked;
      if (alreadyDesired) break;
      if (blocked && observed.blockedUsers.length >= 500) return { error: 'Block limit reached.' };
      const version = observed.blockVersion;
      const versionPredicate = version === 0
        ? { $or: [{ blockVersion: 0 }, { blockVersion: { $exists: false } }] }
        : { blockVersion: version };
      const statePredicate = blocked
        ? { 'blockedUsers.usernameKey': { $ne: targetKey } }
        : { 'blockedUsers.usernameKey': targetKey };
      const update = blocked
        ? { $push: { blockedUsers: {
          usernameKey: targetKey,
          username: normalizeUsername(target.username),
          createdAt: new Date()
        } }, $inc: { blockVersion: 1 } }
        : { $pull: { blockedUsers: { usernameKey: targetKey } }, $inc: { blockVersion: 1 } };
      const updated = await UserExperienceStateModel.findOneAndUpdate(
        { usernameKey, ...versionPredicate, ...statePredicate },
        update,
        { new: true }
      );
      if (updated) {
        observed = safeBlockState(updated);
        break;
      }
      observed = await ensureBlockState(usernameKey);
    }
    if (blockSetFromState(observed).has(normalizeAccountKey(target.username)) !== blocked) {
      return { error: 'Block state changed. Reload and try again.' };
    }
    replaceAccountBlockCaches(sockets, usernameKey, observed, onlineUsersMap);
    const publication = publicBlockMutationState(target, observed);
    for (const live of Array.isArray(sockets) ? sockets : []) {
      const session = onlineUsersMap.get(live.id);
      if (normalizeAccountKey(live.username || session?.username) !== usernameKey) continue;
      live.emit('user_block_updated', publication);
    }
    await refreshBlockerSessions({ usernameKey, state: observed, sockets });
    return publication;
  }

  function exactStoredPin(room, messageId) {
    const normalizedMessageId = String(messageId || '').toLowerCase();
    const storedPin = (Array.isArray(room && room.pinnedMessages) ? room.pinnedMessages : [])
      .find(pin => String(pin && pin.messageId || '').toLowerCase() === normalizedMessageId);
    if (!storedPin) return null;
    return {
      messageId: storedPin.messageId,
      pinnedAt: storedPin.pinnedAt,
      pinnedBy: storedPin.pinnedBy
    };
  }

  function roomPinVersionPredicate(room) {
    const storedVersion = room && room.pinVersion;
    if (storedVersion === undefined || storedVersion === 0) {
      return { $or: [{ pinVersion: 0 }, { pinVersion: { $exists: false } }] };
    }
    if (!Number.isInteger(storedVersion) || storedVersion < 0) {
      throw new Error('Invalid pin version.');
    }
    return { pinVersion: storedVersion };
  }

  async function removePinBeforeFallbackDelete({ room, message, blockVersion }) {
    const messageId = String(message && message._id || '').toLowerCase();
    const priorPin = exactStoredPin(room, messageId);
    if (!priorPin) return { room, priorPin: null, blockVersion };
    const updatedRoom = await ChatServerModel.findOneAndUpdate(
      {
        code: room.code,
        ...roomPinVersionPredicate(room),
        'pinnedMessages.messageId': messageId
      },
      { $pull: { pinnedMessages: { messageId } }, $inc: { pinVersion: 1 } },
      { new: true }
    );
    if (!updatedRoom) throw new Error('Pinned message removal lost its version race.');
    return { room: updatedRoom, priorPin, blockVersion };
  }

  function pinsMatchExactPrior(pin, priorPin) {
    if (!pin || !priorPin ||
        String(pin.messageId || '').toLowerCase() !== String(priorPin.messageId || '').toLowerCase() ||
        pin.pinnedBy !== priorPin.pinnedBy) return false;
    const pinTime = pin.pinnedAt instanceof Date ? pin.pinnedAt.getTime() : new Date(pin.pinnedAt).getTime();
    const priorTime = priorPin.pinnedAt instanceof Date
      ? priorPin.pinnedAt.getTime()
      : new Date(priorPin.pinnedAt).getTime();
    return !Number.isNaN(pinTime) && pinTime === priorTime;
  }

  function priorPinState(room, priorPin) {
    const messageId = String(priorPin && priorPin.messageId || '').toLowerCase();
    const sameMessagePins = (Array.isArray(room && room.pinnedMessages) ? room.pinnedMessages : [])
      .filter(pin => String(pin && pin.messageId || '').toLowerCase() === messageId);
    if (sameMessagePins.some(pin => pinsMatchExactPrior(pin, priorPin))) return 'exact';
    return sameMessagePins.length > 0 ? 'conflict' : 'absent';
  }

  async function restorePinAfterFailedDelete({ room, priorPin, blockVersion }) {
    let observedRoom = room;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let attemptedMutation = null;
      try {
        if (!observedRoom) throw new Error('Pinned message room disappeared.');
        const observedState = priorPinState(observedRoom, priorPin);
        if (observedState === 'absent') {
          attemptedMutation = 'restore';
          const restoredRoom = await ChatServerModel.findOneAndUpdate(
            {
              code: observedRoom.code,
              ...roomPinVersionPredicate(observedRoom),
              'pinnedMessages.messageId': { $ne: String(priorPin.messageId).toLowerCase() }
            },
            { $push: { pinnedMessages: priorPin }, $inc: { pinVersion: 1 } },
            { new: true }
          );
          if (!restoredRoom) throw new Error('Pinned message restoration lost its version race.');
          observedRoom = restoredRoom;
        } else if (observedState === 'conflict') {
          attemptedMutation = 'remove_conflict';
          const messageId = String(priorPin.messageId).toLowerCase();
          const unpinnedRoom = await ChatServerModel.findOneAndUpdate(
            {
              code: observedRoom.code,
              ...roomPinVersionPredicate(observedRoom),
              'pinnedMessages.messageId': messageId
            },
            { $pull: { pinnedMessages: { messageId } }, $inc: { pinVersion: 1 } },
            { new: true }
          );
          if (!unpinnedRoom) throw new Error('Conflicting pin removal lost its version race.');
          observedRoom = unpinnedRoom;
        }
      } catch (err) {
        lastError = err;
      }

      try {
        const verifiedRoom = await ChatServerModel.findOne({ code: room.code });
        observedRoom = verifiedRoom;
        if (!verifiedRoom) throw new Error('Pinned message room disappeared during verification.');
        const verifiedState = priorPinState(verifiedRoom, priorPin);
        if (verifiedState === 'exact') {
          return { restored: true, pinned: true, verified: true, room: verifiedRoom, blockVersion };
        }
        if (verifiedState === 'absent' && (attemptedMutation === 'remove_conflict' || attempt === 1)) {
          return { restored: false, pinned: false, verified: true, room: verifiedRoom, blockVersion, error: lastError };
        }
        if (verifiedState === 'conflict' && attempt === 1) {
          return { restored: false, pinned: true, verified: true, room: verifiedRoom, blockVersion, error: lastError };
        }
      } catch (err) {
        lastError = err;
      }
    }
    return {
      restored: false,
      pinned: null,
      verified: false,
      room: observedRoom,
      blockVersion,
      error: lastError
    };
  }

  async function quarantineLiveSocket(live, session, roomCodes) {
    if (live.id === socket.id) {
      terminallyClosed = true;
      suppressDisconnectPresence = true;
    }
    live.username = null;
    live.displayName = null;
    live.role = null;
    live.serverCode = null;
    live.joinedServers = [];
    live.bannedRooms = [];
    if (session) {
      session.username = null;
      session.displayName = null;
      session.role = null;
      session.serverCode = null;
      session.joinedServers = [];
      session.bannedRooms = [];
    }
    onlineUsersMap.delete(live.id);
    for (const roomCode of new Set((roomCodes || []).filter(Boolean))) {
      try {
        await Promise.resolve(live.leave(roomCode));
      } catch (leaveError) {
        logUnexpectedError(logger, 'room_transport_quarantine_leave', leaveError);
      }
    }
    try {
      await Promise.resolve(live.disconnect(true));
    } catch (disconnectError) {
      logUnexpectedError(logger, 'room_transport_disconnect', disconnectError);
    }
  }

  async function quarantineAccountSessions(sockets, username, roomCodes) {
    const accountKey = normalizeAccountKey(username);
    const quarantinedIds = new Set();
    const transportQuarantines = [];
    for (const live of sockets || []) {
      const session = onlineUsersMap.get(live.id);
      if (normalizeAccountKey(live.username || session?.username) !== accountKey) continue;
      quarantinedIds.add(live.id);
      const transportRooms = new Set((roomCodes || []).filter(Boolean));
      const joinedRoomSnapshot = live.rooms && typeof live.rooms[Symbol.iterator] === 'function'
        ? live.rooms
        : live.joinedRooms;
      if (joinedRoomSnapshot && typeof joinedRoomSnapshot[Symbol.iterator] === 'function') {
        for (const roomCode of joinedRoomSnapshot) {
          if (roomCode && roomCode !== live.id) transportRooms.add(roomCode);
        }
      }
      if (live.serverCode) transportRooms.add(live.serverCode);
      if (session?.serverCode) transportRooms.add(session.serverCode);
      transportQuarantines.push(quarantineLiveSocket(live, session, [...transportRooms]));
    }
    for (const [id, session] of onlineUsersMap.entries()) {
      if (quarantinedIds.has(id) || normalizeAccountKey(session?.username) !== accountKey) continue;
      session.username = null;
      session.displayName = null;
      session.role = null;
      session.serverCode = null;
      session.joinedServers = [];
      session.bannedRooms = [];
      onlineUsersMap.delete(id);
    }
    await Promise.all(transportQuarantines);
  }

  async function repairPrivateRemovalInvariant({ targetUser, room, serverCode }) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const freshUser = await findUserByUsername(UserModel, targetUser.username);
        if (freshUser) {
          freshUser.servers = (Array.isArray(freshUser.servers) ? freshUser.servers : [])
            .filter(code => code !== serverCode);
          await freshUser.save();
        }
        const freshRoom = await ChatServerModel.findOne({ code: serverCode });
        if (freshRoom) {
          freshRoom.moderators = (Array.isArray(freshRoom.moderators) ? freshRoom.moderators : [])
            .filter(username => normalizeAccountKey(username) !== normalizeAccountKey(targetUser.username));
          await freshRoom.save();
        }
        const verifiedUser = await findUserByUsername(UserModel, targetUser.username);
        const verifiedRoom = await ChatServerModel.findOne({ code: serverCode });
        const membershipRemoved = !verifiedUser ||
          !(Array.isArray(verifiedUser.servers) && verifiedUser.servers.includes(serverCode));
        const moderatorRemoved = !verifiedRoom || !isCurrentRoomModerator(verifiedRoom, targetUser.username);
        if (!membershipRemoved || !moderatorRemoved) throw new Error('Private removal invariant incomplete.');
        targetUser.servers = verifiedUser && Array.isArray(verifiedUser.servers) ? [...verifiedUser.servers] : [];
        room.moderators = verifiedRoom && Array.isArray(verifiedRoom.moderators) ? [...verifiedRoom.moderators] : [];
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    logUnexpectedError(logger, 'moderation_invariant_repair', lastError);
    return false;
  }

  async function restorePrivateAccessSnapshot({
    targetUser,
    room,
    serverCode,
    wasMember,
    wasModerator
  }) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const freshUser = await findUserByUsername(UserModel, targetUser.username);
        if (freshUser) {
          const servers = Array.isArray(freshUser.servers) ? [...freshUser.servers] : [];
          const hasMembership = servers.includes(serverCode);
          if (wasMember !== hasMembership) {
            freshUser.servers = wasMember
              ? [...new Set([...servers, serverCode])]
              : servers.filter(code => code !== serverCode);
            await freshUser.save();
          }
        }
        const freshRoom = await ChatServerModel.findOne({ code: serverCode });
        if (freshRoom) {
          const moderators = Array.isArray(freshRoom.moderators) ? [...freshRoom.moderators] : [];
          const hasModerator = moderators.some(username =>
            normalizeAccountKey(username) === normalizeAccountKey(targetUser.username)
          );
          if (wasModerator !== hasModerator) {
            freshRoom.moderators = wasModerator
              ? [...moderators, targetUser.username]
              : moderators.filter(username =>
                normalizeAccountKey(username) !== normalizeAccountKey(targetUser.username)
              );
            await freshRoom.save();
          }
        }
        const verifiedUser = await findUserByUsername(UserModel, targetUser.username);
        const verifiedRoom = await ChatServerModel.findOne({ code: serverCode });
        const hasMembership = Boolean(verifiedUser &&
          Array.isArray(verifiedUser.servers) && verifiedUser.servers.includes(serverCode));
        const hasModerator = Boolean(verifiedRoom &&
          isCurrentRoomModerator(verifiedRoom, targetUser.username));
        if (hasMembership !== wasMember || hasModerator !== wasModerator) {
          throw new Error('Private access snapshot restore incomplete.');
        }
        targetUser.servers = verifiedUser && Array.isArray(verifiedUser.servers)
          ? [...verifiedUser.servers]
          : [];
        room.moderators = verifiedRoom && Array.isArray(verifiedRoom.moderators)
          ? [...verifiedRoom.moderators]
          : [];
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    logUnexpectedError(logger, 'moderation_snapshot_restore', lastError);
    return false;
  }

  async function establishFailClosedPrivateBan({ targetUser, serverCode, actorUsername }) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await RoomRestrictionModel.findOneAndUpdate(
          { serverCode, username: normalizeAccountKey(targetUser.username) },
          { $set: {
            bannedAt: new Date(),
            bannedBy: actorUsername,
            banReason: 'Restriction retained after failed moderation',
            timeoutUntil: null,
            timeoutBy: null,
            timeoutReason: null
          } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } catch (err) {
        lastError = err;
      }
      try {
        const verifiedRestriction = await RoomRestrictionModel.findOne({
          serverCode,
          username: normalizeAccountKey(targetUser.username)
        });
        if (activeRestrictionState(verifiedRestriction).banned) return true;
      } catch (err) {
        lastError = err;
      }
    }
    logUnexpectedError(logger, 'moderation_fail_closed_restriction', lastError);
    return false;
  }

  async function reconcileAccountSessions({
    sockets,
    username,
    joinedServers,
    bannedRooms = [],
    removedRoom = null,
    removedRooms = null,
    fallbackCode = null,
    notifyAccess = true
  }) {
    const authoritativeMemberships = [...new Set(Array.isArray(joinedServers) ? joinedServers : [])];
    const activeBannedRooms = [...new Set(Array.isArray(bannedRooms) ? bannedRooms : [])];
    const removedRoomSet = new Set(Array.isArray(removedRooms) ? removedRooms.filter(Boolean) : []);
    const normalizedUsername = normalizeAccountKey(username);
    const accountSockets = [];

    for (const live of sockets || []) {
      const session = onlineUsersMap.get(live.id);
      const liveUsername = normalizeAccountKey(live.username || session?.username);
      if (liveUsername !== normalizedUsername) continue;
      const activeRoom = live.serverCode ?? session?.serverCode ?? null;
      const effectiveRemovedRoom = removedRoom || (removedRoomSet.has(activeRoom) ? activeRoom : null);
      applySessionAccessSnapshot({
        live,
        session,
        joinedServers: authoritativeMemberships,
        bannedRooms: activeBannedRooms,
        removedRoom: effectiveRemovedRoom,
        fallbackCode
      });
      accountSockets.push({
        live, session, activeRoom, removedRoom: effectiveRemovedRoom, quarantined: false
      });
    }

    const liveSessionIds = new Set(accountSockets.map(({ live }) => live.id));
    for (const [id, session] of onlineUsersMap.entries()) {
      if (liveSessionIds.has(id) || normalizeAccountKey(session?.username) !== normalizedUsername) continue;
      const activeRoom = session?.serverCode ?? null;
      applySessionAccessSnapshot({
        session,
        joinedServers: authoritativeMemberships,
        bannedRooms: activeBannedRooms,
        removedRoom: removedRoom || (removedRoomSet.has(activeRoom) ? activeRoom : null),
        fallbackCode
      });
    }

    let transportSynchronized = true;
    for (const record of accountSockets) {
      const { live, session, activeRoom, removedRoom: recordRemovedRoom } = record;
      if (recordRemovedRoom) {
        try {
          await Promise.resolve(live.leave(recordRemovedRoom));
          if (activeRoom === recordRemovedRoom && fallbackCode) {
            await Promise.resolve(live.join(fallbackCode));
          }
        } catch (err) {
          transportSynchronized = false;
          record.quarantined = true;
          logUnexpectedError(logger, 'room_transport_eviction', err);
          await quarantineLiveSocket(live, session, [recordRemovedRoom, fallbackCode]);
        }
      }

      if (notifyAccess && !record.quarantined) {
        try {
          live.emit('room_access_updated', {
            username,
            joinedServers: [...authoritativeMemberships],
            serverCode: live.serverCode ?? session?.serverCode ?? null,
            bannedRooms: [...activeBannedRooms]
          });
        } catch (err) {
          transportSynchronized = false;
          logUnexpectedError(logger, 'room_access_notification', err);
        }
      }
    }
    return {
      transportSynchronized,
      accountSockets,
      authoritativeMemberships,
      activeBannedRooms
    };
  }

  async function loadAccountSessionAccess(user) {
    const memberships = Array.isArray(user?.servers) ? [...new Set(user.servers)] : [];
    const [rooms, rows] = await Promise.all([
      typeof ChatServerModel.find === 'function'
        ? ChatServerModel.find({ code: { $in: memberships } })
        : memberships.map(code => ({ code })),
      RoomRestrictionModel.find({ username: normalizeAccountKey(user?.username) })
    ]);
    const restrictions = (rows || []).map(row => ({
      serverCode: row.serverCode,
      ...activeRestrictionState(row)
    }));
    const activeBannedRooms = restrictions.filter(item => item.banned).map(item => item.serverCode);
    const blockedRooms = new Set(activeBannedRooms);
    const existingRooms = new Set((rooms || []).map(room => room.code));
    const authoritativeMemberships = memberships.filter(code =>
      (code === 'global' || existingRooms.has(code)) && !blockedRooms.has(code)
    );
    const fallbackCode = chooseAccessibleRoom({ user, rooms, restrictions });
    return { rooms, restrictions, activeBannedRooms, authoritativeMemberships, fallbackCode };
  }

  async function synchronizeMembership(sockets, username, joinedServers, options = {}) {
    const {
      bannedRooms = [], removedRoom = null, fallbackCode = null, notifyAccess = true
    } = options;
    const result = await reconcileAccountSessions({
      sockets,
      username,
      joinedServers,
      bannedRooms,
      removedRoom,
      fallbackCode,
      notifyAccess
    });
    return result.transportSynchronized;
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

  async function appendAuditReliably(entry) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await ModerationAuditModel.create(entry);
        return true;
      } catch (err) {
        if (err && err.code === 11000) return true;
        lastError = err;
      }
    }
    logUnexpectedError(logger, 'moderation_audit_write', lastError);
    return false;
  }

  async function rejectAutoModContent({
    serverCode,
    clientContextId,
    access,
    roomRole,
    rawText,
    result
  }) {
    socket.emit('message_blocked', { rule: 'content_policy', serverCode, clientContextId });
    if (result.shouldAudit === false) return;
    await appendAuditReliably({
      correlationId: new mongoose.Types.ObjectId().toString(),
      action: 'automod_block',
      serverCode,
      actorUsername: socket.username,
      actorRole: access.user.role || 'user',
      actorRoomRole: roomRole,
      targetUsername: socket.username,
      targetRole: access.user.role || 'user',
      targetRoomRole: roomRole,
      reason: 'Automated content policy',
      metadata: {
        rule: result.rule,
        contentDigest: createHash('sha256').update(rawText).digest('hex')
      }
    });
  }

  async function loadModeratorAccess(serverCode, username) {
    const access = await loadRoomAccessState({
      UserModel,
      ChatServerModel,
      RoomRestrictionModel,
      username,
      serverCode
    });
    if (!access.allowed || access.restriction.banned) return null;
    const eligible = access.user.role === 'admin' ||
      (serverCode !== 'global' && isCurrentRoomModerator(access.room, access.user.username));
    return eligible ? access : null;
  }

  async function deliverModeratorRead(serverCode, callback, operation) {
    return withAccountTransitionLock(socket.username, () =>
      withRoomMutationLock(serverCode, async () => {
        const access = await loadModeratorAccess(serverCode, socket.username);
        if (!access) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const response = await operation(access);
        callback(response);
      })
    );
  }

  async function emitModerationQueueUpdated(serverCode) {
    let sockets;
    try {
      sockets = await fetchLiveSockets();
    } catch (err) {
      logUnexpectedError(logger, 'moderation_queue_socket_discovery', err);
      return;
    }
    for (const live of sockets) {
      const session = onlineUsersMap.get(live.id);
      const username = live.username || session?.username;
      if (!username) continue;
      try {
        const access = await loadModeratorAccess(serverCode, username);
        if (access) live.emit('moderation_queue_updated', { serverCode });
      } catch (err) {
        logUnexpectedError(logger, 'moderation_queue_notification', err);
      }
    }
  }

  async function emitRoomDetailsUpdated(serverCode, room) {
    let liveSockets;
    try {
      liveSockets = await fetchLiveSockets();
    } catch (err) {
      logUnexpectedError(logger, 'room_details_socket_discovery', err);
      return;
    }
    const byAccount = new Map();
    for (const live of liveSockets) {
      const session = onlineUsersMap.get(live.id);
      const username = live.username || session?.username;
      const accountKey = normalizeAccountKey(username);
      if (!normalizeUsername(username) || !accountKey) continue;
      if (!byAccount.has(accountKey)) byAccount.set(accountKey, { username, sockets: [] });
      byAccount.get(accountKey).sockets.push(live);
    }
    for (const { username, sockets } of byAccount.values()) {
      try {
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel, username, serverCode
        });
        if (!access.allowed || access.restriction.banned || !access.user) continue;
        const actualMember = serverCode === 'global' ||
          (Array.isArray(access.user.servers) && access.user.servers.includes(serverCode));
        const payload = safeRoomDetails(room, canEditRoomDetails({ serverCode, access }));
        for (const live of sockets) {
          const session = onlineUsersMap.get(live.id);
          const liveUsername = live.username || session?.username;
          if (normalizeAccountKey(liveUsername) !== normalizeAccountKey(access.user.username)) continue;
          const adminInspecting = access.user.role === 'admin' && live.serverCode === serverCode;
          if (actualMember || adminInspecting) live.emit('room_details_updated', payload);
        }
      } catch (err) {
        logUnexpectedError(logger, 'room_details_notification', err);
      }
    }
  }

  function paginationCursor(data) {
    if (data.before === undefined || data.before === null) return { cursor: null };
    const cursor = decodeCursor(data.before);
    return cursor ? { cursor } : { error: 'Invalid input format.' };
  }

  function nextPage(items, limit) {
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return {
      page,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last._id) : null
    };
  }

  function safeReportRow(row) {
    return {
      _id: String(row._id),
      serverCode: row.serverCode,
      reporterUsername: row.reporterUsername,
      targetUsername: row.targetUsername,
      messageId: row.messageId ? String(row.messageId) : null,
      reason: row.reason,
      status: row.status,
      resolvedBy: row.resolvedBy || null,
      resolution: row.resolution || null,
      resolvedAt: row.resolvedAt || null,
      createdAt: row.createdAt
    };
  }

  function safeAuditRow(row) {
    return {
      _id: String(row._id),
      correlationId: row.correlationId,
      action: row.action,
      serverCode: row.serverCode,
      actorUsername: row.actorUsername,
      actorRole: row.actorRole,
      actorRoomRole: row.actorRoomRole,
      targetUsername: row.targetUsername || null,
      targetRole: row.targetRole || null,
      targetRoomRole: row.targetRoomRole || null,
      reason: row.reason,
      duration: row.duration || null,
      expiresAt: row.expiresAt || null,
      messageId: row.messageId ? String(row.messageId) : null,
      reportId: row.reportId ? String(row.reportId) : null,
      metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
      createdAt: row.createdAt
    };
  }

  function safeRestrictionRow(row, now) {
    const state = activeRestrictionState(row, now);
    return {
      _id: String(row._id),
      targetUsername: row.username,
      banned: state.banned,
      bannedAt: state.banned ? row.bannedAt : null,
      bannedBy: state.banned ? (row.bannedBy || null) : null,
      banReason: state.banned ? (row.banReason || null) : null,
      timedOut: state.timedOut,
      timeoutUntil: state.timeoutUntil,
      timeoutBy: state.timedOut ? (row.timeoutBy || null) : null,
      timeoutReason: state.timedOut ? (row.timeoutReason || null) : null,
      createdAt: row.createdAt
    };
  }

  async function reconcileRestrictedAccount({
    username,
    removedRoom,
    fallbackCode,
    liveSockets,
    user,
    restrictions
  }) {
    const memberships = Array.isArray(user?.servers) ? [...new Set(user.servers)] : [];
    const rooms = typeof ChatServerModel.find === 'function'
      ? await ChatServerModel.find({ code: { $in: memberships } })
      : memberships.map(code => ({ code }));
    const existingRooms = new Set((rooms || []).map(room => room.code));
    const activeBannedRooms = (restrictions || [])
      .filter(item => item.banned)
      .map(item => item.serverCode);
    const blockedRooms = new Set(activeBannedRooms);
    const authoritativeMemberships = memberships.filter(code =>
      (code === 'global' || existingRooms.has(code)) && !blockedRooms.has(code)
    );
    return reconcileAccountSessions({
      sockets: liveSockets,
      username,
      joinedServers: authoritativeMemberships,
      bannedRooms: activeBannedRooms,
      removedRoom,
      fallbackCode,
      notifyAccess: false
    });
  }

  function emitModerationSessionUpdates({
    reconciliation,
    username,
    restrictionState,
    serverCode
  }) {
    for (const record of reconciliation.accountSockets) {
      if (record.quarantined) continue;
      const { live, session } = record;
      try {
        live.emit('room_access_updated', {
          username,
          joinedServers: [...reconciliation.authoritativeMemberships],
          serverCode: live.serverCode ?? session?.serverCode ?? null,
          bannedRooms: [...reconciliation.activeBannedRooms]
        });
        live.emit('room_restriction_updated', {
          serverCode,
          banned: restrictionState.banned,
          timedOut: restrictionState.timedOut,
          timeoutUntil: restrictionState.timeoutUntil,
          bannedRooms: [...reconciliation.activeBannedRooms]
        });
      } catch (err) {
        logUnexpectedError(logger, 'moderation_target_notification', err);
      }
    }
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
        const [rooms, restrictionRows, durableBlockState] = await Promise.all([
          role === 'admin'
            ? ChatServerModel.find()
            : ChatServerModel.find({ code: { $in: user.servers } }),
          RoomRestrictionModel.find({ username: normalizeAccountKey(user.username) }),
          loadDurableBlockState(user.username)
        ]);
        const restrictions = (restrictionRows || []).map(row => ({
          serverCode: row.serverCode,
          ...activeRestrictionState(row)
        }));
        const bannedRooms = restrictions.filter(item => item.banned).map(item => item.serverCode);
        const blockedRooms = new Set(bannedRooms);
        const { snapshot: blockState, blockedUserKeys } = durableBlockState;
        const validatedRooms = [];
        const actualMemberships = new Set();
        const roomStateByCode = new Map();
        const roomPinByCode = new Map();
        for (const candidateRoom of (rooms || []).filter(room => !blockedRooms.has(room.code))) {
          const validated = await withRoomMutationLock(candidateRoom.code, async () => {
            const [freshRoom, freshUser] = await Promise.all([
              ChatServerModel.findOne({ code: candidateRoom.code }),
              findUserByUsername(UserModel, user.username)
            ]);
            if (!freshRoom || !freshUser) return null;
            const actualMember = Array.isArray(freshUser.servers) &&
              freshUser.servers.includes(candidateRoom.code);
            if (!actualMember && role !== 'admin') return null;
            return {
              room: freshRoom,
              actualMember,
              state: actualMember ? await loadRoomStateSnapshot({
                usernameKey: freshUser.username,
                serverCode: candidateRoom.code,
                blockedUserKeys
              }) : null,
              pin: await visiblePinCountSnapshot({
                room: freshRoom,
                blockedUserKeys,
                blockVersion: blockState.blockVersion
              })
            };
          });
          if (!validated) continue;
          validatedRooms.push(validated.room);
          if (validated.actualMember) {
            actualMemberships.add(candidateRoom.code);
            roomStateByCode.set(candidateRoom.code, validated.state);
          }
          roomPinByCode.set(candidateRoom.code, validated.pin);
        }
        const joinedServers = user.servers.filter(code => actualMemberships.has(code));
        const roomStates = joinedServers.map(code => roomStateByCode.get(code));
        const visibleRoomCodes = new Set(validatedRooms.map(room => room.code));
        const chosenServerCode = chooseAccessibleRoom({
          user: { servers: joinedServers }, rooms: validatedRooms, restrictions
        });
        const defaultServerCode = visibleRoomCodes.has(chosenServerCode)
          ? chosenServerCode
          : (joinedServers.find(code => code !== 'global' && visibleRoomCodes.has(code)) || null);
        const restriction = defaultServerCode
          ? (restrictions.find(item => item.serverCode === defaultServerCode) || activeRestrictionState(null))
          : activeRestrictionState(null);
        const attentionSnapshots = roomStates.map(state => ({
          serverCode: state.serverCode,
          unreadCount: state.unreadCount,
          mentionCount: state.mentionCount
        }));
        const roomSummaries = validatedRooms.map(room => safeRoomSummary(room, roomPinByCode.get(room.code)));

        socket.username = user.username;
        socket.displayName = user.displayName;
        socket.role = role;
        socket.color = user.color || '';
        socket.avatarUrl = user.avatarUrl || '';
        socket.serverCode = defaultServerCode;
        socket.joinedServers = [...joinedServers];
        socket.bannedRooms = [...bannedRooms];
        socket.blockedUserKeys = new Set(blockedUserKeys);
        socket.blockVersion = blockState.blockVersion;

        onlineUsersMap.set(socket.id, {
          username: user.username,
          displayName: socket.displayName,
          role: socket.role,
          color: socket.color,
          avatarUrl: socket.avatarUrl,
          serverCode: defaultServerCode,
          joinedServers: [...joinedServers],
          bannedRooms: [...bannedRooms],
          blockedUsers: [...blockedUserKeys],
          blockVersion: blockState.blockVersion
        });
        if (defaultServerCode) await Promise.resolve(socket.join(defaultServerCode));

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
          servers: roomSummaries,
          joinedServers: [...joinedServers],
          defaultServerCode,
          restriction: {
            banned: restriction.banned,
            timedOut: restriction.timedOut,
            timeoutUntil: restriction.timeoutUntil
          },
          bannedRooms: [...bannedRooms],
          roomStates,
          blockState,
          attentionSnapshots
        };
      });

      if (result.success) rateLimiter.clear(rateKey);
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'login', err);
      callback({ error: 'Login failed.' });
    }
  });

  socket.on('set_user_block', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!isPlainObject(data) || typeof data.blocked !== 'boolean') {
      return callback({ error: 'Invalid input format.' });
    }
    const requestedUsername = normalizeUsername(data.username);
    if (!requestedUsername) return callback({ error: 'Invalid input format.' });
    const actorUsername = socket.username;
    try {
      const result = await withAccountTransitionLock(actorUsername, async () => {
        if (normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername)) {
          return { error: 'Unable to update block.' };
        }
        const target = await findUserByUsername(UserModel, requestedUsername);
        if (!target || normalizeAccountKey(target.username) === normalizeAccountKey(actorUsername)) {
          return { error: 'Unable to update block.' };
        }
        const sockets = await fetchLiveSockets();
        return applyBlockMutation({
          usernameKey: normalizeAccountKey(actorUsername), target, blocked: data.blocked, sockets
        });
      });
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'set_user_block', err);
      callback({ error: 'Failed to update block.' });
    }
  });

  socket.on('get_blocked_message', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!isPlainObject(data)) return callback({ error: 'Invalid input format.' });
    const serverCode = normalizeServerCode(data.serverCode);
    const rawMessageId = typeof data.messageId === 'string' ? data.messageId : '';
    const messageId = rawMessageId.toLowerCase();
    const clientContextId = normalizeClientContextId(data.clientContextId);
    if (!serverCode || !isValidObjectId(rawMessageId) || clientContextId === null) {
      return callback({ error: 'Invalid input format.' });
    }
    if (normalizeServerCode(socket.serverCode) !== serverCode) {
      return callback({ error: 'Permission denied.' });
    }
    const actorUsername = socket.username;
    try {
      const result = await withAccountTransitionLock(actorUsername, () =>
        withRoomMutationLock(serverCode, async () => {
          if (normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
              normalizeServerCode(socket.serverCode) !== serverCode) {
            return { error: 'Permission denied.' };
          }
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel, username: actorUsername, serverCode
          });
          if (!access.allowed || access.restriction.banned || !access.user || !access.room) {
            return { error: 'Permission denied.' };
          }
          const target = await MessageModel.findById(messageId);
          const targetServerCode = normalizeServerCode(target?.serverCode || 'global');
          const authorKey = authorKeyForMessage(target);
          if (!target || targetServerCode !== serverCode || !authorKey) {
            return { error: 'Permission denied.' };
          }
          const blockState = await ensureBlockState(access.user.username);
          if (!blockSetFromState(blockState).has(authorKey)) return { error: 'Permission denied.' };
          const safeTarget = safeBlockedMessageReveal(target);
          if (!safeTarget) return { error: 'Permission denied.' };
          return {
            success: true,
            serverCode,
            messageId,
            clientContextId,
            blockVersion: blockState.blockVersion,
            message: { ...safeTarget, serverCode }
          };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'get_blocked_message', err);
      callback({ error: 'Failed to load blocked message.' });
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

  socket.on('get_room_details', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return callback({ error: 'Invalid input format.' });
    const serverCode = normalizeServerCode(data.serverCode);
    if (!serverCode) return callback({ error: 'Invalid input format.' });
    try {
      const result = await withAccountTransitionLock(socket.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel, username: socket.username, serverCode
          });
          if (!access.allowed || access.restriction.banned) return { error: 'Permission denied.' };
          return { success: true, ...safeRoomDetails(access.room, canEditRoomDetails({ serverCode, access })) };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'get_room_details', err);
      callback({ error: 'Failed to load room details.' });
    }
  });

  socket.on('update_room_details', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return callback({ error: 'Invalid input format.' });
    const serverCode = normalizeServerCode(data.serverCode);
    const description = normalizeRoomText(data.description, 500);
    const rules = normalizeRoomText(data.rules, 2000);
    if (!serverCode || description === null || rules === null) return callback({ error: 'Invalid input format.' });
    try {
      const result = await withAccountTransitionLock(socket.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel, username: socket.username, serverCode
          });
          if (!access.allowed || access.restriction.banned || !canEditRoomDetails({ serverCode, access })) {
            return { error: 'Permission denied.' };
          }
          const storedVersion = access.room.metadataVersion;
          const currentVersion = storedVersion === undefined ? 0 :
            (Number.isInteger(storedVersion) && storedVersion >= 0 ? storedVersion : null);
          if (currentVersion === null) return { error: 'Room details changed. Reload and try again.' };
          const currentDescription = typeof access.room.description === 'string' ? access.room.description : '';
          const currentRules = typeof access.room.rules === 'string' ? access.room.rules : '';
          if (description === currentDescription && rules === currentRules) {
            return { success: true, ...safeRoomDetails(access.room, true) };
          }
          const versionPredicate = currentVersion === 0
            ? { $or: [{ metadataVersion: 0 }, { metadataVersion: { $exists: false } }] }
            : { metadataVersion: currentVersion };
          const updated = await ChatServerModel.findOneAndUpdate(
            { code: serverCode, ...versionPredicate },
            { $set: { description, rules }, $inc: { metadataVersion: 1 } },
            { new: true }
          );
          if (!updated) return { error: 'Room details changed. Reload and try again.' };
          const descriptionChanged = description !== currentDescription;
          const rulesChanged = rules !== currentRules;
          await appendAuditReliably({
            correlationId: new mongoose.Types.ObjectId().toString(),
            action: 'room_details_update',
            serverCode,
            actorUsername: access.user.username,
            actorRole: access.user.role || 'user',
            actorRoomRole: currentRoomRole(access.room, access.user.username),
            reason: 'Updated room details',
            metadata: { descriptionChanged, rulesChanged, descriptionLength: description.length, rulesLength: rules.length }
          });
          await emitRoomDetailsUpdated(serverCode, updated);
          return { success: true, ...safeRoomDetails(updated, true) };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'update_room_details', err);
      callback({ error: 'Failed to update room details.' });
    }
  });

  socket.on('list_pinned_messages', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const clientContextId = normalizeClientContextId(data.clientContextId);
    if (!serverCode || clientContextId === null) return callback({ error: 'Invalid input format.' });
    if (serverCode !== socket.serverCode) return callback({ error: 'Permission denied.' });
    try {
      const result = await withAccountTransitionLock(socket.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel, username: socket.username, serverCode
          });
          if (socket.serverCode !== serverCode || !access.allowed || access.restriction.banned ||
              !access.user || !access.room) {
            return { error: 'Permission denied.' };
          }
          const { snapshot: blockState, blockedUserKeys } = await loadDurableBlockState(access.user.username);
          const snapshot = await visiblePinSnapshot({
            room: access.room, blockedUserKeys, blockVersion: blockState.blockVersion
          });
          return { success: true, ...snapshot };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'list_pinned_messages', err);
      callback({ error: 'Failed to load pinned messages.' });
    }
  });

  socket.on('set_message_pin', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const rawMessageId = typeof data.messageId === 'string' ? data.messageId : '';
    const messageId = rawMessageId.toLowerCase();
    const clientContextId = normalizeClientContextId(data.clientContextId);
    if (!serverCode || !isValidObjectId(rawMessageId) || typeof data.pinned !== 'boolean' ||
        clientContextId === null) return callback({ error: 'Invalid input format.' });
    if (serverCode !== socket.serverCode) return callback({ error: 'Permission denied.' });

    try {
      const result = await withAccountTransitionLock(socket.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel, username: socket.username, serverCode
          });
          if (socket.serverCode !== serverCode || !canManagePins({ serverCode, access })) {
            return { error: 'Permission denied.' };
          }
          const target = await MessageModel.findById(messageId);
          const targetAuthorKey = authorKeyForMessage(target);
          if (!target || target.deleted || target.serverCode !== serverCode || !targetAuthorKey) {
            return { error: 'Permission denied.' };
          }

          let observedRoom = access.room;
          let updatedRoom = null;
          let changed = false;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (!observedRoom) return { error: 'Pin state changed. Reload and try again.' };
            const pinnedMessages = Array.isArray(observedRoom.pinnedMessages) ? observedRoom.pinnedMessages : [];
            const alreadyPinned = pinnedMessages.some(pin =>
              String(pin && pin.messageId || '').toLowerCase() === messageId);
            if (alreadyPinned === data.pinned) {
              updatedRoom = observedRoom;
              break;
            }
            if (data.pinned && pinnedMessages.length >= 20) return { error: 'Pin limit reached.' };
            const storedVersion = observedRoom.pinVersion;
            const pinVersion = storedVersion === undefined ? 0
              : (Number.isInteger(storedVersion) && storedVersion >= 0 ? storedVersion : null);
            if (pinVersion === null) return { error: 'Pin state changed. Reload and try again.' };
            const versionPredicate = pinVersion === 0
              ? { $or: [{ pinVersion: 0 }, { pinVersion: { $exists: false } }] }
              : { pinVersion };
            const statePredicate = data.pinned
              ? { 'pinnedMessages.messageId': { $ne: messageId } }
              : { 'pinnedMessages.messageId': messageId };
            const update = data.pinned
              ? { $push: { pinnedMessages: {
                messageId, pinnedAt: new Date(), pinnedBy: access.user.username
              } }, $inc: { pinVersion: 1 } }
              : { $pull: { pinnedMessages: { messageId } }, $inc: { pinVersion: 1 } };
            updatedRoom = await ChatServerModel.findOneAndUpdate(
              { code: serverCode, ...versionPredicate, ...statePredicate },
              update,
              { new: true }
            );
            if (updatedRoom) {
              changed = true;
              break;
            }
            observedRoom = await ChatServerModel.findOne({ code: serverCode });
          }
          if (!updatedRoom) {
            const alreadyPinned = Array.isArray(observedRoom && observedRoom.pinnedMessages) &&
              observedRoom.pinnedMessages.some(pin =>
                String(pin && pin.messageId || '').toLowerCase() === messageId);
            if (alreadyPinned !== data.pinned) return { error: 'Pin state changed. Reload and try again.' };
            updatedRoom = observedRoom;
          }

          if (changed) {
            await appendAuditReliably({
              correlationId: new mongoose.Types.ObjectId().toString(),
              action: data.pinned ? 'pin_message' : 'unpin_message',
              serverCode,
              actorUsername: access.user.username,
              actorRole: access.user.role || 'user',
              actorRoomRole: currentRoomRole(access.room, access.user.username),
              targetUsername: normalizeUsername(target.username) || targetAuthorKey,
              targetRole: typeof target.role === 'string' ? target.role : 'user',
              targetRoomRole: typeof target.roomRole === 'string' ? target.roomRole : 'user',
              messageId,
              reason: data.pinned ? 'Pinned message' : 'Unpinned message',
              metadata: {}
            });
            await emitMessagePinUpdated({
              serverCode, messageId, pinned: data.pinned, room: updatedRoom, targetAuthorKey
            });
          }
          const { snapshot: blockState, blockedUserKeys } = await loadDurableBlockState(access.user.username);
          const pin = await visiblePinCountSnapshot({
            room: updatedRoom, blockedUserKeys, blockVersion: blockState.blockVersion
          });
          return { success: true, messageId, pinned: data.pinned, pin };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'set_message_pin', err);
      callback({ error: 'Failed to update pin.' });
    }
  });

  socket.on('update_room_notification', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const level = normalizeNotificationLevel(data.level);
    if (!serverCode || !level) return callback({ error: 'Invalid input format.' });

    try {
      await withAccountTransitionLock(socket.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel, username: socket.username, serverCode
          });
          const actualMember = Array.isArray(access.user?.servers) &&
            access.user.servers.includes(serverCode);
          if (!access.allowed || access.restriction.banned || !access.user || !actualMember) {
            callback({ error: 'Permission denied.' });
            return;
          }

          const usernameKey = normalizeAccountKey(access.user.username);
          const { blockedUserKeys } = await loadDurableBlockState(usernameKey);
          const current = await ensureRoomState({ usernameKey, serverCode });
          const changed = normalizeNotificationLevel(current.notificationLevel) !== level;
          if (changed) {
            const currentVersion = Number.isInteger(current.version) && current.version >= 0
              ? current.version : 0;
            const versionPredicate = currentVersion === 0
              ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
              : { version: currentVersion };
            const updated = await RoomMemberStateModel.findOneAndUpdate(
              { usernameKey, serverCode, ...versionPredicate },
              { $set: { notificationLevel: level }, $inc: { version: 1 } },
              { new: true }
            );
            if (!updated) throw new Error('Room notification compare-and-set failed.');
          }

          const snapshot = await loadRoomStateSnapshot({
            usernameKey, serverCode, blockedUserKeys
          });
          if (changed) {
            const liveSockets = await fetchLiveSockets();
            for (const live of liveSockets) {
              const session = onlineUsersMap.get(live.id);
              if (normalizeAccountKey(live.username || session?.username) === usernameKey) {
                live.emit('room_notification_updated', snapshot);
              }
            }
          }
          callback(snapshot);
        })
      );
    } catch (err) {
      logUnexpectedError(logger, 'update_room_notification', err);
      callback({ error: 'Notification update failed.' });
    }
  });

  socket.on('mark_room_read', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const rawMessageId = typeof data.messageId === 'string' ? data.messageId : '';
    const messageId = rawMessageId.toLowerCase();
    if (!serverCode || !isValidObjectId(rawMessageId)) {
      return callback({ error: 'Invalid input format.' });
    }
    if (normalizeServerCode(socket.serverCode) !== serverCode) {
      return callback({ error: 'Permission denied.' });
    }

    const actorUsername = socket.username;
    try {
      const snapshot = await withAccountTransitionLock(actorUsername, () =>
        withRoomMutationLock(serverCode, async () => {
          if (normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
              normalizeServerCode(socket.serverCode) !== serverCode) {
            return { error: 'Permission denied.' };
          }
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel, username: actorUsername, serverCode
          });
          const actualMember = Array.isArray(access.user?.servers) && access.user.servers.includes(serverCode);
          if (!access.allowed || access.restriction.banned || !access.user || !access.room || !actualMember) {
            return { error: 'Permission denied.' };
          }

          const target = await MessageModel.findById(messageId);
          const storedServerCode = target?.serverCode;
          const targetMatchesRoom = serverCode === 'global'
            ? storedServerCode === 'global' || storedServerCode === null || storedServerCode === undefined
            : storedServerCode === serverCode;
          const targetCursor = cursorFromMessage(target);
          if (!target || !targetMatchesRoom || !targetCursor || !authorKeyForMessage(target)) {
            return { error: 'Permission denied.' };
          }

          const usernameKey = normalizeAccountKey(access.user.username);
          const observed = await ensureRoomState({ usernameKey, serverCode });
          const observedCursor = {
            lastReadAt: observed.lastReadAt || null,
            lastReadMessageId: observed.lastReadMessageId || null
          };
          if (compareCursor(observedCursor, targetCursor) < 0) {
            const currentVersion = Number.isInteger(observed.version) && observed.version >= 0
              ? observed.version : 0;
            const versionPredicate = currentVersion === 0
              ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
              : { version: currentVersion };
            const updated = await RoomMemberStateModel.findOneAndUpdate(
              { usernameKey, serverCode, ...versionPredicate },
              { $set: {
                lastReadAt: targetCursor.lastReadAt,
                lastReadMessageId: targetCursor.lastReadMessageId
              }, $inc: { version: 1 } },
              { new: true }
            );
            if (!updated) throw new Error('Room read compare-and-set failed.');
          }

          const { blockedUserKeys } = await loadDurableBlockState(usernameKey);
          const complete = await loadRoomStateSnapshot({ usernameKey, serverCode, blockedUserKeys });
          const liveSockets = await fetchLiveSockets();
          for (const live of liveSockets) {
            const session = onlineUsersMap.get(live.id);
            if (normalizeAccountKey(live.username || session?.username) === usernameKey) {
              live.emit('room_read_updated', complete);
            }
          }
          return complete;
        })
      );
      callback(snapshot);
    } catch (err) {
      logUnexpectedError(logger, 'mark_room_read', err);
      callback({ error: 'Read update failed.' });
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
        if (action === 'promote_global_admin' || action === 'demote_global_admin') {
            if (action === 'demote_global_admin' && normalizeAccountKey(targetUser) === 'nyzhang1') {
              return callback({ error: 'Cannot modify system owner.' });
            }
            const result = await withAccountTransitionLocks([socket.username, targetUser], async () => {
                const [actorUser, targetUserDoc] = await Promise.all([
                  findUserByUsername(UserModel, socket.username),
                  findUserByUsername(UserModel, targetUser)
                ]);
                if (!actorUser || actorUser.role !== 'admin') return { error: 'Only Global Admins can modify global roles.' };
                if (!targetUserDoc) return { error: 'User not found.' };

                const targetDisp = targetUserDoc.displayName || targetUserDoc.username;
                targetUserDoc.role = action === 'promote_global_admin' ? 'admin' : 'user';
                await targetUserDoc.save();

                const [sockets, access] = await Promise.all([
                  fetchLiveSockets(),
                  loadAccountSessionAccess(targetUserDoc)
                ]);
                const normalizedTarget = normalizeAccountKey(targetUserDoc.username);
                const targetSockets = [];
                const invalidActiveRooms = new Set();
                for (const live of sockets) {
                  const session = onlineUsersMap.get(live.id);
                  if (normalizeAccountKey(live.username || session?.username) !== normalizedTarget) continue;
                  live.role = targetUserDoc.role;
                  if (session) session.role = targetUserDoc.role;
                  targetSockets.push({ live, session });
                  const activeRoom = live.serverCode ?? session?.serverCode ?? null;
                  if (targetUserDoc.role !== 'admin' && activeRoom && !access.authoritativeMemberships.includes(activeRoom)) {
                    invalidActiveRooms.add(activeRoom);
                  }
                }
                for (const session of onlineUsersMap.values()) {
                  if (normalizeAccountKey(session?.username) !== normalizedTarget) continue;
                  session.role = targetUserDoc.role;
                  if (targetUserDoc.role !== 'admin' && session.serverCode &&
                      !access.authoritativeMemberships.includes(session.serverCode)) {
                    invalidActiveRooms.add(session.serverCode);
                  }
                }

                const reconciliation = await reconcileAccountSessions({
                  sockets,
                  username: targetUserDoc.username,
                  joinedServers: access.authoritativeMemberships,
                  bannedRooms: access.activeBannedRooms,
                  removedRooms: [...invalidActiveRooms],
                  fallbackCode: invalidActiveRooms.size > 0 ? access.fallbackCode : null,
                  notifyAccess: false
                });
                let roleSyncFailed = !reconciliation.transportSynchronized;

                for (const { live, session } of targetSockets) {
                  if (!live.username) continue;
                  try {
                    live.emit('global_role_updated', { username: targetUserDoc.username, role: targetUserDoc.role });
                    if (invalidActiveRooms.size > 0) {
                      live.emit('room_access_updated', {
                        username: targetUserDoc.username,
                        joinedServers: [...access.authoritativeMemberships],
                        serverCode: live.serverCode ?? session?.serverCode ?? null,
                        bannedRooms: [...access.activeBannedRooms]
                      });
                    }
                  } catch (err) {
                    roleSyncFailed = true;
                    logUnexpectedError(logger, 'manage_role_notification', err);
                  }
                }

                ioInstance.emit('system_message', `${socket.displayName} ${action === 'promote_global_admin' ? 'promoted' : 'demoted'} ${targetDisp} ${action === 'promote_global_admin' ? 'to' : 'from'} Global Admin.`);
                const roomsToUpdate = new Set(access.authoritativeMemberships);
                if (access.fallbackCode) roomsToUpdate.add(access.fallbackCode);
                roomsToUpdate.forEach(code => broadcastOnlineUsersFn(code));
                return roleSyncFailed ? { error: 'Failed to manage role.' } : { success: true };
            });
            return callback(result);
        }

        const serverCode = normalizeServerCode(data.serverCode);
        if (!serverCode || serverCode === 'global') return callback({ error: 'Invalid input format.' });
        const result = await withAccountTransitionLocks([socket.username, targetUser], () =>
          withRoomMutationLock(serverCode, async () => {
            const [actorUser, targetUserDoc, srv, actorRestriction] = await Promise.all([
              findUserByUsername(UserModel, socket.username),
              findUserByUsername(UserModel, targetUser),
              ChatServerModel.findOne({ code: serverCode }),
              RoomRestrictionModel.findOne({
                serverCode,
                username: normalizeAccountKey(socket.username)
              })
            ]);
            if (!targetUserDoc) return { error: 'User not found.' };
            if (!srv) return { error: 'Server not found.' };
            const isGlobalAdmin = actorUser?.role === 'admin';
            const isRoomMod = isCurrentRoomModerator(srv, actorUser?.username);
            const isCurrentMember = Array.isArray(actorUser?.servers) && actorUser.servers.includes(serverCode);
            const actorRestrictionState = activeRestrictionState(actorRestriction);
            const targetDisp = targetUserDoc.displayName || targetUserDoc.username;

            if (!actorUser || actorRestrictionState.banned) {
              return { error: 'Permission denied.' };
            }

            if (action === 'promote_mod') {
              if (!isGlobalAdmin && (!isRoomMod || !isCurrentMember ||
                  actorRestrictionState.banned || actorRestrictionState.timedOut)) {
                return { error: 'Permission denied.' };
              }
              if (!Array.isArray(targetUserDoc.servers) || !targetUserDoc.servers.includes(serverCode)) {
                return { error: 'Target user is not a room member.' };
              }
              if (!isCurrentRoomModerator(srv, targetUserDoc.username)) {
                if (!Array.isArray(srv.moderators)) srv.moderators = [];
                srv.moderators.push(targetUserDoc.username);
                await srv.save();
                ioInstance.to(serverCode).emit('system_message', `${socket.displayName} promoted ${targetDisp} to Room Moderator.`);
              }
            } else if (action === 'demote_mod') {
              if (!isGlobalAdmin) return { error: 'Only Global Admins can remove moderator roles.' };
              srv.moderators = (Array.isArray(srv.moderators) ? srv.moderators : [])
                .filter(username => normalizeAccountKey(username) !== normalizeAccountKey(targetUserDoc.username));
              await srv.save();
              ioInstance.to(serverCode).emit('system_message', `${socket.displayName} removed ${targetDisp}'s Room Moderator role.`);
            }
            broadcastOnlineUsersFn(serverCode);
            ioInstance.to(serverCode).emit('room_role_updated', {
              username: targetUserDoc.username,
              targetServer: serverCode
            });
            return { success: true };
          })
        );
        callback(result);
    } catch (err) {
        logUnexpectedError(logger, 'manage_role', err);
        callback({ error: 'Failed to manage role.' });
    }
  });

  socket.on('moderate_user', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const targetInput = normalizeUsername(data.targetUser);
    const action = normalizeModerationAction(data.action);
    const reason = normalizeModerationReason(data.reason);
    const duration = action === 'timeout' && typeof data.duration === 'string'
      ? data.duration.trim().toLowerCase()
      : null;
    if (!serverCode || !targetInput || !action || !reason ||
        (action === 'timeout' && !Object.prototype.hasOwnProperty.call(MODERATION_DURATIONS, duration))) {
      return callback({ error: 'Invalid input format.' });
    }

    try {
      const initialTarget = await findUserByUsername(UserModel, targetInput);
      if (!initialTarget) return callback({ error: 'Permission denied.' });
      const canonicalTargetUsername = initialTarget.username;
      const result = await withAccountTransitionLocks(
        [socket.username, canonicalTargetUsername],
        () => withRoomMutationLock(serverCode, async () => {
          const [actorUser, targetUser, room] = await Promise.all([
            findUserByUsername(UserModel, socket.username),
            findUserByUsername(UserModel, canonicalTargetUsername),
            ChatServerModel.findOne({ code: serverCode })
          ]);
          if (!canModerateTarget({ serverCode, action, actorUser, targetUser, room })) {
            return { error: 'Permission denied.' };
          }

          const [restriction, actorRestriction] = await Promise.all([
            RoomRestrictionModel.findOne({
              serverCode,
              username: normalizeAccountKey(targetUser.username)
            }),
            RoomRestrictionModel.findOne({
              serverCode,
              username: normalizeAccountKey(actorUser.username)
            })
          ]);
          const actorState = activeRestrictionState(actorRestriction);
          const actorIsAdmin = actorUser.role === 'admin';
          const actorIsCurrentMember = Array.isArray(actorUser.servers) && actorUser.servers.includes(serverCode);
          if (actorState.banned ||
              (!actorIsAdmin && (!actorIsCurrentMember || actorState.timedOut))) {
            return { error: 'Permission denied.' };
          }
          const actorRoomRole = isCurrentRoomModerator(room, actorUser.username) ? 'mod' : 'user';
          const targetRoomRole = isCurrentRoomModerator(room, targetUser.username) ? 'mod' : 'user';
          const currentState = activeRestrictionState(restriction);
          const memberships = Array.isArray(targetUser.servers) ? targetUser.servers : [];
          const isCurrentMember = memberships.includes(serverCode);
          const wasCurrentModerator = targetRoomRole === 'mod';
          if (serverCode !== 'global' &&
              (action === 'kick' || action === 'timeout' || action === 'ban') &&
              !isCurrentMember) {
            return { error: 'Permission denied.' };
          }
          if (action === 'timeout' && currentState.banned) return { error: 'Permission denied.' };
          if (action === 'ban' && currentState.banned) return { error: 'Permission denied.' };
          if (action === 'clear_timeout' && !currentState.timedOut) return { error: 'Permission denied.' };
          if (action === 'unban' && !currentState.banned) return { error: 'Permission denied.' };

          const liveSockets = await fetchLiveSockets();
          const now = new Date();
          let expiresAt = null;
          let updatedRestriction = restriction;
          const removesPrivateMembership = serverCode !== 'global' &&
            (action === 'kick' || action === 'ban');
          const enforcesPrivateAbsence = removesPrivateMembership ||
            (serverCode !== 'global' && action === 'unban');
          const transactionConnection = sharedTransactionConnection([
            UserModel, ChatServerModel, RoomRestrictionModel
          ]);
          try {
            if (action === 'unban' && serverCode === 'global') {
              await advanceRoomCursorToNewest({
                usernameKey: targetUser.username,
                serverCode
              });
            }
            const persisted = await runPersistence(async session => {
              const restrictionOptions = extra => ({
                ...extra,
                ...(session ? { session } : {})
              });
              let persistentTarget = targetUser;
              let persistentRoom = room;
              if (enforcesPrivateAbsence && session) {
                persistentTarget = await findUserByUsername(
                  UserModel,
                  targetUser.username,
                  { session }
                );
                persistentRoom = await applyQuerySession(
                  ChatServerModel.findOne({ code: serverCode }),
                  session
                );
                if (!persistentTarget || !persistentRoom) {
                  throw new Error('Moderation persistence target disappeared.');
                }
              }

              let persistedRestriction = restriction;
              if (action === 'timeout') {
                expiresAt = new Date(now.getTime() + MODERATION_DURATIONS[duration]);
                persistedRestriction = await RoomRestrictionModel.findOneAndUpdate(
                  { serverCode, username: normalizeAccountKey(targetUser.username) },
                  { $set: {
                    timeoutUntil: expiresAt,
                    timeoutBy: actorUser.username,
                    timeoutReason: reason
                  } },
                  restrictionOptions({ upsert: true, new: true, setDefaultsOnInsert: true })
                );
              } else if (action === 'ban') {
                persistedRestriction = await RoomRestrictionModel.findOneAndUpdate(
                  { serverCode, username: normalizeAccountKey(targetUser.username) },
                  { $set: {
                    bannedAt: now,
                    bannedBy: actorUser.username,
                    banReason: reason,
                    timeoutUntil: null,
                    timeoutBy: null,
                    timeoutReason: null
                  } },
                  restrictionOptions({ upsert: true, new: true, setDefaultsOnInsert: true })
                );
              } else if (action === 'clear_timeout') {
                persistedRestriction = await RoomRestrictionModel.findOneAndUpdate(
                  { serverCode, username: normalizeAccountKey(targetUser.username) },
                  { $set: { timeoutUntil: null, timeoutBy: null, timeoutReason: null } },
                  restrictionOptions({ new: true })
                );
              }

              if (enforcesPrivateAbsence) {
                persistentTarget.servers = (Array.isArray(persistentTarget.servers)
                  ? persistentTarget.servers : [])
                  .filter(code => code !== serverCode);
                persistentRoom.moderators = (Array.isArray(persistentRoom.moderators)
                  ? persistentRoom.moderators : [])
                  .filter(username => normalizeAccountKey(username) !== normalizeAccountKey(targetUser.username));
                if (session) await persistentTarget.save({ session });
                else await persistentTarget.save();
                if (session) await persistentRoom.save({ session });
                else await persistentRoom.save();
              }

              if (action === 'unban') {
                persistedRestriction = await RoomRestrictionModel.findOneAndUpdate(
                  { serverCode, username: normalizeAccountKey(targetUser.username) },
                  { $set: { bannedAt: null, bannedBy: null, banReason: null } },
                  restrictionOptions({ new: true })
                );
              }

              return {
                restriction: persistedRestriction,
                servers: Array.isArray(persistentTarget.servers) ? [...persistentTarget.servers] : [],
                moderators: Array.isArray(persistentRoom.moderators) ? [...persistentRoom.moderators] : []
              };
            }, transactionConnection);
            updatedRestriction = persisted.restriction;
            if (enforcesPrivateAbsence) {
              targetUser.servers = persisted.servers;
              room.moderators = persisted.moderators;
            }
          } catch (persistenceError) {
            const quarantinePending = action === 'ban' || enforcesPrivateAbsence
              ? quarantineAccountSessions(liveSockets, targetUser.username, [serverCode])
              : Promise.resolve();
            if (!transactionConnection) {
              if (action === 'ban') {
                try {
                  updatedRestriction = await RoomRestrictionModel.findOneAndUpdate(
                    { serverCode, username: normalizeAccountKey(targetUser.username) },
                    { $set: {
                      bannedAt: now,
                      bannedBy: actorUser.username,
                      banReason: reason,
                      timeoutUntil: null,
                      timeoutBy: null,
                      timeoutReason: null
                    } },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                  );
                } catch (repairRestrictionError) {
                  logUnexpectedError(logger, 'moderation_restriction_repair', repairRestrictionError);
                }
              } else if (serverCode !== 'global' && action === 'unban') {
                try {
                  updatedRestriction = await RoomRestrictionModel.findOneAndUpdate(
                    { serverCode, username: normalizeAccountKey(targetUser.username) },
                    { $set: {
                      bannedAt: restriction.bannedAt || now,
                      bannedBy: restriction.bannedBy || actorUser.username,
                      banReason: restriction.banReason || 'Restriction retained after failed unban'
                    } },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                  );
                } catch (repairRestrictionError) {
                  logUnexpectedError(logger, 'moderation_restriction_repair', repairRestrictionError);
                }
              }
              if (enforcesPrivateAbsence) {
                const invariantRepaired = await repairPrivateRemovalInvariant({
                  targetUser,
                  room,
                  serverCode
                });
                if (!invariantRepaired) {
                  let shouldRestoreSnapshot = action === 'kick';
                  if (action === 'ban') {
                    try {
                      const verifiedRestriction = await RoomRestrictionModel.findOne({
                        serverCode,
                        username: normalizeAccountKey(targetUser.username)
                      });
                      shouldRestoreSnapshot = !activeRestrictionState(verifiedRestriction).banned;
                    } catch (verifyRestrictionError) {
                      shouldRestoreSnapshot = true;
                      logUnexpectedError(
                        logger,
                        'moderation_restriction_verification',
                        verifyRestrictionError
                      );
                    }
                  }
                  if (shouldRestoreSnapshot) {
                    const snapshotRestored = await restorePrivateAccessSnapshot({
                      targetUser,
                      room,
                      serverCode,
                      wasMember: isCurrentMember,
                      wasModerator: wasCurrentModerator
                    });
                    if (!snapshotRestored) {
                      await establishFailClosedPrivateBan({
                        targetUser,
                        serverCode,
                        actorUsername: actorUser.username
                      });
                    }
                  }
                }
              }
            }
            await quarantinePending;
            throw persistenceError;
          }

          const access = await loadAccountSessionAccess(targetUser);
          const removedRoom = action === 'kick' || action === 'ban' ? serverCode : null;
          const reconciliation = await reconcileRestrictedAccount({
            username: targetUser.username,
            removedRoom,
            fallbackCode: access.fallbackCode,
            liveSockets,
            user: targetUser,
            restrictions: access.restrictions
          });
          const restrictionState = activeRestrictionState(updatedRestriction);
          const correlationId = new mongoose.Types.ObjectId().toString();
          await appendAuditReliably({
            correlationId,
            action,
            serverCode,
            actorUsername: actorUser.username,
            actorRole: actorUser.role || 'user',
            actorRoomRole,
            targetUsername: targetUser.username,
            targetRole: targetUser.role || 'user',
            targetRoomRole,
            reason,
            duration,
            expiresAt,
            metadata: {
              transportSynchronized: reconciliation.transportSynchronized,
              removedRoom,
              fallbackCode: access.fallbackCode
            }
          });

          emitModerationSessionUpdates({
            reconciliation,
            username: targetUser.username,
            restrictionState,
            serverCode
          });
          if (action === 'kick' || action === 'ban') {
            ioInstance.to(serverCode).emit('system_message', 'A member was removed by moderation.');
          }
          const presenceRooms = new Set([serverCode]);
          if (access.fallbackCode) presenceRooms.add(access.fallbackCode);
          for (const roomCode of presenceRooms) {
            try {
              await Promise.resolve(broadcastOnlineUsersFn(roomCode));
            } catch (err) {
              logUnexpectedError(logger, 'moderation_presence_broadcast', err);
            }
          }
          return { success: true };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'moderate_user', err);
      callback({ error: 'Moderation failed.' });
    }
  });

  socket.on('report_moderation_target', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const targetInput = normalizeUsername(data.targetUser);
    const reason = normalizeModerationReason(data.reason, 300);
    const messageId = data.messageId === undefined || data.messageId === null
      ? null
      : data.messageId;
    if (!serverCode || !targetInput || !reason || (messageId !== null && !isValidObjectId(messageId))) {
      return callback({ error: 'Invalid input format.' });
    }

    try {
      const initialReporter = await findUserByUsername(UserModel, socket.username);
      if (!initialReporter) return callback({ error: 'Permission denied.' });
      const result = await withAccountTransitionLock(initialReporter.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const [access, targetUser] = await Promise.all([
            loadRoomAccessState({
              UserModel,
              ChatServerModel,
              RoomRestrictionModel,
              username: initialReporter.username,
              serverCode
            }),
            findUserByUsername(UserModel, targetInput)
          ]);
          if (!access.allowed || access.restriction.banned || !targetUser) {
            return { error: 'Permission denied.' };
          }
          if (serverCode !== 'global' &&
              targetUser.role !== 'admin' &&
              (!Array.isArray(targetUser.servers) || !targetUser.servers.includes(serverCode))) {
            return { error: 'Permission denied.' };
          }

          if (messageId) {
            const message = await MessageModel.findById(messageId);
            if (!message || message.serverCode !== serverCode ||
                normalizeAccountKey(message.username) !== normalizeAccountKey(targetUser.username)) {
              return { error: 'Permission denied.' };
            }
          }

          const duplicateQuery = {
            reporterUsername: access.user.username,
            serverCode,
            targetUsername: targetUser.username,
            messageId,
            status: 'open'
          };
          if (await ModerationReportModel.findOne(duplicateQuery)) {
            return { error: 'Duplicate report.' };
          }
          const rollingStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const recentCount = await ModerationReportModel.countDocuments({
            reporterUsername: access.user.username,
            createdAt: { $gt: rollingStart }
          });
          if (recentCount >= 10) return { error: 'Too many reports.' };

          try {
            await ModerationReportModel.create({
              serverCode,
              reporterUsername: access.user.username,
              targetUsername: targetUser.username,
              messageId,
              reason,
              status: 'open'
            });
          } catch (err) {
            if (err && err.code === 11000) return { error: 'Duplicate report.' };
            throw err;
          }
          await emitModerationQueueUpdated(serverCode);
          return { success: true };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'report_moderation_target', err);
      callback({ error: 'Report failed.' });
    }
  });

  socket.on('list_moderation_reports', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const status = !Object.prototype.hasOwnProperty.call(data, 'status')
      ? 'open'
      : (typeof data.status === 'string' ? data.status.trim().toLowerCase() : null);
    const limit = normalizePageLimit(data.limit);
    const cursorResult = paginationCursor(data);
    if (!serverCode || !['open', 'resolved', 'dismissed'].includes(status) || !limit || cursorResult.error) {
      return callback({ error: 'Invalid input format.' });
    }

    try {
      await deliverModeratorRead(serverCode, callback, async () => {
        const query = { serverCode, status };
        if (cursorResult.cursor) {
          query.$or = [
            { createdAt: { $lt: cursorResult.cursor.date } },
            { createdAt: cursorResult.cursor.date, _id: { $lt: cursorResult.cursor.id } }
          ];
        }
        const rows = await ModerationReportModel.find(query)
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .select('_id serverCode reporterUsername targetUsername messageId reason status resolvedBy resolution resolvedAt createdAt');
        const { page, nextCursor } = nextPage(rows, limit);
        return { items: page.map(safeReportRow), nextCursor };
      });
    } catch (err) {
      logUnexpectedError(logger, 'list_moderation_reports', err);
      callback({ error: 'Failed to list reports.' });
    }
  });

  socket.on('resolve_moderation_report', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const reportId = typeof data.reportId === 'string' ? data.reportId : null;
    const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : null;
    const resolution = normalizeModerationReason(data.resolution, 300);
    if (!serverCode || !isValidObjectId(reportId) ||
        !['resolved', 'dismissed'].includes(status) || !resolution) {
      return callback({ error: 'Invalid input format.' });
    }

    try {
      const initialActor = await findUserByUsername(UserModel, socket.username);
      if (!initialActor) return callback({ error: 'Permission denied.' });
      const result = await withAccountTransitionLock(initialActor.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const access = await loadModeratorAccess(serverCode, initialActor.username);
          if (!access) return { error: 'Permission denied.' };
          const report = await ModerationReportModel.findOne({
            _id: reportId,
            serverCode,
            status: 'open'
          });
          if (!report) return { error: 'Report unavailable.' };

          const targetUser = await findUserByUsername(UserModel, report.targetUsername);
          const now = new Date();
          report.status = status;
          report.resolvedBy = access.user.username;
          report.resolution = resolution;
          report.resolvedAt = now;
          await report.save();

          await appendAuditReliably({
            correlationId: new mongoose.Types.ObjectId().toString(),
            action: 'resolve_report',
            serverCode,
            actorUsername: access.user.username,
            actorRole: access.user.role || 'user',
            actorRoomRole: isCurrentRoomModerator(access.room, access.user.username) ? 'mod' : 'user',
            targetUsername: report.targetUsername,
            targetRole: targetUser?.role || 'user',
            targetRoomRole: isCurrentRoomModerator(access.room, report.targetUsername) ? 'mod' : 'user',
            reason: resolution,
            reportId,
            metadata: { status }
          });
          await emitModerationQueueUpdated(serverCode);
          return { success: true };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'resolve_moderation_report', err);
      callback({ error: 'Resolution failed.' });
    }
  });

  socket.on('list_room_restrictions', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const targetInput = data.targetUser === undefined || data.targetUser === null
      ? null
      : normalizeUsername(data.targetUser);
    const limit = normalizePageLimit(data.limit);
    const cursorResult = paginationCursor(data);
    if (!serverCode || (data.targetUser !== undefined && data.targetUser !== null && !targetInput) ||
        !limit || cursorResult.error) {
      return callback({ error: 'Invalid input format.' });
    }

    try {
      await deliverModeratorRead(serverCode, callback, async () => {
        const now = new Date();
        const query = { serverCode };
        if (targetInput) query.username = normalizeAccountKey(targetInput);
        const clauses = [{
          $or: [
            { bannedAt: { $ne: null } },
            { timeoutUntil: { $gt: now } }
          ]
        }];
        if (cursorResult.cursor) {
          clauses.push({
            $or: [
              { createdAt: { $lt: cursorResult.cursor.date } },
              { createdAt: cursorResult.cursor.date, _id: { $lt: cursorResult.cursor.id } }
            ]
          });
        }
        query.$and = clauses;
        const rows = await RoomRestrictionModel.find(query)
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .select('_id username bannedAt bannedBy banReason timeoutUntil timeoutBy timeoutReason createdAt');
        const activeRows = rows.filter(row => {
          const state = activeRestrictionState(row, now);
          return state.banned || state.timedOut;
        });
        const { page, nextCursor } = nextPage(activeRows, limit);
        return { items: page.map(row => safeRestrictionRow(row, now)), nextCursor };
      });
    } catch (err) {
      logUnexpectedError(logger, 'list_room_restrictions', err);
      callback({ error: 'Failed to list restrictions.' });
    }
  });

  socket.on('get_moderation_audit', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const limit = normalizePageLimit(data.limit);
    const cursorResult = paginationCursor(data);
    if (!serverCode || !limit || cursorResult.error) {
      return callback({ error: 'Invalid input format.' });
    }

    try {
      await deliverModeratorRead(serverCode, callback, async () => {
        const query = { serverCode };
        if (cursorResult.cursor) {
          query.$or = [
            { createdAt: { $lt: cursorResult.cursor.date } },
            { createdAt: cursorResult.cursor.date, _id: { $lt: cursorResult.cursor.id } }
          ];
        }
        const rows = await ModerationAuditModel.find(query)
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .select('_id correlationId action serverCode actorUsername actorRole actorRoomRole targetUsername targetRole targetRoomRole reason duration expiresAt messageId reportId metadata createdAt');
        const { page, nextCursor } = nextPage(rows, limit);
        return { items: page.map(safeAuditRow), nextCursor };
      });
    } catch (err) {
      logUnexpectedError(logger, 'get_moderation_audit', err);
      callback({ error: 'Failed to load audit.' });
    }
  });

  socket.on('get_automod', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    if (!serverCode) return callback({ error: 'Invalid input format.' });
    try {
      await deliverModeratorRead(serverCode, callback, async access => {
        const autoMod = normalizeStoredAutoModSettings(access.room.autoMod);
        if (!autoMod) throw new Error('Invalid stored AutoMod state.');
        return { autoMod };
      });
    } catch (err) {
      logUnexpectedError(logger, 'get_automod', err);
      callback({ error: 'Failed to load AutoMod.' });
    }
  });

  socket.on('update_automod', async (data, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return callback({ error: 'Invalid input format.' });
    }
    const serverCode = normalizeServerCode(data.serverCode);
    const autoMod = normalizeAutoModSettings({
      blockedKeywords: data.blockedKeywords,
      mentionLimit: data.mentionLimit,
      repeatLimit: data.repeatLimit,
      repeatWindowSeconds: data.repeatWindowSeconds,
      messageLimit: data.messageLimit,
      messageWindowSeconds: data.messageWindowSeconds
    });
    if (!serverCode || !autoMod) return callback({ error: 'Invalid input format.' });

    try {
      const result = await withAccountTransitionLock(socket.username, () =>
        withRoomMutationLock(serverCode, async () => {
          const access = await loadRoomAccessState({
            UserModel,
            ChatServerModel,
            RoomRestrictionModel,
            username: socket.username,
            serverCode
          });
          if (!access.allowed || access.restriction.banned) return { error: 'Permission denied.' };
          const actorRoomRole = currentRoomRole(access.room, access.user.username);
          const authorized = access.user.role === 'admin' ||
            (serverCode !== 'global' && actorRoomRole === 'mod');
          if (!authorized) return { error: 'Permission denied.' };

          access.room.autoMod = autoMod;
          if (typeof access.room.markModified === 'function') access.room.markModified('autoMod');
          await access.room.save();
          await appendAuditReliably({
            correlationId: new mongoose.Types.ObjectId().toString(),
            action: 'update_automod',
            serverCode,
            actorUsername: access.user.username,
            actorRole: access.user.role || 'user',
            actorRoomRole,
            reason: 'Updated AutoMod settings',
            metadata: {
              keywordCount: autoMod.blockedKeywords.length,
              mentionLimit: autoMod.mentionLimit,
              repeatLimit: autoMod.repeatLimit,
              repeatWindowSeconds: autoMod.repeatWindowSeconds,
              messageLimit: autoMod.messageLimit,
              messageWindowSeconds: autoMod.messageWindowSeconds
            }
          });
          return { success: true, autoMod };
        })
      );
      callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'update_automod', err);
      callback({ error: 'Failed to update AutoMod.' });
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
      await withAccountTransitionLock(socket.username, () => withRoomMutationLock(srv.code, async () => {
        const user = await UserModel.findOne({ username: socket.username });
        if (!user) throw new Error('User not found.');
        if (!Array.isArray(user.servers) || user.servers.length === 0) user.servers = ['global'];

        if (!user.servers.includes(srv.code)) {
          await advanceRoomCursorToNewest({
            usernameKey: user.username || socket.username,
            serverCode: srv.code
          });
          if (typeof user.servers.addToSet === 'function') user.servers.addToSet(srv.code);
          else user.servers.push(srv.code);
          await user.save();

          let sockets = [socket];
          try {
            sockets = await fetchLiveSockets();
          } catch (err) {
            logUnexpectedError(logger, 'create_server_membership_sync', err);
          }
          const access = await loadAccountSessionAccess(user);
          await synchronizeMembership(sockets, socket.username, access.authoritativeMemberships, {
            bannedRooms: access.activeBannedRooms,
            fallbackCode: null
          });
          broadcastOnlineUsersFn(srv.code);
        }
      }));
      const creatorBlockState = await loadDurableBlockState(socket.username);
      const creatorPin = await visiblePinCountSnapshot({
        room: srv,
        blockedUserKeys: creatorBlockState.blockedUserKeys,
        blockVersion: creatorBlockState.snapshot.blockVersion
      });
      callback({ success: true, server: safeRoomSummary(srv, creatorPin) });

      try {
        const sockets = await ioInstance.fetchSockets();
        const recipientsByAccount = new Map();
        for (const live of sockets) {
          const session = onlineUsersMap.get(live.id);
          const username = normalizeUsername(live.username || session?.username);
          const accountKey = normalizeAccountKey(username);
          if (!session || !username || !accountKey) continue;
          if (!recipientsByAccount.has(accountKey)) {
            recipientsByAccount.set(accountKey, { username, sockets: [] });
          }
          recipientsByAccount.get(accountKey).sockets.push(live);
        }
        for (const [accountKey, recipient] of recipientsByAccount.entries()) {
          await withAccountTransitionLock(accountKey, () =>
            withRoomMutationLock(srv.code, async () => {
              const [freshUser, freshRoom] = await Promise.all([
                findUserByUsername(UserModel, recipient.username),
                ChatServerModel.findOne({ code: srv.code })
              ]);
              if (!freshUser || freshUser.role !== 'admin' || !freshRoom || freshRoom.code !== srv.code) return;
              for (const live of recipient.sockets) {
                let session = onlineUsersMap.get(live.id);
                if (!session || normalizeAccountKey(live.username || session.username) !== accountKey) continue;
                const blockedUserKeys = blockCacheForLiveSession(live, session);
                const pin = await visiblePinCountSnapshot({
                  room: freshRoom,
                  blockedUserKeys,
                  blockVersion: blockVersionForLiveSession(live, session)
                });
                session = onlineUsersMap.get(live.id);
                if (!session || normalizeAccountKey(live.username || session.username) !== accountKey) continue;
                live.emit('admin_new_server', safeRoomSummary(freshRoom, pin));
              }
            })
          );
        }
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
            await advanceRoomCursorToNewest({
              usernameKey: user.username,
              serverCode: srv.code
            });
            if (typeof user.servers.addToSet === 'function') user.servers.addToSet(srv.code);
            else user.servers.push(srv.code);
            await user.save();

            let sockets = [socket];
            try {
              sockets = await fetchLiveSockets();
            } catch (err) {
              logUnexpectedError(logger, 'join_server_membership_sync', err);
            }
            const access = await loadAccountSessionAccess(user);
            await synchronizeMembership(sockets, socket.username, access.authoritativeMemberships, {
              bannedRooms: access.activeBannedRooms,
              fallbackCode: null
            });

            broadcastOnlineUsersFn(srv.code);

            if (socket.serverCode === srv.code) {
                socket.to(srv.code).emit('system_message', `${socket.displayName} joined.`);
            }
          }
          const { snapshot: blockState, blockedUserKeys } = await loadDurableBlockState(user.username);
          const pin = await visiblePinCountSnapshot({
            room: srv, blockedUserKeys, blockVersion: blockState.blockVersion
          });
          return { success: true, server: safeRoomSummary(srv, pin) };
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
        const access = await loadAccountSessionAccess(user);
        const transportSynchronized = await synchronizeMembership(
          sockets,
          socket.username,
          access.authoritativeMemberships,
          {
            bannedRooms: access.activeBannedRooms,
            removedRoom: serverCode,
            fallbackCode: access.fallbackCode
          }
        );

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
        if (wasActive && access.fallbackCode) broadcastOnlineUsersFn(access.fallbackCode);
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
      const result = await withIdentityMutationLock(async () => {
        const sockets = await fetchLiveSockets();
        const sessionUsernames = new Map();
        for (const live of sockets) {
          const session = onlineUsersMap.get(live.id);
          const username = live.username || session?.username;
          const key = normalizeAccountKey(username);
          if (key && !sessionUsernames.has(key)) sessionUsernames.set(key, username);
        }
        for (const session of onlineUsersMap.values()) {
          const key = normalizeAccountKey(session?.username);
          if (key && !sessionUsernames.has(key)) sessionUsernames.set(key, session.username);
        }
        const actorKey = normalizeAccountKey(socket.username);
        if (actorKey) sessionUsernames.set(actorKey, socket.username);
        return withAccountTransitionLocks([...sessionUsernames.values()], () =>
          withRoomMutationLock(serverCode, async () => {
        const currentRoom = await ChatServerModel.findOne({ code: serverCode });
        if (!currentRoom) return { error: 'Server not found.' };
        const actorAccess = await loadRoomAccessState({
          UserModel,
          ChatServerModel,
          RoomRestrictionModel,
          username: socket.username,
          serverCode
        });
        const actorIsAdmin = actorAccess.user?.role === 'admin';
        const actorIsOwner = normalizeAccountKey(currentRoom.owner) ===
          normalizeAccountKey(actorAccess.user?.username);
        const actorIsMember = Array.isArray(actorAccess.user?.servers) &&
          actorAccess.user.servers.includes(serverCode);
        if (!actorAccess.user || actorAccess.restriction.banned ||
            (!actorIsAdmin && (!actorIsOwner || !actorIsMember || !actorAccess.allowed))) {
          return { error: 'Permission denied.' };
        }

        const freshAccessByAccount = new Map();
        if (typeof UserModel.findOne === 'function') {
          for (const [key, username] of sessionUsernames.entries()) {
            const user = await findUserByUsername(UserModel, username);
            if (!user) {
              freshAccessByAccount.set(key, {
                authoritativeMemberships: [],
                activeBannedRooms: [],
                fallbackCode: null
              });
              continue;
            }
            const access = await loadAccountSessionAccess(user);
            const activeBannedRooms = access.activeBannedRooms.filter(code => code !== serverCode);
            const authoritativeMemberships = access.authoritativeMemberships.filter(code => code !== serverCode);
            const fallbackCode = authoritativeMemberships.includes('global')
              ? 'global'
              : (authoritativeMemberships.find(code => code !== 'global') || null);
            freshAccessByAccount.set(key, {
              authoritativeMemberships,
              activeBannedRooms,
              fallbackCode
            });
          }
        }
        await ChatServerModel.deleteOne({ code: serverCode });

        let cleanupFailed = false;
        try {
          await RoomMemberStateModel.deleteMany({ serverCode });
        } catch (err) {
          cleanupFailed = true;
          logUnexpectedError(logger, 'delete_server_room_state_cleanup', err);
        }

        const affectedSockets = [];
        for (const live of sockets) {
          const session = onlineUsersMap.get(live.id);
          const currentMemberships = Array.isArray(live.joinedServers)
            ? live.joinedServers
            : (Array.isArray(session?.joinedServers) ? session.joinedServers : []);
          const freshAccess = freshAccessByAccount.get(normalizeAccountKey(live.username || session?.username));
          const activeBannedRooms = freshAccess
            ? freshAccess.activeBannedRooms
            : (Array.isArray(live.bannedRooms)
              ? live.bannedRooms
              : (Array.isArray(session?.bannedRooms) ? session.bannedRooms : []))
              .filter(roomCode => roomCode !== serverCode);
          const blockedRooms = new Set(activeBannedRooms);
          const hadMembership = currentMemberships.includes(serverCode);
          const nextMemberships = freshAccess
            ? freshAccess.authoritativeMemberships
            : currentMemberships.filter(roomCode => roomCode !== serverCode && !blockedRooms.has(roomCode));
          const activeRoom = live.serverCode ?? session?.serverCode ?? null;
          const fallbackCode = freshAccess
            ? freshAccess.fallbackCode
            : (nextMemberships.includes('global')
              ? 'global'
              : (nextMemberships.find(roomCode => roomCode !== 'global') || null));
          applySessionAccessSnapshot({
            live,
            session,
            joinedServers: nextMemberships,
            bannedRooms: activeBannedRooms,
            removedRoom: serverCode,
            fallbackCode
          });
          affectedSockets.push({
            live,
            session,
            activeRoom,
            hadMembership,
            nextMemberships,
            activeBannedRooms,
            fallbackCode
          });
        }

        const liveIds = new Set(affectedSockets.map(({ live }) => live.id));
        for (const [id, session] of onlineUsersMap.entries()) {
          if (liveIds.has(id)) continue;
          const freshAccess = freshAccessByAccount.get(normalizeAccountKey(session?.username));
          const activeBannedRooms = freshAccess
            ? freshAccess.activeBannedRooms
            : (Array.isArray(session?.bannedRooms) ? session.bannedRooms : [])
              .filter(roomCode => roomCode !== serverCode);
          const blockedRooms = new Set(activeBannedRooms);
          const nextMemberships = freshAccess
            ? freshAccess.authoritativeMemberships
            : (Array.isArray(session?.joinedServers) ? session.joinedServers : [])
              .filter(roomCode => roomCode !== serverCode && !blockedRooms.has(roomCode));
          const fallbackCode = freshAccess
            ? freshAccess.fallbackCode
            : (nextMemberships.includes('global')
              ? 'global'
              : (nextMemberships.find(roomCode => roomCode !== 'global') || null));
          applySessionAccessSnapshot({
            session,
            joinedServers: nextMemberships,
            bannedRooms: activeBannedRooms,
            removedRoom: serverCode,
            fallbackCode
          });
        }

        for (const {
          live, session, activeRoom, hadMembership, nextMemberships, activeBannedRooms, fallbackCode
        } of affectedSockets) {
          try {
            await Promise.resolve(live.leave(serverCode));
            if (activeRoom === serverCode && fallbackCode) {
              await Promise.resolve(live.join(fallbackCode));
            }
          } catch (err) {
            cleanupFailed = true;
            logUnexpectedError(logger, 'room_transport_eviction', err);
            await quarantineLiveSocket(live, session, [serverCode, fallbackCode]);
            continue;
          }
          if (hadMembership || activeRoom === serverCode) {
            try {
              live.emit('room_access_updated', {
                username: live.username || session?.username,
                joinedServers: [...nextMemberships],
                serverCode: live.serverCode ?? session?.serverCode ?? null,
                bannedRooms: [...activeBannedRooms]
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
          const hasInjectedRestrictionCleanup = RoomRestrictionModel !== RoomRestriction;
          if (typeof RoomRestrictionModel.deleteMany === 'function' &&
              (hasInjectedRestrictionCleanup || ChatServerModel === ChatServer)) {
            await RoomRestrictionModel.deleteMany({ serverCode });
          }
        } catch (err) {
          cleanupFailed = true;
          logUnexpectedError(logger, 'delete_server_restriction_cleanup', err);
        }
        try {
          const hasInjectedReportCleanup = ModerationReportModel !== ModerationReport;
          if (typeof ModerationReportModel.deleteMany === 'function' &&
              (hasInjectedReportCleanup || ChatServerModel === ChatServer)) {
            await ModerationReportModel.deleteMany({ serverCode });
          }
        } catch (err) {
          cleanupFailed = true;
          logUnexpectedError(logger, 'delete_server_report_cleanup', err);
        }
        try {
          await UserModel.updateMany({}, { $pull: { servers: serverCode } });
        } catch (err) {
          cleanupFailed = true;
          logUnexpectedError(logger, 'delete_server_membership_cleanup', err);
        }
        broadcastOnlineUsersFn('global');
        return cleanupFailed ? { error: 'Deletion failed.' } : { success: true };
          })
        );
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

    let result;
    try {
      result = await withAccountTransitionLock(socket.username, () => withRoomMutationLock(serverCode, async () => {
        let access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel,
          username: socket.username, serverCode
        });
        if (!access.room) {
          const error = { error: 'Server not found.' };
          callback(error);
          return error;
        }
        if (!access.allowed || access.restriction.banned || !access.user) {
          const error = { error: 'Permission denied.' };
          callback(error);
          return error;
        }

        const usernameKey = normalizeAccountKey(access.user.username);
        const { snapshot: blockState, blockedUserKeys } = await loadDurableBlockState(usernameKey);
        const roomRole = await getRoomRoleFn(serverCode, access.user.username);
        const history = await MessageModel.find(roomMessageQuery(serverCode))
          .sort({ timestamp: -1, _id: -1 })
          .limit(100)
          .lean();
        const safeHistory = history
          .map(storedMessage => {
            const safeMessage = safeMessageForViewer(storedMessage, { blockedUserKeys });
            return safeMessage ? { ...safeMessage, serverCode } : null;
          })
          .filter(Boolean)
          .reverse();
        access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel,
          username: socket.username, serverCode
        });
        if (!access.room) {
          const error = { error: 'Server not found.' };
          callback(error);
          return error;
        }
        if (!access.allowed || access.restriction.banned || !access.user) {
          const error = { error: 'Permission denied.' };
          callback(error);
          return error;
        }
        const actualMember = Array.isArray(access.user.servers) && access.user.servers.includes(serverCode);
        const notification = actualMember
          ? await loadRoomStateSnapshot({ usernameKey, serverCode, blockedUserKeys })
          : null;
        const detailSnapshot = safeRoomDetails(
          access.room,
          canEditRoomDetails({ serverCode, access })
        );
        const details = {
          description: detailSnapshot.description,
          rules: detailSnapshot.rules,
          metadataVersion: detailSnapshot.metadataVersion,
          canEdit: detailSnapshot.canEdit
        };
        const pin = await visiblePinCountSnapshot({
          room: access.room,
          blockedUserKeys,
          blockVersion: blockState.blockVersion
        });

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
        socket.blockedUserKeys = new Set(blockedUserKeys);
        socket.blockVersion = blockState.blockVersion;
        if (session) {
          session.serverCode = serverCode;
          session.blockedUsers = [...blockedUserKeys];
          session.blockVersion = blockState.blockVersion;
        }
        callback({
          serverCode,
          history: safeHistory,
          roomRole,
          restriction: {
            banned: access.restriction.banned,
            timedOut: access.restriction.timedOut,
            timeoutUntil: access.restriction.timeoutUntil
          },
          details,
          notification,
          pin,
          attention: notification ? {
            unreadCount: notification.unreadCount,
            mentionCount: notification.mentionCount
          } : null
        });
        return { success: true, oldCode };
      }));
    } catch (err) {
      logUnexpectedError(logger, 'switch_server', err);
      return callback({ error: 'Failed to switch server.' });
    }
    if (result.error) return;

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
      const actorUsername = socket.username;
      const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
      if (!actorUsername || !serverCode || !canAccessRoom(identity, serverCode)) return;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.text !== 'string') return;
      const intendedServerCode = normalizeServerCode(payload.serverCode);
      const clientContextId = normalizeClientContextId(payload.clientContextId);
      if (intendedServerCode !== serverCode || clientContextId === null) return;
      if (!isValidAttachment(payload.attachment)) return;

      const attachment = sanitizeAttachment(payload.attachment);
      const rawText = neutralizePingTokens(payload.text.trim().substring(0, 2000));
      if (!rawText && !attachment) return;

      const createdMessage = await withAccountTransitionLock(actorUsername, () =>
        withRoomMutationLock(serverCode, async () => {
        if (normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
            socket.serverCode !== intendedServerCode) return;
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel,
          username: actorUsername, serverCode
        });
        if (!access.allowed || access.restriction.timedOut || !access.user || !access.room ||
            normalizeAccountKey(access.user.username) !== normalizeAccountKey(actorUsername) ||
            !canAccessRoom(socket, serverCode)) return;
        if (socket.serverCode !== intendedServerCode) return;
        const settings = roomAutoModSettings(access.room);
        if (!settings) return;
        const freshRoomRole = currentRoomRole(access.room, access.user.username);
        let rateResult;
        try {
          rateResult = evaluateMessageRate({
            username: access.user.username,
            serverCode,
            settings,
            tracker: autoModTracker
          });
        } catch (err) {
          logUnexpectedError(logger, 'automod_message_rate', err);
          return;
        }
        if (!rateResult.allowed) {
          await rejectAutoModContent({
            serverCode,
            clientContextId,
            access,
            roomRole: freshRoomRole,
            rawText,
            result: rateResult
          });
          return;
        }

        let replyTo = null;
        if (payload.replyTo && typeof payload.replyTo === 'object' && isValidObjectId(payload.replyTo.id)) {
          const referenced = await MessageModel.findById(payload.replyTo.id);
          if (referenced && !referenced.deleted &&
              normalizeServerCode(referenced.serverCode || 'global') === serverCode) {
            replyTo = createReplySnapshot(referenced);
          }
        }

        let cleanText = await resolvePingsFn(
          rawText,
          serverCode,
          access.user.role,
          freshRoomRole,
          access.user.username
        );
        if (typeof cleanText !== 'string' || cleanText.length > 2000) return;
        if (socket.serverCode !== intendedServerCode || !canAccessRoom(socket, serverCode)) return;
        const autoModResult = evaluateAutoMod({
          text: rawText,
          resolvedText: cleanText,
          username: access.user.username,
          serverCode,
          role: access.user.role,
          settings,
          tracker: autoModTracker,
          now: new Date()
        });
        if (!autoModResult.allowed) {
          await rejectAutoModContent({
            serverCode,
            clientContextId,
            access,
            roomRole: freshRoomRole,
            rawText,
            result: autoModResult
          });
          return;
        }

        const authorKey = normalizeAccountKey(access.user.username);
        const notificationMentions = extractNotificationMentions(cleanText);
        const msg = await MessageModel.create({
            serverCode,
            username: access.user.username,
            displayName: access.user.displayName || socket.displayName || access.user.username,
            authorKey, notificationMentions,
            role: access.user.role,
            roomRole: freshRoomRole,
            color: access.user.color || socket.color,
            avatarUrl: access.user.avatarUrl || socket.avatarUrl,
            text: cleanText, attachment, replyTo, reactions: {}
        });

        await emitPersonalizedRoomEvent({
          serverCode: msg.serverCode || serverCode,
          event: 'chat_message',
          buildPayload: ({ blockedUserKeys }) => safeMessageForViewer(msg, { blockedUserKeys })
        });
        return msg;
      }));
      if (createdMessage) await emitRoomActivity(createdMessage);
    } catch (err) {
      logUnexpectedError(logger, 'chat_message', err);
    }
  });

  socket.on('toggle_reaction', async (data) => {
    try {
      if (!socket.username || !data || typeof data !== 'object' || Array.isArray(data)) return;
      const { id, emoji } = data;
      const actorUsername = socket.username;
      const intendedServerCode = normalizeServerCode(data.serverCode);
      const clientContextId = normalizeClientContextId(data.clientContextId);
      if (!isValidObjectId(id) || !isValidReaction(emoji) ||
          intendedServerCode !== socket.serverCode || clientContextId === null) return;

      await withAccountTransitionLock(actorUsername, () =>
        withRoomMutationLock(intendedServerCode, async () => {
          if (normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
              socket.serverCode !== intendedServerCode) return;
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel,
            username: actorUsername, serverCode: intendedServerCode
          });
          if (!access.allowed || access.restriction.timedOut || !access.user || !access.room ||
              normalizeAccountKey(access.user.username) !== normalizeAccountKey(actorUsername) ||
              !canAccessRoom(socket, intendedServerCode)) return;
          const msg = await MessageModel.findById(id);
          if (!msg || msg.deleted || msg.serverCode !== intendedServerCode) return;

          const actor = access.user.username;
          let rx = msg.reactions || {};
          let users = Array.isArray(rx[emoji]) ? rx[emoji] : [];

          if (users.includes(actor)) {
            users = users.filter(username => username !== actor);
            if (users.length === 0) delete rx[emoji];
            else rx[emoji] = users;
          } else {
            const reactionKeys = Object.keys(rx);
            if (!Object.prototype.hasOwnProperty.call(rx, emoji) && reactionKeys.length >= MAX_REACTION_KEYS) return;
            if (users.length >= MAX_REACTION_USERS) return;
            const reactionsByUser = Object.values(rx).filter(reactionUsers =>
              Array.isArray(reactionUsers) && reactionUsers.includes(actor)
            ).length;
            if (reactionsByUser >= MAX_REACTIONS_PER_USER) return;
            users.push(actor);
            rx[emoji] = users;
          }

          msg.reactions = rx;
          msg.markModified('reactions');
          await msg.save();

          const targetAuthorKey = authorKeyForMessage(msg);
          await emitPersonalizedRoomEvent({
            serverCode: msg.serverCode,
            event: 'reaction_updated',
            buildPayload: ({ blockedUserKeys }) => {
              if (!targetAuthorKey || blockedUserKeys.has(targetAuthorKey)) return null;
              return { id: msg._id, reactions: safeReactionsForViewer(msg.reactions, blockedUserKeys) };
            }
          });
        })
      );
    } catch (err) {
      logUnexpectedError(logger, 'toggle_reaction', err);
    }
  });

  socket.on('edit_message', async (data) => {
    try {
      if (!socket.username || !data || typeof data !== 'object' || Array.isArray(data) ||
          !isValidObjectId(data.id) || typeof data.text !== 'string') return;
      const actorUsername = socket.username;
      const intendedServerCode = normalizeServerCode(data.serverCode);
      const clientContextId = normalizeClientContextId(data.clientContextId);
      if (intendedServerCode !== socket.serverCode || clientContextId === null) return;
      const rawText = neutralizePingTokens(data.text.trim().substring(0, 2000));
      if (!rawText) return;

      await withAccountTransitionLock(actorUsername, () =>
        withRoomMutationLock(intendedServerCode, async () => {
          if (normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
              socket.serverCode !== intendedServerCode) return;
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel,
            username: actorUsername, serverCode: intendedServerCode
          });
          if (!access.allowed || access.restriction.timedOut || !access.user || !access.room ||
              normalizeAccountKey(access.user.username) !== normalizeAccountKey(actorUsername) ||
              !canAccessRoom(socket, intendedServerCode)) return;
          const msg = await MessageModel.findById(data.id);
          if (!msg || msg.deleted || msg.serverCode !== intendedServerCode) return;
          const freshRoomRole = currentRoomRole(access.room, access.user.username);
          const authorOwnsMessage = normalizeAccountKey(msg.username) ===
            normalizeAccountKey(access.user.username);
          if (!authorOwnsMessage && access.user.role !== 'admin' && freshRoomRole !== 'mod') return;

          let cleanText = await resolvePingsFn(
            rawText,
            intendedServerCode,
            access.user.role,
            freshRoomRole,
            access.user.username
          );
          if (typeof cleanText !== 'string' || cleanText.length > 2000) return;
          const settings = roomAutoModSettings(access.room);
          if (!settings) return;
          const autoModResult = evaluateAutoMod({
            text: rawText,
            resolvedText: cleanText,
            username: access.user.username,
            serverCode: intendedServerCode,
            role: access.user.role,
            settings,
            tracker: autoModTracker,
            now: new Date()
          });
          if (!autoModResult.allowed) {
            await rejectAutoModContent({
              serverCode: intendedServerCode,
              clientContextId,
              access,
              roomRole: freshRoomRole,
              rawText,
              result: autoModResult
            });
            return;
          }

          if (msg.text !== cleanText) {
            msg.history = appendBoundedHistory(msg.history, { text: msg.text, timestamp: new Date() });
            msg.text = cleanText;
            msg.edited = true;
            msg.markModified('history');
            await msg.save();
            const targetAuthorKey = authorKeyForMessage(msg);
            await emitPersonalizedRoomEvent({
              serverCode: intendedServerCode,
              event: 'message_edited',
              buildPayload: ({ blockedUserKeys }) => {
                if (!targetAuthorKey || blockedUserKeys.has(targetAuthorKey)) return null;
                return {
                  id: msg._id,
                  username: normalizeUsername(msg.username) || targetAuthorKey,
                  role: typeof msg.role === 'string' ? msg.role : 'user',
                  roomRole: typeof msg.roomRole === 'string' ? msg.roomRole : 'user',
                  text: typeof msg.text === 'string' ? msg.text : ''
                };
              }
            });
          }
        })
      );
    } catch (err) {
      logUnexpectedError(logger, 'edit_message', err);
    }
  });

  socket.on('delete_message', async (data, callback) => {
    callback = safeAck(callback);
    try {
      if (!socket.username || !data || typeof data !== 'object' || Array.isArray(data)) return;
      const msgId = data.id;
      const intendedServerCode = normalizeServerCode(data.serverCode);
      const clientContextId = normalizeClientContextId(data.clientContextId);
      if (!isValidObjectId(msgId) || intendedServerCode !== socket.serverCode ||
          clientContextId === null) return;
      const actorUsername = socket.username;
      const result = await withAccountTransitionLock(actorUsername, () =>
        withRoomMutationLock(intendedServerCode, async () => {
          if (normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
              socket.serverCode !== intendedServerCode) return null;
          const access = await loadRoomAccessState({
            UserModel, ChatServerModel, RoomRestrictionModel,
            username: actorUsername, serverCode: intendedServerCode
          });
          if (!access.allowed || access.restriction.banned || !access.user || !access.room ||
              normalizeAccountKey(access.user.username) !== normalizeAccountKey(actorUsername)) return null;

          const message = await MessageModel.findById(msgId);
          if (!message || message.deleted || message.serverCode !== intendedServerCode) return null;
          if (access.restriction.timedOut &&
              normalizeAccountKey(message.username) !== normalizeAccountKey(access.user.username)) return null;
          const freshRoomRole = currentRoomRole(access.room, access.user.username);
          const mayDelete = normalizeAccountKey(message.username) === normalizeAccountKey(access.user.username) ||
            access.user.role === 'admin' || freshRoomRole === 'mod';
          if (!mayDelete) return null;

          const targetAuthorKey = authorKeyForMessage(message);
          const { snapshot: blockState, blockedUserKeys } = await loadDurableBlockState(access.user.username);
          const blockVersion = blockState.blockVersion;
          const priorPin = exactStoredPin(access.room, msgId);
          let persistedRoom = access.room;
          let pinChanged = false;

          if (priorPin) {
            const transactionConnection = sharedTransactionConnection([MessageModel, ChatServerModel]);
            const fallbackPinnedDelete = async () => {
              const removed = await removePinBeforeFallbackDelete({
                room: access.room, message, blockVersion
              });
              persistedRoom = removed.room;
              message.deleted = true;
              try {
                await message.save();
              } catch (deleteError) {
                message.deleted = false;
                const restored = await restorePinAfterFailedDelete({
                  room: persistedRoom, priorPin: removed.priorPin, blockVersion
                });
                persistedRoom = restored.room || persistedRoom;
                if (!restored.restored) {
                  logUnexpectedError(logger, 'delete_message_pin_restore', restored.error || deleteError);
                }
                if (restored.verified) {
                  await emitMessagePinUpdated({
                    serverCode: intendedServerCode,
                    messageId: msgId,
                    pinned: restored.pinned,
                    room: persistedRoom,
                    targetAuthorKey
                  });
                }
                throw deleteError;
              }
              return { message, room: persistedRoom };
            };
            const persisted = await runPersistence(async session => {
                const [transactionMessage, transactionRoom] = await Promise.all([
                  applyQuerySession(MessageModel.findById(msgId), session),
                  applyQuerySession(ChatServerModel.findOne({ code: intendedServerCode }), session)
                ]);
                if (!transactionMessage || transactionMessage.deleted ||
                    transactionMessage.serverCode !== intendedServerCode || !transactionRoom ||
                    !exactStoredPin(transactionRoom, msgId)) {
                  throw new Error('Pinned message transaction state changed.');
                }
                const transactionMayDelete =
                  normalizeAccountKey(transactionMessage.username) === normalizeAccountKey(access.user.username) ||
                  access.user.role === 'admin' || currentRoomRole(transactionRoom, access.user.username) === 'mod';
                if (!transactionMayDelete) throw new Error('Pinned message transaction authority changed.');

                transactionMessage.deleted = true;
                await transactionMessage.save({ session });
                const updatedRoom = await ChatServerModel.findOneAndUpdate(
                  {
                    code: intendedServerCode,
                    ...roomPinVersionPredicate(transactionRoom),
                    'pinnedMessages.messageId': msgId
                  },
                  { $pull: { pinnedMessages: { messageId: msgId } }, $inc: { pinVersion: 1 } },
                  { new: true, session }
                );
                if (!updatedRoom) throw new Error('Pinned message transaction lost its version race.');
                return { message: transactionMessage, room: updatedRoom };
              }, transactionConnection, {
                unsupportedTopologyFallback: fallbackPinnedDelete
              });
            persistedRoom = persisted.room;
            pinChanged = true;
          } else {
            message.deleted = true;
            await message.save();
          }

          if (pinChanged) {
            await emitMessagePinUpdated({
              serverCode: intendedServerCode,
              messageId: msgId,
              pinned: false,
              room: persistedRoom,
              targetAuthorKey
            });
          }
          await emitPersonalizedRoomEvent({
            serverCode: intendedServerCode,
            event: 'message_deleted',
            buildPayload: ({ blockedUserKeys: recipientBlocks }) => {
              if (!targetAuthorKey || recipientBlocks.has(targetAuthorKey)) return null;
              return { id: msgId, serverCode: intendedServerCode };
            }
          });
          const pin = await visiblePinCountSnapshot({
            room: persistedRoom, blockedUserKeys, blockVersion
          });
          return { success: true, messageId: msgId, pin };
        })
      );
      if (result) callback(result);
    } catch (err) {
      logUnexpectedError(logger, 'delete_message', err);
      callback({ error: 'Failed to delete message.' });
    }
  });

  socket.on('get_edit_history', async (msgId, callback) => {
    callback = safeAck(callback);
    if (!socket.username) return callback({ error: 'Not authenticated.' });
    try {
      if (!isValidObjectId(msgId)) return callback({ error: 'Invalid input format.' });
      const actorUsername = socket.username;
      const initialMessage = await MessageModel.findById(msgId);
      const serverCode = normalizeServerCode(initialMessage?.serverCode || 'global');
      let preflightAllowed = false;
      if (initialMessage && serverCode) {
        const authorKey = authorKeyForMessage(initialMessage);
        const blockState = await ensureBlockState(actorUsername);
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (authorKey && !blockSetFromState(blockState).has(authorKey) && canAccessRoom(identity, serverCode)) {
          const restriction = await getActiveRoomRestriction(RoomRestrictionModel, serverCode, actorUsername);
          if (!restriction.banned && await roomExists(serverCode)) {
            const roomRole = await getRoomRoleFn(serverCode, actorUsername);
            preflightAllowed = normalizeAccountKey(initialMessage.username) === normalizeAccountKey(actorUsername) ||
              socket.role === 'admin' || roomRole === 'mod';
          }
        }
      }
      if (!initialMessage || !serverCode) return callback({ error: 'Permission denied.' });

      await withAccountTransitionLock(actorUsername, () => withRoomMutationLock(serverCode, async () => {
        if (!preflightAllowed || normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
            normalizeServerCode(socket.serverCode) !== serverCode) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel, username: actorUsername, serverCode
        });
        if (!access.allowed || access.restriction.banned || !access.user || !access.room) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const message = await MessageModel.findById(msgId);
        const authorKey = authorKeyForMessage(message);
        if (!message || normalizeServerCode(message.serverCode || 'global') !== serverCode || !authorKey) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const blockState = await ensureBlockState(access.user.username);
        if (blockSetFromState(blockState).has(authorKey)) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const mayRead = normalizeAccountKey(message.username) === normalizeAccountKey(access.user.username) ||
          access.user.role === 'admin' || currentRoomRole(access.room, access.user.username) === 'mod';
        if (!mayRead) {
          callback({ error: 'Permission denied.' });
          return;
        }
        callback({
          success: true,
          history: (Array.isArray(message.history) ? message.history : []).slice(-20)
        });
      }));
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
      const actorUsername = socket.username;
      const initialMessage = await MessageModel.findById(msgId);
      const serverCode = normalizeServerCode(initialMessage?.serverCode || 'global');
      let preflightAllowed = false;
      if (initialMessage?.deleted && serverCode) {
        const authorKey = authorKeyForMessage(initialMessage);
        const blockState = await ensureBlockState(actorUsername);
        const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
        if (authorKey && !blockSetFromState(blockState).has(authorKey) && canAccessRoom(identity, serverCode)) {
          const restriction = await getActiveRoomRestriction(RoomRestrictionModel, serverCode, actorUsername);
          if (!restriction.banned && await roomExists(serverCode)) {
            const roomRole = await getRoomRoleFn(serverCode, actorUsername);
            preflightAllowed = normalizeAccountKey(initialMessage.username) === normalizeAccountKey(actorUsername) ||
              socket.role === 'admin' || roomRole === 'mod';
          }
        }
      }
      if (!initialMessage || !serverCode) return callback({ error: 'Permission denied.' });

      await withAccountTransitionLock(actorUsername, () => withRoomMutationLock(serverCode, async () => {
        if (!preflightAllowed || normalizeAccountKey(socket.username) !== normalizeAccountKey(actorUsername) ||
            normalizeServerCode(socket.serverCode) !== serverCode) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel, username: actorUsername, serverCode
        });
        if (!access.allowed || access.restriction.banned || !access.user || !access.room) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const message = await MessageModel.findById(msgId);
        const authorKey = authorKeyForMessage(message);
        if (!message || !message.deleted || normalizeServerCode(message.serverCode || 'global') !== serverCode || !authorKey) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const blockState = await ensureBlockState(access.user.username);
        if (blockSetFromState(blockState).has(authorKey)) {
          callback({ error: 'Permission denied.' });
          return;
        }
        const mayRead = normalizeAccountKey(message.username) === normalizeAccountKey(access.user.username) ||
          access.user.role === 'admin' || currentRoomRole(access.room, access.user.username) === 'mod';
        if (!mayRead) {
          callback({ error: 'Permission denied.' });
          return;
        }
        callback({
          success: true,
          text: typeof message.text === 'string' ? message.text : '',
          attachment: sanitizeAttachment(message.attachment)
        });
      }));
    } catch (err) {
      logUnexpectedError(logger, 'get_deleted_message', err);
      callback({ error: 'Failed to load deleted message.' });
    }
  });

  socket.on('typing', async (data) => {
    try {
      const serverCode = socket.serverCode;
      const identity = { role: socket.role, joinedServers: socket.joinedServers || [] };
      if (!socket.username || !serverCode || !data || typeof data !== 'object' || Array.isArray(data)) return;
      const intendedServerCode = normalizeServerCode(data.serverCode);
      const clientContextId = normalizeClientContextId(data.clientContextId);
      const isTyping = data.isTyping;
      if (intendedServerCode !== serverCode || clientContextId === null ||
          typeof isTyping !== 'boolean' || !canAccessRoom(identity, serverCode)) return;
      await withRoomMutationLock(serverCode, async () => {
        const access = await loadRoomAccessState({
          UserModel, ChatServerModel, RoomRestrictionModel,
          username: socket.username, serverCode
        });
        if (socket.serverCode !== intendedServerCode || !access.allowed ||
            access.restriction.timedOut || !canAccessRoom(socket, serverCode)) return;
        const typingAuthorKey = normalizeAccountKey(access.user.username);
        await emitPersonalizedRoomEvent({
          serverCode,
          event: 'typing',
          buildPayload: ({ blockedUserKeys }) => {
            if (blockedUserKeys.has(typingAuthorKey)) return null;
            return {
              username: access.user.username,
              displayName: socket.displayName || access.user.username,
              isTyping
            };
          }
        });
      });
    } catch (err) {
      logUnexpectedError(logger, 'typing', err);
    }
  });

  socket.on('disconnect', async () => {
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
            const typingAuthorKey = normalizeAccountKey(socket.username);
            await emitPersonalizedRoomEvent({
              serverCode,
              event: 'typing',
              buildPayload: ({ blockedUserKeys }) => {
                if (blockedUserKeys.has(typingAuthorKey)) return null;
                return { username: socket.username, displayName: dName, isTyping: false };
              }
            });
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
  sharedTransactionConnection,
  runPersistence,
  safeAck,
  normalizeUsername,
  normalizeDisplayName,
  normalizeServerName,
  normalizeServerCode,
  normalizeModerationAction,
  normalizeModerationReason,
  normalizeAutoModSettings,
  normalizeStoredAutoModSettings,
  normalizeAccountKey,
  normalizeRoomText,
  normalizeNotificationLevel,
  authorKeyForMessage,
  extractNotificationMentions,
  isNotificationMention,
  roomMessageQuery,
  newestRoomMessage,
  cursorFromMessage,
  compareCursor,
  safeReplyForViewer,
  safeReactionsForViewer,
  safeMessageForViewer,
  safeBlockedMessageReveal,
  safeRoomDetails,
  safeRoomState,
  safeBlockState,
  blockSetFromState,
  replaceAccountBlockCaches,
  createAutoModTracker,
  evaluateAutoMod,
  evaluateMessageRate,
  findUserByUsername,
  canModerateTarget,
  activeRestrictionState,
  getActiveRoomRestriction,
  chooseAccessibleRoom,
  applySessionAccessSnapshot,
  loadRoomAccessState,
  canEditRoomDetails,
  canManagePins,
  rejectAuditMutation,
  MODERATION_DURATIONS,
  RoomRestriction,
  ModerationAudit,
  ModerationReport,
  ChatServer,
  Message,
  RoomMemberState,
  UserExperienceState,
  isValidPassword,
  normalizeColor,
  normalizeAvatarUrl,
  isValidAttachment,
  sanitizeAttachment,
  isValidReaction,
  isValidObjectId,
  encodeCursor,
  decodeCursor,
  neutralizePingTokens,
  normalizeTransportAddress,
  createRateLimiter,
  canAccessRoom,
  appendBoundedHistory,
  createReplySnapshot
};
