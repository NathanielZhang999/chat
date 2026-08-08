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
  canModerateTarget,
  activeRestrictionState,
  rejectAuditMutation
} = require('../server');
const { FakeSocket, FakeIo, createMemoryModel, deferred } = require('./support/fakes');

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
  return {
    socket,
    ioInstance,
    onlineUsersMap: new Map(),
    UserModel: createMemoryModel(seed.users || []),
    ChatServerModel: createMemoryModel(seed.rooms || []),
    MessageModel: createMemoryModel(seed.messages || []),
    RoomRestrictionModel: createMemoryModel(seed.restrictions || []),
    ModerationAuditModel: createMemoryModel(seed.audits || []),
    ModerationReportModel: createMemoryModel(seed.reports || [])
  };
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

module.exports = { VALID_MESSAGE_ID, userDocument, roomDocument, restrictionDocument, registerWithModels };
