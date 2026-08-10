const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionHandler, seedSystem, withAccountTransitionLock } = require('../server');
const { FakeSocket, FakeIo, queryResult, acknowledge, deferred, createMemoryModel } = require('./support/fakes');

function register(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  const MessageModel = { ...createMemoryModel([]), ...(overrides.MessageModel || {}) };
  const RoomMemberStateModel = overrides.RoomMemberStateModel || createMemoryModel([]);
  const UserExperienceStateModel = overrides.UserExperienceStateModel || createMemoryModel([]);
  const defaultUserModel = {
    async findOne() {
      return {
        username: socket.username || 'alice',
        role: socket.role || 'user',
        servers: Array.isArray(socket.joinedServers) && socket.joinedServers.length > 0
          ? [...socket.joinedServers] : ['global']
      };
    }
  };
  createConnectionHandler({
    ioInstance,
    ChatServerModel: {
      async find(query = {}) {
        const codes = query.code && Array.isArray(query.code.$in) ? query.code.$in : ['global'];
        return codes.map(code => ({ code, moderators: [] }));
      },
      async findOne() { return null; }
    },
    RoomRestrictionModel: { async findOne() { return null; }, async find() { return []; } },
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    ...overrides,
    MessageModel,
    RoomMemberStateModel,
    UserExperienceStateModel,
    UserModel: { ...defaultUserModel, ...(overrides.UserModel || {}) }
  })(socket);
  return { socket, ioInstance, MessageModel, RoomMemberStateModel, UserExperienceStateModel };
}

function registerSharedSocket(overrides, id) {
  const socket = new FakeSocket();
  socket.id = id;
  const MessageModel = { ...createMemoryModel([]), ...(overrides.MessageModel || {}) };
  const RoomMemberStateModel = overrides.RoomMemberStateModel || createMemoryModel([]);
  const UserExperienceStateModel = overrides.UserExperienceStateModel || createMemoryModel([]);
  const defaultUserModel = {
    async findOne() {
      return {
        username: socket.username || 'alice',
        role: socket.role || 'user',
        servers: Array.isArray(socket.joinedServers) && socket.joinedServers.length > 0
          ? [...socket.joinedServers] : ['global']
      };
    }
  };
  createConnectionHandler({
    ChatServerModel: {
      async find(query = {}) {
        const codes = query.code && Array.isArray(query.code.$in) ? query.code.$in : ['global'];
        return codes.map(code => ({ code, moderators: [] }));
      },
      async findOne() { return null; }
    },
    RoomRestrictionModel: { async findOne() { return null; }, async find() { return []; } },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    ...overrides,
    MessageModel,
    RoomMemberStateModel,
    UserExperienceStateModel,
    UserModel: { ...defaultUserModel, ...(overrides.UserModel || {}) }
  })(socket);
  return socket;
}

function emptySwitchSuccess(usernameKey = 'alice', { canEdit = false } = {}) {
  return {
    serverCode: 'ABC123',
    history: [],
    roomRole: 'user',
    restriction: { banned: false, timedOut: false, timeoutUntil: null },
    details: { description: '', rules: '', metadataVersion: 0, canEdit },
    notification: {
      serverCode: 'ABC123', usernameKey, notificationLevel: 'all',
      lastReadAt: null, lastReadMessageId: null,
      unreadCount: 0, mentionCount: 0, version: 0, blockVersion: 0
    },
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 0, blockVersion: 0 },
    attention: { unreadCount: 0, mentionCount: 0 }
  };
}

function roomActivityFixture({ mentioned = false, recipientBlockVersion = 0 } = {}) {
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const UserModel = createMemoryModel([
    { username: 'Author', displayName: 'Author', role: 'user', servers: ['global', 'ABC123'] },
    { username: 'Member', displayName: 'Member', role: 'user', servers: ['global', 'ABC123'] },
    { username: 'Timed', displayName: 'Timed', role: 'user', servers: ['global', 'ABC123'] },
    { username: 'Banned', displayName: 'Banned', role: 'user', servers: ['global', 'ABC123'] },
    { username: 'Nonmember', displayName: 'Nonmember', role: 'user', servers: ['global'] },
    { username: 'GhostAdmin', displayName: 'GhostAdmin', role: 'admin', servers: ['global'] }
  ]);
  const ChatServerModel = createMemoryModel([{
    code: 'ABC123', name: 'Private', owner: 'Author', moderators: [],
    autoMod: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 }
  }]);
  const MessageModel = createMemoryModel([]);
  const baseCreate = MessageModel.create.bind(MessageModel);
  const timestamp = new Date('2026-08-10T15:00:00.000Z');
  MessageModel.create = value => baseCreate({
    _id: '507f1f77bcf86cd799439101', timestamp, deleted: false, ...value
  });
  const RoomRestrictionModel = createMemoryModel([
    { serverCode: 'ABC123', username: 'timed', bannedAt: null, timeoutUntil: new Date(Date.now() + 60_000) },
    { serverCode: 'ABC123', username: 'banned', bannedAt: new Date(), timeoutUntil: null }
  ]);
  const RoomMemberStateModel = createMemoryModel([]);
  const UserExperienceStateModel = createMemoryModel([{
    usernameKey: 'member', blockedUsers: [], blockVersion: recipientBlockVersion
  }]);
  const shared = {
    ioInstance, onlineUsersMap, UserModel, ChatServerModel, MessageModel,
    RoomRestrictionModel, RoomMemberStateModel, UserExperienceStateModel,
    resolvePingsFn: async text => mentioned ? '{{PING:Member|Member}}' : text,
    logger: { error() {} }
  };
  function add({ id, username, role = 'user', serverCode = 'global', joinedServers }) {
    const memberships = joinedServers || UserModel.rows.find(row => row.username === username)?.servers || [];
    const socket = registerSharedSocket(shared, id);
    Object.assign(socket, {
      username, displayName: username, role, serverCode, joinedServers: [...memberships],
      bannedRooms: [], blockedUserKeys: new Set(),
      blockVersion: username.toLowerCase() === 'member' ? recipientBlockVersion : 0
    });
    if (serverCode) socket.joinedRooms.add(serverCode);
    onlineUsersMap.set(id, {
      username, displayName: username, role, serverCode, joinedServers: [...memberships],
      bannedRooms: [], blockedUsers: [], blockVersion: socket.blockVersion
    });
    ioInstance.sockets.push(socket);
    return socket;
  }
  return { ...shared, add, timestamp };
}

function eventPayloads(socket, event) {
  return socket.outbound.filter(item => item.event === event).map(item => item.payload);
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

test('create join and admin room discovery payloads expose only exact safe summaries', async () => {
  const autoModSentinel = 'ROOM_AUTOMOD_SENTINEL';
  const pinSentinel = '507f1f77bcf86cd799439099';
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const UserModel = createMemoryModel([
    { username: 'Creator', displayName: 'Creator', role: 'user', servers: ['global'] },
    { username: 'Joiner', displayName: 'Joiner', role: 'user', servers: ['global'] },
    { username: 'Admin', displayName: 'Admin', role: 'admin', servers: ['global'] }
  ]);
  const ChatServerModel = createMemoryModel([{
    code: 'ABC123', name: 'Existing Room', owner: 'Creator', moderators: ['Creator'],
    description: 'private description', rules: 'private rules', metadataVersion: 4,
    pinnedMessages: [{ messageId: pinSentinel, pinnedAt: new Date(), pinnedBy: 'Creator' }],
    pinVersion: 9, autoMod: { blockedKeywords: [autoModSentinel], mentionLimit: 8,
      repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 5, messageWindowSeconds: 5 },
    __v: 7, internalSentinel: 'ROOM_INTERNAL_SENTINEL'
  }]);
  const createRoom = ChatServerModel.create.bind(ChatServerModel);
  ChatServerModel.create = value => createRoom({
    ...value,
    description: 'created private description',
    rules: 'created private rules',
    metadataVersion: 0,
    pinnedMessages: [{ messageId: pinSentinel, pinnedAt: new Date(), pinnedBy: 'Creator' }],
    pinVersion: 3,
    autoMod: { blockedKeywords: [autoModSentinel], mentionLimit: 8,
      repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 5, messageWindowSeconds: 5 },
    moderators: ['Creator', 'HiddenModerator'],
    __v: 11,
    internalSentinel: 'ROOM_INTERNAL_SENTINEL'
  });
  const dependencies = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    ChatServerModel,
    MessageModel: createMemoryModel([]),
    RoomRestrictionModel: createMemoryModel([]),
    RoomMemberStateModel: createMemoryModel([]),
    UserExperienceStateModel: createMemoryModel([]),
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    logger: { error() {} }
  };
  function connect(id, username, role = 'user') {
    const live = new FakeSocket();
    live.id = id;
    createConnectionHandler(dependencies)(live);
    Object.assign(live, {
      username, displayName: username, role, serverCode: 'global',
      joinedServers: ['global'], bannedRooms: [], blockedUserKeys: new Set(), blockVersion: 0
    });
    live.joinedRooms.add('global');
    onlineUsersMap.set(id, {
      username, displayName: username, role, serverCode: 'global', joinedServers: ['global'],
      bannedRooms: [], blockedUsers: [], blockVersion: 0
    });
    ioInstance.sockets.push(live);
    return live;
  }
  const creator = connect('creator', 'Creator');
  const joiner = connect('joiner', 'Joiner');
  const admin = connect('admin', 'Admin', 'admin');

  const createAck = acknowledge();
  await creator.trigger('create_server', 'Created Room', createAck.callback);
  const createdSummary = createAck.value().server;
  const adminSummary = admin.outbound.find(item =>
    item.event === 'admin_new_server' && item.payload.code === createdSummary.code
  ).payload;
  const joinAck = acknowledge();
  await joiner.trigger('join_server', 'ABC123', joinAck.callback);
  const joinedSummary = joinAck.value().server;

  const expectedKeys = ['code', 'metadataVersion', 'name', 'owner', 'pin'];
  for (const [label, summary] of [
    ['create acknowledgement', createdSummary],
    ['administrator discovery event', adminSummary],
    ['join acknowledgement', joinedSummary]
  ]) {
    assert.deepEqual(Object.keys(summary).sort(), expectedKeys, label);
    assert.deepEqual(Object.keys(summary.pin).sort(), [
      'blockVersion', 'pinCount', 'pinVersion', 'serverCode'
    ], `${label} pin summary`);
  }
  const serialized = JSON.stringify({ createdSummary, adminSummary, joinedSummary });
  for (const sentinel of [
    autoModSentinel, pinSentinel, 'HiddenModerator', 'ROOM_INTERNAL_SENTINEL',
    'private description', 'private rules'
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test('room activity reaches inactive actual members but not admin ghost viewers nonmembers or banned users', async () => {
  const setup = roomActivityFixture();
  const author = setup.add({ id: 'author', username: 'Author', serverCode: 'ABC123' });
  const inactive = setup.add({ id: 'member-inactive', username: 'Member', serverCode: 'global' });
  const secondSession = setup.add({ id: 'member-second', username: 'Member', serverCode: null });
  const timed = setup.add({ id: 'timed', username: 'Timed', serverCode: 'global' });
  const banned = setup.add({ id: 'banned', username: 'Banned', serverCode: 'global' });
  const nonmember = setup.add({ id: 'nonmember', username: 'Nonmember', serverCode: 'global' });
  const ghost = setup.add({
    id: 'ghost', username: 'GhostAdmin', role: 'admin', serverCode: 'ABC123', joinedServers: ['global']
  });

  await author.trigger('chat_message', { text: 'activity for the room rail' });

  assert.equal(eventPayloads(inactive, 'room_activity').length, 1);
  assert.equal(eventPayloads(secondSession, 'room_activity').length, 1);
  assert.equal(eventPayloads(timed, 'room_activity').length, 1);
  for (const denied of [author, banned, nonmember, ghost]) {
    assert.deepEqual(eventPayloads(denied, 'room_activity'), [], denied.id);
  }
});

test('room activity carries the recipient current blockVersion and normalized message tuple', async () => {
  const setup = roomActivityFixture({ mentioned: true, recipientBlockVersion: 7 });
  const author = setup.add({ id: 'author', username: 'Author', serverCode: 'ABC123' });
  const recipient = setup.add({ id: 'member', username: 'Member', serverCode: 'global' });

  await author.trigger('chat_message', { text: '@Member' });

  assert.deepEqual(eventPayloads(recipient, 'room_activity'), [{
    serverCode: 'ABC123',
    messageId: '507f1f77bcf86cd799439101',
    timestamp: setup.timestamp,
    authorKey: 'author',
    mentioned: true,
    blockVersion: 7
  }]);
});

test('room activity cannot reach a member after a concurrent leave commits', async () => {
  const setup = roomActivityFixture();
  const activityAccessRead = deferred();
  const releaseActivityAccess = deferred();
  const findOne = setup.UserModel.findOne.bind(setup.UserModel);
  let gated = false;
  setup.UserModel.findOne = query => {
    const result = findOne(query);
    const usernamePattern = query?.username?.$regex;
    if (gated || !(usernamePattern instanceof RegExp) || !usernamePattern.test('Member')) return result;
    gated = true;
    return {
      then(resolve, reject) {
        return Promise.resolve(result).then(async user => {
          activityAccessRead.resolve();
          await releaseActivityAccess.promise;
          return user;
        }).then(resolve, reject);
      }
    };
  };
  const author = setup.add({ id: 'author', username: 'Author', serverCode: 'ABC123' });
  const recipient = setup.add({ id: 'member', username: 'Member', serverCode: 'global' });

  const sendPending = author.trigger('chat_message', { text: 'race with membership removal' });
  await activityAccessRead.promise;

  const leaveAck = acknowledge();
  await recipient.trigger('leave_server', 'ABC123', leaveAck.callback);
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(setup.UserModel.rows.find(row => row.username === 'Member').servers, ['global']);
  assert.deepEqual(recipient.joinedServers, ['global']);

  releaseActivityAccess.resolve();
  await sendPending;

  assert.deepEqual(eventPayloads(recipient, 'room_activity'), []);
});

test('login reconnect and account events replace exact counts from MongoDB', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const UserModel = createMemoryModel([{
    username: 'Reader', displayName: 'Reader', password: 'hash', role: 'user', servers: ['global', 'ABC123']
  }]);
  const ChatServerModel = createMemoryModel([
    { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] },
    { code: 'ABC123', name: 'Private', owner: 'Owner', moderators: [] }
  ]);
  const MessageModel = createMemoryModel([
    {
      _id: '507f1f77bcf86cd799439111', serverCode: 'ABC123', username: 'Other', authorKey: 'other',
      notificationMentions: [], timestamp: cursorAt
    },
    {
      _id: '507f1f77bcf86cd799439112', serverCode: 'ABC123', username: 'Other', authorKey: 'other',
      notificationMentions: ['reader'], timestamp: new Date('2026-08-10T12:01:00.000Z')
    },
    {
      _id: '507f1f77bcf86cd799439113', serverCode: 'ABC123', username: 'Other', authorKey: 'other',
      notificationMentions: [], timestamp: new Date('2026-08-10T12:02:00.000Z')
    }
  ]);
  preserveAttentionProjection(MessageModel);
  const RoomMemberStateModel = createMemoryModel([{
    usernameKey: 'reader', serverCode: 'ABC123', notificationLevel: 'all',
    lastReadAt: cursorAt, lastReadMessageId: '507f1f77bcf86cd799439111', version: 2
  }]);
  const UserExperienceStateModel = createMemoryModel([]);
  const shared = {
    ioInstance, onlineUsersMap, UserModel, ChatServerModel, MessageModel,
    RoomRestrictionModel: createMemoryModel([]), RoomMemberStateModel, UserExperienceStateModel,
    bcryptImpl: { async compare() { return true; } }, logger: { error() {} }
  };
  const first = registerSharedSocket(shared, 'login-one');
  ioInstance.sockets.push(first);
  const firstAck = acknowledge();
  await first.trigger('login', { username: 'Reader', password: '123456' }, firstAck.callback);
  const second = registerSharedSocket(shared, 'login-two');
  ioInstance.sockets.push(second);
  const secondAck = acknowledge();
  await second.trigger('login', { username: 'reader', password: '123456' }, secondAck.callback);

  for (const result of [firstAck.value(), secondAck.value()]) {
    const state = result.roomStates.find(row => row.serverCode === 'ABC123');
    assert.deepEqual({ unreadCount: state.unreadCount, mentionCount: state.mentionCount }, {
      unreadCount: 2, mentionCount: 1
    });
  }
  const notificationAck = acknowledge();
  await first.trigger('update_room_notification', {
    serverCode: 'ABC123', level: 'mentions'
  }, notificationAck.callback);
  assert.equal(notificationAck.value().unreadCount, 2);
  assert.equal(notificationAck.value().mentionCount, 1);
  assert.deepEqual(eventPayloads(second, 'room_notification_updated').at(-1), notificationAck.value());
});

test('login returns safe room summaries and actual-member room attention without admin ghost counts', async () => {
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const UserModel = createMemoryModel([{
    username: 'Admin', displayName: 'Admin', password: 'hash', role: 'admin',
    color: '#123456', avatarUrl: '', servers: ['global']
  }]);
  const ChatServerModel = createMemoryModel([
    {
      code: 'global', name: 'Global Chat', owner: 'System', metadataVersion: 2,
      pinnedMessages: [{ messageId: '507f1f77bcf86cd799439001' }], pinVersion: 3,
      moderators: []
    },
    {
      code: 'ABC123', name: 'Private', owner: 'Owner', metadataVersion: 4,
      pinnedMessages: [{ messageId: '507f1f77bcf86cd799439002' }], pinVersion: 5,
      moderators: []
    }
  ]);
  const MessageModel = createMemoryModel([{
    _id: '507f1f77bcf86cd799439010', serverCode: 'global', timestamp: cursorAt
  }]);
  const RoomMemberStateModel = createMemoryModel([]);
  const UserExperienceStateModel = createMemoryModel([{
    usernameKey: 'admin', blockedUsers: [{ usernameKey: 'bob', username: 'Bob', createdAt: new Date() }],
    blockVersion: 6
  }]);
  const setup = register({
    UserModel, ChatServerModel, MessageModel, RoomMemberStateModel, UserExperienceStateModel,
    bcryptImpl: { async compare() { return true; } }
  });
  const ack = acknowledge();

  await setup.socket.trigger('login', { username: 'admin', password: '123456' }, ack.callback);

  assert.deepEqual(ack.value(), {
    success: true,
    username: 'Admin', displayName: 'Admin', role: 'admin', color: '#123456', avatarUrl: '',
    servers: [
      {
        code: 'global', name: 'Global Chat', owner: 'System', metadataVersion: 2,
        pin: { serverCode: 'global', pinCount: 0, pinVersion: 3, blockVersion: 6 }
      },
      {
        code: 'ABC123', name: 'Private', owner: 'Owner', metadataVersion: 4,
        pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 5, blockVersion: 6 }
      }
    ],
    joinedServers: ['global'], defaultServerCode: 'global',
    restriction: { banned: false, timedOut: false, timeoutUntil: null }, bannedRooms: [],
    roomStates: [{
      serverCode: 'global', usernameKey: 'admin', notificationLevel: 'all',
      lastReadAt: cursorAt, lastReadMessageId: '507f1f77bcf86cd799439010',
      unreadCount: 0, mentionCount: 0, version: 0, blockVersion: 6
    }],
    blockState: { blockedUsers: [{ usernameKey: 'bob', username: 'Bob' }], blockVersion: 6 },
    attentionSnapshots: [{ serverCode: 'global', unreadCount: 0, mentionCount: 0 }]
  });
  assert.deepEqual(RoomMemberStateModel.rows.map(row => row.serverCode), ['global']);
  assert.equal(setup.socket.blockedUserKeys.has('bob'), true);
  assert.equal(setup.socket.blockVersion, 6);
});

test('login revalidates room existence and membership after a concurrent room deletion', async () => {
  const roomQueryCaptured = deferred();
  const releaseRoomQuery = deferred();
  const UserModel = createMemoryModel([
    { username: 'Alice', displayName: 'Alice', password: 'hash', role: 'user', servers: ['global', 'ABC123'] },
    { username: 'Owner', displayName: 'Owner', password: 'hash', role: 'user', servers: ['global', 'ABC123'] }
  ]);
  const ChatServerModel = createMemoryModel([
    { code: 'global', name: 'Global Chat', owner: 'System', moderators: [], metadataVersion: 1 },
    { code: 'ABC123', name: 'Private', owner: 'Owner', moderators: [], metadataVersion: 2 }
  ]);
  const baseRoomFind = ChatServerModel.find.bind(ChatServerModel);
  let holdLoginQuery = true;
  ChatServerModel.find = query => {
    const snapshot = baseRoomFind(query);
    if (!holdLoginQuery || !query?.code?.$in?.includes('ABC123')) return snapshot;
    holdLoginQuery = false;
    return {
      then(resolve, reject) {
        roomQueryCaptured.resolve();
        return releaseRoomQuery.promise.then(() => snapshot).then(resolve, reject);
      }
    };
  };
  const RoomMemberStateModel = createMemoryModel([]);
  const onlineUsersMap = new Map();
  const loginSocket = new FakeSocket();
  loginSocket.id = 'login-race';
  const ownerSocket = new FakeSocket();
  ownerSocket.id = 'delete-race';
  Object.assign(ownerSocket, {
    username: 'Owner', displayName: 'Owner', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  ownerSocket.joinedRooms.add('ABC123');
  onlineUsersMap.set(ownerSocket.id, {
    username: 'Owner', displayName: 'Owner', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  const ioInstance = new FakeIo([loginSocket, ownerSocket]);
  const dependencies = {
    ioInstance, onlineUsersMap, UserModel, ChatServerModel,
    MessageModel: createMemoryModel([]), RoomRestrictionModel: createMemoryModel([]),
    ModerationReportModel: createMemoryModel([]), RoomMemberStateModel,
    UserExperienceStateModel: createMemoryModel([]),
    bcryptImpl: { async compare() { return true; } },
    broadcastOnlineUsersFn: async () => {}, getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text, logger: { error() {} }
  };
  createConnectionHandler(dependencies)(loginSocket);
  createConnectionHandler(dependencies)(ownerSocket);

  const loginAck = acknowledge();
  const loginPending = loginSocket.trigger(
    'login', { username: 'Alice', password: '123456' }, loginAck.callback
  );
  await roomQueryCaptured.promise;
  const deleteAck = acknowledge();
  await ownerSocket.trigger('delete_server', 'ABC123', deleteAck.callback);
  assert.deepEqual(deleteAck.value(), { success: true });
  releaseRoomQuery.resolve();
  await loginPending;

  assert.deepEqual(loginAck.value(), {
    success: true,
    username: 'Alice', displayName: 'Alice', role: 'user', color: '', avatarUrl: '',
    servers: [{
      code: 'global', name: 'Global Chat', owner: 'System', metadataVersion: 1,
      pin: { serverCode: 'global', pinCount: 0, pinVersion: 0, blockVersion: 0 }
    }],
    joinedServers: ['global'], defaultServerCode: 'global',
    restriction: { banned: false, timedOut: false, timeoutUntil: null }, bannedRooms: [],
    roomStates: [{
      serverCode: 'global', usernameKey: 'alice', notificationLevel: 'all',
      lastReadAt: null, lastReadMessageId: null,
      unreadCount: 0, mentionCount: 0, version: 0, blockVersion: 0
    }],
    blockState: { blockedUsers: [], blockVersion: 0 },
    attentionSnapshots: [{ serverCode: 'global', unreadCount: 0, mentionCount: 0 }]
  });
  assert.deepEqual(RoomMemberStateModel.rows.map(row => row.serverCode), ['global']);
  assert.deepEqual(loginSocket.joinedServers, ['global']);
  assert.equal(loginSocket.serverCode, 'global');
  assert.equal(loginSocket.joinedRooms.has('global'), true);
  assert.equal(loginSocket.joinedRooms.has('ABC123'), false);
  assert.deepEqual(onlineUsersMap.get(loginSocket.id).joinedServers, ['global']);
});

test('switch returns details notification pin count attention and filtered history keys', async () => {
  const olderAt = new Date('2026-08-10T12:00:00.000Z');
  const newerAt = new Date('2026-08-10T12:01:00.000Z');
  const UserModel = createMemoryModel([{
    username: 'Alice', displayName: 'Alice', password: 'hash', role: 'user', servers: ['global', 'ABC123']
  }]);
  const ChatServerModel = createMemoryModel([{
    code: 'ABC123', name: 'Private', owner: 'Owner', moderators: [],
    description: 'Room description', rules: 'Room rules', metadataVersion: 4,
    pinnedMessages: [{ messageId: '507f1f77bcf86cd799439031' }], pinVersion: 7
  }]);
  const MessageModel = createMemoryModel([
    {
      _id: '507f1f77bcf86cd799439031', serverCode: 'ABC123', username: 'Carol', displayName: 'Carol',
      authorKey: 'carol', role: 'user', roomRole: 'user', color: '', avatarUrl: '', text: 'visible',
      attachment: null, replyTo: null, reactions: {}, edited: false, deleted: false, timestamp: olderAt,
      privateHistory: ['must-not-leak']
    },
    {
      _id: '507f1f77bcf86cd799439032', serverCode: 'ABC123', username: 'Bob', displayName: 'Bob',
      authorKey: 'bob', role: 'user', roomRole: 'user', color: '', avatarUrl: '', text: 'secret',
      attachment: null, replyTo: null, reactions: {}, edited: false, deleted: false, timestamp: newerAt,
      privateHistory: ['must-not-leak']
    }
  ]);
  const RoomMemberStateModel = createMemoryModel([{
    usernameKey: 'alice', serverCode: 'ABC123', notificationLevel: 'mentions',
    lastReadAt: olderAt, lastReadMessageId: '507f1f77bcf86cd799439031', version: 3
  }]);
  const UserExperienceStateModel = createMemoryModel([{
    usernameKey: 'alice', blockedUsers: [{ usernameKey: 'bob', username: 'Bob', createdAt: new Date() }],
    blockVersion: 2
  }]);
  const setup = register({
    UserModel, ChatServerModel, MessageModel, RoomMemberStateModel, UserExperienceStateModel
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'global',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  setup.socket.joinedRooms.add('global');
  const ack = acknowledge();

  await setup.socket.trigger('switch_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), {
    serverCode: 'ABC123',
    history: [
      {
        _id: '507f1f77bcf86cd799439031', serverCode: 'ABC123', username: 'Carol', displayName: 'Carol',
        authorKey: 'carol', role: 'user', roomRole: 'user', color: '', avatarUrl: '', text: 'visible',
        attachment: null, replyTo: null, reactions: {}, edited: false, deleted: false, timestamp: olderAt
      },
      {
        _id: '507f1f77bcf86cd799439032', serverCode: 'ABC123', username: 'Bob', authorKey: 'bob',
        timestamp: newerAt, blocked: true
      }
    ],
    roomRole: 'user',
    restriction: { banned: false, timedOut: false, timeoutUntil: null },
    details: { description: 'Room description', rules: 'Room rules', metadataVersion: 4, canEdit: false },
    notification: {
      serverCode: 'ABC123', usernameKey: 'alice', notificationLevel: 'mentions',
      lastReadAt: olderAt, lastReadMessageId: '507f1f77bcf86cd799439031',
      unreadCount: 0, mentionCount: 0, version: 3, blockVersion: 2
    },
    pin: { serverCode: 'ABC123', pinCount: 1, pinVersion: 7, blockVersion: 2 },
    attention: { unreadCount: 0, mentionCount: 0 }
  });
});

test('switch history is blocker-filtered and preserves Global legacy compatibility', async () => {
  const secret = 'BLOCKED_TEXT_SENTINEL';
  const timestamp = new Date('2026-08-10T12:00:00.000Z');
  const setup = register({
    UserModel: createMemoryModel([{
      username: 'Alice', displayName: 'Alice', role: 'user', servers: ['global']
    }]),
    ChatServerModel: createMemoryModel([{
      code: 'global', name: 'Global Chat', owner: 'System', moderators: [], pinnedMessages: [], pinVersion: 0
    }]),
    MessageModel: createMemoryModel([{
      _id: '507f1f77bcf86cd799439011', username: 'Bob', authorKey: 'bob', displayName: 'Bob',
      role: 'user', roomRole: 'user', color: '', avatarUrl: '', text: secret,
      attachment: null, replyTo: null, reactions: {}, edited: false, deleted: false, timestamp
    }]),
    UserExperienceStateModel: createMemoryModel([{
      usernameKey: 'alice', blockedUsers: [{ usernameKey: 'bob', username: 'Bob', createdAt: new Date() }],
      blockVersion: 2
    }])
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'global',
    joinedServers: ['global'], blockedUserKeys: new Set(['bob']), blockVersion: 2
  });
  const ack = acknowledge();

  await setup.socket.trigger('switch_server', 'Global', ack.callback);

  assert.deepEqual(ack.value().history, [{
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'Bob', authorKey: 'bob',
    timestamp, blocked: true
  }]);
  assert.equal(JSON.stringify(ack.value()).includes(secret), false);
});

test('leave retains room state while deletion removes every state row for that room', async () => {
  const retainedState = createMemoryModel([{
    usernameKey: 'alice', serverCode: 'ABC123', notificationLevel: 'none',
    lastReadAt: null, lastReadMessageId: null, version: 2
  }]);
  const leaveSetup = register({
    UserModel: createMemoryModel([{ username: 'Alice', role: 'user', servers: ['global', 'ABC123'] }]),
    ChatServerModel: createMemoryModel([
      { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] },
      { code: 'ABC123', name: 'Private', owner: 'Owner', moderators: [] }
    ]),
    RoomMemberStateModel: retainedState
  });
  Object.assign(leaveSetup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  leaveSetup.socket.joinedRooms.add('ABC123');
  const leaveAck = acknowledge();
  await leaveSetup.socket.trigger('leave_server', 'ABC123', leaveAck.callback);
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.equal(retainedState.rows.length, 1);

  const deletedState = createMemoryModel([
    { usernameKey: 'alice', serverCode: 'ABC123', notificationLevel: 'all', version: 0 },
    { usernameKey: 'bob', serverCode: 'ABC123', notificationLevel: 'mentions', version: 4 },
    { usernameKey: 'alice', serverCode: 'global', notificationLevel: 'none', version: 1 }
  ]);
  const deleteSetup = register({
    UserModel: createMemoryModel([{
      username: 'Owner', displayName: 'Owner', role: 'user', servers: ['global', 'ABC123']
    }]),
    ChatServerModel: createMemoryModel([
      { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] },
      { code: 'ABC123', name: 'Private', owner: 'Owner', moderators: [] }
    ]),
    MessageModel: createMemoryModel([]), RoomRestrictionModel: createMemoryModel([]),
    RoomMemberStateModel: deletedState
  });
  Object.assign(deleteSetup.socket, {
    username: 'Owner', displayName: 'Owner', role: 'user', serverCode: 'global',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  const deleteAck = acknowledge();
  await deleteSetup.socket.trigger('delete_server', 'ABC123', deleteAck.callback);
  assert.deepEqual(deleteAck.value(), { success: true });
  assert.deepEqual(deletedState.rows.map(row => ({ usernameKey: row.usernameKey, serverCode: row.serverCode })), [
    { usernameKey: 'alice', serverCode: 'global' }
  ]);
});

test('account transition locks serialize one normalized account and release after failure', async () => {
  const firstGate = deferred();
  const events = [];

  const first = withAccountTransitionLock('Alice', async () => {
    events.push('alice:first:start');
    await firstGate.promise;
    events.push('alice:first:end');
  });
  const second = withAccountTransitionLock('alice', async () => {
    events.push('alice:second');
  });
  const bob = withAccountTransitionLock('bob', async () => {
    events.push('bob');
  });

  await bob;
  assert.deepEqual(events, ['alice:first:start', 'bob']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['alice:first:start', 'bob', 'alice:first:end', 'alice:second']);

  await assert.rejects(withAccountTransitionLock('alice', async () => { throw new Error('expected'); }));
  await assert.doesNotReject(withAccountTransitionLock('ALICE', async () => {}));
});

test('login rejects replacing an authenticated socket identity', async () => {
  const { socket } = register();
  socket.username = 'alice';
  const ack = acknowledge();
  await socket.trigger('login', { username: 'bob', password: '123456' }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Already authenticated.' });
  assert.equal(socket.username, 'alice');
});

test('a late login server query failure leaves socket, rooms, presence, and broadcasts unchanged', async () => {
  const onlineUsersMap = new Map();
  const broadcasts = [];
  const { socket } = register({
    UserModel: {
      async findOne() {
        return { username: 'alice', displayName: 'Alice', password: 'hash', role: 'user', servers: ['global'] };
      }
    },
    ChatServerModel: { async find() { throw new Error('database unavailable'); } },
    bcryptImpl: { async compare() { return true; } },
    onlineUsersMap,
    broadcastOnlineUsersFn: async code => broadcasts.push(code),
    logger: { error() {} }
  });
  const ack = acknowledge();
  await socket.trigger('login', { username: 'alice', password: '123456' }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Login failed.' });
  assert.equal(socket.username, undefined);
  assert.equal(socket.serverCode, null);
  assert.deepEqual(socket.joinedServers, []);
  assert.equal(socket.joinedRooms.has('global'), false);
  assert.equal(onlineUsersMap.size, 0);
  assert.deepEqual(broadcasts, []);
});

test('login cannot publish membership removed by a concurrent leave', async () => {
  const compareStarted = deferred();
  const releaseCompare = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Alice', password: 'hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global', 'ABC123']
  };
  const staleLoginSnapshot = { ...persisted, servers: [...persisted.servers] };
  let regexReads = 0;
  let compareCalls = 0;

  function readUser(source = persisted) {
    const document = { ...source, servers: [...source.servers] };
    document.save = async () => {
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.username && typeof query.username === 'object') {
        regexReads += 1;
        return readUser(regexReads === 1 ? staleLoginSnapshot : persisted);
      }
      return readUser();
    }
  };
  const bcryptImpl = {
    async compare() {
      compareCalls += 1;
      if (compareCalls === 1) {
        compareStarted.resolve();
        await releaseCompare.promise;
      }
      return true;
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const rooms = [
    { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] },
    { code: 'ABC123', name: 'Private', owner: 'Owner', moderators: [] }
  ];
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    bcryptImpl,
    ChatServerModel: {
      async find(query = {}) {
        const included = query.code?.$in;
        return rooms.filter(room => !included || included.includes(room.code));
      },
      async findOne(query) { return rooms.find(room => room.code === query.code) || null; },
      async updateOne() {}
    }
  };
  const loginSocket = registerSharedSocket(shared, 'socket-login');
  const liveSocket = registerSharedSocket(shared, 'socket-live');
  Object.assign(liveSocket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  liveSocket.joinedRooms.add('ABC123');
  onlineUsersMap.set(liveSocket.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  ioInstance.sockets = [loginSocket, liveSocket];

  const loginAck = acknowledge();
  const loginPending = loginSocket.trigger('login', {
    username: 'alice', password: '123456'
  }, loginAck.callback);
  await compareStarted.promise;

  const leaveAck = acknowledge();
  await liveSocket.trigger('leave_server', 'ABC123', leaveAck.callback);
  assert.deepEqual(leaveAck.value(), { success: true });

  releaseCompare.resolve();
  await loginPending;

  assert.deepEqual(loginAck.value().joinedServers, ['global']);
  for (const live of [loginSocket, liveSocket]) {
    assert.deepEqual(live.joinedServers, ['global']);
    assert.equal(live.joinedRooms.has('ABC123'), false);
    assert.deepEqual(onlineUsersMap.get(live.id).joinedServers, ['global']);
  }
  assert.deepEqual(onlineUsersMap.get('map-only').joinedServers, ['global']);
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');
});

test('login cannot retain ghost access after concurrent global-admin demotion', async () => {
  const compareStarted = deferred();
  const releaseCompare = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Alice', password: 'hash', role: 'admin',
    color: '', avatarUrl: '', servers: ['global']
  };
  const staleLoginSnapshot = { ...persisted, servers: [...persisted.servers] };
  let regexReads = 0;
  let compareCalls = 0;

  function readUser(source = persisted) {
    const document = { ...source, servers: [...source.servers] };
    document.save = async () => {
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.username && typeof query.username === 'object') {
        regexReads += 1;
        return readUser(regexReads === 1 ? staleLoginSnapshot : persisted);
      }
      return readUser();
    }
  };
  const bcryptImpl = {
    async compare() {
      compareCalls += 1;
      if (compareCalls === 1) {
        compareStarted.resolve();
        await releaseCompare.promise;
      }
      return true;
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    bcryptImpl,
    ChatServerModel: {
      async find() { return []; },
      async findOne() { return { code: 'ABC123', moderators: [] }; }
    },
    MessageModel: { find: () => queryResult([]) }
  };
  const loginSocket = registerSharedSocket(shared, 'socket-login');
  const liveSocket = registerSharedSocket(shared, 'socket-live');
  Object.assign(liveSocket, {
    username: 'Alice', displayName: 'Alice', role: 'admin', serverCode: 'ABC123',
    joinedServers: ['global']
  });
  liveSocket.joinedRooms.add('ABC123');
  onlineUsersMap.set(liveSocket.id, {
    username: 'Alice', displayName: 'Alice', role: 'admin', serverCode: 'ABC123',
    joinedServers: ['global']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'ABC123',
    joinedServers: ['global']
  });
  ioInstance.sockets = [loginSocket, liveSocket];

  const loginAck = acknowledge();
  const loginPending = loginSocket.trigger('login', {
    username: 'alice', password: '123456'
  }, loginAck.callback);
  await compareStarted.promise;

  const roleAck = acknowledge();
  await liveSocket.trigger('manage_role', {
    targetUser: 'Alice', action: 'demote_global_admin'
  }, roleAck.callback);
  assert.deepEqual(roleAck.value(), { success: true });

  releaseCompare.resolve();
  await loginPending;

  assert.equal(loginAck.value().role, 'user');
  for (const live of [loginSocket, liveSocket]) {
    assert.equal(live.role, 'user');
    assert.equal(onlineUsersMap.get(live.id).role, 'user');
    assert.equal(live.joinedRooms.has('ABC123'), false);
  }
  assert.equal(onlineUsersMap.get('map-only').role, 'user');
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');

  const switchAck = acknowledge();
  await loginSocket.trigger('switch_server', 'ABC123', switchAck.callback);
  assert.deepEqual(switchAck.value(), { error: 'Permission denied.' });
  assert.equal(loginSocket.joinedRooms.has('ABC123'), false);
});

test('login overlapping profile update publishes the final profile', async () => {
  const compareStarted = deferred();
  const releaseCompare = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Old Alice', password: 'hash', role: 'user',
    color: '#111111', avatarUrl: 'https://example.test/old.png', servers: ['global']
  };
  const staleLoginSnapshot = { ...persisted, servers: [...persisted.servers] };
  let regexReads = 0;
  let compareCalls = 0;

  function readUser(source = persisted) {
    const document = { ...source, servers: [...source.servers] };
    document.save = async () => {
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.displayName && typeof query.displayName === 'object') return null;
      if (query.username && typeof query.username === 'object') {
        regexReads += 1;
        return readUser(regexReads === 1 ? staleLoginSnapshot : persisted);
      }
      return readUser();
    }
  };
  const bcryptImpl = {
    async compare() {
      compareCalls += 1;
      if (compareCalls === 1) {
        compareStarted.resolve();
        await releaseCompare.promise;
      }
      return true;
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    bcryptImpl,
    ChatServerModel: { async find() { return []; } },
    MessageModel: { async updateMany() {} }
  };
  const loginSocket = registerSharedSocket(shared, 'socket-login');
  const liveSocket = registerSharedSocket(shared, 'socket-live');
  Object.assign(liveSocket, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set(liveSocket.id, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [loginSocket, liveSocket];

  const loginAck = acknowledge();
  const loginPending = loginSocket.trigger('login', {
    username: 'alice', password: '123456'
  }, loginAck.callback);
  await compareStarted.promise;

  const profileAck = acknowledge();
  await liveSocket.trigger('update_profile', {
    displayName: 'New Alice', color: '#aabbcc', avatarUrl: 'https://example.test/new.png'
  }, profileAck.callback);
  assert.deepEqual(profileAck.value(), {
    success: true,
    displayName: 'New Alice',
    color: '#aabbcc',
    avatarUrl: 'https://example.test/new.png'
  });

  releaseCompare.resolve();
  await loginPending;

  const expectedProfile = {
    displayName: 'New Alice', color: '#aabbcc', avatarUrl: 'https://example.test/new.png'
  };
  assert.deepEqual({
    displayName: loginAck.value().displayName,
    color: loginAck.value().color,
    avatarUrl: loginAck.value().avatarUrl
  }, expectedProfile);
  for (const live of [loginSocket, liveSocket]) {
    assert.deepEqual({
      displayName: live.displayName, color: live.color, avatarUrl: live.avatarUrl
    }, expectedProfile);
    const session = onlineUsersMap.get(live.id);
    assert.deepEqual({
      displayName: session.displayName, color: session.color, avatarUrl: session.avatarUrl
    }, expectedProfile);
  }
  const mapOnly = onlineUsersMap.get('map-only');
  assert.deepEqual({
    displayName: mapOnly.displayName, color: mapOnly.color, avatarUrl: mapOnly.avatarUrl
  }, expectedProfile);
});

test('profile update reconciles a session that becomes live during the write', async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Old Alice', password: 'hash', role: 'user',
    color: '#111111', avatarUrl: 'https://example.test/old.png', servers: ['global']
  };

  function readUser() {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      saveStarted.resolve();
      await releaseSave.promise;
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.displayName && typeof query.displayName === 'object') return null;
      return readUser();
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    MessageModel: { async updateMany() {} }
  };
  const updater = registerSharedSocket(shared, 'socket-updater');
  const arriving = registerSharedSocket(shared, 'socket-arriving');
  Object.assign(updater, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set(updater.id, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [updater];

  let acknowledgement;
  let profilesAtAcknowledgement;
  const pending = updater.trigger('update_profile', {
    displayName: 'New Alice', color: '#aabbcc', avatarUrl: 'https://example.test/new.png'
  }, value => {
    acknowledgement = value;
    profilesAtAcknowledgement = [updater, arriving].map(live => ({
      displayName: live.displayName,
      color: live.color,
      avatarUrl: live.avatarUrl,
      session: { ...onlineUsersMap.get(live.id) }
    }));
    profilesAtAcknowledgement.push({ session: { ...onlineUsersMap.get('map-only') } });
  });
  await saveStarted.promise;

  Object.assign(arriving, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set(arriving.id, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [updater, arriving];
  releaseSave.resolve();
  await pending;

  assert.deepEqual(acknowledgement, {
    success: true,
    displayName: 'New Alice',
    color: '#aabbcc',
    avatarUrl: 'https://example.test/new.png'
  });
  for (const snapshot of profilesAtAcknowledgement) {
    const liveProfile = snapshot.displayName === undefined ? snapshot.session : snapshot;
    assert.equal(liveProfile.displayName, 'New Alice');
    assert.equal(liveProfile.color, '#aabbcc');
    assert.equal(liveProfile.avatarUrl, 'https://example.test/new.png');
    assert.equal(snapshot.session.displayName, 'New Alice');
    assert.equal(snapshot.session.color, '#aabbcc');
    assert.equal(snapshot.session.avatarUrl, 'https://example.test/new.png');
  }
});

test('unauthorized room switch leaves current membership unchanged', async () => {
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123' }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({ ChatServerModel, MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');
  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.equal(socket.serverCode, 'global');
  assert.equal(socket.leftRooms.length, 0);
});

test('authorized room switch leaves old room only after access succeeds', async () => {
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({ ChatServerModel, MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'ABC123'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');
  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.equal(socket.serverCode, 'ABC123');
  assert.deepEqual(socket.leftRooms, ['global']);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
  assert.deepEqual(ack.value(), emptySwitchSuccess());
});

test('room switch history failure preserves transport, socket, and presence state', async () => {
  const onlineUsersMap = new Map([['socket-1', {
    username: 'alice', serverCode: 'OLD123', joinedServers: ['global', 'OLD123', 'ABC123']
  }]]);
  const broadcasts = [];
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        async lean() { throw new Error('history unavailable'); }
      };
    }
  };
  const { socket } = register({
    ChatServerModel,
    MessageModel,
    onlineUsersMap,
    broadcastOnlineUsersFn: code => broadcasts.push(code),
    logger: { error() {} }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'OLD123', 'ABC123'];
  socket.serverCode = 'OLD123';
  socket.joinedRooms.add('OLD123');

  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Failed to switch server.' });
  assert.equal(socket.serverCode, 'OLD123');
  assert.deepEqual(socket.leftRooms, []);
  assert.equal(socket.joinedRooms.has('OLD123'), true);
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'OLD123');
  assert.deepEqual(broadcasts, []);
});

for (const scenario of [
  { stage: 'leave', failure: 'synchronous throw' },
  { stage: 'leave', failure: 'rejected promise' },
  { stage: 'join', failure: 'synchronous throw' },
  { stage: 'join', failure: 'rejected promise' }
]) {
  test(`room switch fails closed when ${scenario.stage} has a ${scenario.failure}`, async () => {
    const events = [];
    const broadcasts = [];
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', serverCode: 'OLD123', joinedServers: ['global', 'OLD123', 'ABC123']
    }]]);
    const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
    const MessageModel = { find: () => queryResult([]) };
    const { socket } = register({
      ChatServerModel,
      MessageModel,
      onlineUsersMap,
      broadcastOnlineUsersFn: code => broadcasts.push(code),
      logger: { error() {} }
    });
    socket.username = 'alice';
    socket.role = 'user';
    socket.joinedServers = ['global', 'OLD123', 'ABC123'];
    socket.serverCode = 'OLD123';
    socket.joinedRooms.add('OLD123');

    const originalLeave = socket.leave.bind(socket);
    const originalJoin = socket.join.bind(socket);
    let failed = false;
    socket.leave = roomCode => {
      events.push(`leave:${roomCode}`);
      originalLeave(roomCode);
      if (!failed && scenario.stage === 'leave' && roomCode === 'OLD123') {
        failed = true;
        if (scenario.failure === 'synchronous throw') throw new Error('leave failed');
        return Promise.reject(new Error('leave failed'));
      }
    };
    socket.join = roomCode => {
      events.push(`join:${roomCode}`);
      originalJoin(roomCode);
      if (!failed && scenario.stage === 'join' && roomCode === 'ABC123') {
        failed = true;
        if (scenario.failure === 'synchronous throw') throw new Error('join failed');
        return Promise.reject(new Error('join failed'));
      }
    };
    socket.disconnect = force => {
      events.push(`disconnect:${force}`);
      socket.joinedRooms.clear();
      socket.disconnected = force;
      return socket.handlers.get('disconnect')();
    };

    const ack = acknowledge();
    await socket.trigger('switch_server', 'ABC123', ack.callback);

    assert.deepEqual(ack.value(), { error: 'Failed to switch server.' });
    assert.equal(socket.disconnected, true);
    assert.equal(socket.serverCode, null);
    assert.equal(onlineUsersMap.has(socket.id), false);
    assert.deepEqual([...socket.joinedRooms], []);
    assert.deepEqual(socket.joinedServers, []);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(events, scenario.stage === 'leave'
      ? ['leave:OLD123', 'leave:ABC123', 'leave:OLD123', 'disconnect:true']
      : ['leave:OLD123', 'join:ABC123', 'leave:ABC123', 'leave:OLD123', 'disconnect:true']);
  });
}

for (const failure of ['synchronous throw', 'rejected promise']) {
  test(`failed target join clears authorization and transport when disconnect has a ${failure}`, async () => {
    const events = [];
    const broadcasts = [];
    let userLookups = 0;
    let userCreates = 0;
    let passwordComparisons = 0;
    let passwordHashes = 0;
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'OLD123',
      joinedServers: ['global', 'OLD123', 'ABC123']
    }]]);
    const room = { code: 'ABC123', owner: 'owner', moderators: [] };
    const readUser = () => ({
      username: 'alice', displayName: 'Alice', password: 'hash', role: 'admin',
      color: '', avatarUrl: '', servers: ['global'], async save() {}
    });
    const { socket } = register({
      onlineUsersMap,
      UserModel: {
        async findOne(query) {
          userLookups += 1;
          if (query.username && typeof query.username === 'object') {
            return query.username.$regex.test('alice') ? readUser() : null;
          }
          if (query.displayName) return null;
          return query.username === 'alice' ? readUser() : null;
        },
        async create() { userCreates += 1; }
      },
      bcryptImpl: {
        async compare() { passwordComparisons += 1; return true; },
        async hash() { passwordHashes += 1; return 'hash'; }
      },
      ChatServerModel: {
        async findOne() { return room; },
        async find() { return []; }
      },
      MessageModel: { find: () => queryResult([]) },
      broadcastOnlineUsersFn: code => broadcasts.push(code),
      logger: { error() {} }
    });
    Object.assign(socket, {
      username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'OLD123',
      joinedServers: ['global', 'OLD123', 'ABC123']
    });
    socket.joinedRooms.add('OLD123');

    socket.leave = roomCode => {
      events.push(`leave:${roomCode}`);
      FakeSocket.prototype.leave.call(socket, roomCode);
    };
    socket.join = roomCode => {
      events.push(`join:${roomCode}`);
      FakeSocket.prototype.join.call(socket, roomCode);
      if (roomCode === 'ABC123') return Promise.reject(new Error('target join failed'));
    };
    socket.disconnect = force => {
      events.push(`disconnect:${force}`);
      if (failure === 'synchronous throw') throw new Error('disconnect failed');
      return Promise.reject(new Error('disconnect failed'));
    };

    const switchAck = acknowledge();
    await socket.trigger('switch_server', 'ABC123', switchAck.callback);

    assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
    assert.equal(socket.username, null);
    assert.equal(socket.displayName, null);
    assert.equal(socket.role, null);
    assert.deepEqual(socket.joinedServers, []);
    assert.equal(socket.serverCode, null);
    assert.equal(onlineUsersMap.has(socket.id), false);
    assert.deepEqual([...socket.joinedRooms], []);
    const userLookupsAfterSwitch = userLookups;

    const authenticatedAck = acknowledge();
    await socket.trigger('join_server', 'ABC123', authenticatedAck.callback);
    assert.deepEqual(authenticatedAck.value(), { error: 'Not authenticated.' });

    const loginAck = acknowledge();
    await socket.trigger('login', {
      username: 'alice', password: '123456'
    }, loginAck.callback);
    const registerAck = acknowledge();
    await socket.trigger('register', {
      username: 'bob', displayName: 'Bob', password: '123456'
    }, registerAck.callback);
    assert.deepEqual(loginAck.value(), { error: 'Connection unavailable.' });
    assert.deepEqual(registerAck.value(), { error: 'Connection unavailable.' });
    assert.equal(userLookups, userLookupsAfterSwitch);
    assert.equal(userCreates, 0);
    assert.equal(passwordComparisons, 0);
    assert.equal(passwordHashes, 0);
    assert.equal(socket.username, null);
    assert.deepEqual(socket.joinedServers, []);
    assert.equal(onlineUsersMap.has(socket.id), false);

    socket.handlers.get('disconnect')();

    assert.deepEqual(broadcasts, []);
    assert.deepEqual(events, [
      'leave:OLD123', 'join:ABC123', 'leave:ABC123', 'leave:OLD123', 'disconnect:true'
    ]);
  });
}

test('failed target join cannot restore source access revoked by a concurrent leave', async () => {
  const targetJoinStarted = deferred();
  const releaseTargetJoin = deferred();
  const persisted = {
    username: 'alice', servers: ['global', 'OLD123', 'NEW123']
  };
  const readUser = () => {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      persisted.servers = [...document.servers];
    };
    return document;
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return readUser(); } },
    ChatServerModel: {
      async findOne({ code }) { return { code, owner: 'owner', moderators: [] }; },
      async updateOne() {}
    },
    MessageModel: { find: () => queryResult([]) },
    logger: { error() {} }
  };
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  Object.assign(switcher, {
    username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  switcher.joinedRooms.add('OLD123');
  const revoker = registerSharedSocket(shared, 'socket-revoker');
  Object.assign(revoker, {
    username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'global',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  revoker.joinedRooms.add('global');
  for (const live of [switcher, revoker]) {
    onlineUsersMap.set(live.id, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: live.serverCode,
      joinedServers: ['global', 'OLD123', 'NEW123']
    });
  }
  ioInstance.sockets = [switcher, revoker];

  let targetAttempted = false;
  switcher.join = async roomCode => {
    FakeSocket.prototype.join.call(switcher, roomCode);
    if (roomCode === 'NEW123' && !targetAttempted) {
      targetAttempted = true;
      targetJoinStarted.resolve();
      await releaseTargetJoin.promise;
      throw new Error('target join failed');
    }
  };
  switcher.disconnect = force => {
    switcher.joinedRooms.clear();
    switcher.disconnected = force;
    return switcher.handlers.get('disconnect')();
  };

  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'NEW123', switchAck.callback);
  await targetJoinStarted.promise;

  const leaveAck = acknowledge();
  const leavePending = revoker.trigger('leave_server', 'OLD123', leaveAck.callback);
  await Promise.resolve();
  releaseTargetJoin.resolve();
  await Promise.all([switchPending, leavePending]);
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(persisted.servers, ['global', 'NEW123']);

  assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
  assert.equal(switcher.disconnected, true);
  assert.equal(switcher.serverCode, null);
  assert.equal(onlineUsersMap.has(switcher.id), false);
  assert.equal(switcher.joinedRooms.has('OLD123'), false);
});

test('failed target join cannot restore source access revoked by a concurrent demotion', async () => {
  const targetJoinStarted = deferred();
  const releaseTargetJoin = deferred();
  const targetUser = {
    username: 'bob', displayName: 'Bob', role: 'admin', servers: ['global'],
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return targetUser; } },
    ChatServerModel: {
      async findOne({ code }) { return { code, owner: 'owner', moderators: [] }; }
    },
    MessageModel: { find: () => queryResult([]) },
    logger: { error() {} }
  };
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  Object.assign(switcher, {
    username: 'bob', displayName: 'Bob', role: 'admin', serverCode: 'OLD123',
    joinedServers: ['global']
  });
  switcher.joinedRooms.add('OLD123');
  const administrator = registerSharedSocket(shared, 'socket-admin');
  Object.assign(administrator, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  administrator.joinedRooms.add('global');
  onlineUsersMap.set(switcher.id, {
    username: 'bob', displayName: 'Bob', role: 'admin', serverCode: 'OLD123',
    joinedServers: ['global']
  });
  onlineUsersMap.set(administrator.id, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  ioInstance.sockets = [switcher, administrator];

  let targetAttempted = false;
  switcher.join = async roomCode => {
    FakeSocket.prototype.join.call(switcher, roomCode);
    if (roomCode === 'NEW123' && !targetAttempted) {
      targetAttempted = true;
      targetJoinStarted.resolve();
      await releaseTargetJoin.promise;
      throw new Error('target join failed');
    }
  };
  switcher.disconnect = force => {
    switcher.joinedRooms.clear();
    switcher.disconnected = force;
    return switcher.handlers.get('disconnect')();
  };

  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'NEW123', switchAck.callback);
  await targetJoinStarted.promise;

  const roleAck = acknowledge();
  const rolePending = administrator.trigger('manage_role', {
    targetUser: 'bob', action: 'demote_global_admin'
  }, roleAck.callback);
  await Promise.resolve();
  releaseTargetJoin.resolve();
  await Promise.all([switchPending, rolePending]);
  assert.deepEqual(roleAck.value(), { success: true });
  assert.equal(targetUser.role, 'user');

  assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
  assert.equal(switcher.disconnected, true);
  assert.equal(switcher.serverCode, null);
  assert.equal(onlineUsersMap.has(switcher.id), false);
  assert.equal(switcher.joinedRooms.has('OLD123'), false);
});

test('failed target join cannot restore a concurrently deleted source room', async () => {
  const targetJoinStarted = deferred();
  const releaseTargetJoin = deferred();
  const rooms = new Map([
    ['OLD123', { code: 'OLD123', owner: 'alice', moderators: [] }],
    ['NEW123', { code: 'NEW123', owner: 'owner', moderators: [] }]
  ]);
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    ChatServerModel: {
      async findOne({ code }) { return rooms.get(code) || null; },
      async deleteOne({ code }) { rooms.delete(code); }
    },
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher && matcher.test('alice')) {
          return { username: 'alice', role: 'admin', servers: ['global'] };
        }
        return { username: 'bob', role: 'user', servers: ['global', 'OLD123', 'NEW123'] };
      },
      async updateMany() {}
    },
    MessageModel: {
      find: () => queryResult([]),
      async deleteMany() {}
    },
    logger: { error() {} }
  };
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  Object.assign(switcher, {
    username: 'bob', displayName: 'Bob', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  switcher.joinedRooms.add('OLD123');
  const deleter = registerSharedSocket(shared, 'socket-deleter');
  Object.assign(deleter, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  deleter.joinedRooms.add('global');
  onlineUsersMap.set(switcher.id, {
    username: 'bob', displayName: 'Bob', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  onlineUsersMap.set(deleter.id, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  ioInstance.sockets = [switcher, deleter];

  let targetAttempted = false;
  switcher.join = async roomCode => {
    FakeSocket.prototype.join.call(switcher, roomCode);
    if (roomCode === 'NEW123' && !targetAttempted) {
      targetAttempted = true;
      targetJoinStarted.resolve();
      await releaseTargetJoin.promise;
      throw new Error('target join failed');
    }
  };
  switcher.disconnect = force => {
    switcher.joinedRooms.clear();
    switcher.disconnected = force;
    return switcher.handlers.get('disconnect')();
  };

  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'NEW123', switchAck.callback);
  await targetJoinStarted.promise;

  const deleteAck = acknowledge();
  const deletePending = deleter.trigger('delete_server', 'OLD123', deleteAck.callback);
  await Promise.resolve();
  releaseTargetJoin.resolve();
  await Promise.all([switchPending, deletePending]);
  assert.deepEqual(deleteAck.value(), { success: true });
  assert.equal(rooms.has('OLD123'), false);

  assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
  assert.equal(switcher.disconnected, true);
  assert.equal(switcher.serverCode, null);
  assert.equal(onlineUsersMap.has(switcher.id), false);
  assert.equal(switcher.joinedRooms.has('OLD123'), false);
});

test('room switch acknowledges success before broadcasting target presence', async () => {
  const events = [];
  const onlineUsersMap = new Map([['socket-1', {
    username: 'alice', serverCode: 'OLD123', joinedServers: ['global', 'OLD123', 'ABC123']
  }]]);
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({
    ChatServerModel,
    MessageModel,
    onlineUsersMap,
    broadcastOnlineUsersFn: code => events.push(`broadcast:${code}`)
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'OLD123', 'ABC123'];
  socket.serverCode = 'OLD123';
  socket.joinedRooms.add('OLD123');

  await socket.trigger('switch_server', 'ABC123', result => {
    events.push('ack');
    assert.deepEqual(result, emptySwitchSuccess());
  });

  assert.equal(socket.serverCode, 'ABC123');
  assert.equal(socket.joinedRooms.has('OLD123'), false);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'ABC123');
  assert.deepEqual(events, [
    'ack', 'broadcast:OLD123', 'broadcast:ABC123', 'broadcast:global'
  ]);
});

test('room switch finishes role lookup before history lookup begins', async () => {
  const events = [];
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = {
    find() {
      events.push('history:find');
      return {
        sort() { return this; },
        limit() { return this; },
        async select() { return []; },
        async lean() {
          events.push('history:lean');
          return [];
        }
      };
    }
  };
  const { socket } = register({
    ChatServerModel,
    MessageModel,
    async getRoomRoleFn() {
      events.push('role:start');
      await Promise.resolve();
      events.push('role:end');
      return 'user';
    }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'ABC123'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');

  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), emptySwitchSuccess());
  assert.deepEqual(events, [
    'role:start', 'role:end', 'history:find', 'history:lean', 'history:find', 'history:find'
  ]);
});

test('leaving the active room removes transport and moderator access then moves to global', async () => {
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const pulled = [];
  const UserModel = { findOne: async () => user };
  const ChatServerModel = { async updateOne(filter, update) { pulled.push({ filter, update }); } };
  const { socket } = register({ UserModel, ChatServerModel });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = user.servers;
  socket.joinedRooms.add('ABC123');
  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);
  assert.deepEqual(user.servers, ['global']);
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(socket.joinedRooms.has('global'), true);
  assert.equal(socket.serverCode, 'global');
  assert.deepEqual(pulled, [{
    filter: { code: 'ABC123' },
    update: { $pull: { moderators: 'alice' } }
  }]);
  assert.deepEqual(ack.value(), { success: true });
});

test('leaving a room revokes membership and transport access from every live session', async () => {
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }],
    ['socket-2', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]
  ]);
  const ioInstance = new FakeIo();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne() {} }
  });
  socket.username = 'alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');

  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  for (const liveSocket of [socket, second]) {
    assert.deepEqual(liveSocket.joinedServers, ['global']);
    assert.equal(liveSocket.serverCode, 'global');
    assert.equal(liveSocket.joinedRooms.has('ABC123'), false);
    assert.equal(liveSocket.joinedRooms.has('global'), true);
    assert.deepEqual(liveSocket.outbound.at(-1), {
      target: 'self',
      event: 'room_access_updated',
      payload: { username: 'alice', joinedServers: ['global'], serverCode: 'global', bannedRooms: [] }
    });
  }
  assert.deepEqual(onlineUsersMap.get('socket-1').joinedServers, ['global']);
  assert.deepEqual(onlineUsersMap.get('socket-2').joinedServers, ['global']);
});

test('moderator cleanup failure cannot preserve transport access after leaving', async () => {
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }],
    ['socket-2', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]
  ]);
  const ioInstance = new FakeIo();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne() { throw new Error('cleanup unavailable'); } },
    logger: { error() {} }
  });
  socket.username = 'alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Failed to leave.' });
  for (const liveSocket of [socket, second]) {
    assert.deepEqual(liveSocket.joinedServers, ['global']);
    assert.equal(liveSocket.serverCode, 'global');
    assert.equal(liveSocket.joinedRooms.has('ABC123'), false);
  }
});

test('leaving updates every session membership before awaiting transport eviction', async () => {
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }],
    ['socket-2', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]
  ]);
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne() {} }
  });
  socket.username = 'alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  socket.leave = async room => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(socket, room);
  };
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  const pending = socket.trigger('leave_server', 'ABC123', ack.callback);
  await firstLeaveStarted.promise;
  assert.deepEqual(second.joinedServers, ['global']);
  assert.deepEqual(onlineUsersMap.get(second.id).joinedServers, ['global']);
  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(ack.value(), { success: true });
});

test('leaving an active ghost-access room moves a global admin to global without database cleanup', async () => {
  const user = { servers: ['global'], async save() { throw new Error('must not save'); } };
  const pulled = [];
  const onlineUsersMap = new Map([['socket-1', { serverCode: 'ABC123', joinedServers: ['global'] }]]);
  const { socket } = register({
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne(...args) { pulled.push(args); } },
    onlineUsersMap
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global'];
  socket.joinedRooms.add('ABC123');
  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(user.servers, ['global']);
  assert.deepEqual(pulled, []);
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(socket.joinedRooms.has('global'), true);
  assert.equal(socket.serverCode, 'global');
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'global');
});

test('deleting an active room keeps the socket and mapped session in global', async () => {
  const onlineUsersMap = new Map([['socket-1', { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]]);
  const { socket, ioInstance } = register({
    onlineUsersMap,
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() {}
    },
    UserModel: { async updateMany() {} },
    MessageModel: { async deleteMany() {} }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket];
  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(socket.serverCode, 'global');
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(socket.joinedRooms.has('global'), true);
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'global');
});

test('room deletion computes fallback from fresh restrictions instead of stale cached bannedRooms', async () => {
  const rooms = [
    { code: 'global', owner: 'System', moderators: [] },
    { code: 'ABC123', owner: 'alice', moderators: [] },
    { code: 'XYZ789', owner: 'bob', moderators: [] }
  ];
  const users = {
    alice: { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] },
    bob: { username: 'Bob', role: 'user', servers: ['global', 'ABC123', 'XYZ789'] }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return Object.values(users).find(user => matcher.test(user.username));
        return users[query.username];
      },
      async updateMany() {
        for (const user of Object.values(users)) {
          user.servers = user.servers.filter(code => code !== 'ABC123');
        }
      }
    },
    ChatServerModel: {
      async find(query = {}) {
        const codes = query.code && Array.isArray(query.code.$in) ? query.code.$in : [];
        return rooms.filter(room => codes.includes(room.code));
      },
      async findOne(query) { return rooms.find(room => room.code === query.code) || null; },
      async deleteOne(query) {
        const index = rooms.findIndex(room => room.code === query.code);
        if (index >= 0) rooms.splice(index, 1);
      }
    },
    RoomRestrictionModel: {
      async find(query) {
        return query.username === 'bob'
          ? [{ serverCode: 'global', username: 'bob', bannedAt: new Date() }]
          : [];
      },
      async findOne() { return null; }
    },
    MessageModel: { async deleteMany() {} }
  });
  Object.assign(socket, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  onlineUsersMap.set(socket.id, {
    username: 'alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  const target = new FakeSocket();
  target.id = 'target-delete-fallback';
  Object.assign(target, {
    username: 'Bob', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  target.joinedRooms.add('ABC123');
  onlineUsersMap.set(target.id, {
    username: 'Bob', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  onlineUsersMap.set('target-delete-map-only', {
    username: 'bob', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  ioInstance.sockets = [socket, target];

  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.equal(target.serverCode, 'XYZ789');
  assert.deepEqual(target.joinedServers, ['XYZ789']);
  assert.deepEqual(target.bannedRooms, ['global']);
  assert.equal(target.joinedRooms.has('global'), false);
  assert.equal(target.joinedRooms.has('XYZ789'), true);
  assert.equal(onlineUsersMap.get('target-delete-map-only').serverCode, 'XYZ789');
  assert.deepEqual(onlineUsersMap.get('target-delete-map-only').bannedRooms, ['global']);
});

test('room deletion preflights live sockets before destructive writes', async () => {
  let deleted = 0;
  const ioInstance = new FakeIo();
  ioInstance.fetchSockets = async () => { throw new Error('adapter unavailable'); };
  const { socket } = register({
    ioInstance,
    logger: { error() {} },
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() { deleted += 1; }
    },
    MessageModel: { async deleteMany() {} },
    UserModel: { async updateMany() {} }
  });
  socket.username = 'alice';
  socket.role = 'user';
  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Deletion failed.' });
  assert.equal(deleted, 0);
});

test('primary room deletion failure preserves live authorization state', async () => {
  let messageCleanupCalls = 0;
  let membershipCleanupCalls = 0;
  const ioInstance = new FakeIo();
  const { socket } = register({
    ioInstance,
    logger: { error() {} },
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() { throw new Error('delete unavailable'); }
    },
    MessageModel: { async deleteMany() { messageCleanupCalls += 1; } },
    UserModel: { async updateMany() { membershipCleanupCalls += 1; } }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket];

  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Deletion failed.' });
  assert.equal(socket.serverCode, 'ABC123');
  assert.deepEqual(socket.joinedServers, ['global', 'ABC123']);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
  assert.equal(messageCleanupCalls, 0);
  assert.equal(membershipCleanupCalls, 0);
  assert.equal(ioInstance.outbound.some(item => item.event === 'server_deleted'), false);
});

for (const failedStage of ['message cleanup', 'membership cleanup']) {
  test(`room deletion closes live access when ${failedStage} fails after room removal`, async () => {
    const ioInstance = new FakeIo();
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123']
    }]]);
    let messageCleanupCalls = 0;
    let membershipCleanupCalls = 0;
    const { socket } = register({
      ioInstance,
      onlineUsersMap,
      logger: { error() {} },
      ChatServerModel: {
        async findOne() { return { code: 'ABC123', owner: 'alice' }; },
        async deleteOne() {}
      },
      MessageModel: {
        async deleteMany() {
          messageCleanupCalls += 1;
          if (failedStage === 'message cleanup') throw new Error('messages unavailable');
        }
      },
      UserModel: {
        async updateMany() {
          membershipCleanupCalls += 1;
          if (failedStage === 'membership cleanup') throw new Error('users unavailable');
        }
      }
    });
    socket.username = 'alice';
    socket.role = 'user';
    socket.serverCode = 'ABC123';
    socket.joinedServers = ['global', 'ABC123'];
    socket.joinedRooms.add('ABC123');
    ioInstance.sockets = [socket];

    const ack = acknowledge();
    await socket.trigger('delete_server', 'ABC123', ack.callback);

    assert.deepEqual(ack.value(), { error: 'Deletion failed.' });
    assert.equal(socket.serverCode, 'global');
    assert.deepEqual(socket.joinedServers, ['global']);
    assert.equal(socket.joinedRooms.has('ABC123'), false);
    assert.equal(socket.joinedRooms.has('global'), true);
    assert.equal(ioInstance.outbound.some(item =>
      item.room === '*' && item.event === 'server_deleted' && item.payload === 'ABC123'
    ), true);
    assert.equal(messageCleanupCalls, 1);
    assert.equal(membershipCleanupCalls, 1);
  });
}

test('join grant cannot resurrect a detached membership removed by a concurrent leave', async () => {
  const grantSaveStarted = deferred();
  const releaseGrantSave = deferred();
  const persisted = { username: 'alice', servers: ['global', 'SECRET'] };

  function readUser() {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      const proposedServers = [...document.servers];
      if (proposedServers.includes('OTHER1')) {
        grantSaveStarted.resolve();
        await releaseGrantSave.promise;
      }
      persisted.servers = proposedServers;
    };
    return document;
  }

  const joinedRoom = { code: 'OTHER1', owner: 'owner', moderators: [] };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return readUser(); } },
    ChatServerModel: {
      async findOne({ code }) { return code === joinedRoom.code ? joinedRoom : null; },
      async updateOne() {}
    },
    logger: { error() {} }
  };
  const joiner = registerSharedSocket(shared, 'socket-joiner');
  const leaver = registerSharedSocket(shared, 'socket-leaver');
  for (const live of [joiner, leaver]) {
    Object.assign(live, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
    live.joinedRooms.add('SECRET');
    onlineUsersMap.set(live.id, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
  }
  onlineUsersMap.set('map-only', {
    username: 'ALICE', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [joiner, leaver];

  const joinAck = acknowledge();
  const joinPending = joiner.trigger('join_server', 'OTHER1', joinAck.callback);
  await grantSaveStarted.promise;

  const arriving = registerSharedSocket(shared, 'socket-arriving');
  Object.assign(arriving, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  arriving.joinedRooms.add('SECRET');
  onlineUsersMap.set(arriving.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [joiner, leaver, arriving];

  const leaveAck = acknowledge();
  const leavePending = leaver.trigger('leave_server', 'SECRET', leaveAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  const leaveCompletedBeforeGrant = leaveAck.value() !== undefined;
  releaseGrantSave.resolve();
  await Promise.all([joinPending, leavePending]);

  assert.equal(leaveCompletedBeforeGrant, false);
  assert.deepEqual(joinAck.value(), {
    success: true,
    server: {
      code: 'OTHER1', name: '', owner: 'owner', metadataVersion: 0,
      pin: { serverCode: 'OTHER1', pinCount: 0, pinVersion: 0, blockVersion: 0 }
    }
  });
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(persisted.servers, ['global', 'OTHER1']);
  for (const live of [joiner, leaver, arriving]) {
    assert.deepEqual(live.joinedServers, ['global', 'OTHER1']);
    assert.equal(live.serverCode, 'global');
    assert.equal(live.joinedRooms.has('SECRET'), false);
    assert.deepEqual(onlineUsersMap.get(live.id).joinedServers, ['global', 'OTHER1']);
  }
  assert.deepEqual(onlineUsersMap.get('map-only').joinedServers, ['global', 'OTHER1']);
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');
});

test('create grant cannot resurrect a detached membership removed by a concurrent leave', async () => {
  const grantSaveStarted = deferred();
  const releaseGrantSave = deferred();
  const persisted = { username: 'alice', servers: ['global', 'SECRET'] };

  function readUser() {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      const proposedServers = [...document.servers];
      if (proposedServers.includes('NEW123')) {
        grantSaveStarted.resolve();
        await releaseGrantSave.promise;
      }
      persisted.servers = proposedServers;
    };
    return document;
  }

  const createdRoom = { code: 'NEW123', name: 'Team', owner: 'alice', moderators: ['alice'] };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return readUser(); } },
    ChatServerModel: {
      async create() { return createdRoom; },
      async updateOne() {}
    },
    logger: { error() {} }
  };
  const creator = registerSharedSocket(shared, 'socket-creator');
  const leaver = registerSharedSocket(shared, 'socket-leaver');
  for (const live of [creator, leaver]) {
    Object.assign(live, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
    live.joinedRooms.add('SECRET');
    onlineUsersMap.set(live.id, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
  }
  onlineUsersMap.set('map-only', {
    username: 'ALICE', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [creator, leaver];

  const createAck = acknowledge();
  const createPending = creator.trigger('create_server', 'Team', createAck.callback);
  await grantSaveStarted.promise;

  const arriving = registerSharedSocket(shared, 'socket-arriving');
  Object.assign(arriving, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  arriving.joinedRooms.add('SECRET');
  onlineUsersMap.set(arriving.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [creator, leaver, arriving];

  const leaveAck = acknowledge();
  const leavePending = leaver.trigger('leave_server', 'SECRET', leaveAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  const leaveCompletedBeforeGrant = leaveAck.value() !== undefined;
  releaseGrantSave.resolve();
  await Promise.all([createPending, leavePending]);

  assert.equal(leaveCompletedBeforeGrant, false);
  assert.deepEqual(createAck.value(), {
    success: true,
    server: {
      code: 'NEW123', name: 'Team', owner: 'alice', metadataVersion: 0,
      pin: { serverCode: 'NEW123', pinCount: 0, pinVersion: 0, blockVersion: 0 }
    }
  });
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(persisted.servers, ['global', 'NEW123']);
  for (const live of [creator, leaver, arriving]) {
    assert.deepEqual(live.joinedServers, ['global', 'NEW123']);
    assert.equal(live.serverCode, 'global');
    assert.equal(live.joinedRooms.has('SECRET'), false);
    assert.deepEqual(onlineUsersMap.get(live.id).joinedServers, ['global', 'NEW123']);
  }
  assert.deepEqual(onlineUsersMap.get('map-only').joinedServers, ['global', 'NEW123']);
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');
});

test('room deletion serializes against an in-flight membership join', async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  const state = { roomExists: true, persistedServers: ['global'], savedAfterDeletion: false };
  const joinerUser = {
    username: 'bob', role: 'user', servers: ['global'],
    async save() {
      const proposedServers = [...this.servers];
      saveStarted.resolve();
      await releaseSave.promise;
      state.savedAfterDeletion = !state.roomExists;
      state.persistedServers = proposedServers;
    }
  };
  const deleterUser = { username: 'alice', role: 'admin', servers: ['global'] };
  const UserModel = {
    async findOne(query) {
      const matcher = query.username && query.username.$regex;
      return matcher && matcher.test('alice') ? deleterUser : joinerUser;
    },
    async updateMany() {
      state.persistedServers = state.persistedServers.filter(code => code !== 'ABC123');
    }
  };
  const ChatServerModel = {
    async findOne() {
      return state.roomExists ? { code: 'ABC123', owner: 'alice' } : null;
    },
    async deleteOne() { state.roomExists = false; }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    ChatServerModel,
    MessageModel: { async deleteMany() {} },
    logger: { error() {} }
  };
  const joiner = register(shared).socket;
  joiner.id = 'socket-joiner';
  joiner.username = 'bob';
  joiner.serverCode = 'global';
  joiner.joinedServers = ['global'];
  joiner.joinedRooms.add('global');
  onlineUsersMap.set(joiner.id, {
    username: 'bob', serverCode: 'global', joinedServers: ['global']
  });
  const deleter = register(shared).socket;
  deleter.id = 'socket-deleter';
  deleter.username = 'alice';
  deleter.role = 'admin';
  deleter.serverCode = 'global';
  deleter.joinedServers = ['global'];
  onlineUsersMap.set(deleter.id, {
    username: 'alice', role: 'admin', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [joiner, deleter];

  const joinAck = acknowledge();
  const deleteAck = acknowledge();
  const joinPending = joiner.trigger('join_server', 'ABC123', joinAck.callback);
  await saveStarted.promise;
  const deletePending = deleter.trigger('delete_server', 'ABC123', deleteAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseSave.resolve();
  await Promise.all([joinPending, deletePending]);

  assert.equal(state.savedAfterDeletion, false);
  assert.deepEqual(state.persistedServers, ['global']);
  assert.deepEqual(joiner.joinedServers, ['global']);
  assert.equal(joiner.joinedRooms.has('ABC123'), false);
  assert.deepEqual(deleteAck.value(), { success: true });
});

test('deletion preflights sockets then waits for a queued switch account commit', async () => {
  const mutationEntered = deferred();
  const historyEntered = deferred();
  const historyPrepared = deferred();
  const releaseMutation = deferred();
  const deletionFinished = deferred();
  const deleteFetchEntered = deferred();
  const order = [];
  const state = { roomExists: true, mutationReleased: false, roomReads: 0 };
  const room = { code: 'ABC123', owner: 'alice', moderators: [] };
  const ioInstance = new FakeIo();
  ioInstance.fetchSockets = async () => {
    order.push('delete:fetchSockets');
    deleteFetchEntered.resolve();
    return ioInstance.sockets;
  };
  const onlineUsersMap = new Map();
  const ChatServerModel = {
    async findOne() {
      state.roomReads += 1;
      if (state.roomReads === 3 && !state.mutationReleased) {
        await deletionFinished.promise;
        return room;
      }
      return state.roomExists ? room : null;
    },
    async deleteOne() { state.roomExists = false; }
  };
  const MessageModel = {
    async create(data) {
      mutationEntered.resolve();
      await releaseMutation.promise;
      return { _id: 'message-1', ...data };
    },
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        async select() { return []; },
        lean() {
          historyEntered.resolve();
          return historyPrepared.promise;
        }
      };
    },
    async deleteMany() {}
  };
  const UserModel = {
    async findOne() { return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] }; },
    async updateMany() { deletionFinished.resolve(); }
  };
  const shared = {
    ioInstance,
    onlineUsersMap,
    ChatServerModel,
    MessageModel,
    UserModel,
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    broadcastOnlineUsersFn: async () => {},
    logger: { error() {} }
  };
  const holder = registerSharedSocket(shared, 'socket-holder');
  holder.username = 'alice';
  holder.displayName = 'Alice';
  holder.role = 'admin';
  holder.serverCode = 'ABC123';
  holder.joinedServers = ['global', 'ABC123'];
  holder.joinedRooms.add('ABC123');
  const late = registerSharedSocket(shared, 'socket-late');
  late.username = 'bob';
  late.displayName = 'Bob';
  late.role = 'admin';
  late.serverCode = 'global';
  late.joinedServers = ['global'];
  late.joinedRooms.add('global');
  const originalLateJoin = late.join.bind(late);
  late.join = roomCode => {
    if (roomCode === 'ABC123') order.push('late:join:ABC123');
    originalLateJoin(roomCode);
  };
  const deleter = registerSharedSocket(shared, 'socket-deleter');
  deleter.username = 'alice';
  deleter.role = 'admin';
  deleter.serverCode = 'global';
  deleter.joinedServers = ['global'];
  deleter.joinedRooms.add('global');
  for (const live of [holder, late, deleter]) {
    onlineUsersMap.set(live.id, {
      username: live.username,
      role: live.role,
      serverCode: live.serverCode,
      joinedServers: [...live.joinedServers]
    });
  }
  ioInstance.sockets = [holder, late, deleter];

  const mutationPending = holder.trigger('chat_message', { text: 'held mutation' });
  await mutationEntered.promise;
  const switchAck = acknowledge();
  const switchPending = late.trigger('switch_server', 'ABC123', switchAck.callback);
  const deleteAck = acknowledge();
  const deletePending = deleter.trigger('delete_server', 'ABC123', deleteAck.callback);
  await deleteFetchEntered.promise;
  state.mutationReleased = true;
  releaseMutation.resolve();
  await mutationPending;
  await historyEntered.promise;
  historyPrepared.resolve([]);
  await Promise.all([switchPending, deletePending]);

  const joinIndex = order.indexOf('late:join:ABC123');
  const fetchIndex = order.indexOf('delete:fetchSockets');
  assert.notEqual(joinIndex, -1);
  assert.notEqual(fetchIndex, -1);
  assert.ok(fetchIndex < joinIndex);
  assert.deepEqual(switchAck.value(), emptySwitchSuccess('alice', { canEdit: true }));
  assert.deepEqual(deleteAck.value(), { success: true });
  assert.equal(late.serverCode, 'global');
  assert.equal(onlineUsersMap.get(late.id).serverCode, 'global');
  assert.equal(late.joinedRooms.has('ABC123'), false);
  assert.equal(late.joinedRooms.has('global'), true);
  assert.equal(late.joinedServers.includes('ABC123'), false);
  assert.equal(onlineUsersMap.get(late.id).joinedServers.includes('ABC123'), false);
});

test('a switch waiting behind deletion cannot join the deleted room', async () => {
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  let historyReads = 0;
  const state = { roomExists: true };
  const room = { code: 'ABC123', owner: 'alice', moderators: [] };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const ChatServerModel = {
    async findOne() { return state.roomExists ? room : null; },
    async deleteOne() {
      deleteEntered.resolve();
      await releaseDelete.promise;
      state.roomExists = false;
    }
  };
  const MessageModel = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        lean() {
          historyReads += 1;
          return Promise.resolve([]);
        }
      };
    },
    async deleteMany() {}
  };
  const shared = {
    ioInstance,
    onlineUsersMap,
    ChatServerModel,
    MessageModel,
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher && matcher.test('alice')) {
          return { username: 'alice', role: 'admin', servers: ['global'] };
        }
        return { username: 'bob', role: 'user', servers: ['global', 'OLD123', 'ABC123'] };
      },
      async updateMany() {}
    },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    logger: { error() {} }
  };
  const deleter = registerSharedSocket(shared, 'socket-deleter');
  deleter.username = 'alice';
  deleter.role = 'admin';
  deleter.serverCode = 'global';
  deleter.joinedServers = ['global'];
  deleter.joinedRooms.add('global');
  ioInstance.sockets = [deleter];
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  switcher.username = 'bob';
  switcher.role = 'user';
  switcher.serverCode = 'OLD123';
  switcher.joinedServers = ['global', 'OLD123', 'ABC123'];
  switcher.joinedRooms.add('OLD123');
  onlineUsersMap.set(switcher.id, {
    username: 'bob', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'ABC123']
  });

  const deleteAck = acknowledge();
  const deletePending = deleter.trigger('delete_server', 'ABC123', deleteAck.callback);
  await deleteEntered.promise;
  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'ABC123', switchAck.callback);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(historyReads, 0);
  assert.equal(switchAck.value(), undefined);
  releaseDelete.resolve();
  await Promise.all([deletePending, switchPending]);

  assert.deepEqual(deleteAck.value(), { success: true });
  assert.deepEqual(switchAck.value(), { error: 'Server not found.' });
  assert.equal(switcher.serverCode, 'OLD123');
  assert.equal(onlineUsersMap.get(switcher.id).serverCode, 'OLD123');
  assert.equal(switcher.joinedRooms.has('OLD123'), true);
  assert.equal(switcher.joinedRooms.has('ABC123'), false);
  assert.deepEqual(switcher.leftRooms, []);
  assert.equal(historyReads, 0);
});

test('room deletion clears every session cache before awaiting transport eviction', async () => {
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() {}
    },
    UserModel: { async updateMany() {} },
    MessageModel: { async deleteMany() {} }
  });
  socket.username = 'alice';
  socket.role = 'admin';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  socket.leave = async room => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(socket, room);
  };
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'bob';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  for (const live of [socket, second]) {
    onlineUsersMap.set(live.id, {
      username: live.username,
      serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123']
    });
  }
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  const pending = socket.trigger('delete_server', 'ABC123', ack.callback);
  await firstLeaveStarted.promise;
  assert.deepEqual(second.joinedServers, ['global']);
  assert.deepEqual(onlineUsersMap.get(second.id).joinedServers, ['global']);
  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(ack.value(), { success: true });
});

test('global-admin demotion evicts every ghost-viewing session before acknowledgement', async () => {
  const target = {
    username: 'bob', displayName: 'Bob', role: 'admin', servers: ['global'],
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map([
    ['socket-2', { username: 'bob', role: 'admin', serverCode: 'ABC123', joinedServers: ['global'] }],
    ['socket-3', { username: 'bob', role: 'admin', serverCode: 'XYZ789', joinedServers: ['global'] }]
  ]);
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return target; } }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';

  const targetSockets = ['ABC123', 'XYZ789'].map((code, index) => {
    const live = new FakeSocket();
    live.id = `socket-${index + 2}`;
    live.username = 'bob';
    live.role = 'admin';
    live.serverCode = code;
    live.joinedServers = ['global'];
    live.joinedRooms.add(code);
    return live;
  });
  ioInstance.sockets = targetSockets;

  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'demote_global_admin'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  for (const live of targetSockets) {
    assert.equal(live.role, 'user');
    assert.equal(live.serverCode, 'global');
    assert.equal(live.joinedRooms.has('global'), true);
    assert.equal(live.leftRooms.length, 1);
    assert.equal(onlineUsersMap.get(live.id).role, 'user');
    assert.equal(onlineUsersMap.get(live.id).serverCode, 'global');
  }
});

test('global-admin demotion stages every session role and fallback before awaiting transport eviction', async () => {
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const target = {
    username: 'bob', displayName: 'Bob', role: 'admin', servers: ['global'],
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return target; } }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';

  const first = new FakeSocket();
  first.id = 'socket-2';
  first.username = 'bob';
  first.role = 'admin';
  first.serverCode = 'ABC123';
  first.joinedServers = ['global'];
  first.leave = async room => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(first, room);
  };
  const second = new FakeSocket();
  second.id = 'socket-3';
  second.username = 'bob';
  second.role = 'admin';
  second.serverCode = 'XYZ789';
  second.joinedServers = ['global'];
  for (const live of [first, second]) {
    live.joinedRooms.add(live.serverCode);
    onlineUsersMap.set(live.id, {
      username: 'bob', role: 'admin', serverCode: live.serverCode, joinedServers: ['global']
    });
  }
  ioInstance.sockets = [first, second];

  const ack = acknowledge();
  const pending = socket.trigger('manage_role', {
    targetUser: 'bob', action: 'demote_global_admin'
  }, ack.callback);
  await firstLeaveStarted.promise;
  const stagedBeforeTransport = {
    liveRole: second.role,
    liveServerCode: second.serverCode,
    sessionRole: onlineUsersMap.get(second.id).role,
    sessionServerCode: onlineUsersMap.get(second.id).serverCode
  };
  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(stagedBeforeTransport, {
    liveRole: 'user', liveServerCode: 'global',
    sessionRole: 'user', sessionServerCode: 'global'
  });
  assert.deepEqual(ack.value(), { success: true });
});

test('profile updates synchronize identity snapshots across every live session', async () => {
  const user = {
    username: 'alice', displayName: 'Alice', color: '', avatarUrl: '',
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', displayName: 'Alice', color: '', avatarUrl: '', joinedServers: ['global'] }],
    ['socket-2', { username: 'alice', displayName: 'Alice', color: '', avatarUrl: '', joinedServers: ['global'] }]
  ]);
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: {
      async findOne(query) {
        if (query.displayName) return null;
        return user;
      }
    },
    MessageModel: { async updateMany() {} }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.joinedServers = ['global'];
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.displayName = 'Alice';
  second.color = '';
  second.avatarUrl = '';
  second.joinedServers = ['global'];
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  await socket.trigger('update_profile', {
    displayName: 'Alice Smith', color: '#aabbcc', avatarUrl: 'https://example.test/alice.png'
  }, ack.callback);

  assert.deepEqual(ack.value(), {
    success: true,
    displayName: 'Alice Smith',
    color: '#aabbcc',
    avatarUrl: 'https://example.test/alice.png'
  });
  for (const live of [socket, second]) {
    assert.equal(live.displayName, 'Alice Smith');
    assert.equal(live.color, '#aabbcc');
    assert.equal(live.avatarUrl, 'https://example.test/alice.png');
    assert.equal(onlineUsersMap.get(live.id).displayName, 'Alice Smith');
  }
});

test('a failed best-effort admin notification acknowledges server creation only once', async () => {
  const user = { servers: ['global'], async save() {} };
  const ioInstance = new FakeIo();
  const logged = [];
  ioInstance.fetchSockets = async () => { throw new Error('notification unavailable'); };
  const { socket } = register({
    ioInstance,
    ChatServerModel: { async create() { return { code: 'ABC123', name: 'Team', owner: 'alice' }; } },
    UserModel: { async findOne() { return user; } },
    logger: { error(...args) { logged.push(args); } }
  });
  socket.username = 'alice';
  const acknowledgements = [];
  await assert.doesNotReject(socket.trigger('create_server', 'Team', value => acknowledgements.push(value)));
  assert.deepEqual(acknowledgements, [{
    success: true,
    server: {
      code: 'ABC123', name: 'Team', owner: 'alice', metadataVersion: 0,
      pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 0, blockVersion: 0 }
    }
  }]);
  assert.equal(logged.some(args => JSON.stringify(args).includes('create_server_admin_notification')), true);
  assert.equal(JSON.stringify(logged).includes('notification unavailable'), false);
});

test('server creation normalizes malformed legacy memberships before checking the new room', async () => {
  const user = { username: 'alice', servers: null, async save() {} };
  const { socket } = register({
    UserModel: { async findOne() { return user; } },
    ChatServerModel: {
      async create(value) { return { ...value, code: 'ABC123' }; }
    }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';

  const ack = acknowledge();
  await socket.trigger('create_server', 'Private Room', ack.callback);

  assert.equal(ack.value().success, true);
  assert.deepEqual(user.servers, ['global', 'ABC123']);
});

test('invalid profile values do not write the user record', async () => {
  let lookups = 0;
  const UserModel = { async findOne() { lookups += 1; } };
  const { socket } = register({ UserModel });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  const ack = acknowledge();
  await socket.trigger('update_profile', {
    displayName: 'Alice', color: 'blue', avatarUrl: 'https://example.test/a.png'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Invalid input format.' });
  assert.equal(lookups, 0);
});

test('profile updates reserve the system owner name for every account', async () => {
  let lookups = 0;
  const { socket } = register({
    UserModel: { async findOne() { lookups += 1; } }
  });
  socket.username = 'NYZhang1';
  socket.displayName = 'Bacon';
  const ack = acknowledge();
  await socket.trigger('update_profile', {
    displayName: 'NYZhang1', color: '', avatarUrl: ''
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Reserved name.' });
  assert.equal(lookups, 0);
});

test('promoting a non-member does not write the room moderator list', async () => {
  let roomWrites = 0;
  const actor = { username: 'alice', displayName: 'Alice', role: 'admin', servers: ['global'] };
  const target = { username: 'bob', displayName: 'Bob', servers: ['global'], async save() {} };
  const room = {
    code: 'ABC123', owner: 'alice', moderators: [],
    async save() { roomWrites += 1; }
  };
  const { socket } = register({
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return matcher.test(actor.username) ? actor : target;
        return query.username === actor.username ? actor : target;
      }
    },
    ChatServerModel: { findOne: async () => room }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';
  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'promote_mod', serverCode: 'ABC123'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Target user is not a room member.' });
  assert.equal(roomWrites, 0);
});

test('a stale nonmember moderator cannot promote a current room member', async () => {
  let roomWrites = 0;
  const users = {
    bob: { username: 'bob', displayName: 'Bob', servers: ['global', 'ABC123'] },
    alice: { username: 'alice', displayName: 'Alice', servers: ['global'] }
  };
  const room = {
    code: 'ABC123', owner: 'owner', moderators: ['alice'],
    async save() { roomWrites += 1; }
  };
  const { socket } = register({
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return Object.values(users).find(user => matcher.test(user.username));
        return users[query.username];
      }
    },
    ChatServerModel: { async findOne() { return room; } }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.joinedServers = ['global'];

  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'promote_mod', serverCode: 'ABC123'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.deepEqual(room.moderators, ['alice']);
  assert.equal(roomWrites, 0);
});

test('a timed-out room moderator cannot promote a current room member', async () => {
  let roomWrites = 0;
  const users = {
    alice: { username: 'alice', displayName: 'Alice', role: 'user', servers: ['global', 'ABC123'] },
    bob: { username: 'bob', displayName: 'Bob', role: 'user', servers: ['global', 'ABC123'] }
  };
  const room = {
    code: 'ABC123', owner: 'owner', moderators: ['alice'],
    async save() { roomWrites += 1; }
  };
  const { socket } = register({
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return Object.values(users).find(user => matcher.test(user.username));
        return users[query.username];
      }
    },
    ChatServerModel: { async findOne() { return room; } },
    RoomRestrictionModel: {
      async findOne(query) {
        return query.username === 'alice'
          ? { serverCode: 'ABC123', username: 'alice', timeoutUntil: new Date(Date.now() + 60_000) }
          : null;
      },
      async find() { return []; }
    }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];

  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'promote_mod', serverCode: 'ABC123'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.deepEqual(room.moderators, ['alice']);
  assert.equal(roomWrites, 0);
});

for (const scenario of [
  {
    name: 'room deletion',
    mutate(state) { state.room = null; },
    expected: { error: 'Server not found.' }
  },
  {
    name: 'membership removal',
    mutate(_state, socket) { socket.joinedServers = ['global']; },
    expected: { error: 'Permission denied.' }
  },
  {
    name: 'administrator demotion',
    configure(socket) { socket.role = 'admin'; socket.joinedServers = ['global']; },
    mutate(_state, socket) { socket.role = 'user'; },
    expected: { error: 'Permission denied.' }
  }
]) {
  test(`room switch rechecks ${scenario.name} after pending history work`, async () => {
    const history = deferred();
    const historyStarted = deferred();
    const state = { room: { code: 'ABC123', moderators: [] } };
    const ChatServerModel = { async findOne() { return state.room; } };
    const MessageModel = {
      find() {
        return {
          sort() { return this; },
          limit() { return this; },
          async lean() {
            historyStarted.resolve();
            return history.promise;
          }
        };
      }
    };
    const { socket } = register({ ChatServerModel, MessageModel });
    socket.username = 'alice';
    socket.role = 'user';
    socket.joinedServers = ['global', 'ABC123'];
    socket.serverCode = 'global';
    socket.joinedRooms.add('global');
    if (scenario.configure) scenario.configure(socket);

    const ack = acknowledge();
    const pending = socket.trigger('switch_server', 'ABC123', ack.callback);
    await historyStarted.promise;
    scenario.mutate(state, socket);
    history.resolve([]);
    await pending;

    assert.deepEqual(ack.value(), scenario.expected);
    assert.equal(socket.serverCode, 'global');
    assert.equal(socket.joinedRooms.has('ABC123'), false);
    assert.deepEqual(socket.leftRooms, []);
  });
}

test('spoofed forwarded addresses cannot rotate an authentication attempt budget', async () => {
  const { socket } = register();
  socket.handshake.address = '203.0.113.77';
  const results = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    socket.handshake.headers['x-forwarded-for'] = `198.51.100.${attempt}`;
    await socket.trigger('register', {
      username: 'NYZhang1', displayName: 'Owner', password: '123456'
    }, result => results.push(result));
  }
  assert.deepEqual(results.slice(0, 10), Array(10).fill(null).map(() => ({ error: 'Reserved name.' })));
  assert.deepEqual(results[10], { error: 'Too many requests. Try again later.' });
});

test('concurrent registrations allocate case-insensitive identity names only once', async () => {
  const firstCreateStarted = deferred();
  const releaseFirstCreate = deferred();
  const records = [];
  let createCalls = 0;
  const UserModel = {
    async findOne(query) {
      if (query.username && typeof query.username === 'object') {
        return records.find(record => query.username.$regex.test(record.username)) || null;
      }
      if (query.displayName && typeof query.displayName === 'object') {
        return records.find(record => query.displayName.$regex.test(record.displayName)) || null;
      }
      return null;
    },
    async create(value) {
      createCalls += 1;
      if (createCalls === 1) {
        firstCreateStarted.resolve();
        await releaseFirstCreate.promise;
      }
      records.push({ ...value });
      return value;
    }
  };
  const first = register({ UserModel, bcryptImpl: { async hash() { return 'hash'; } } }).socket;
  const second = register({ UserModel, bcryptImpl: { async hash() { return 'hash'; } } }).socket;
  first.handshake.address = '203.0.113.81';
  second.handshake.address = '203.0.113.82';
  const firstAck = acknowledge();
  const secondAck = acknowledge();

  const firstPending = first.trigger('register', {
    username: 'Alice', displayName: 'First', password: '123456'
  }, firstAck.callback);
  await firstCreateStarted.promise;
  const secondPending = second.trigger('register', {
    username: 'alice', displayName: 'Second', password: '123456'
  }, secondAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstCreate.resolve();
  await Promise.all([firstPending, secondPending]);

  assert.equal(records.length, 1);
  assert.deepEqual([firstAck.value(), secondAck.value()], [
    { success: true },
    { error: 'Username taken.' }
  ]);
});

test('concurrent profile changes allocate a display name only once and sync all sessions', async () => {
  const firstSaveStarted = deferred();
  const releaseFirstSave = deferred();
  const records = {
    alice: { username: 'alice', displayName: 'Alice', color: '', avatarUrl: '' },
    bob: { username: 'bob', displayName: 'Bob', color: '', avatarUrl: '' }
  };
  const UserModel = {
    async findOne(query) {
      if (query.displayName && typeof query.displayName === 'object') {
        return Object.values(records).find(record => query.displayName.$regex.test(record.displayName)) || null;
      }
      const record = records[query.username];
      if (!record) return null;
      return {
        ...record,
        async save() {
          if (query.username === 'alice') {
            firstSaveStarted.resolve();
            await releaseFirstSave.promise;
          }
          records[query.username] = {
            username: query.username,
            displayName: this.displayName,
            color: this.color,
            avatarUrl: this.avatarUrl
          };
        }
      };
    }
  };
  const MessageModel = { async updateMany() {} };
  const aliceIo = new FakeIo();
  const bobIo = new FakeIo();
  const alice = register({ UserModel, MessageModel, ioInstance: aliceIo }).socket;
  const bob = register({ UserModel, MessageModel, ioInstance: bobIo }).socket;
  Object.assign(alice, { username: 'alice', displayName: 'Alice', joinedServers: ['global'] });
  Object.assign(bob, { username: 'bob', displayName: 'Bob', joinedServers: ['global'] });
  aliceIo.sockets = [alice];
  bobIo.sockets = [bob];
  const aliceAck = acknowledge();
  const bobAck = acknowledge();

  const alicePending = alice.trigger('update_profile', {
    displayName: 'Shared', color: '#112233', avatarUrl: ''
  }, aliceAck.callback);
  await firstSaveStarted.promise;
  const bobPending = bob.trigger('update_profile', {
    displayName: 'shared', color: '#445566', avatarUrl: ''
  }, bobAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstSave.resolve();
  await Promise.all([alicePending, bobPending]);

  assert.equal(Object.values(records).filter(record => record.displayName.toLowerCase() === 'shared').length, 1);
  assert.deepEqual(aliceAck.value(), {
    success: true, displayName: 'Shared', color: '#112233', avatarUrl: ''
  });
  assert.deepEqual(bobAck.value(), { error: 'Display Name is already taken.' });
});

test('identity mutation lock releases after a failed registration', async () => {
  let shouldFail = true;
  const UserModel = {
    async findOne() {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('lookup failed');
      }
      return null;
    },
    async create() {}
  };
  const { socket } = register({
    UserModel,
    bcryptImpl: { async hash() { return 'hash'; } },
    logger: { error() {} }
  });
  socket.handshake.address = '203.0.113.83';
  const firstAck = acknowledge();
  const secondAck = acknowledge();
  await socket.trigger('register', {
    username: 'alice', displayName: 'Alice', password: '123456'
  }, firstAck.callback);
  await socket.trigger('register', {
    username: 'alice', displayName: 'Alice', password: '123456'
  }, secondAck.callback);
  assert.deepEqual(firstAck.value(), { error: 'Registration failed.' });
  assert.deepEqual(secondAck.value(), { success: true });
});

test('registration rejects case-insensitive username collisions', async () => {
  const calls = [];
  const { socket } = register({
    UserModel: {
      findOne(query) { calls.push(query); return queryResult({ username: 'Alice' }); },
      async create() { throw new Error('must not create'); }
    }
  });
  const ack = acknowledge();
  await socket.trigger('register', {
    username: 'alice', displayName: 'New Name', password: '123456'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Username taken.' });
  assert.equal(calls.length, 1);
});

test('registration rejects case-insensitive display-name collisions independently', async () => {
  const calls = [];
  const { socket } = register({
    UserModel: {
      findOne(query) {
        calls.push(query);
        return queryResult(calls.length === 1 ? null : { displayName: 'DISPLAY NAME' });
      },
      async create() { throw new Error('must not create'); }
    }
  });
  const ack = acknowledge();
  await socket.trigger('register', {
    username: 'alice', displayName: 'display name', password: '123456'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Display Name is already taken.' });
  assert.equal(calls.length, 2);
});

test('seedSystem creates the global room without an administrator password', async () => {
  const roomUpdates = [];
  let userLookups = 0;
  await seedSystem({
    UserModel: { async findOne() { userLookups += 1; } },
    ChatServerModel: { async findOneAndUpdate(...args) { roomUpdates.push(args); } },
    adminPassword: ''
  });
  assert.deepEqual(roomUpdates, [[
    { code: 'global' },
    { $setOnInsert: { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] } },
    { upsert: true, setDefaultsOnInsert: true }
  ]]);
  assert.equal(userLookups, 0);
});

test('unexpected handler failures log only event-specific safe metadata', async () => {
  const logged = [];
  const secret = 'password=do-not-log';
  const { socket } = register({
    logger: { error(...args) { logged.push(args); } },
    ChatServerModel: { async findOne() { throw new Error(secret); } }
  });
  socket.username = 'alice';
  const ack = acknowledge();
  await socket.trigger('join_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Join failed.' });
  assert.equal(logged.length, 1);
  assert.equal(JSON.stringify(logged).includes('join_server'), true);
  assert.equal(JSON.stringify(logged).includes(secret), false);
});

test('malformed acknowledgement inputs use the standard protocol error', async () => {
  const { socket } = register();
  socket.username = 'alice';
  socket.displayName = 'Alice';
  const cases = [
    ['change_password', [null]],
    ['update_profile', [{ displayName: '<bad>', color: '', avatarUrl: '' }]],
    ['manage_role', [null]],
    ['create_server', ['<bad>']],
    ['join_server', ['<bad>']],
    ['leave_server', ['<bad>']],
    ['delete_server', ['<bad>']],
    ['switch_server', ['<bad>']],
    ['get_edit_history', ['not-an-id']],
    ['get_deleted_message', ['not-an-id']]
  ];

  for (const [event, args] of cases) {
    const ack = acknowledge();
    await socket.trigger(event, ...args, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Invalid input format.' }, event);
  }
});

const acknowledgementEvents = [
  ['register', [null]],
  ['login', [null]],
  ['change_password', [null]],
  ['logout_all_devices', []],
  ['update_profile', [null]],
  ['manage_role', [null]],
  ['create_server', [null]],
  ['join_server', [null]],
  ['leave_server', [null]],
  ['delete_server', [null]],
  ['switch_server', [null]],
  ['get_edit_history', [null]],
  ['get_deleted_message', [null]]
];

for (const [event, args] of acknowledgementEvents) {
  test(`${event} tolerates an omitted acknowledgement callback`, async () => {
    const { socket } = register();
    await assert.doesNotReject(socket.trigger(event, ...args));
  });
}
