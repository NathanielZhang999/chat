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
  applySessionAccessSnapshot,
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
    RoomRestrictionModel: seed.RoomRestrictionModel || createMemoryModel(seed.restrictions || []),
    ModerationAuditModel: seed.ModerationAuditModel || createMemoryModel(seed.audits || []),
    ModerationReportModel: createMemoryModel(seed.reports || [])
  };
  createConnectionHandler({
    ...setup,
    bcryptImpl: { async compare() { return true; }, async hash(value) { return value; } },
    broadcastOnlineUsersFn: seed.broadcastOnlineUsersFn || (async () => {}),
    getRoomRoleFn: seed.getRoomRoleFn || (async () => 'user'),
    resolvePingsFn: seed.resolvePingsFn || (async text => text),
    logger: seed.logger || { error() {} }
  })(socket);
  return setup;
}

function connectAdditionalSocket(setup, {
  id,
  username,
  serverCode,
  joinedServers,
  role = 'user',
  bannedRooms = []
}) {
  const live = new FakeSocket();
  live.id = id;
  Object.assign(live, {
    username,
    displayName: username,
    role,
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: [...bannedRooms]
  });
  if (serverCode) live.joinedRooms.add(serverCode);
  setup.onlineUsersMap.set(id, {
    username,
    displayName: username,
    role,
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: [...bannedRooms]
  });
  createConnectionHandler({
    ...setup,
    bcryptImpl: { async compare() { return true; }, async hash(value) { return value; } },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    logger: { error() {} }
  })(live);
  Object.assign(live, {
    username,
    displayName: username,
    role,
    serverCode,
    joinedServers: [...joinedServers],
    bannedRooms: [...bannedRooms]
  });
  if (serverCode) live.joinedRooms.add(serverCode);
  setup.ioInstance.sockets.push(live);
  return live;
}

function moderationScenario({
  room = 'ABC123', actor = 'admin', action = 'kick', logger,
  ModerationAuditModel, RoomRestrictionModel, broadcastOnlineUsersFn
} = {}) {
  const actorProfiles = {
    admin: { username: 'Admin', role: 'admin' },
    mod: { username: 'RoomMod', role: 'user' },
    'mod-from-ABC123': { username: 'ABCMod', role: 'user' }
  };
  const actorProfile = actorProfiles[actor] || actorProfiles.admin;
  const target = userDocument({
    username: 'TargetUser', displayName: 'Target User',
    servers: ['global', 'ABC123', 'XYZ789']
  });
  const abcModerators = ['RoomMod', 'ABCMod'];
  if (actor === 'mod' && action === 'timeout') abcModerators.push(target.username);
  const restrictions = [];
  if (action === 'unban') restrictions.push(restrictionDocument(room, target.username, {
    bannedAt: new Date('2026-08-08T12:00:00.000Z'),
    bannedBy: 'Admin',
    banReason: 'existing ban'
  }));
  if (action === 'clear_timeout') restrictions.push(restrictionDocument(room, target.username, {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'Admin',
    timeoutReason: 'existing timeout'
  }));
  const setup = registerWithModels({
    users: [
      userDocument({ username: actorProfile.username, displayName: actorProfile.username, role: actorProfile.role, servers: ['global', 'ABC123', 'XYZ789'] }),
      target
    ],
    rooms: [
      roomDocument('global', { owner: 'System' }),
      roomDocument('ABC123', { moderators: abcModerators }),
      roomDocument('XYZ789')
    ],
    restrictions,
    logger,
    ModerationAuditModel,
    RoomRestrictionModel,
    broadcastOnlineUsersFn
  });
  Object.assign(setup.socket, {
    username: actorProfile.username,
    displayName: actorProfile.username,
    role: actorProfile.role,
    serverCode: room,
    joinedServers: ['global', 'ABC123', 'XYZ789'],
    bannedRooms: []
  });
  setup.socket.joinedRooms.add(room);
  setup.onlineUsersMap.set(setup.socket.id, {
    username: actorProfile.username,
    displayName: actorProfile.username,
    role: actorProfile.role,
    serverCode: room,
    joinedServers: ['global', 'ABC123', 'XYZ789'],
    bannedRooms: []
  });
  const models = {
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    MessageModel: setup.MessageModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    ModerationReportModel: setup.ModerationReportModel
  };
  return { ...setup, target, models };
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

for (const row of [
  { name: 'admin may timeout global member', room: 'global', actor: 'admin', action: 'timeout', ok: true },
  { name: 'admin may ban global member', room: 'global', actor: 'admin', action: 'ban', ok: true },
  { name: 'admin may not kick global member', room: 'global', actor: 'admin', action: 'kick', ok: false },
  { name: 'room mod may kick exact-room member', room: 'ABC123', actor: 'mod', action: 'kick', ok: true },
  { name: 'room mod may not kick other-room member', room: 'XYZ789', actor: 'mod', action: 'kick', ok: false },
  { name: 'room mod may not timeout current room mod', room: 'ABC123', actor: 'mod', action: 'timeout', ok: false },
  { name: 'admin may not ban another admin', room: 'ABC123', actor: 'admin', action: 'ban', ok: false }
]) {
  test(row.name, async () => {
    const setup = moderationScenario(row);
    if (row.name.includes('another admin')) setup.UserModel.rows[1].role = 'admin';
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: row.room,
      targetUser: setup.target.username,
      action: row.action,
      duration: row.action === 'timeout' ? '10m' : undefined,
      reason: 'documented test reason'
    }, ack.callback);
    assert.equal(Boolean(ack.value().success), row.ok);
    assert.equal(Boolean(ack.value().error), !row.ok);
  });
}

test('moderationScenario exposes the documented aggregate and individual model handles', () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  assert.deepEqual(setup.models, {
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    MessageModel: setup.MessageModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    ModerationReportModel: setup.ModerationReportModel
  });
});

for (const action of ['timeout', 'ban']) {
  test(`admin may ${action} a Global account whose private-only legacy membership omits Global`, async () => {
    const setup = moderationScenario({ room: 'global', actor: 'admin', action });
    setup.UserModel.rows.find(user => user.username === 'TargetUser').servers = ['ABC123', 'XYZ789'];
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'global', targetUser: 'TargetUser', action,
      duration: action === 'timeout' ? '10m' : undefined,
      reason: 'documented legacy Global moderation'
    }, ack.callback);
    assert.deepEqual(ack.value(), { success: true });
  });
}

test('Private kick removes membership and moderator authority before awaiting every-session eviction', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const first = connectAdditionalSocket(setup, {
    id: 'target-1', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  first.leave = async code => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(first, code);
  };
  const second = connectAdditionalSocket(setup, {
    id: 'target-2', username: 'targetuser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  setup.onlineUsersMap.set('target-map-only', {
    username: 'TARGETUSER', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });

  const ack = acknowledge();
  const pending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'kick',
    reason: 'documented test reason'
  }, ack.callback);
  await Promise.race([firstLeaveStarted.promise, pending]);

  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, ['global', 'XYZ789']);
  assert.deepEqual(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators, ['RoomMod', 'ABCMod']);
  for (const live of [first, second]) {
    assert.deepEqual(live.joinedServers, ['global', 'XYZ789']);
    assert.equal(live.serverCode, 'global');
    assert.deepEqual(setup.onlineUsersMap.get(live.id).joinedServers, ['global', 'XYZ789']);
    assert.equal(setup.onlineUsersMap.get(live.id).serverCode, 'global');
  }
  assert.deepEqual(setup.onlineUsersMap.get('target-map-only').joinedServers, ['global', 'XYZ789']);
  assert.equal(setup.onlineUsersMap.get('target-map-only').serverCode, 'global');

  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(setup.RoomRestrictionModel.rows.length, 0);
  assert.equal(setup.ModerationAuditModel.rows.length, 1);
  for (const live of [first, second]) {
    assert.equal(live.joinedRooms.has('ABC123'), false);
    assert.equal(live.joinedRooms.has('global'), true);
    assert.equal(live.outbound.some(item => item.event === 'room_access_updated'), true);
  }
});

test('Private ban removes access and upserts normalized ban fields while clearing timeout fields', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TARGETUSER');
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'RoomMod',
    timeoutReason: 'superseded timeout'
  }));
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-ban', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'abc123', targetUser: 'TARGETUSER', action: 'BAN',
    reason: 'documented ban reason'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, ['global', 'XYZ789']);
  assert.deepEqual(setup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators, ['RoomMod', 'ABCMod']);
  assert.equal(targetSocket.serverCode, 'global');
  const restriction = setup.RoomRestrictionModel.rows[0];
  assert.equal(restriction.serverCode, 'ABC123');
  assert.equal(restriction.username, 'targetuser');
  assert.equal(restriction.bannedAt instanceof Date, true);
  assert.equal(restriction.bannedBy, 'Admin');
  assert.equal(restriction.banReason, 'documented ban reason');
  assert.equal(restriction.timeoutUntil, null);
  assert.equal(restriction.timeoutBy, null);
  assert.equal(restriction.timeoutReason, null);
});

test('Global ban preserves private memberships and moves all Global sessions to one accessible private fallback', async () => {
  const setup = moderationScenario({ room: 'global', actor: 'admin', action: 'ban' });
  setup.UserModel.rows.find(user => user.username === 'TargetUser').servers.push('OLD123');
  const first = connectAdditionalSocket(setup, {
    id: 'target-global-1', username: 'TargetUser', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789', 'OLD123']
  });
  const second = connectAdditionalSocket(setup, {
    id: 'target-global-2', username: 'targetuser', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789', 'OLD123']
  });
  setup.onlineUsersMap.set('target-global-map', {
    username: 'TARGETUSER', serverCode: 'global',
    joinedServers: ['global', 'ABC123', 'XYZ789', 'OLD123'], bannedRooms: []
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'GLOBAL', targetUser: 'targetuser', action: 'ban',
    reason: 'documented global ban'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, ['global', 'ABC123', 'XYZ789', 'OLD123']);
  for (const live of [first, second]) {
    assert.deepEqual(live.joinedServers, ['ABC123', 'XYZ789']);
    assert.deepEqual(live.bannedRooms, ['global']);
    assert.equal(live.serverCode, 'ABC123');
    assert.equal(live.joinedRooms.has('global'), false);
    assert.equal(live.joinedRooms.has('ABC123'), true);
  }
  assert.equal(setup.onlineUsersMap.get('target-global-map').serverCode, 'ABC123');
  assert.deepEqual(setup.onlineUsersMap.get('target-global-map').bannedRooms, ['global']);
});

test('Global ban reconciliation never inserts Global implicitly for private or null fallback', () => {
  const live = {
    serverCode: 'global', joinedServers: ['global', 'ABC123'], bannedRooms: [],
    username: 'TargetUser'
  };
  const session = {
    serverCode: 'global', joinedServers: ['global', 'ABC123'], bannedRooms: [],
    username: 'TargetUser'
  };
  applySessionAccessSnapshot({
    live, session, joinedServers: ['ABC123'], bannedRooms: ['global'],
    removedRoom: 'global', fallbackCode: 'ABC123'
  });
  assert.deepEqual(live.joinedServers, ['ABC123']);
  assert.equal(live.serverCode, 'ABC123');
  assert.equal(live.joinedServers.includes('global'), false);
  applySessionAccessSnapshot({
    live, session, joinedServers: [], bannedRooms: ['global'],
    removedRoom: 'ABC123', fallbackCode: null
  });
  assert.deepEqual(live.joinedServers, []);
  assert.equal(live.serverCode, null);
  assert.equal(session.serverCode, null);
  assert.equal(session.joinedServers.includes('global'), false);
});

test('Global ban real reconciliation moves live and map-only Global sessions to lobby when no fallback exists', async () => {
  const setup = moderationScenario({ room: 'global', actor: 'admin', action: 'ban' });
  setup.UserModel.rows.find(user => user.username === 'TargetUser').servers = ['global'];
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-global-lobby', username: 'TargetUser', serverCode: 'global',
    joinedServers: ['global']
  });
  setup.onlineUsersMap.set('target-global-lobby-map', {
    username: 'targetuser', serverCode: 'global', joinedServers: ['global'], bannedRooms: []
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'ban',
    reason: 'documented no-fallback Global ban'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.equal(targetSocket.serverCode, null);
  assert.deepEqual(targetSocket.joinedServers, []);
  assert.deepEqual(targetSocket.bannedRooms, ['global']);
  assert.equal(targetSocket.joinedRooms.has('global'), false);
  assert.equal(setup.onlineUsersMap.get('target-global-lobby-map').serverCode, null);
  assert.deepEqual(setup.onlineUsersMap.get('target-global-lobby-map').joinedServers, []);
  assert.deepEqual(setup.onlineUsersMap.get('target-global-lobby-map').bannedRooms, ['global']);
});

test('globally banned lobby creation preserves the Global ban and never publishes Global presence', async () => {
  const broadcasts = [];
  const setup = registerWithModels({
    user: userDocument({ username: 'Alice', servers: ['global'] }),
    rooms: [roomDocument('global')],
    restrictions: [restrictionDocument('global', 'alice', { bannedAt: new Date() })],
    broadcastOnlineUsersFn: code => broadcasts.push(code)
  });
  Object.assign(setup.socket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: null,
    joinedServers: [], bannedRooms: ['global']
  });
  setup.onlineUsersMap.set(setup.socket.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: null,
    joinedServers: [], bannedRooms: ['global']
  });
  const ack = acknowledge();
  await setup.socket.trigger('create_server', 'Private Team', ack.callback);
  assert.equal(ack.value().success, true);
  assert.equal(setup.socket.joinedServers.includes('global'), false);
  assert.deepEqual(setup.socket.bannedRooms, ['global']);
  assert.equal(setup.onlineUsersMap.get(setup.socket.id).joinedServers.includes('global'), false);
  assert.deepEqual(setup.onlineUsersMap.get(setup.socket.id).bannedRooms, ['global']);
  assert.equal(setup.socket.joinedRooms.has('global'), false);
  assert.equal(broadcasts.includes('global'), false);
});

test('Timeout stores the exact configured expiry, keeps transport access, and notifies only target sessions', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'timeout' });
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-timeout', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const before = Date.now();
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'timeout', duration: '10m',
    reason: 'documented timeout reason'
  }, ack.callback);
  const after = Date.now();

  assert.deepEqual(ack.value(), { success: true });
  const restriction = setup.RoomRestrictionModel.rows[0];
  assert.equal(restriction.timeoutUntil.getTime() >= before + MODERATION_DURATIONS['10m'], true);
  assert.equal(restriction.timeoutUntil.getTime() <= after + MODERATION_DURATIONS['10m'], true);
  assert.equal(restriction.timeoutBy, 'Admin');
  assert.equal(restriction.timeoutReason, 'documented timeout reason');
  assert.equal(targetSocket.serverCode, 'ABC123');
  assert.equal(targetSocket.joinedRooms.has('ABC123'), true);
  assert.equal(targetSocket.outbound.filter(item => item.event === 'room_restriction_updated').length, 1);
  assert.equal(setup.socket.outbound.some(item => item.event === 'room_restriction_updated'), false);
});

test('clear_timeout and unban clear only their own fields and never restore membership or moderation', async () => {
  const clearSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'clear_timeout' });
  Object.assign(clearSetup.RoomRestrictionModel.rows[0], {
    bannedAt: new Date('2026-08-08T12:00:00.000Z'),
    bannedBy: 'Admin',
    banReason: 'preserve this ban'
  });
  const clearAck = acknowledge();
  await clearSetup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'clear_timeout',
    reason: 'documented clear reason'
  }, clearAck.callback);
  assert.deepEqual(clearAck.value(), { success: true });
  assert.deepEqual({
    timeoutUntil: clearSetup.RoomRestrictionModel.rows[0].timeoutUntil,
    timeoutBy: clearSetup.RoomRestrictionModel.rows[0].timeoutBy,
    timeoutReason: clearSetup.RoomRestrictionModel.rows[0].timeoutReason
  }, { timeoutUntil: null, timeoutBy: null, timeoutReason: null });
  assert.equal(clearSetup.RoomRestrictionModel.rows[0].banReason, 'preserve this ban');

  const unbanSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'unban' });
  Object.assign(unbanSetup.RoomRestrictionModel.rows[0], {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'Admin',
    timeoutReason: 'preserve this timeout'
  });
  unbanSetup.UserModel.rows[1].servers = ['global', 'XYZ789'];
  unbanSetup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators = ['RoomMod', 'ABCMod'];
  const unbanAck = acknowledge();
  await unbanSetup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'unban',
    reason: 'documented unban reason'
  }, unbanAck.callback);
  assert.deepEqual(unbanAck.value(), { success: true });
  assert.deepEqual({
    bannedAt: unbanSetup.RoomRestrictionModel.rows[0].bannedAt,
    bannedBy: unbanSetup.RoomRestrictionModel.rows[0].bannedBy,
    banReason: unbanSetup.RoomRestrictionModel.rows[0].banReason
  }, { bannedAt: null, bannedBy: null, banReason: null });
  assert.equal(unbanSetup.RoomRestrictionModel.rows[0].timeoutReason, 'preserve this timeout');
  assert.deepEqual(unbanSetup.UserModel.rows[1].servers, ['global', 'XYZ789']);
  assert.deepEqual(unbanSetup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators, ['RoomMod', 'ABCMod']);
});

test('ban then unban cannot revive a superseded timeout or restore membership', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', {
    timeoutUntil: new Date(Date.now() + 60_000),
    timeoutBy: 'RoomMod',
    timeoutReason: 'must stay cleared'
  }));
  const banAck = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented ban'
  }, banAck.callback);
  const unbanAck = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'targetuser', action: 'unban', reason: 'documented unban'
  }, unbanAck.callback);

  assert.deepEqual(banAck.value(), { success: true });
  assert.deepEqual(unbanAck.value(), { success: true });
  assert.equal(setup.RoomRestrictionModel.rows[0].bannedAt, null);
  assert.equal(setup.RoomRestrictionModel.rows[0].timeoutUntil, null);
  assert.equal(activeRestrictionState(setup.RoomRestrictionModel.rows[0]).timedOut, false);
  assert.deepEqual(setup.UserModel.rows[1].servers, ['global', 'XYZ789']);
});

for (const scenario of [
  { name: 'private kick requires current membership', action: 'kick', mutate(setup) { setup.UserModel.rows[1].servers = ['global', 'XYZ789']; } },
  { name: 'timeout requires current membership', action: 'timeout', mutate(setup) { setup.UserModel.rows[1].servers = ['global', 'XYZ789']; } },
  { name: 'first-time ban requires current membership', action: 'ban', mutate(setup) { setup.UserModel.rows[1].servers = ['global', 'XYZ789']; } },
  { name: 'timeout rejects an active ban', action: 'timeout', mutate(setup) { setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', { bannedAt: new Date() })); } },
  { name: 'ban rejects an already-active ban', action: 'ban', mutate(setup) { setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'targetuser', { bannedAt: new Date() })); } },
  { name: 'clear_timeout requires an active timeout', action: 'clear_timeout', mutate(setup) { setup.RoomRestrictionModel.rows.length = 0; } },
  { name: 'unban requires an active ban', action: 'unban', mutate(setup) { setup.RoomRestrictionModel.rows.length = 0; } }
]) {
  test(`${scenario.name} and returns a generic state error`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: scenario.action });
    scenario.mutate(setup);
    const before = JSON.parse(JSON.stringify({
      user: setup.UserModel.rows[1],
      room: setup.ChatServerModel.rows.find(room => room.code === 'ABC123'),
      restrictions: setup.RoomRestrictionModel.rows
    }));
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: scenario.action,
      duration: scenario.action === 'timeout' ? '10m' : undefined,
      reason: 'documented invalid-state reason'
    }, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Permission denied.' });
    assert.deepEqual(JSON.parse(JSON.stringify({
      user: setup.UserModel.rows[1],
      room: setup.ChatServerModel.rows.find(room => room.code === 'ABC123'),
      restrictions: setup.RoomRestrictionModel.rows
    })), before);
    assert.equal(setup.ModerationAuditModel.rows.length, 0);
  });
}

for (const actorState of ['nonmember', 'banned', 'timed out']) {
  test(`room moderator cannot moderate after becoming a current ${actorState}`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'mod', action: 'kick' });
    const actor = setup.UserModel.rows.find(user => user.username === 'RoomMod');
    if (actorState === 'nonmember') actor.servers = ['global', 'XYZ789'];
    if (actorState === 'banned') {
      setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'roommod', {
        bannedAt: new Date(), bannedBy: 'Admin', banReason: 'active actor ban'
      }));
    }
    if (actorState === 'timed out') {
      setup.RoomRestrictionModel.rows.push(restrictionDocument('ABC123', 'roommod', {
        timeoutUntil: new Date(Date.now() + 60_000),
        timeoutBy: 'Admin', timeoutReason: 'active actor timeout'
      }));
    }
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
      reason: 'must be rejected from stale authority'
    }, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Permission denied.' });
    assert.deepEqual(setup.UserModel.rows.find(user => user.username === 'TargetUser').servers, [
      'global', 'ABC123', 'XYZ789'
    ]);
    assert.equal(setup.ModerationAuditModel.rows.length, 0);
  });
}

for (const failureStage of ['leave', 'join', 'disconnect']) {
  test(`failed ${failureStage} during eviction quarantines stale target identity and map access`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
    const targetSocket = connectAdditionalSocket(setup, {
      id: `target-failed-${failureStage}`, username: 'TargetUser', serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const originalLeave = targetSocket.leave.bind(targetSocket);
    const originalJoin = targetSocket.join.bind(targetSocket);
    let leaveCalls = 0;
    targetSocket.leave = code => {
      leaveCalls += 1;
      if ((failureStage === 'leave' || failureStage === 'disconnect') && leaveCalls === 1) {
        return Promise.reject(new Error('transport leave rejected'));
      }
      return originalLeave(code);
    };
    targetSocket.join = code => {
      originalJoin(code);
      if (failureStage === 'join') return Promise.reject(new Error('transport join rejected'));
    };
    if (failureStage === 'disconnect') {
      targetSocket.disconnect = () => Promise.reject(new Error('transport disconnect rejected'));
    }
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban',
      reason: 'documented transport-failure reason'
    }, ack.callback);

    assert.deepEqual(ack.value(), { success: true });
    assert.equal(targetSocket.username, null);
    assert.equal(targetSocket.serverCode, null);
    assert.deepEqual(targetSocket.joinedServers, []);
    assert.equal(setup.onlineUsersMap.has(targetSocket.id), false);
    assert.equal(targetSocket.joinedServers.includes('ABC123'), false);
    assert.equal(targetSocket.joinedRooms.has('ABC123'), false);
    assert.equal(targetSocket.joinedRooms.has('global'), false);
    if (failureStage !== 'disconnect') assert.equal(targetSocket.disconnected, true);
    assert.deepEqual(setup.ModerationAuditModel.rows[0].metadata, {
      transportSynchronized: false,
      removedRoom: 'ABC123',
      fallbackCode: 'global'
    });
  });
}

test('audit retry treats first-write-committed response loss as one successful append', async () => {
  const rows = [];
  let attempts = 0;
  const ModerationAuditModel = {
    rows,
    async create(entry) {
      attempts += 1;
      if (rows.some(row => row.correlationId === entry.correlationId)) {
        const duplicate = new Error('duplicate');
        duplicate.code = 11000;
        throw duplicate;
      }
      rows.push({ ...entry });
      throw new Error('response lost after commit');
    }
  };
  const setup = moderationScenario({
    room: 'ABC123', actor: 'admin', action: 'timeout', ModerationAuditModel
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'timeout', duration: '10m',
    reason: 'audit retry reason'
  }, ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(attempts, 2);
  assert.equal(rows.length, 1);
  assert.match(rows[0].correlationId, /^[0-9a-f]{24}$/);
});

test('audit snapshots pre-mutation room roles independently from global account roles', async () => {
  const globalSetup = moderationScenario({ room: 'global', actor: 'admin', action: 'timeout' });
  const timeoutAck = acknowledge();
  await globalSetup.socket.trigger('moderate_user', {
    serverCode: 'global', targetUser: 'TargetUser', action: 'timeout', duration: '10m',
    reason: 'documented audit role timeout'
  }, timeoutAck.callback);
  assert.deepEqual(timeoutAck.value(), { success: true });
  assert.equal(globalSetup.ModerationAuditModel.rows[0].actorRole, 'admin');
  assert.equal(globalSetup.ModerationAuditModel.rows[0].actorRoomRole, 'user');

  const privateSetup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  privateSetup.ChatServerModel.rows.find(room => room.code === 'ABC123').moderators.push('TargetUser');
  const kickAck = acknowledge();
  await privateSetup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick',
    reason: 'documented audit role kick'
  }, kickAck.callback);
  assert.deepEqual(kickAck.value(), { success: true });
  assert.equal(privateSetup.ModerationAuditModel.rows[0].actorRole, 'admin');
  assert.equal(privateSetup.ModerationAuditModel.rows[0].actorRoomRole, 'user');
  assert.equal(privateSetup.ModerationAuditModel.rows[0].targetRoomRole, 'mod');
});

test('audit double failure stays redacted, preserves notifications, and acknowledges enforced state', async () => {
  const logs = [];
  let attempts = 0;
  const ModerationAuditModel = {
    rows: [],
    async create() { attempts += 1; throw new Error('secret audit outage'); }
  };
  const setup = moderationScenario({
    room: 'ABC123', actor: 'admin', action: 'timeout', ModerationAuditModel,
    logger: { error(...args) { logs.push(args); } }
  });
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-audit-failure', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const reason = 'never log this moderation reason';
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'timeout', duration: '10m', reason
  }, ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(attempts, 2);
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes('moderation_audit_write'), true);
  assert.equal(JSON.stringify(logs).includes(reason), false);
  assert.equal(JSON.stringify(logs).includes('secret audit outage'), false);
  assert.equal(targetSocket.outbound.some(item => item.event === 'room_restriction_updated'), true);
});

test('retrying an already-applied client ban returns generic error without duplicate state or audit', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  const firstAck = acknowledge();
  const secondAck = acknowledge();
  const request = {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented ban'
  };
  await setup.socket.trigger('moderate_user', request, firstAck.callback);
  await setup.socket.trigger('moderate_user', request, secondAck.callback);
  assert.deepEqual(firstAck.value(), { success: true });
  assert.deepEqual(secondAck.value(), { error: 'Permission denied.' });
  assert.equal(setup.RoomRestrictionModel.rows.length, 1);
  assert.equal(setup.ModerationAuditModel.rows.length, 1);
});

test('ordinary room notification for removal exposes no actor target or reason', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  const reason = 'sensitive documented reason';
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick', reason
  }, ack.callback);
  const notices = setup.ioInstance.outbound.filter(item => item.room === 'ABC123' && item.event === 'system_message');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].payload, 'A member was removed by moderation.');
  assert.equal(JSON.stringify(notices).includes('Admin'), false);
  assert.equal(JSON.stringify(notices).includes('TargetUser'), false);
  assert.equal(JSON.stringify(notices).includes(reason), false);
});

test('unban refreshes target restriction snapshots and rebroadcasts room presence', async () => {
  const broadcasts = [];
  const setup = moderationScenario({
    room: 'ABC123', actor: 'admin', action: 'unban',
    broadcastOnlineUsersFn: code => broadcasts.push(code)
  });
  setup.UserModel.rows[1].servers = ['global', 'ABC123', 'XYZ789'];
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-unban', username: 'TargetUser', serverCode: 'XYZ789',
    joinedServers: ['global', 'XYZ789'], bannedRooms: ['ABC123']
  });
  const ack = acknowledge();
  await setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'unban',
    reason: 'documented unban'
  }, ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(targetSocket.bannedRooms, []);
  assert.deepEqual(setup.onlineUsersMap.get(targetSocket.id).bannedRooms, []);
  assert.equal(targetSocket.outbound.some(item => item.event === 'room_restriction_updated' && item.payload.banned === false), true);
  assert.equal(broadcasts.includes('ABC123'), true);
});

for (const action of ['timeout', 'ban']) {
  test(`Global Chat ${action} blocks only Global Chat and preserves private-room interaction`, async () => {
    const setup = moderationScenario({ room: 'global', actor: 'admin', action });
    const targetSocket = connectAdditionalSocket(setup, {
      id: `target-global-${action}`, username: 'TargetUser', serverCode: 'global',
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const ack = acknowledge();
    await setup.socket.trigger('moderate_user', {
      serverCode: 'global', targetUser: 'TargetUser', action,
      duration: action === 'timeout' ? '10m' : undefined,
      reason: `documented global ${action}`
    }, ack.callback);
    assert.deepEqual(ack.value(), { success: true });

    if (action === 'timeout') {
      await targetSocket.trigger('chat_message', { text: 'must not publish in Global' });
      assert.equal(setup.MessageModel.created.length, 0);
      const switchAck = acknowledge();
      await targetSocket.trigger('switch_server', 'ABC123', switchAck.callback);
      assert.equal(Boolean(switchAck.value().error), false);
    } else {
      assert.equal(targetSocket.joinedRooms.has('global'), false);
    }
    assert.equal(targetSocket.serverCode, 'ABC123');
    await targetSocket.trigger('typing', true);
    assert.equal(targetSocket.outbound.some(item =>
      item.target === 'ABC123' && item.event === 'typing' && item.payload.isTyping === true
    ), true);
  });
}

for (const racedAction of ['switch', 'join', 'message publication']) {
  test(`Ban racing ${racedAction} leaves no forbidden transport membership or emitted message`, async () => {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const restrictions = createMemoryModel([]);
    const baseUpsert = restrictions.findOneAndUpdate.bind(restrictions);
    let held = false;
    restrictions.findOneAndUpdate = async (...args) => {
      if (!held) {
        held = true;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return baseUpsert(...args);
    };
    const setup = moderationScenario({
      room: 'ABC123', actor: 'admin', action: 'ban', RoomRestrictionModel: restrictions
    });
    const initialRoom = racedAction === 'message publication' ? 'ABC123' : 'global';
    const targetSocket = connectAdditionalSocket(setup, {
      id: `target-race-${racedAction.replaceAll(' ', '-')}`,
      username: 'TargetUser', serverCode: initialRoom,
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const banAck = acknowledge();
    const banPending = setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented race ban'
    }, banAck.callback);
    await writeStarted.promise;

    let racedPending;
    let racedAck;
    if (racedAction === 'message publication') {
      racedPending = targetSocket.trigger('chat_message', { text: 'must never publish' });
    } else {
      racedAck = acknowledge();
      racedPending = targetSocket.trigger(
        racedAction === 'switch' ? 'switch_server' : 'join_server',
        'ABC123', racedAck.callback
      );
    }
    await new Promise(resolve => setImmediate(resolve));
    releaseWrite.resolve();
    await Promise.all([banPending, racedPending]);

    assert.deepEqual(banAck.value(), { success: true });
    assert.equal(targetSocket.joinedRooms.has('ABC123'), false);
    assert.equal(targetSocket.joinedServers.includes('ABC123'), false);
    assert.equal(setup.onlineUsersMap.get(targetSocket.id).joinedServers.includes('ABC123'), false);
    assert.equal(setup.ioInstance.outbound.some(item => item.room === 'ABC123' && item.event === 'chat_message'), false);
    if (racedAck) assert.deepEqual(racedAck.value(), { error: 'Permission denied.' });
  });
}

test('target leave that wins the account lock makes a racing first-time ban fail on canonical membership', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  const targetSocket = connectAdditionalSocket(setup, {
    id: 'target-leave-race', username: 'TargetUser', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.UserModel.findOne.bind(setup.UserModel);
  let held = false;
  setup.UserModel.findOne = async query => {
    const document = await baseFindOne(query);
    if (document && document.username === 'TargetUser' && !held) {
      const baseSave = document.save.bind(document);
      return {
        ...document,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(document, values);
          return baseSave();
        }
      };
    }
    return document;
  };
  const leaveAck = acknowledge();
  const leavePending = targetSocket.trigger('leave_server', 'ABC123', leaveAck.callback);
  await saveStarted.promise;
  const banAck = acknowledge();
  const banPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented race ban'
  }, banAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(banAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([leavePending, banPending]);
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(banAck.value(), { error: 'Permission denied.' });
  assert.deepEqual(setup.UserModel.rows[1].servers, ['global', 'XYZ789']);
  assert.equal(setup.RoomRestrictionModel.rows.length, 0);
});

test('actor room demotion that wins the account lock makes later moderation fail', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'mod', action: 'kick' });
  setup.UserModel.rows.push(userDocument({
    username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
    servers: ['global', 'ABC123', 'XYZ789']
  }));
  const administrator = connectAdditionalSocket(setup, {
    id: 'room-demoter', username: 'SecondAdmin', serverCode: 'ABC123', role: 'admin',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
  let held = false;
  setup.ChatServerModel.findOne = async query => {
    const room = await baseFindOne(query);
    if (room && room.code === 'ABC123' && !held) {
      const baseSave = room.save.bind(room);
      return {
        ...room,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(room, values);
          return baseSave();
        }
      };
    }
    return room;
  };
  const demoteAck = acknowledge();
  const demotePending = administrator.trigger('manage_role', {
    targetUser: 'RoomMod', action: 'demote_mod', serverCode: 'ABC123'
  }, demoteAck.callback);
  await saveStarted.promise;
  const moderationAck = acknowledge();
  const moderationPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick', reason: 'documented race moderation'
  }, moderationAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(moderationAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([demotePending, moderationPending]);
  assert.deepEqual(demoteAck.value(), { success: true });
  assert.deepEqual(moderationAck.value(), { error: 'Permission denied.' });
});

test('actor global demotion that wins the account lock makes later moderation fail', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'kick' });
  setup.UserModel.rows.push(userDocument({
    username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
    servers: ['global', 'ABC123', 'XYZ789']
  }));
  const administrator = connectAdditionalSocket(setup, {
    id: 'global-demoter', username: 'SecondAdmin', serverCode: 'global', role: 'admin',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.UserModel.findOne.bind(setup.UserModel);
  let held = false;
  setup.UserModel.findOne = async query => {
    const user = await baseFindOne(query);
    if (user && user.username === 'Admin' && !held) {
      const baseSave = user.save.bind(user);
      return {
        ...user,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(user, values);
          return baseSave();
        }
      };
    }
    return user;
  };
  const demoteAck = acknowledge();
  const demotePending = administrator.trigger('manage_role', {
    targetUser: 'Admin', action: 'demote_global_admin'
  }, demoteAck.callback);
  await saveStarted.promise;
  const moderationAck = acknowledge();
  const moderationPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'kick', reason: 'documented race moderation'
  }, moderationAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(moderationAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([demotePending, moderationPending]);
  assert.deepEqual(demoteAck.value(), { success: true });
  assert.deepEqual(moderationAck.value(), { error: 'Permission denied.' });
});

test('target promotion that wins the account lock protects the target from a later ban', async () => {
  const setup = moderationScenario({ room: 'ABC123', actor: 'admin', action: 'ban' });
  setup.UserModel.rows.push(userDocument({
    username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
    servers: ['global', 'ABC123', 'XYZ789']
  }));
  const administrator = connectAdditionalSocket(setup, {
    id: 'target-promoter', username: 'SecondAdmin', serverCode: 'global', role: 'admin',
    joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  const baseFindOne = setup.UserModel.findOne.bind(setup.UserModel);
  let held = false;
  setup.UserModel.findOne = async query => {
    const user = await baseFindOne(query);
    if (user && user.username === 'TargetUser' && !held) {
      const baseSave = user.save.bind(user);
      return {
        ...user,
        markModified() {},
        async save() {
          held = true;
          saveStarted.resolve();
          await releaseSave.promise;
          const values = { ...this };
          delete values.save;
          delete values.markModified;
          Object.assign(user, values);
          return baseSave();
        }
      };
    }
    return user;
  };
  const promoteAck = acknowledge();
  const promotePending = administrator.trigger('manage_role', {
    targetUser: 'TargetUser', action: 'promote_global_admin'
  }, promoteAck.callback);
  await saveStarted.promise;
  const banAck = acknowledge();
  const banPending = setup.socket.trigger('moderate_user', {
    serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented race ban'
  }, banAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(banAck.value(), undefined);
  releaseSave.resolve();
  await Promise.all([promotePending, banPending]);
  assert.deepEqual(promoteAck.value(), { success: true });
  assert.deepEqual(banAck.value(), { error: 'Permission denied.' });
  assert.equal(setup.RoomRestrictionModel.rows.length, 0);
});

for (const transition of ['demotion', 'promotion']) {
  test(`target room ${transition} that wins the account lock controls a later room-mod ban`, async () => {
    const setup = moderationScenario({ room: 'ABC123', actor: 'mod', action: 'ban' });
    setup.UserModel.rows.push(userDocument({
      username: 'SecondAdmin', displayName: 'SecondAdmin', role: 'admin',
      servers: ['global', 'ABC123', 'XYZ789']
    }));
    const roomRow = setup.ChatServerModel.rows.find(room => room.code === 'ABC123');
    if (transition === 'demotion') roomRow.moderators.push('TargetUser');
    const administrator = connectAdditionalSocket(setup, {
      id: `target-room-${transition}`, username: 'SecondAdmin', serverCode: 'ABC123', role: 'admin',
      joinedServers: ['global', 'ABC123', 'XYZ789']
    });
    const saveStarted = deferred();
    const releaseSave = deferred();
    const baseFindOne = setup.ChatServerModel.findOne.bind(setup.ChatServerModel);
    let held = false;
    setup.ChatServerModel.findOne = async query => {
      const room = await baseFindOne(query);
      if (room && room.code === 'ABC123' && !held) {
        const baseSave = room.save.bind(room);
        return {
          ...room,
          markModified() {},
          async save() {
            held = true;
            saveStarted.resolve();
            await releaseSave.promise;
            const values = { ...this };
            delete values.save;
            delete values.markModified;
            Object.assign(room, values);
            return baseSave();
          }
        };
      }
      return room;
    };
    const roleAck = acknowledge();
    const rolePending = administrator.trigger('manage_role', {
      targetUser: 'TargetUser',
      action: transition === 'demotion' ? 'demote_mod' : 'promote_mod',
      serverCode: 'ABC123'
    }, roleAck.callback);
    await saveStarted.promise;
    const banAck = acknowledge();
    const banPending = setup.socket.trigger('moderate_user', {
      serverCode: 'ABC123', targetUser: 'TargetUser', action: 'ban', reason: 'documented room-role race'
    }, banAck.callback);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(banAck.value(), undefined);
    releaseSave.resolve();
    await Promise.all([rolePending, banPending]);

    assert.deepEqual(roleAck.value(), { success: true });
    assert.deepEqual(
      banAck.value(),
      transition === 'demotion' ? { success: true } : { error: 'Permission denied.' }
    );
    assert.equal(setup.RoomRestrictionModel.rows.length, transition === 'demotion' ? 1 : 0);
  });
}

module.exports = {
  VALID_MESSAGE_ID,
  userDocument,
  roomDocument,
  restrictionDocument,
  registerWithModels,
  authenticatedRoomSocket,
  authenticatedLobbySocket,
  timedOutAuthenticatedSocket,
  moderationScenario
};
