const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoModTracker, createConnectionHandler } = require('../server');
const { FakeSocket, FakeIo, acknowledge, deferred, createMemoryModel } = require('./support/fakes');

const TEXT_SECRET = 'BLOCKED_TEXT_SENTINEL';
const ATTACHMENT_SECRET = 'BLOCKED_ATTACHMENT_SENTINEL';
const REPLY_SECRET = 'BLOCKED_REPLY_SENTINEL';
const HISTORY_SECRET = 'BLOCKED_HISTORY_SENTINEL';
const AVATAR_SECRET = 'BLOCKED_AVATAR_SENTINEL';
const REACTION_SECRET = 'BLOCKED_REACTION_SENTINEL';

function objectId(index) {
  return Number(index).toString(16).padStart(24, '0');
}

function user(username, overrides = {}) {
  return {
    username, displayName: username, password: 'hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global', 'ABC123', 'XYZ789'], ...overrides
  };
}

function room(code, overrides = {}) {
  return {
    code, name: code, owner: code === 'global' ? 'System' : 'Owner', moderators: [],
    description: '', rules: '', metadataVersion: 0, pinnedMessages: [], pinVersion: 0,
    autoMod: {
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      messageLimit: 20, messageWindowSeconds: 5
    },
    ...overrides
  };
}

function message(index, overrides = {}) {
  return {
    _id: objectId(index), serverCode: 'ABC123', username: 'Author', displayName: 'Author',
    authorKey: 'author', role: 'user', roomRole: 'user', color: '#123456', avatarUrl: '',
    text: `message ${index}`, attachment: null, replyTo: null, reactions: {}, history: [],
    edited: false, deleted: false, timestamp: new Date(1_700_000_000_000 + index), ...overrides
  };
}

function preserveAttentionProjection(MessageModel) {
  const find = MessageModel.find.bind(MessageModel);
  MessageModel.find = (query = {}) => {
    const result = find(query);
    if (!Array.isArray(query.$and)) return result;
    return {
      async select() {
        return (await result).map(row => ({
          _id: row._id, serverCode: row.serverCode, timestamp: row.timestamp,
          username: row.username, authorKey: row.authorKey,
          notificationMentions: Array.isArray(row.notificationMentions)
            ? [...row.notificationMentions] : row.notificationMentions,
          deleted: row.deleted
        }));
      }
    };
  };
}

function fixture(overrides = {}) {
  const setup = {
    ioInstance: new FakeIo(),
    onlineUsersMap: new Map(),
    presenceCalls: [],
    logs: [],
    UserModel: overrides.UserModel || createMemoryModel(overrides.users || [
      user('Blocker'), user('Author'), user('Other'), user('Owner'), user('Admin', { role: 'admin' })
    ]),
    ChatServerModel: overrides.ChatServerModel || createMemoryModel(overrides.rooms || [
      room('global'), room('ABC123'), room('XYZ789')
    ]),
    MessageModel: overrides.MessageModel || createMemoryModel(overrides.messages || []),
    RoomRestrictionModel: overrides.RoomRestrictionModel || createMemoryModel(overrides.restrictions || []),
    ModerationAuditModel: overrides.ModerationAuditModel || createMemoryModel([]),
    RoomMemberStateModel: overrides.RoomMemberStateModel || createMemoryModel(overrides.roomStates || []),
    UserExperienceStateModel: overrides.UserExperienceStateModel || createMemoryModel(overrides.experienceStates || [])
  };
  setup.getRoomRoleFn = overrides.getRoomRoleFn;
  setup.logger = overrides.logger || { error(...args) { setup.logs.push(args); } };
  setup.broadcastOnlineUsersFn = overrides.broadcastOnlineUsersFn || (async code => {
    setup.presenceCalls.push(code);
  });
  return setup;
}

function register(setup, id) {
  const socket = new FakeSocket();
  socket.id = id;
  createConnectionHandler({
    ioInstance: setup.ioInstance,
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    MessageModel: setup.MessageModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    RoomMemberStateModel: setup.RoomMemberStateModel,
    UserExperienceStateModel: setup.UserExperienceStateModel,
    onlineUsersMap: setup.onlineUsersMap,
    broadcastOnlineUsersFn: setup.broadcastOnlineUsersFn,
    getRoomRoleFn: setup.getRoomRoleFn || (async (code, username) => {
      const stored = setup.ChatServerModel.rows?.find(candidate => candidate.code === code);
      return stored?.moderators?.some(candidate => candidate.toLowerCase() === username.toLowerCase()) ? 'mod' : 'user';
    }),
    resolvePingsFn: async text => text,
    autoModTracker: createAutoModTracker(),
    bcryptImpl: { async compare() { return true; }, async hash(value) { return value; } },
    logger: setup.logger
  })(socket);
  setup.ioInstance.sockets.push(socket);
  return socket;
}

function authenticate(setup, {
  id, username, serverCode = 'ABC123', role = 'user',
  joinedServers = ['global', 'ABC123', 'XYZ789'], blockedUsers = [], blockVersion = 0
}) {
  const socket = register(setup, id);
  Object.assign(socket, {
    username, displayName: username, role, color: '', avatarUrl: '', serverCode,
    joinedServers: [...joinedServers], bannedRooms: [], blockedUserKeys: new Set(blockedUsers), blockVersion
  });
  socket.joinedRooms.add(serverCode);
  setup.onlineUsersMap.set(id, {
    username, displayName: username, role, color: '', avatarUrl: '', serverCode,
    joinedServers: [...joinedServers], bannedRooms: [], blockedUsers: [...blockedUsers], blockVersion
  });
  return socket;
}

async function setBlock(socket, username, blocked) {
  const ack = acknowledge();
  await socket.trigger('set_user_block', { username, blocked }, ack.callback);
  return ack.value();
}

function events(socket, event) {
  return socket.outbound.filter(item => item.event === event).map(item => item.payload);
}

function blockerOutput(setup, sockets, extra = []) {
  return JSON.stringify({
    sockets: sockets.map(socket => socket.outbound), extra, logs: setup.logs
  });
}

function assertNoNormalSecrets(serialized) {
  for (const sentinel of [TEXT_SECRET, ATTACHMENT_SECRET, REPLY_SECRET, HISTORY_SECRET, AVATAR_SECRET, REACTION_SECRET]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
}

test('authenticated users block existing accounts but cannot block themselves or a missing account', async () => {
  const setup = fixture();
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });

  assert.deepEqual(await setBlock(blocker, 'aUtHoR', true), {
    success: true, usernameKey: 'author', username: 'Author',
    blockedUsers: [{ usernameKey: 'author', username: 'Author' }], blockVersion: 1
  });
  assert.deepEqual(await setBlock(blocker, 'Blocker', true), { error: 'Unable to update block.' });
  assert.deepEqual(await setBlock(blocker, 'Missing', true), { error: 'Unable to update block.' });
});

test('block arrays are bounded at five hundred and duplicate block or unblock is idempotent', async () => {
  const full = Array.from({ length: 500 }, (_, index) => ({
    usernameKey: `u${index}`, username: `u${index}`, createdAt: new Date(index)
  }));
  const setup = fixture({ experienceStates: [{ usernameKey: 'blocker', blockedUsers: full, blockVersion: 4 }] });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: full.map(item => item.usernameKey), blockVersion: 4
  });

  assert.deepEqual(await setBlock(blocker, 'Author', true), { error: 'Block limit reached.' });
  const duplicateSetup = fixture({ experienceStates: [{
    usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
    blockVersion: 7
  }] });
  const duplicate = authenticate(duplicateSetup, {
    id: 'duplicate', username: 'Blocker', blockedUsers: ['author'], blockVersion: 7
  });
  assert.equal((await setBlock(duplicate, 'Author', true)).blockVersion, 7);
  assert.equal((await setBlock(duplicate, 'Other', false)).blockVersion, 7);
});

test('block state and blockVersion change atomically under the blocker account lock', async () => {
  const setup = fixture();
  const first = authenticate(setup, { id: 'first', username: 'Blocker' });
  const second = authenticate(setup, { id: 'second', username: 'Blocker' });

  const [one, two] = await Promise.all([
    setBlock(first, 'Author', true),
    setBlock(second, 'Other', true)
  ]);
  const row = setup.UserExperienceStateModel.rows.find(item => item.usernameKey === 'blocker');
  assert.equal(row.blockVersion, 2);
  assert.deepEqual(row.blockedUsers.map(item => item.usernameKey).sort(), ['author', 'other']);
  assert.deepEqual([one.blockVersion, two.blockVersion].sort(), [1, 2]);
});

test('blocking is private asymmetric global and never changes memberships restrictions or presence', async () => {
  const setup = fixture();
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });
  const target = authenticate(setup, { id: 'author', username: 'Author' });
  const usersBefore = JSON.stringify(setup.UserModel.rows);
  const roomsBefore = JSON.stringify(setup.ChatServerModel.rows);
  const restrictionsBefore = JSON.stringify(setup.RoomRestrictionModel.rows);
  const presenceBefore = [...setup.presenceCalls];

  await setBlock(blocker, 'Author', true);

  assert.equal(JSON.stringify(setup.UserModel.rows), usersBefore);
  assert.equal(JSON.stringify(setup.ChatServerModel.rows), roomsBefore);
  assert.equal(JSON.stringify(setup.RoomRestrictionModel.rows), restrictionsBefore);
  assert.deepEqual(setup.ModerationAuditModel.rows, []);
  assert.deepEqual(setup.presenceCalls, presenceBefore);
  assert.deepEqual(target.outbound, []);
  assert.equal(target.blockedUserKeys.has('blocker'), false);
});

test('all live blocker sessions replace block caches before acknowledgement', async () => {
  const setup = fixture();
  const first = authenticate(setup, { id: 'first', username: 'Blocker' });
  const second = authenticate(setup, { id: 'second', username: 'Blocker', serverCode: 'XYZ789' });
  let observed;

  await first.trigger('set_user_block', { username: 'Author', blocked: true }, result => {
    observed = {
      result,
      sockets: [first, second].map(live => [live.blockedUserKeys.has('author'), live.blockVersion]),
      sessions: ['first', 'second'].map(id => [
        setup.onlineUsersMap.get(id).blockedUsers.includes('author'), setup.onlineUsersMap.get(id).blockVersion
      ]),
      events: [first, second].map(live => events(live, 'user_block_updated').length)
    };
  });

  assert.deepEqual(observed.sockets, [[true, 1], [true, 1]]);
  assert.deepEqual(observed.sessions, [[true, 1], [true, 1]]);
  assert.deepEqual(observed.events, [1, 1]);
  assert.equal(observed.result.blockVersion, 1);
});

test('partial socket discovery cannot omit the initiating blocker session', async () => {
  const setup = fixture();
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });
  const unrelated = authenticate(setup, { id: 'unrelated', username: 'Other' });
  setup.ioInstance.sockets = [unrelated];

  const result = await setBlock(blocker, 'Author', true);

  assert.equal(result.success, true);
  assert.equal(blocker.blockedUserKeys.has('author'), true);
  assert.equal(blocker.blockVersion, 1);
  assert.equal(events(blocker, 'user_block_updated').length, 1);
});

test('concurrent login serializes with blocking and reloads the winning durable block set', async () => {
  const mutationStarted = deferred();
  const releaseMutation = deferred();
  const stateModel = createMemoryModel([]);
  const baseUpdate = stateModel.findOneAndUpdate.bind(stateModel);
  let gated = false;
  stateModel.findOneAndUpdate = (query, update, options) => {
    if (!gated && update?.$push?.blockedUsers) {
      gated = true;
      return {
        then(resolve, reject) {
          mutationStarted.resolve();
          return releaseMutation.promise.then(() => baseUpdate(query, update, options)).then(resolve, reject);
        }
      };
    }
    return baseUpdate(query, update, options);
  };
  const setup = fixture({ UserExperienceStateModel: stateModel });
  const blocker = authenticate(setup, { id: 'existing', username: 'Blocker' });
  const login = register(setup, 'login');

  const blockPending = setBlock(blocker, 'Author', true);
  await mutationStarted.promise;
  const loginAck = acknowledge();
  const loginPending = login.trigger('login', { username: 'Blocker', password: '123456' }, loginAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loginAck.value(), undefined);
  releaseMutation.resolve();
  await Promise.all([blockPending, loginPending]);

  assert.equal(login.blockedUserKeys.has('author'), true);
  assert.equal(login.blockVersion, 1);
  assert.deepEqual(loginAck.value().blockState, {
    blockedUsers: [{ usernameKey: 'author', username: 'Author' }], blockVersion: 1
  });
});

test('live delivery linearizes entirely before or after synchronous cache replacement', async () => {
  const accessStarted = deferred();
  const releaseAccess = deferred();
  const mutationStarted = deferred();
  const releaseMutation = deferred();
  const users = createMemoryModel([user('Blocker'), user('Author')]);
  const baseUserFind = users.findOne.bind(users);
  let gateBlockerAccess = true;
  users.findOne = query => {
    const found = baseUserFind(query);
    const regex = query?.username?.$regex;
    if (gateBlockerAccess && regex instanceof RegExp && regex.test('Blocker')) {
      gateBlockerAccess = false;
      return {
        then(resolve, reject) {
          accessStarted.resolve();
          return releaseAccess.promise.then(() => found).then(resolve, reject);
        }
      };
    }
    return found;
  };
  const states = createMemoryModel([]);
  const baseStateUpdate = states.findOneAndUpdate.bind(states);
  states.findOneAndUpdate = (query, update, options) => {
    if (update?.$push?.blockedUsers) return {
      then(resolve, reject) {
        mutationStarted.resolve();
        return releaseMutation.promise.then(() => baseStateUpdate(query, update, options)).then(resolve, reject);
      }
    };
    return baseStateUpdate(query, update, options);
  };
  const setup = fixture({ UserModel: users, UserExperienceStateModel: states });
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });
  const author = authenticate(setup, { id: 'author', username: 'Author' });

  const sendPending = author.trigger('chat_message', { text: 'before replacement' });
  await accessStarted.promise;
  const blockPending = setBlock(blocker, 'Author', true);
  await mutationStarted.promise;
  releaseAccess.resolve();
  await sendPending;
  assert.equal(events(blocker, 'chat_message').at(-1).blocked, undefined);
  releaseMutation.resolve();
  await blockPending;
  await author.trigger('chat_message', { text: TEXT_SECRET });
  const after = events(blocker, 'chat_message').at(-1);
  assert.equal(after.blocked, true);
  assert.deepEqual(Object.keys(after).sort(), ['_id', 'authorKey', 'blocked', 'serverCode', 'timestamp', 'username']);
});

test('edit history cannot acknowledge blocked content after a concurrent block acknowledgement', async () => {
  const roleLookupStarted = deferred();
  const releaseRoleLookup = deferred();
  let gated = false;
  const target = message(1, { history: [{ text: HISTORY_SECRET, timestamp: new Date() }] });
  const setup = fixture({
    users: [user('Blocker', { role: 'admin' }), user('Author')],
    messages: [target],
    getRoomRoleFn: async () => {
      if (!gated) {
        gated = true;
        roleLookupStarted.resolve();
        await releaseRoleLookup.promise;
      }
      return 'user';
    }
  });
  const reader = authenticate(setup, { id: 'reader', username: 'Blocker', role: 'admin' });
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker', role: 'admin' });
  const detailAck = acknowledge();

  const readPending = reader.trigger('get_edit_history', target._id, detailAck.callback);
  await roleLookupStarted.promise;
  const blockAck = await setBlock(blocker, 'Author', true);
  assert.equal(blockAck.success, true);
  assert.equal(reader.blockedUserKeys.has('author'), true);
  releaseRoleLookup.resolve();
  await readPending;

  assert.deepEqual(detailAck.value(), { error: 'Permission denied.' });
  assert.equal(JSON.stringify(detailAck.value()).includes(HISTORY_SECRET), false);
});

test('deleted message cannot acknowledge blocked content after a concurrent block acknowledgement', async () => {
  const roleLookupStarted = deferred();
  const releaseRoleLookup = deferred();
  let gated = false;
  const target = message(1, {
    deleted: true,
    text: TEXT_SECRET,
    attachment: `data:image/png;base64,${Buffer.from(ATTACHMENT_SECRET).toString('base64')}`
  });
  const setup = fixture({
    rooms: [room('global'), room('ABC123', { moderators: ['Blocker'] }), room('XYZ789')],
    messages: [target],
    getRoomRoleFn: async () => {
      if (!gated) {
        gated = true;
        roleLookupStarted.resolve();
        await releaseRoleLookup.promise;
      }
      return 'mod';
    }
  });
  const reader = authenticate(setup, { id: 'reader', username: 'Blocker' });
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });
  const detailAck = acknowledge();

  const readPending = reader.trigger('get_deleted_message', target._id, detailAck.callback);
  await roleLookupStarted.promise;
  const blockAck = await setBlock(blocker, 'Author', true);
  assert.equal(blockAck.success, true);
  assert.equal(reader.blockedUserKeys.has('author'), true);
  releaseRoleLookup.resolve();
  await readPending;

  assert.deepEqual(detailAck.value(), { error: 'Permission denied.' });
  assertNoNormalSecrets(blockerOutput(setup, [reader], [detailAck.value()]));
});

test('unblocked authors moderators and administrators retain detail access with existing timeout and ban behavior', async () => {
  const historyTarget = message(1, {
    username: 'Author', authorKey: 'author', history: [{ text: 'allowed history', timestamp: new Date() }]
  });
  const deletedTarget = message(2, {
    username: 'Author', authorKey: 'author', text: 'allowed deleted text', deleted: true
  });
  const setup = fixture({
    users: [user('Author'), user('Blocker'), user('Admin', { role: 'admin' })],
    rooms: [room('global'), room('ABC123', { moderators: ['Blocker'] }), room('XYZ789')],
    messages: [historyTarget, deletedTarget],
    restrictions: [{
      serverCode: 'ABC123', username: 'author', bannedAt: null,
      timeoutUntil: new Date(Date.now() + 60_000)
    }]
  });
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  const moderator = authenticate(setup, { id: 'moderator', username: 'Blocker' });
  const admin = authenticate(setup, { id: 'admin', username: 'Admin', role: 'admin' });

  const authorHistory = acknowledge();
  const moderatorDeleted = acknowledge();
  const adminHistory = acknowledge();
  await author.trigger('get_edit_history', historyTarget._id, authorHistory.callback);
  await moderator.trigger('get_deleted_message', deletedTarget._id, moderatorDeleted.callback);
  await admin.trigger('get_edit_history', historyTarget._id, adminHistory.callback);
  assert.equal(authorHistory.value().history[0].text, 'allowed history');
  assert.equal(moderatorDeleted.value().text, 'allowed deleted text');
  assert.equal(adminHistory.value().history[0].text, 'allowed history');

  setup.RoomRestrictionModel.rows.push({
    serverCode: 'ABC123', username: 'blocker', bannedAt: new Date(), timeoutUntil: null
  });
  const bannedModerator = acknowledge();
  await moderator.trigger('get_deleted_message', deletedTarget._id, bannedModerator.callback);
  assert.deepEqual(bannedModerator.value(), { error: 'Permission denied.' });
});

test('modern reply snapshots use the post-replacement block cache without suppressing the visible wrapper', async () => {
  const accessStarted = deferred();
  const releaseAccess = deferred();
  const users = createMemoryModel([user('Blocker'), user('Author'), user('Other')]);
  const baseFind = users.findOne.bind(users);
  let gateBlockerAccess = false;
  users.findOne = query => {
    const found = baseFind(query);
    const regex = query?.username?.$regex;
    if (gateBlockerAccess && regex instanceof RegExp && regex.test('Blocker')) {
      gateBlockerAccess = false;
      return {
        then(resolve, reject) {
          accessStarted.resolve();
          return releaseAccess.promise.then(() => found).then(resolve, reject);
        }
      };
    }
    return found;
  };
  const referenced = message(1, { text: REPLY_SECRET });
  const setup = fixture({ UserModel: users, messages: [referenced] });
  const reader = authenticate(setup, { id: 'reader', username: 'Blocker' });
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });
  const wrapperAuthor = authenticate(setup, { id: 'wrapper', username: 'Other' });

  await wrapperAuthor.trigger('chat_message', {
    text: 'visible wrapper before block', replyTo: { id: referenced._id }
  });
  assert.equal(events(reader, 'chat_message').at(-1).replyTo.text, REPLY_SECRET);

  gateBlockerAccess = true;
  const sendPending = wrapperAuthor.trigger('chat_message', {
    text: 'visible wrapper after block', replyTo: { id: referenced._id }
  });
  await accessStarted.promise;
  const blockAck = await setBlock(blocker, 'Author', true);
  assert.equal(blockAck.success, true);
  assert.equal(reader.blockedUserKeys.has('author'), true);
  releaseAccess.resolve();
  await sendPending;

  const delivered = events(reader, 'chat_message').at(-1);
  assert.equal(delivered.authorKey, 'other');
  assert.equal(delivered.text, 'visible wrapper after block');
  assert.equal(delivered.replyTo, null);
  assert.equal(JSON.stringify(delivered).includes(REPLY_SECRET), false);
});

test('history sends an explicit content-free placeholder for blocked authors', async () => {
  const secretMessage = message(1, {
    text: TEXT_SECRET, attachment: `data:image/png;base64,${Buffer.from(ATTACHMENT_SECRET).toString('base64')}`,
    avatarUrl: `https://example.test/${AVATAR_SECRET}`,
    replyTo: { id: objectId(9), authorKey: 'other', displayname: 'Other', text: REPLY_SECRET },
    reactions: { '👍': [REACTION_SECRET] }, history: [{ text: HISTORY_SECRET, timestamp: new Date() }]
  });
  const setup = fixture({
    messages: [secretMessage],
    experienceStates: [{
      usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
      blockVersion: 3
    }]
  });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', serverCode: 'global', blockedUsers: ['author'], blockVersion: 3
  });
  const ack = acknowledge();
  await blocker.trigger('switch_server', 'ABC123', ack.callback);

  const envelope = ack.value().history[0];
  assert.deepEqual(Object.keys(envelope).sort(), ['_id', 'authorKey', 'blocked', 'serverCode', 'timestamp', 'username']);
  assert.equal(envelope.blocked, true);
  assertNoNormalSecrets(blockerOutput(setup, [blocker], [ack.value()]));
});

test('live messages from blocked authors reveal no content to blocker sessions', async () => {
  const setup = fixture({ experienceStates: [{
    usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
    blockVersion: 2
  }] });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: ['author'], blockVersion: 2
  });
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  author.avatarUrl = `https://example.test/${AVATAR_SECRET}`;

  await author.trigger('chat_message', {
    text: TEXT_SECRET,
    attachment: `data:image/png;base64,${Buffer.from(ATTACHMENT_SECRET).toString('base64')}`
  });

  const envelope = events(blocker, 'chat_message').at(-1);
  assert.deepEqual(Object.keys(envelope).sort(), ['_id', 'authorKey', 'blocked', 'serverCode', 'timestamp', 'username']);
  assertNoNormalSecrets(blockerOutput(setup, [blocker]));
});

test('personalized content reaches only sockets actively viewing the exact room', async () => {
  const setup = fixture();
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  const active = authenticate(setup, { id: 'active', username: 'Other' });
  const inactive = authenticate(setup, { id: 'inactive', username: 'Blocker', serverCode: 'XYZ789' });

  await author.trigger('chat_message', { text: 'exact room only' });

  assert.equal(events(active, 'chat_message').length, 1);
  assert.equal(events(inactive, 'chat_message').length, 0);
  assert.equal(setup.ioInstance.outbound.some(item =>
    item.event === 'chat_message' && item.direct !== true), false);
});

test('reply previews reactions typing edits and pins are filtered per current block cache', async () => {
  const target = message(1, {
    reactions: { '👍': ['Author', REACTION_SECRET] },
    replyTo: { id: objectId(2), authorKey: 'author', displayname: 'Author', text: REPLY_SECRET }
  });
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      pinnedMessages: [{ messageId: target._id, pinnedAt: new Date(), pinnedBy: 'Owner' }], pinVersion: 8
    }), room('XYZ789')],
    messages: [target],
    experienceStates: [{
      usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
      blockVersion: 4
    }]
  });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: ['author'], blockVersion: 4
  });
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  const owner = authenticate(setup, { id: 'owner', username: 'Owner' });

  await author.trigger('typing', true);
  await author.trigger('toggle_reaction', { id: target._id, emoji: '👍' });
  await author.trigger('edit_message', { id: target._id, text: TEXT_SECRET });
  const pinAck = acknowledge();
  await owner.trigger('set_message_pin', {
    serverCode: 'ABC123', messageId: target._id, pinned: false, clientContextId: 1
  }, pinAck.callback);

  assert.equal(events(blocker, 'typing').length, 0);
  assert.equal(events(blocker, 'reaction_updated').length, 0);
  assert.equal(events(blocker, 'message_edited').length, 0);
  assert.equal(events(blocker, 'message_pin_updated').filter(payload => payload.messageId).length, 0);
  assertNoNormalSecrets(blockerOutput(setup, [blocker], [pinAck.value()]));
});

test('legacy reply previews disappear for any viewer with a nonempty block list', async () => {
  const setup = fixture({ experienceStates: [{
    usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'other', username: 'Other', createdAt: new Date() }],
    blockVersion: 1
  }] });
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: ['other'], blockVersion: 1
  });
  const open = authenticate(setup, { id: 'open', username: 'Other' });
  const legacyReply = { id: objectId(8), displayname: 'Legacy', text: REPLY_SECRET };
  setup.MessageModel.create = async value => ({
    ...value, _id: objectId(7), timestamp: new Date(), replyTo: legacyReply
  });

  await author.trigger('chat_message', { text: 'reply wrapper' });

  assert.equal(events(blocker, 'chat_message').at(-1).replyTo, null);
  assert.equal(events(open, 'chat_message').at(-1).replyTo.text, REPLY_SECRET);
});

test('missing or malformed legacy author identity fails closed without content disclosure', async () => {
  const setup = fixture({
    messages: [message(1, { username: '<bad>', authorKey: '', text: TEXT_SECRET })],
    experienceStates: [{
      usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'other', username: 'Other', createdAt: new Date() }],
      blockVersion: 1
    }]
  });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', serverCode: 'global', blockedUsers: ['other'], blockVersion: 1
  });
  const ack = acknowledge();
  await blocker.trigger('switch_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value().history, []);
  assertNoNormalSecrets(blockerOutput(setup, [blocker], [ack.value()]));
});

test('blocked-message reveal requires fresh access exact room context and a currently blocked author', async () => {
  const target = message(1, { text: 'requested reveal' });
  const setup = fixture({
    messages: [target],
    experienceStates: [{
      usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
      blockVersion: 5
    }]
  });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: ['author'], blockVersion: 1
  });
  const allowed = acknowledge();
  await blocker.trigger('get_blocked_message', {
    serverCode: 'ABC123', messageId: target._id, clientContextId: 1
  }, allowed.callback);
  assert.equal(allowed.value().success, true);
  assert.equal(allowed.value().blockVersion, 5);
  assert.equal(allowed.value().message.text, 'requested reveal');

  blocker.serverCode = 'XYZ789';
  const wrongContext = acknowledge();
  await blocker.trigger('get_blocked_message', {
    serverCode: 'ABC123', messageId: target._id, clientContextId: 1
  }, wrongContext.callback);
  assert.deepEqual(wrongContext.value(), { error: 'Permission denied.' });

  setup.UserExperienceStateModel.rows[0].blockedUsers = [];
  blocker.serverCode = 'ABC123';
  const staleCache = acknowledge();
  await blocker.trigger('get_blocked_message', {
    serverCode: 'ABC123', messageId: target._id, clientContextId: 1
  }, staleCache.callback);
  assert.deepEqual(staleCache.value(), { error: 'Permission denied.' });
});

test('blocked-message reveal omits history reaction identities and reply content without changing state', async () => {
  const target = message(1, {
    text: 'explicitly requested', attachment: 'data:image/png;base64,AA==', deleted: true,
    history: [{ text: HISTORY_SECRET, timestamp: new Date() }],
    reactions: { '👍': [REACTION_SECRET] },
    replyTo: { id: objectId(2), authorKey: 'other', displayname: 'Other', text: REPLY_SECRET },
    autoModDecision: TEXT_SECRET
  });
  const setup = fixture({
    messages: [target],
    experienceStates: [{
      usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
      blockVersion: 6
    }]
  });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: ['author'], blockVersion: 6
  });
  const before = JSON.stringify(setup.UserExperienceStateModel.rows);
  const ack = acknowledge();
  await blocker.trigger('get_blocked_message', {
    serverCode: 'ABC123', messageId: target._id, clientContextId: 1
  }, ack.callback);

  assert.deepEqual(Object.keys(ack.value().message).sort(), [
    '_id', 'attachment', 'authorKey', 'deleted', 'displayName', 'edited',
    'serverCode', 'text', 'timestamp', 'username'
  ]);
  assert.equal(ack.value().message.text, '');
  assert.equal(ack.value().message.attachment, null);
  assert.equal(JSON.stringify(ack.value()).includes(HISTORY_SECRET), false);
  assert.equal(JSON.stringify(ack.value()).includes(REACTION_SECRET), false);
  assert.equal(JSON.stringify(ack.value()).includes(REPLY_SECRET), false);
  assert.equal(JSON.stringify(setup.UserExperienceStateModel.rows), before);
});

test('moderation system and presence events remain visible across a block', async () => {
  const setup = fixture({ experienceStates: [{
    usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
    blockVersion: 1
  }] });
  authenticate(setup, { id: 'blocker', username: 'Blocker', blockedUsers: ['author'], blockVersion: 1 });
  const author = authenticate(setup, { id: 'author', username: 'Author' });

  await author.trigger('disconnect');

  assert.equal(setup.ioInstance.outbound.some(item =>
    item.event === 'system_message' && item.payload === 'Author disconnected.'), true);
  assert.equal(setup.presenceCalls.includes('ABC123'), true);
  assert.equal(setup.presenceCalls.includes('global'), true);
});

test('block updates refresh room attention pin counts typing and active history on every blocker session', async () => {
  const target = message(1);
  const setup = fixture({ rooms: [
    room('global'), room('ABC123', {
      pinnedMessages: [{ messageId: target._id, pinnedAt: new Date(), pinnedBy: 'Owner' }], pinVersion: 3
    }), room('XYZ789')
  ], messages: [target] });
  const first = authenticate(setup, { id: 'first', username: 'Blocker' });
  const second = authenticate(setup, { id: 'second', username: 'Blocker', serverCode: 'XYZ789' });
  first.typingUsers = new Set(['author', 'other']);
  second.typingUsers = new Map([['author', true], ['other', true]]);

  await setBlock(first, 'Author', true);

  for (const live of [first, second]) {
    assert.equal(events(live, 'user_block_updated').length, 1);
    assert.equal(events(live, 'room_refresh_required').length, 1);
    assert.equal(events(live, 'room_attention_updated').length >= 1, true);
    assert.equal(events(live, 'message_pin_updated').some(payload => payload.pin?.blockVersion === 1), true);
  }
  assert.equal(first.typingUsers.has('author'), false);
  assert.equal(second.typingUsers.has('author'), false);
});

test('unblocking may expose newer unread messages without silently advancing any cursor', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const setup = fixture({
    messages: [message(10, {
      notificationMentions: ['blocker'], timestamp: new Date('2026-08-10T12:01:00.000Z')
    })],
    roomStates: [
      {
        usernameKey: 'blocker', serverCode: 'XYZ789', notificationLevel: 'all',
        lastReadAt: cursorAt, lastReadMessageId: objectId(9), version: 7
      },
      {
        usernameKey: 'blocker', serverCode: 'ABC123', notificationLevel: 'mentions',
        lastReadAt: cursorAt, lastReadMessageId: objectId(9), version: 3
      }
    ],
    experienceStates: [{
      usernameKey: 'blocker', blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
      blockVersion: 4
    }]
  });
  preserveAttentionProjection(setup.MessageModel);
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: ['author'], blockVersion: 4
  });
  const cursorRowsBefore = new Map(setup.RoomMemberStateModel.rows.map(row => [
    row.serverCode,
    JSON.stringify({
      lastReadAt: row.lastReadAt, lastReadMessageId: row.lastReadMessageId, version: row.version
    })
  ]));

  await setBlock(blocker, 'Author', false);

  assert.deepEqual(events(blocker, 'room_refresh_required').at(-1), { serverCode: 'ABC123', blockVersion: 5 });
  for (const serverCode of ['ABC123', 'XYZ789']) {
    const row = setup.RoomMemberStateModel.rows.find(candidate => candidate.serverCode === serverCode);
    assert.equal(JSON.stringify({
      lastReadAt: row.lastReadAt, lastReadMessageId: row.lastReadMessageId, version: row.version
    }), cursorRowsBefore.get(serverCode), serverCode);
  }
  const attention = events(blocker, 'room_attention_updated')
    .find(snapshot => snapshot.serverCode === 'ABC123');
  assert.deepEqual({
    unreadCount: attention.unreadCount,
    mentionCount: attention.mentionCount,
    blockVersion: attention.blockVersion
  }, { unreadCount: 1, mentionCount: 1, blockVersion: 5 });
});

test('blocked account receives no event acknowledgement or observable state change', async () => {
  const setup = fixture();
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });
  const target = authenticate(setup, { id: 'author', username: 'Author' });
  const before = JSON.stringify({ socket: target, session: setup.onlineUsersMap.get('author') }, (key, value) =>
    value instanceof Set || value instanceof Map || key === 'handlers' || key === '_fakeIoInstance' ? undefined : value);

  const result = await setBlock(blocker, 'Author', true);

  assert.equal(result.success, true);
  assert.deepEqual(target.outbound, []);
  const after = JSON.stringify({ socket: target, session: setup.onlineUsersMap.get('author') }, (key, value) =>
    value instanceof Set || value instanceof Map || key === 'handlers' || key === '_fakeIoInstance' ? undefined : value);
  assert.equal(after, before);
});

test('all normal content serializers reject internal Mongo AutoMod and edit-history fields', async () => {
  const created = message(1, {
    text: 'safe text', privateMongo: TEXT_SECRET, autoModDecision: ATTACHMENT_SECRET,
    history: [{ text: HISTORY_SECRET }], __v: REPLY_SECRET
  });
  const model = createMemoryModel([]);
  model.create = async () => created;
  const setup = fixture({ MessageModel: model });
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });

  await author.trigger('chat_message', { text: 'safe text' });

  const delivered = events(blocker, 'chat_message').at(-1);
  assert.deepEqual(Object.keys(delivered).sort(), [
    '_id', 'attachment', 'authorKey', 'avatarUrl', 'color', 'deleted', 'displayName', 'edited',
    'reactions', 'replyTo', 'role', 'roomRole', 'serverCode', 'text', 'timestamp', 'username'
  ]);
  assertNoNormalSecrets(blockerOutput(setup, [blocker]));
});
