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
    MessageModel: createMemoryModel([]),
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
    ModerationAuditModel: createMemoryModel([])
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
