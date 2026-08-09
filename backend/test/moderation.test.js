const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODERATION_DURATIONS,
  normalizeModerationAction,
  normalizeModerationReason,
  normalizeAutoModSettings,
  normalizeAccountKey,
  findUserByUsername,
  withAccountTransitionLocks,
  withAccountTransitionLock,
  canModerateTarget,
  activeRestrictionState,
  rejectAuditMutation,
  createConnectionHandler
} = require('../server');
const { FakeSocket, FakeIo, createMemoryModel, acknowledge, deferred } = require('./support/fakes');

const VALID_MESSAGE_ID = '507f1f77bcf86cd799439011';

function saveableDocument(value) {
  const document = { ...value };
  Object.defineProperties(document, {
    markModified: { value: () => {}, enumerable: false },
    save: { value: async () => document, enumerable: false }
  });
  return document;
}

function userDocument(overrides = {}) {
  return saveableDocument({
    username: 'Alice', displayName: 'Alice', password: 'hash', role: 'user', servers: ['global'],
    ...overrides
  });
}

function roomDocument(code, overrides = {}) {
  return saveableDocument({
    code, name: code === 'global' ? 'Global Chat' : code, owner: 'Owner', moderators: [],
    autoMod: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 },
    ...overrides
  });
}

function restrictionDocument(serverCode, username, overrides = {}) {
  return saveableDocument({
    serverCode, username: username.normalize('NFKC').trim().toLowerCase(), bannedAt: null, timeoutUntil: null, ...overrides
  });
}

function registerWithModels(seed = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  const MessageModel = createMemoryModel(seed.messages || []);
  MessageModel.created = [];
  const createMessage = MessageModel.create.bind(MessageModel);
  MessageModel.create = async value => {
    const created = await createMessage(value);
    MessageModel.created.push(created);
    return created;
  };
  const setup = {
    socket,
    ioInstance,
    onlineUsersMap: seed.onlineUsersMap || new Map(),
    UserModel: createMemoryModel(seed.users || (seed.user ? [seed.user] : [])),
    ChatServerModel: createMemoryModel(seed.rooms || []),
    MessageModel,
    RoomRestrictionModel: createMemoryModel(seed.restrictions || []),
    ModerationAuditModel: createMemoryModel(seed.audits || []),
    ModerationReportModel: createMemoryModel(seed.reports || [])
  };
  createConnectionHandler({
    ...setup,
    bcryptImpl: { async compare() { return true; }, async hash(value) { return value; } },
    broadcastOnlineUsersFn: seed.broadcastOnlineUsersFn || (async () => {}),
    getRoomRoleFn: seed.getRoomRoleFn || (async () => 'user'),
    resolvePingsFn: seed.resolvePingsFn || (async text => text),
    logger: { error() {} }
  })(socket);
  return setup;
}

function authenticatedRoomSocket({ joinedServers = ['global', 'ABC123'], serverCode = 'global', username = 'Alice' } = {}) {
  const setup = registerWithModels({
    user: userDocument({ username, servers: joinedServers }),
    rooms: joinedServers.map(code => roomDocument(code))
  });
  setup.socket.username = username;
  setup.socket.displayName = username;
  setup.socket.role = 'user';
  setup.socket.serverCode = serverCode;
  setup.socket.joinedServers = [...joinedServers];
  setup.socket.joinedRooms.add(serverCode);
  setup.onlineUsersMap.set(setup.socket.id, {
    username,
    displayName: username,
    role: 'user',
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: []
  });
  return setup;
}

function authenticatedLobbySocket({ username = 'Alice', bannedRooms = [] } = {}) {
  const setup = registerWithModels({
    user: userDocument({ username, servers: ['global'] }),
    rooms: [roomDocument('global'), roomDocument('ABC123')],
    restrictions: bannedRooms.map(code => restrictionDocument(code, username, { bannedAt: new Date() }))
  });
  setup.socket.username = username;
  setup.socket.displayName = username;
  setup.socket.role = 'user';
  setup.socket.serverCode = null;
  setup.socket.joinedServers = [];
  setup.socket.bannedRooms = [...bannedRooms];
  setup.onlineUsersMap.set(setup.socket.id, {
    username,
    displayName: username,
    role: 'user',
    serverCode: null,
    joinedServers: [],
    bannedRooms: [...bannedRooms]
  });
  return setup;
}

function timedOutAuthenticatedSocket(serverCode, username) {
  const message = saveableDocument({
    _id: VALID_MESSAGE_ID,
    serverCode,
    username,
    displayName: username,
    role: 'user',
    roomRole: 'user',
    text: 'original',
    history: [],
    reactions: {},
    deleted: false
  });
  const setup = authenticatedRoomSocket({ joinedServers: ['global', serverCode], serverCode, username });
  setup.RoomRestrictionModel.rows.push(restrictionDocument(serverCode, username, {
    timeoutUntil: new Date(Date.now() + 60_000)
  }));
  setup.MessageModel.findById = async () => message;
  return { ...setup, message };
}

test('moderation inputs accept only the supported actions, durations, reasons, and AutoMod bounds', () => {
  assert.equal(normalizeModerationAction(' Ban '), 'ban');
  assert.equal(normalizeModerationAction('kick'), 'kick');
  assert.equal(normalizeModerationAction('suspend'), null);
  assert.equal(normalizeModerationReason('  repeated harassment  '), 'repeated harassment');
  assert.equal(normalizeModerationReason(' '.repeat(3)), null);
  assert.equal(normalizeModerationReason('x'.repeat(201)), null);
  assert.deepEqual(Object.keys(MODERATION_DURATIONS).sort(), ['10m', '1h', '24h', '7d'].sort());
  assert.deepEqual(normalizeAutoModSettings({
    blockedKeywords: ['  SPAM  ', 'spam', 'ＢＡＤ'],
    mentionLimit: 5,
    repeatLimit: 3,
    repeatWindowSeconds: 30
  }), {
    blockedKeywords: ['spam', 'bad'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30
  });
  assert.equal(normalizeAutoModSettings({ blockedKeywords: [], mentionLimit: 0, repeatLimit: 3, repeatWindowSeconds: 30 }), null);
});

test('moderation authority is exact-room and respects the global/private action matrix', () => {
  const admin = { username: 'Admin', role: 'admin' };
  const mod = { username: 'Mod', role: 'user' };
  const member = { username: 'Member', role: 'user' };
  const otherMod = { username: 'OtherMod', role: 'user' };
  const room = { code: 'ABC123', moderators: ['Mod', 'OtherMod'] };
  const otherRoom = { code: 'XYZ789', owner: 'Owner', moderators: [] };

  assert.equal(canModerateTarget({ serverCode: 'global', action: 'kick', actorUser: admin, targetUser: member, room: { code: 'global', moderators: [] } }), false);
  assert.equal(canModerateTarget({ serverCode: 'global', action: 'ban', actorUser: admin, targetUser: member, room: { code: 'global', moderators: [] } }), true);
  assert.equal(canModerateTarget({ serverCode: 'global', action: 'timeout', actorUser: mod, targetUser: member, room: { code: 'global', moderators: [] } }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'kick', actorUser: mod, targetUser: member, room }), true);
  assert.equal(canModerateTarget({ serverCode: otherRoom.code, action: 'kick', actorUser: mod, targetUser: member, room: otherRoom }), false);
  assert.equal(canModerateTarget({ serverCode: otherRoom.code, action: 'kick', actorUser: { username: otherRoom.owner, role: 'user' }, targetUser: member, room: otherRoom }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: mod, targetUser: otherMod, room }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: mod, targetUser: admin, room }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: admin, targetUser: { username: 'SecondAdmin', role: 'admin' }, room }), false);
  assert.equal(canModerateTarget({ serverCode: room.code, action: 'ban', actorUser: admin, targetUser: { username: 'NYZhang1', role: 'user' }, room }), false);
});

test('moderation authority rejects missing and unsupported actions', () => {
  const context = {
    serverCode: 'ABC123',
    actorUser: { username: 'Admin', role: 'admin' },
    targetUser: { username: 'Member', role: 'user' },
    room: { code: 'ABC123', moderators: [] }
  };

  for (const action of [null, undefined, '', 'suspend', 'erase']) {
    assert.equal(canModerateTarget({ ...context, action }), false);
  }
});

test('moderation fixture documents can be marked and saved directly', async () => {
  const fixtures = [
    userDocument(),
    roomDocument('ABC123'),
    restrictionDocument('ABC123', 'Alice')
  ];

  for (const fixture of fixtures) {
    fixture.label = 'changed';
    assert.doesNotThrow(() => fixture.markModified('label'));
    assert.equal(await fixture.save(), fixture);
    assert.equal(fixture.label, 'changed');
  }
});

test('memory model save persists data without storing helper methods', async () => {
  const UserModel = createMemoryModel([{ username: 'Alice', displayName: 'Alice' }]);
  const user = await UserModel.findOne({ username: 'Alice' });
  user.displayName = 'Updated';
  user.markModified('displayName');
  await user.save();

  assert.deepEqual(UserModel.rows, [{ username: 'Alice', displayName: 'Updated' }]);
});

test('multiple account locks normalize, de-duplicate, sort, serialize overlap, and release after rejection', async () => {
  const gate = deferred();
  const order = [];
  const first = withAccountTransitionLocks(['Target', 'actor', 'target'], async () => {
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
  });
  const second = withAccountTransitionLocks(['ACTOR'], async () => order.push('second'));
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  await assert.rejects(withAccountTransitionLocks(['actor', 'target'], async () => { throw new Error('expected'); }));
  await assert.doesNotReject(withAccountTransitionLocks(['TARGET'], async () => {}));
});

test('restriction state expires timeouts without treating an expired timeout as active', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');
  assert.deepEqual(activeRestrictionState({ bannedAt: now, timeoutUntil: new Date('2026-08-08T11:59:00.000Z') }, now), { banned: true, timedOut: false, timeoutUntil: null });
  assert.deepEqual(activeRestrictionState({ timeoutUntil: new Date('2026-08-08T12:10:00.000Z') }, now), { banned: false, timedOut: true, timeoutUntil: new Date('2026-08-08T12:10:00.000Z') });
});

test('canonical user lookup is case-insensitive while restriction keys stay normalized', async () => {
  const UserModel = createMemoryModel([userDocument({ username: 'Alice' })]);
  const user = await findUserByUsername(UserModel, 'aLiCe');
  assert.equal(user.username, 'Alice');
  assert.equal(normalizeAccountKey(user.username), 'alice');
});

test('audit mutation hook rejects updates and deletes', () => {
  assert.throws(() => rejectAuditMutation(), /append-only/);
});

test('audit schema registers every prohibited mutation operation', () => {
  const source = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
    assert.match(source, new RegExp(`pre\\(['\"]${operation}['\"]`));
  }
});

test('global-banned login chooses the first accessible joined private room', async () => {
  const { socket } = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global', 'ABC123', 'XYZ789'] }),
    rooms: [roomDocument('global'), roomDocument('ABC123'), roomDocument('XYZ789')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })]
  });
  const ack = acknowledge();
  await socket.trigger('login', { username: 'Alice', password: '123456' }, ack.callback);
  assert.equal(ack.value().defaultServerCode, 'ABC123');
  assert.equal(socket.serverCode, 'ABC123');
  assert.equal(socket.joinedRooms.has('global'), false);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
});

test('global-banned login with no accessible private room enters authenticated lobby', async () => {
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })]
  });
  const ack = acknowledge();
  await setup.socket.trigger('login', { username: 'Alice', password: '123456' }, ack.callback);
  assert.equal(ack.value().defaultServerCode, null);
  assert.equal(setup.socket.serverCode, null);
  assert.equal(setup.onlineUsersMap.get(setup.socket.id).serverCode, null);
  assert.deepEqual([...setup.socket.joinedRooms], []);
});

test('global-banned login never publishes Global presence or a Global join notice', async () => {
  const broadcasts = [];
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })],
    broadcastOnlineUsersFn: code => broadcasts.push(code)
  });
  const ack = acknowledge();
  await setup.socket.trigger('login', { username: 'alice', password: '123456' }, ack.callback);
  assert.deepEqual(broadcasts, []);
  assert.equal(setup.socket.outbound.some(item => item.target === 'global' && item.event === 'system_message'), false);
  assert.deepEqual(ack.value().bannedRooms, ['global']);
});

test('room ban blocks join and switch even when socket membership is stale', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'] });
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', { bannedAt: new Date() }));
  const joinAck = acknowledge();
  const switchAck = acknowledge();
  await setup.socket.trigger('join_server', 'ABC123', joinAck.callback);
  await setup.socket.trigger('switch_server', 'ABC123', switchAck.callback);
  assert.deepEqual(joinAck.value(), { error: 'Permission denied.' });
  assert.deepEqual(switchAck.value(), { error: 'Permission denied.' });
});

test('mixed-case ban lookup denies the canonical user', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'], username: 'Alice' });
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', { bannedAt: new Date() }));
  const ack = acknowledge();
  await setup.socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
});

test('global-banned lobby user can join an unbanned private room without joining Global', async () => {
  const setup = authenticatedLobbySocket({ username: 'Alice', bannedRooms: ['global'] });
  const ack = acknowledge();
  await setup.socket.trigger('join_server', 'ABC123', ack.callback);
  assert.equal(ack.value().success, true);
  assert.equal(setup.socket.joinedRooms.has('global'), false);
  assert.deepEqual(setup.onlineUsersMap.get(setup.socket.id).bannedRooms, ['global']);
});

test('timeout blocks send edit reaction and typing but allows own delete', async () => {
  const setup = timedOutAuthenticatedSocket('ABC123', 'Alice');
  await setup.socket.trigger('chat_message', { text: 'blocked message' });
  await setup.socket.trigger('edit_message', { id: VALID_MESSAGE_ID, text: 'blocked edit' });
  await setup.socket.trigger('toggle_reaction', { id: VALID_MESSAGE_ID, emoji: '👍' });
  await setup.socket.trigger('typing', true);
  await setup.socket.trigger('delete_message', VALID_MESSAGE_ID);
  assert.equal(setup.MessageModel.created.length, 0);
  assert.equal(setup.message.text, 'original');
  assert.deepEqual(setup.message.reactions, {});
  assert.equal(setup.socket.outbound.some(item => item.event === 'typing'), false);
  assert.equal(setup.message.deleted, true);
});

test('timed-out room moderator cannot delete another user message', async () => {
  const message = saveableDocument({
    _id: VALID_MESSAGE_ID,
    serverCode: 'ABC123',
    username: 'Bob',
    displayName: 'Bob',
    role: 'user',
    roomRole: 'user',
    text: 'belongs to Bob',
    history: [],
    reactions: {},
    deleted: false
  });
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global', 'ABC123'] }),
    rooms: [roomDocument('global'), roomDocument('ABC123', { moderators: ['Alice'] })],
    restrictions: [restrictionDocument('ABC123', 'alice', {
      timeoutUntil: new Date(Date.now() + 60_000)
    })],
    getRoomRoleFn: async () => 'mod'
  });
  Object.assign(setup.socket, {
    username: 'Alice',
    displayName: 'Alice',
    role: 'user',
    serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  setup.socket.joinedRooms.add('ABC123');
  setup.MessageModel.findById = async () => message;

  await setup.socket.trigger('delete_message', VALID_MESSAGE_ID);

  assert.equal(message.deleted, false);
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'message_deleted'), false);
});

test('join_server rejects a ban committed before its account and room critical section', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global'] });
  setup.ChatServerModel.rows.push(roomDocument('ABC123'));
  const releaseAccount = deferred();
  const accountHeld = deferred();
  const holder = withAccountTransitionLock('alice', async () => {
    accountHeld.resolve();
    await releaseAccount.promise;
  });
  await accountHeld.promise;

  const ack = acknowledge();
  const pending = setup.socket.trigger('join_server', 'ABC123', ack.callback);
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', { bannedAt: new Date() }));
  releaseAccount.resolve();
  await Promise.all([holder, pending]);

  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.deepEqual(setup.UserModel.rows[0].servers, ['global']);
  assert.equal(setup.socket.outbound.some(item => item.event === 'room_access_updated'), false);
});

test('chat_message rejects a timeout committed before its room critical section', async () => {
  const setup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'], serverCode: 'ABC123' });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const holderMessage = {
    _id: VALID_MESSAGE_ID,
    serverCode: 'ABC123',
    username: 'Bob',
    deleted: false,
    reactions: {},
    markModified() {},
    async save() {
      saveStarted.resolve();
      await releaseSave.promise;
    }
  };
  setup.MessageModel.findById = async () => holderMessage;

  const holdingMutation = setup.socket.trigger('toggle_reaction', { id: VALID_MESSAGE_ID, emoji: '👍' });
  await saveStarted.promise;
  const pendingMessage = setup.socket.trigger('chat_message', { text: 'blocked after commit' });
  await new Promise(resolve => setImmediate(resolve));
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', {
    timeoutUntil: new Date(Date.now() + 60_000)
  }));
  releaseSave.resolve();
  await Promise.all([holdingMutation, pendingMessage]);

  assert.equal(setup.MessageModel.created.length, 0);
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'chat_message'), false);
});

test('successful login and switch expose only active timeout state', async () => {
  const loginTimeoutUntil = new Date(Date.now() + 120_000);
  const loginSetup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', {
      timeoutUntil: loginTimeoutUntil,
      timeoutBy: 'Admin',
      timeoutReason: 'sensitive'
    })]
  });
  const loginAck = acknowledge();
  await loginSetup.socket.trigger('login', { username: 'Alice', password: '123456' }, loginAck.callback);
  assert.deepEqual(loginAck.value().restriction, {
    banned: false,
    timedOut: true,
    timeoutUntil: loginTimeoutUntil
  });

  const switchTimeoutUntil = new Date(Date.now() + 180_000);
  const switchSetup = authenticatedRoomSocket({ joinedServers: ['global', 'ABC123'] });
  switchSetup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'alice', {
    timeoutUntil: switchTimeoutUntil,
    timeoutBy: 'Admin',
    timeoutReason: 'sensitive'
  }));
  const switchAck = acknowledge();
  await switchSetup.socket.trigger('switch_server', 'ABC123', switchAck.callback);
  assert.deepEqual(switchAck.value().restriction, {
    banned: false,
    timedOut: true,
    timeoutUntil: switchTimeoutUntil
  });
});

module.exports = {
  VALID_MESSAGE_ID,
  userDocument,
  roomDocument,
  restrictionDocument,
  registerWithModels,
  authenticatedRoomSocket,
  authenticatedLobbySocket,
  timedOutAuthenticatedSocket
};
