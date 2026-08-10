const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionHandler } = require('../server');
const { FakeSocket, FakeIo, createMemoryModel, acknowledge } = require('./support/fakes');

function user(username, { role = 'user', servers = ['global', 'ABC123'] } = {}) {
  return { username, displayName: username, role, password: 'hash', servers };
}

function room(code, overrides = {}) {
  return {
    code, name: code === 'global' ? 'Global Chat' : code, owner: 'Owner', moderators: [],
    description: '', rules: '', metadataVersion: 0,
    autoMod: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 },
    ...overrides
  };
}

function restriction(serverCode, username, overrides = {}) {
  return { serverCode, username: username.toLowerCase(), bannedAt: null, timeoutUntil: null, ...overrides };
}

function installSession(setup, { id, username, role = 'user', serverCode = 'ABC123', joinedServers = ['global', 'ABC123'] }) {
  const socket = new FakeSocket();
  socket.id = id;
  createConnectionHandler({
    ioInstance: setup.ioInstance,
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    MessageModel: setup.MessageModel,
    RoomMemberStateModel: setup.RoomMemberStateModel,
    UserExperienceStateModel: setup.UserExperienceStateModel,
    onlineUsersMap: setup.onlineUsersMap,
    broadcastOnlineUsersFn: async () => {}, getRoomRoleFn: async () => 'user', resolvePingsFn: async text => text,
    logger: setup.logger
  })(socket);
  Object.assign(socket, { username, displayName: username, role, serverCode, joinedServers, bannedRooms: [] });
  socket.joinedRooms.add(serverCode);
  setup.onlineUsersMap.set(id, { username, displayName: username, role, serverCode, joinedServers, bannedRooms: [] });
  setup.ioInstance.sockets.push(socket);
  return socket;
}

function createFixture({ metadataVersion = 0, legacy = false, logger = { error() {} } } = {}) {
  const setup = {
    ioInstance: new FakeIo(), onlineUsersMap: new Map(), logger,
    UserModel: createMemoryModel([
      user('Owner'), user('ExactMod'), user('OtherRoomMod'), user('Member'), user('Admin', { role: 'admin' }),
      user('TimedOutOwner'), user('BannedAdmin', { role: 'admin' })
    ]),
    ChatServerModel: createMemoryModel([
      room('global', { owner: 'System' }),
      room('ABC123', { moderators: ['ExactMod'], ...(legacy ? {} : { metadataVersion }) }),
      room('XYZ789', { moderators: ['OtherRoomMod'] })
    ]),
    RoomRestrictionModel: createMemoryModel([
      restriction('ABC123', 'TimedOutOwner', { timeoutUntil: new Date(Date.now() + 60_000) }),
      restriction('ABC123', 'BannedAdmin', { bannedAt: new Date() })
    ]),
    ModerationAuditModel: createMemoryModel([]),
    MessageModel: createMemoryModel([]),
    RoomMemberStateModel: createMemoryModel([]),
    UserExperienceStateModel: createMemoryModel([])
  };
  if (legacy) delete setup.ChatServerModel.rows.find(row => row.code === 'ABC123').metadataVersion;
  return {
    ...setup,
    owner: installSession(setup, { id: 'owner', username: 'Owner' }),
    exactMod: installSession(setup, { id: 'exact', username: 'ExactMod' }),
    otherMod: installSession(setup, { id: 'other', username: 'OtherRoomMod', serverCode: 'XYZ789' }),
    member: installSession(setup, { id: 'member', username: 'Member' }),
    admin: installSession(setup, { id: 'admin', username: 'Admin' }),
    timedOutOwner: installSession(setup, { id: 'timeout', username: 'TimedOutOwner' }),
    bannedAdmin: installSession(setup, { id: 'banned', username: 'BannedAdmin', role: 'admin' })
  };
}

async function details(socket, payload) {
  const ack = acknowledge();
  await socket.trigger('get_room_details', payload, ack.callback);
  return ack.value();
}

async function update(socket, payload) {
  const ack = acknowledge();
  await socket.trigger('update_room_details', payload, ack.callback);
  return ack.value();
}

async function updateNotification(socket, payload) {
  const ack = acknowledge();
  await socket.trigger('update_room_notification', payload, ack.callback);
  return ack.value();
}

async function markRoomRead(socket, payload) {
  assert.equal(typeof socket.handlers.get('mark_room_read'), 'function', 'mark_room_read handler is registered');
  const ack = acknowledge();
  await socket.trigger('mark_room_read', payload, ack.callback);
  return ack.value();
}

test('room details are readable by fresh authorized readers and denied after a ban', async () => {
  const setup = createFixture();
  assert.deepEqual(await details(setup.member, { serverCode: ' abc123 ' }), {
    success: true, serverCode: 'ABC123', description: '', rules: '', metadataVersion: 0, canEdit: false
  });
  setup.RoomRestrictionModel.rows.push(restriction('ABC123', 'Member', { bannedAt: new Date() }));
  assert.deepEqual(await details(setup.member, { serverCode: 'ABC123' }), { error: 'Permission denied.' });
});

test('private owner and global admin edit private metadata while room moderators cannot', async () => {
  const setup = createFixture();
  assert.deepEqual(await update(setup.exactMod, { serverCode: 'ABC123', description: 'no', rules: '' }), { error: 'Permission denied.' });
  assert.deepEqual(await update(setup.otherMod, { serverCode: 'ABC123', description: 'no', rules: '' }), { error: 'Permission denied.' });
  assert.equal((await update(setup.owner, { serverCode: 'ABC123', description: 'owner', rules: 'rules' })).success, true);
  assert.equal((await update(setup.admin, { serverCode: 'ABC123', description: 'admin', rules: 'rules' })).metadataVersion, 2);
});

test('only global admins edit Global metadata and active timeouts deny mutations', async () => {
  const setup = createFixture();
  assert.deepEqual(await update(setup.owner, { serverCode: 'global', description: 'no', rules: '' }), { error: 'Permission denied.' });
  assert.equal((await update(setup.admin, { serverCode: 'global', description: 'yes', rules: '' })).success, true);
  setup.UserModel.rows.find(row => row.username === 'TimedOutOwner').servers.push('ABC123');
  setup.ChatServerModel.rows.find(row => row.code === 'ABC123').owner = 'TimedOutOwner';
  assert.deepEqual(await update(setup.timedOutOwner, { serverCode: 'ABC123', description: 'no', rules: '' }), { error: 'Permission denied.' });
});

test('room detail bounds normalization versions and duplicate writes are exact', async () => {
  const setup = createFixture();
  const description = `  \uff21${'d'.repeat(499)}  `;
  const rules = `  ${'r'.repeat(2000)}  `;
  const first = await update(setup.owner, { serverCode: ' abc123 ', description, rules });
  assert.deepEqual(first, { success: true, serverCode: 'ABC123', description: `A${'d'.repeat(499)}`, rules: 'r'.repeat(2000), metadataVersion: 1, canEdit: true });
  const outboundBefore = setup.member.outbound.length;
  const auditsBefore = setup.ModerationAuditModel.rows.length;
  assert.deepEqual(await update(setup.owner, { serverCode: 'ABC123', description: first.description, rules: first.rules }), first);
  assert.equal(setup.member.outbound.length, outboundBefore);
  assert.equal(setup.ModerationAuditModel.rows.length, auditsBefore);
  assert.deepEqual(await update(setup.owner, { serverCode: 'ABC123', description: 'd'.repeat(501), rules: '' }), { error: 'Invalid input format.' });
  assert.deepEqual(await update(setup.owner, { serverCode: 'ABC123', description: '', rules: 'r'.repeat(2001) }), { error: 'Invalid input format.' });
});

test('legacy missing metadataVersion compares as zero and first mutation persists one', async () => {
  const setup = createFixture({ legacy: true });
  const result = await update(setup.owner, { serverCode: 'ABC123', description: 'first', rules: 'version' });
  assert.equal(result.metadataVersion, 1);
  assert.equal(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').metadataVersion, 1);
});

test('metadata events omit stale banned sessions and acknowledgements use canonical rooms', async () => {
  const setup = createFixture();
  setup.UserModel.rows.find(row => row.username === 'Admin').servers = ['global'];
  const unrelatedAdmin = installSession(setup, { id: 'ghost', username: 'Admin', role: 'admin', serverCode: 'XYZ789' });
  const result = await update(setup.owner, { serverCode: ' abc123 ', description: 'changed', rules: 'rules' });
  assert.equal(result.serverCode, 'ABC123');
  assert.equal(setup.member.outbound.filter(item => item.event === 'room_details_updated').length, 1);
  assert.equal(setup.bannedAdmin.outbound.filter(item => item.event === 'room_details_updated').length, 0);
  assert.equal(unrelatedAdmin.outbound.filter(item => item.event === 'room_details_updated').length, 0);
  assert.equal(setup.admin.outbound.filter(item => item.event === 'room_details_updated').length, 1);
});

test('a lost metadata compare-and-set returns a reload error without audit or event', async () => {
  const setup = createFixture();
  setup.ChatServerModel.findOneAndUpdate = async () => null;
  assert.deepEqual(await update(setup.owner, { serverCode: 'ABC123', description: 'changed', rules: 'rules' }), {
    error: 'Room details changed. Reload and try again.'
  });
  assert.equal(setup.ModerationAuditModel.rows.length, 0);
  assert.equal(setup.member.outbound.filter(item => item.event === 'room_details_updated').length, 0);
});

test('metadata audits contain lengths and changed flags but never room text', async () => {
  const logs = [];
  const setup = createFixture({ logger: { error(...args) { logs.push(args); } } });
  const secretDescription = 'PRIVATE-DESCRIPTION-DO-NOT-LOG';
  const secretRules = 'PRIVATE-RULES-DO-NOT-LOG';
  const result = await update(setup.owner, { serverCode: 'ABC123', description: secretDescription, rules: secretRules });
  assert.equal(result.description, secretDescription);
  assert.deepEqual(setup.ModerationAuditModel.rows[0].metadata, {
    descriptionChanged: true, rulesChanged: true, descriptionLength: secretDescription.length, rulesLength: secretRules.length
  });
  const authorizedDelivery = JSON.stringify([
    result,
    setup.member.outbound.filter(item => item.event === 'room_details_updated')
  ]);
  assert.equal(authorizedDelivery.includes(secretDescription), true);
  assert.equal(authorizedDelivery.includes(secretRules), true);
  const deniedDelivery = JSON.stringify([
    setup.ModerationAuditModel.rows, logs,
    setup.bannedAdmin.outbound.filter(item => item.event === 'room_details_updated')
  ]);
  assert.equal(deniedDelivery.includes(secretDescription), false);
  assert.equal(deniedDelivery.includes(secretRules), false);
});

test('complete metadata permission matrix uses fresh users rooms and restrictions', async () => {
  const setup = createFixture();
  const denied = [setup.exactMod, setup.otherMod, setup.member, setup.timedOutOwner, setup.bannedAdmin];
  for (const socket of denied) {
    assert.deepEqual(await update(socket, { serverCode: 'ABC123', description: 'no', rules: '' }), { error: 'Permission denied.' });
  }
  assert.equal((await update(setup.owner, { serverCode: 'ABC123', description: 'owner', rules: '' })).success, true);
  assert.equal((await update(setup.admin, { serverCode: 'ABC123', description: 'admin', rules: '' })).success, true);
});

test('legacy room state initializes at the newest exact-room message under account then room locks', async () => {
  const setup = createFixture();
  const timestamp = new Date('2026-08-10T12:00:00.000Z');
  setup.MessageModel.rows.push(
    { _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', timestamp },
    { _id: '507f1f77bcf86cd799439012', serverCode: 'ABC123', timestamp },
    { _id: '507f1f77bcf86cd799439099', serverCode: 'XYZ789', timestamp: new Date('2026-08-10T13:00:00.000Z') }
  );

  const result = await updateNotification(setup.member, { serverCode: 'ABC123', level: 'all' });

  assert.deepEqual(result, {
    serverCode: 'ABC123', usernameKey: 'member', notificationLevel: 'all',
    lastReadAt: timestamp, lastReadMessageId: '507f1f77bcf86cd799439012',
    unreadCount: 0, mentionCount: 0, version: 0, blockVersion: 0
  });
  assert.deepEqual(setup.RoomMemberStateModel.rows, [{
    _id: setup.RoomMemberStateModel.rows[0]._id,
    usernameKey: 'member', serverCode: 'ABC123', notificationLevel: 'all',
    lastReadAt: timestamp, lastReadMessageId: '507f1f77bcf86cd799439012', version: 0
  }]);
});

test('legacy Global cursor initialization includes missing and null serverCode messages', async () => {
  const setup = createFixture();
  const newestAt = new Date('2026-08-10T12:02:00.000Z');
  setup.MessageModel.rows.push(
    { _id: '507f1f77bcf86cd799439021', serverCode: 'global', timestamp: new Date('2026-08-10T12:00:00.000Z') },
    { _id: '507f1f77bcf86cd799439022', timestamp: new Date('2026-08-10T12:01:00.000Z') },
    { _id: '507f1f77bcf86cd799439023', serverCode: null, timestamp: newestAt },
    { _id: '507f1f77bcf86cd799439099', serverCode: 'ABC123', timestamp: new Date('2026-08-10T13:00:00.000Z') }
  );

  const result = await updateNotification(setup.member, { serverCode: 'global', level: 'all' });

  assert.equal(result.version, 0);
  assert.equal(result.lastReadAt.getTime(), newestAt.getTime());
  assert.equal(result.lastReadMessageId, '507f1f77bcf86cd799439023');
});

test('notification updates allow timed-out readers deny banned readers and validate exact levels', async () => {
  const setup = createFixture();

  assert.deepEqual(await updateNotification(setup.timedOutOwner, {
    serverCode: 'ABC123', level: 'mentions'
  }), {
    serverCode: 'ABC123', usernameKey: 'timedoutowner', notificationLevel: 'mentions',
    lastReadAt: null, lastReadMessageId: null, unreadCount: 0, mentionCount: 0,
    version: 1, blockVersion: 0
  });
  assert.deepEqual(await updateNotification(setup.bannedAdmin, {
    serverCode: 'ABC123', level: 'none'
  }), { error: 'Permission denied.' });

  const rowsBefore = setup.RoomMemberStateModel.rows.length;
  for (const level of ['ALL', 'mentions ', '', null, undefined]) {
    assert.deepEqual(await updateNotification(setup.member, { serverCode: 'ABC123', level }), {
      error: 'Invalid input format.'
    });
  }
  assert.equal(setup.RoomMemberStateModel.rows.length, rowsBefore);
});

test('nonmember global admin cannot persist notification state or receive notification events', async () => {
  const setup = createFixture();
  setup.UserModel.rows.find(row => row.username === 'Admin').servers = ['global'];
  setup.admin.joinedServers = ['global'];
  setup.onlineUsersMap.get(setup.admin.id).joinedServers = ['global'];

  assert.deepEqual(await updateNotification(setup.admin, {
    serverCode: 'ABC123', level: 'none'
  }), { error: 'Permission denied.' });
  assert.deepEqual(setup.RoomMemberStateModel.rows, []);
  assert.deepEqual(setup.admin.outbound.filter(item => item.event === 'room_notification_updated'), []);
});

test('nonmember global admin switch returns null personal state and attention without persistence', async () => {
  const setup = createFixture();
  setup.UserModel.rows.find(row => row.username === 'Admin').servers = ['global'];
  Object.assign(setup.admin, {
    serverCode: 'global', joinedServers: ['global'], bannedRooms: []
  });
  setup.admin.joinedRooms.delete('ABC123');
  setup.admin.joinedRooms.add('global');
  Object.assign(setup.onlineUsersMap.get(setup.admin.id), {
    serverCode: 'global', joinedServers: ['global'], bannedRooms: []
  });
  const ack = acknowledge();

  await setup.admin.trigger('switch_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), {
    serverCode: 'ABC123', history: [], roomRole: 'user',
    restriction: { banned: false, timedOut: false, timeoutUntil: null },
    details: { description: '', rules: '', metadataVersion: 0, canEdit: true },
    notification: null,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 0, blockVersion: 0 },
    attention: null
  });
  assert.deepEqual(setup.RoomMemberStateModel.rows, []);
  assert.deepEqual(setup.admin.outbound.filter(item => item.event === 'room_notification_updated'), []);
});

test('notification and cursor mutations share one version and events carry complete state', async () => {
  const setup = createFixture();
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  setup.RoomMemberStateModel.rows.push({
    _id: '507f1f77bcf86cd799439031', usernameKey: 'member', serverCode: 'ABC123',
    notificationLevel: 'all', lastReadAt: cursorAt,
    lastReadMessageId: '507f1f77bcf86cd799439032', version: 7
  });

  const result = await updateNotification(setup.member, { serverCode: 'ABC123', level: 'none' });

  assert.deepEqual(result, {
    serverCode: 'ABC123', usernameKey: 'member', notificationLevel: 'none',
    lastReadAt: cursorAt, lastReadMessageId: '507f1f77bcf86cd799439032',
    unreadCount: 0, mentionCount: 0, version: 8, blockVersion: 0
  });
  assert.deepEqual(setup.member.outbound.filter(item => item.event === 'room_notification_updated'), [{
    target: 'self', event: 'room_notification_updated', payload: result
  }]);
});

test('duplicate notification writes are idempotent and synchronize every account session', async () => {
  const setup = createFixture();
  setup.UserModel.rows.push(user('Alice'), user('Bob'));
  const aliceRoom = installSession(setup, { id: 'alice-room', username: 'Alice' });
  const aliceOther = installSession(setup, {
    id: 'alice-other', username: 'ALICE', serverCode: 'global', joinedServers: ['global', 'ABC123']
  });
  const bob = installSession(setup, { id: 'bob', username: 'Bob' });

  const first = await updateNotification(aliceRoom, { serverCode: 'ABC123', level: 'none' });
  const second = await updateNotification(aliceRoom, { serverCode: 'ABC123', level: 'none' });

  assert.deepEqual(second, first);
  assert.equal(first.version, 1);
  for (const live of [aliceRoom, aliceOther]) {
    assert.deepEqual(live.outbound.filter(item => item.event === 'room_notification_updated'), [{
      target: 'self', event: 'room_notification_updated', payload: first
    }]);
  }
  assert.deepEqual(bob.outbound.filter(item => item.event === 'room_notification_updated'), []);
});

test('mark read allows active timeout denies active ban and synchronizes all account sessions', async () => {
  const setup = createFixture();
  const cursorAt = new Date('2026-08-10T12:00:00.000Z');
  const targetAt = new Date('2026-08-10T12:01:00.000Z');
  setup.MessageModel.rows.push(
    {
      _id: '507f1f77bcf86cd799439041', serverCode: 'ABC123', username: 'Member',
      authorKey: 'member', notificationMentions: [], timestamp: cursorAt
    },
    {
      _id: '507f1f77bcf86cd799439042', serverCode: 'ABC123', username: 'Member',
      authorKey: 'member', notificationMentions: ['timedoutowner'], timestamp: targetAt
    }
  );
  setup.RoomMemberStateModel.rows.push({
    _id: '507f1f77bcf86cd799439043', usernameKey: 'timedoutowner', serverCode: 'ABC123',
    notificationLevel: 'mentions', lastReadAt: cursorAt,
    lastReadMessageId: '507f1f77bcf86cd799439041', version: 4
  });
  const secondSession = installSession(setup, {
    id: 'timeout-second', username: 'TIMEDOUTOWNER', serverCode: 'global',
    joinedServers: ['global', 'ABC123']
  });
  assert.equal(typeof setup.timedOutOwner.handlers.get('mark_room_read'), 'function', 'mark_room_read handler is registered');
  let observed;
  await setup.timedOutOwner.trigger('mark_room_read', {
    serverCode: 'ABC123', messageId: '507f1f77bcf86cd799439042'
  }, result => {
    observed = {
      result,
      first: setup.timedOutOwner.outbound.filter(item => item.event === 'room_read_updated'),
      second: secondSession.outbound.filter(item => item.event === 'room_read_updated')
    };
  });

  assert.equal(observed.result.version, 5);
  assert.equal(observed.result.lastReadAt.getTime(), targetAt.getTime());
  assert.equal(observed.result.lastReadMessageId, '507f1f77bcf86cd799439042');
  assert.equal(observed.result.unreadCount, 0);
  assert.equal(observed.result.mentionCount, 0);
  assert.deepEqual(observed.first[0].payload, observed.result);
  assert.deepEqual(observed.second[0].payload, observed.result);
  assert.deepEqual(await markRoomRead(setup.bannedAdmin, {
    serverCode: 'ABC123', messageId: '507f1f77bcf86cd799439042'
  }), { error: 'Permission denied.' });
});
