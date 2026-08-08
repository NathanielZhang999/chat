# Room-Scoped Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure, room-scoped kick, timeout, ban/unban, reports, audit history, and lightweight AutoMod while preserving the existing three-file production application.

**Architecture:** Keep all runtime code in `chat.html`, `backend/server.js`, and `backend/package.json`. Add durable MongoDB moderation records and authoritative Socket.IO handlers in the existing backend, then expose only room-safe state and moderator-only data to the single-file client. Serialize cross-account mutations in normalized account order before taking the room lock, and re-read users, room, and restrictions inside that critical section before changing persistence or live sessions.

**Tech Stack:** Node.js, Express, Socket.IO, Mongoose/MongoDB Atlas, browser-native HTML/CSS/JavaScript, Node's built-in test runner.

## Global Constraints

- Keep the production application at exactly three files: `chat.html`, `backend/server.js`, and `backend/package.json`; test and documentation files may be added.
- Add no runtime dependency.
- The current Render deployment runs one Node backend process; in-memory account/room locks and repeat/report windows rely on that single-process topology. Horizontal scaling requires a distributed lock/rate store before adding a second backend instance.
- Preserve the pre-feature deployed application at Git tag `backup/pre-public-ready-features-2026-08-08` (`857e2f1`).
- Global Chat permits only `timeout`, `clear_timeout`, `ban`, and `unban`; it never permits `kick`.
- Private rooms permit `kick`, `timeout`, `clear_timeout`, `ban`, and `unban`.
- A room moderator may moderate only the exact private room whose current `moderators` array contains that moderator.
- A global admin may moderate Global Chat and every private room.
- A room moderator cannot moderate a current room moderator or global admin; a global admin cannot moderate another global admin.
- The protected `NYZhang1` account and the `System` identity cannot be restricted.
- A room creator has moderation authority only while present in that room's current `moderators` array.
- Timeout durations are exactly 10 minutes, 1 hour, 24 hours, or 7 days.
- Timeouts block sending, editing, reacting, and typing, but allow reading, searching, loading older messages, and deleting the user's own messages.
- Private-room kick removes membership and moderator status but does not block a future invite-code rejoin.
- Private-room ban removes membership and moderator status, evicts every live session, and blocks room access until unbanned.
- Unban removes only the ban; it does not restore membership or moderator status.
- A Global Chat ban does not disable the account: login selects an accessible private room, or an authenticated lobby when none exists.
- Report contents, restriction reasons, and audit records must never be broadcast to ordinary room members.
- Use strict input bounds and generic client errors; log unexpected errors without raw message, reason, password, or attachment content.
- Preserve lock order: identity allocation -> normalized account lock(s) -> room lock. Never acquire an account lock from inside a room lock.
- Every feature and bug fix follows RED -> GREEN -> refactor, with the failing test observed before production code changes.

## File Map

- Modify `backend/server.js`: schemas, indexes, policy helpers, ordered account locks, restriction checks, moderation/report/audit/AutoMod handlers, session reconciliation, exports.
- Create `backend/test/moderation.test.js`: pure policy, real-handler authorization, restriction, privacy, AutoMod, and concurrency regressions.
- Modify `backend/test/support/fakes.js`: query chaining, multi-socket transport inspection, and fake model helpers required by moderation tests.
- Modify `backend/test/room-lifecycle.test.js`: login, join, switch, eviction, and fallback regressions that cross existing room lifecycle behavior.
- Modify `backend/test/message-actions.test.js`: timeout/ban enforcement on message mutation paths.
- Modify `chat.html`: moderation context actions, reason/duration confirmation, moderator center, lobby state, restriction events, safe DOM rendering.
- Modify `backend/test/client-smoke.test.js`: client helper, event wiring, conditional action, and text-safety regressions.

---

### Task 1: Moderation Data Model, Validation, Authority, and Ordered Locks

**Files:**
- Modify: `backend/server.js:1-310,1494-1519`
- Modify: `backend/test/support/fakes.js`
- Create: `backend/test/moderation.test.js`

**Interfaces:**
- Consumes: existing `normalizeUsername(value)`, `normalizeServerCode(value)`, `withAccountTransitionLock(username, operation)`, and Mongoose connection.
- Produces: `RoomRestriction`, `ModerationAudit`, `ModerationReport`; `MODERATION_DURATIONS`; `normalizeModerationAction(value)`; `normalizeModerationReason(value, maxLength)`; `normalizeAutoModSettings(value)`; `normalizeAccountKey(value)`; `withAccountTransitionLocks(usernames, operation)`; `canModerateTarget({ serverCode, action, actorUser, targetUser, room })`; `activeRestrictionState(restriction, now)`; `rejectAuditMutation(next)`.
- Produces: `findUserByUsername(UserModel, value)`, which normalizes input, performs the existing escaped anchored case-insensitive lookup, and returns the canonical stored user document. Canonical `user.username` is used in membership, moderator, report, and audit fields; only restriction keys and lock keys use lowercase normalized usernames.
- Produces test fixtures in `moderation.test.js`: `VALID_MESSAGE_ID = '507f1f77bcf86cd799439011'`; `userDocument(overrides)` returns a saveable canonical user with defaults `{ username: 'Alice', displayName: 'Alice', password: 'hash', role: 'user', servers: ['global'] }`; `roomDocument(code, overrides)` returns a saveable room with defaults `{ code, name: code === 'global' ? 'Global Chat' : code, owner: 'Owner', moderators: [], autoMod: { blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30 } }`; `restrictionDocument(serverCode, username, overrides)` returns a saveable normalized restriction; `registerWithModels(seed)` returns `{ socket, ioInstance, onlineUsersMap, UserModel, ChatServerModel, MessageModel, RoomRestrictionModel, ModerationAuditModel, ModerationReportModel }` whose array-backed fake methods mirror the Mongoose calls used by handlers.

- [ ] **Step 1: Add failing unit tests for input policy, action matrix, hierarchy, and lock ordering**

Add table-driven tests using these exact cases:

```js
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
```

- [ ] **Step 2: Run the focused tests and record RED**

Run: `cd backend && node --test --test-name-pattern='moderation inputs|moderation authority|multiple account locks|restriction state|canonical user lookup|audit mutation' test/moderation.test.js`

Expected: FAIL because the new exports and model policy do not exist.

- [ ] **Step 3: Add bounded constants, pure policy helpers, and sorted recursive account locking**

Implement these exact public shapes near the existing normalizers and locks:

```js
const MODERATION_ACTIONS = new Set(['kick', 'timeout', 'clear_timeout', 'ban', 'unban']);
const MODERATION_DURATIONS = Object.freeze({
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
});
const PROTECTED_USERNAMES = new Set(['nyzhang1', 'system']);

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

async function findUserByUsername(UserModel, value) {
  const username = normalizeUsername(value);
  if (!username) return null;
  const escaped = escapeRegExp(username);
  return UserModel.findOne({ username: { $regex: new RegExp(`^${escaped}$`, 'i') } });
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
  const actorKey = normalizeAccountKey(actorUser.username);
  const targetKey = normalizeAccountKey(targetUser.username);
  if (!actorKey || !targetKey || actorKey === targetKey || PROTECTED_USERNAMES.has(targetKey)) return false;
  if (serverCode === 'global' && action === 'kick') return false;
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
```

Implement `normalizeAutoModSettings` with these exact limits: at most 50 NFKC/case-folded unique keywords of 1-40 characters, `mentionLimit` integer 1-20, `repeatLimit` integer 2-10, and `repeatWindowSeconds` integer 5-300. Return `null` for malformed input rather than partially accepting it.

- [ ] **Step 4: Add durable schemas and indexes**

Extend `ChatServerSchema` with:

```js
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
```

Add these models in `backend/server.js`:

```js
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
```

Make `ModerationAudit` write-once at the model layer with `function rejectAuditMutation(next) { const error = new Error('ModerationAudit is append-only.'); if (typeof next === 'function') return next(error); throw error; }`. Register query middleware that rejects `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`, `deleteOne`, `deleteMany`, and `findOneAndDelete`; register document middleware that rejects `save()` when `!this.isNew` and document deletion. Export the hook for direct unit testing and add a source contract asserting every listed mutation operation is registered. Production code may call only `ModerationAuditModel.create`.

Instantiate all three with `mongoose.model`, add them as injectable defaults to `createConnectionHandler`, and export the models and pure helpers for tests. Extend `queryResult` in `backend/test/support/fakes.js` so `.skip()` and `.select()` remain chainable without changing current test behavior. Add an array-backed `createMemoryModel(initialRows)` test utility with `rows`, thenable `find`/`findOne`, `findById`, `create`, `findOneAndUpdate`, `updateOne`, and `countDocuments`; matching must support equality, `$in`, `$or`, `$lt`, `$gt`, regex, and null values used in this plan. Returned documents expose `save()` and `markModified()` and persist mutations back to `rows`. Implement the four test fixture factories from the Interfaces block using this utility; later task implementers must extend its matcher only when a newly observed RED test needs another concrete operator.

- [ ] **Step 5: Run focused and existing tests GREEN**

Run:

```bash
cd backend
node test/moderation.test.js
npm test
```

Expected: moderation unit tests pass and all four existing suites remain green.

- [ ] **Step 6: Commit Task 1**

```bash
git add -- backend/server.js backend/test/support/fakes.js backend/test/moderation.test.js
git commit -m "feat: add moderation policy and data models"
```

---

### Task 2: Authoritative Restriction Enforcement and Safe Room Selection

**Files:**
- Modify: `backend/server.js:415-1460`
- Modify: `backend/test/room-lifecycle.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/moderation.test.js`

**Interfaces:**
- Consumes: injected `RoomRestrictionModel`, Task 1 policy helpers and account locks.
- Produces: `getActiveRoomRestriction(RoomRestrictionModel, serverCode, username, now)`; `chooseAccessibleRoom({ user, rooms, restrictions })`; `loadRoomAccessState({ UserModel, ChatServerModel, RoomRestrictionModel, username, serverCode, now })`; login result fields `defaultServerCode`, `restriction`, and `bannedRooms`; switch result field `restriction`.
- Produces test fixtures in the touched test files: `authenticatedRoomSocket({ joinedServers, serverCode, username })` wraps `registerWithModels` and publishes one authenticated live session; `authenticatedLobbySocket({ username, bannedRooms })` publishes an authenticated map entry with `serverCode: null` and no transport rooms; `timedOutAuthenticatedSocket(serverCode, username)` adds an active restriction plus a saveable owned message and returns it as `message`.

- [ ] **Step 1: Add failing login, join, switch, interaction, and stale-session tests**

Add real-handler tests with these exact assertions:

```js
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
```

Also add two deferred race regressions:

- `join_server` begins with a stale unbanned snapshot, a ban commits before the account/room critical section, and join returns `Permission denied.` without membership publication.
- `chat_message` begins with a stale socket, a timeout commits before the room critical section, and no message is saved or emitted.
- Successful login and switch into an actively timed-out room return `{ banned: false, timedOut: true, timeoutUntil }` without returning actor or reason metadata.

- [ ] **Step 2: Run the focused tests and record RED**

Run:

```bash
cd backend
node --test --test-name-pattern='global-banned login|Global presence|room ban blocks|mixed-case ban|global-banned lobby|timeout blocks|ban commits|timeout commits' test/room-lifecycle.test.js test/message-actions.test.js test/moderation.test.js
```

Expected: FAIL because room restrictions are not yet used by access or message paths.

- [ ] **Step 3: Add authoritative restriction and fallback helpers**

Implement access as a structured decision, not a socket-only boolean:

```js
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
```

`loadRoomAccessState` must re-read the canonical user and room and active restriction, then return:

```js
const memberships = user && Array.isArray(user.servers) ? user.servers : [];
return {
  allowed: Boolean(user && room) && !restriction.banned &&
    (serverCode === 'global' || user.role === 'admin' || memberships.includes(serverCode)),
  user, room, restriction
};
```

Global admin membership bypass does not bypass a stored ban, although the hierarchy rules prevent ordinary users from creating such a ban.

- [ ] **Step 4: Enforce restrictions at every entry and mutation point**

Change login to load all restrictions for the normalized username, choose `defaultServerCode`, join only that transport room when non-null, and return the chosen code. Filter `joinedServers` only for deleted rooms; keep banned private-room membership out of the response if legacy data still contains it. Return and store a presentation-only `bannedRooms` array on each live socket and `onlineUsersMap` session so presence rendering can omit a globally banned account from Global Chat. Authorization still comes from fresh restriction rows, never this cache. Normalize malformed legacy `user.servers` to `['global']` before any `.includes` call.

Inside account -> room critical sections, re-check active bans before `join_server` and `switch_server`; wrap the switch operation by passing its current room-lock callback through `withAccountTransitionLock(socket.username, operation)` before calling `withRoomMutationLock(serverCode, operation)` so it follows the documented order. Return the active non-sensitive `{ banned, timedOut, timeoutUntil }` restriction in successful login/switch responses. In `chat_message`, `edit_message`, `toggle_reaction`, and `typing`, re-read restriction state before persistence/emission and return silently on banned or timed-out state. In `delete_message`, `get_edit_history`, `get_deleted_message`, and history loading, reject an active ban but allow an active timeout. Update `broadcastOnlineUsers` to omit sessions whose presentation-only `bannedRooms` contains the requested room. Future pagination, search, pin, and announcement handlers must use the same fresh ban check.

For `typing`, replace the synchronous handler with an async handler wrapped in `try/catch`, call `withRoomMutationLock(socket.serverCode, operation)`, and perform the fresh restriction check inside `operation` before emitting to the room.

- [ ] **Step 5: Run focused, lifecycle, action, and full tests GREEN**

Run:

```bash
cd backend
node test/moderation.test.js
node test/room-lifecycle.test.js
node test/message-actions.test.js
npm test
```

Expected: all tests pass with no room-banned session joining or mutating that room.

- [ ] **Step 6: Commit Task 2**

```bash
git add -- backend/server.js backend/test/moderation.test.js backend/test/room-lifecycle.test.js backend/test/message-actions.test.js
git commit -m "feat: enforce room restrictions on live actions"
```

---

### Task 3: Kick, Timeout, Ban, Clear, and Unban Mutations

**Files:**
- Modify: `backend/server.js:415-1460`
- Modify: `backend/test/moderation.test.js`
- Modify: `backend/test/room-lifecycle.test.js`

**Interfaces:**
- Consumes: Task 1 policy/locks/models and Task 2 access/fallback helpers.
- Produces: Socket event `moderate_user({ serverCode, targetUser, action, duration, reason }, ack)`; direct events `room_access_updated` and `room_restriction_updated`; `applySessionAccessSnapshot({ live, session, joinedServers, bannedRooms, removedRoom, fallbackCode })`; private helper `reconcileRestrictedAccount({ username, removedRoom, fallbackCode, liveSockets, user, restrictions })`; `appendAuditReliably(entry)`.
- Produces test fixture `moderationScenario({ room, actor, action })`: it creates canonical actor/target accounts, Global plus `ABC123` and `XYZ789`, makes `actor: 'mod'` a moderator only in `ABC123`, makes `actor: 'mod-from-ABC123'` likewise, seeds an active ban for `unban` and an active timeout for `clear_timeout`, authenticates the actor socket in the requested room, and returns `{ socket, target, models, ioInstance, onlineUsersMap }`.

- [ ] **Step 1: Add failing action-matrix, hierarchy, unban, multi-session, and concurrency tests**

Use one table-driven authorization test:

```js
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
```

Add exact behavior tests:

- Private kick removes the room from persisted `User.servers`, pulls the target from `ChatServer.moderators`, updates two live sockets plus a map-only session before the first asynchronous `leave`, moves active sessions to the first permitted fallback, emits `room_access_updated`, writes one audit row, and creates no restriction row.
- Private ban does everything kick does and upserts `bannedAt`, `bannedBy`, and `banReason` under normalized `(serverCode, username)`.
- Global ban leaves private memberships intact, removes only Global transport access, and moves every active Global session to the same accessible private fallback or lobby.
- The shared reconciliation helper never inserts Global implicitly: a Global-ban test invokes the real helper with private fallback and with `null` fallback, then proves no matching live or map-only session joins Global.
- A globally banned lobby user can still join an unbanned private room or create a private room; reconciliation preserves `bannedRooms: ['global']` and never publishes Global presence.
- Timeout stores the exact expiry from `MODERATION_DURATIONS[duration]`, does not evict, and emits `room_restriction_updated` only to target sessions.
- Ban clears any timeout fields because the stronger restriction supersedes timeout. `clear_timeout` nulls only timeout fields; `unban` nulls only ban fields; neither restores membership or moderator status. A ban -> unban regression proves no stale timeout reappears.
- Private kick, timeout, and first-time ban require a current room member; timeout requires no active ban. Ban rejects an already-active ban, clear-timeout requires an active timeout, and unban requires an active ban. Every invalid state returns a generic error without revealing restriction details.
- A failed or rejected `leave`, `join`, or `disconnect` during forced eviction cannot leave a live socket with usable stale identity and room access; the socket is quarantined using the existing terminal fail-closed pattern.
- A deferred target leave/demotion racing a ban is serialized by `withAccountTransitionLocks([actor, target])`, re-reads canonical state, and cannot publish stale membership or moderator authority.
- A deferred actor room-demotion/global-demotion that wins the account lock makes the later moderation attempt fail; a target promotion to room moderator/global admin that wins the account lock protects the target.
- Ban racing switch, join, or message publication is serialized and leaves no forbidden transport membership or emitted message.
- A Global Chat timeout/ban blocks only Global Chat and does not block interaction in an accessible private room.

- [ ] **Step 2: Run focused tests and record RED**

Run: `cd backend && node --test --test-name-pattern='may timeout|may ban|may not kick|exact-room|Private kick|Private ban|Global ban|Timeout stores|clear_timeout|failed.*eviction|racing a ban' test/moderation.test.js test/room-lifecycle.test.js`

Expected: FAIL because `moderate_user` is not registered.

- [ ] **Step 3: Implement the locked authoritative handler**

Register `moderate_user` with `safeAck`. Normalize `serverCode`, `targetUser`, `action`, `reason`, and require `duration` only for `timeout`. Resolve the target once with `findUserByUsername` to obtain canonical casing, use normalized actor/target keys for locking, then re-read both canonical users inside the locks:

```js
const initialTarget = await findUserByUsername(UserModel, targetInput);
if (!initialTarget) return { error: 'Permission denied.' };
const canonicalTargetUsername = initialTarget.username;
return withAccountTransitionLocks([socket.username, canonicalTargetUsername], () =>
  withRoomMutationLock(serverCode, async () => {
    const actorUser = await findUserByUsername(UserModel, socket.username);
    const targetUser = await findUserByUsername(UserModel, canonicalTargetUsername);
    const room = await ChatServerModel.findOne({ code: serverCode });
    if (!canModerateTarget({ serverCode, action, actorUser, targetUser, room })) {
      return { error: 'Permission denied.' };
    }
    return applyModerationAction({ actorUser, targetUser, room, serverCode, action, duration, reason });
  })
);
```

`applyModerationAction` must use `RoomRestrictionModel.findOneAndUpdate` with `$set` and `{ upsert: true, new: true, setDefaultsOnInsert: true }` for ban/timeout, and `$set: { bannedAt: null, bannedBy: null, banReason: null }` or the equivalent timeout fields for unban/clear. Ban also sets `timeoutUntil`, `timeoutBy`, and `timeoutReason` to `null`. For kick/ban in private rooms, save target membership removal and pull the target's canonical username from `room.moderators` before any transport await. For Global ban, do not mutate `User.servers`.

Before changing state, derive the current restriction with `activeRestrictionState` and enforce: private kick/timeout/first-ban target membership, no timeout while banned, no duplicate active ban, active timeout for clear, and active ban for unban. These are server-side preconditions and must be rechecked inside the account(s) -> room critical section.

Create a correlation ID using `new mongoose.Types.ObjectId().toString()`. `appendAuditReliably(entry)` attempts `ModerationAuditModel.create(entry)` twice with that same unique correlation ID, treats duplicate-key code `11000` as success, and logs one redacted `moderation_audit_write` error only if both attempts fail. The moderation action remains enforced and receives a truthful `{ success: true }` acknowledgement even if the audit store is temporarily unavailable; target notifications still occur. Tests cover first-write-committed/response-lost, both-writes-fail, no duplicate row, no reason in logs, and retrying the client action returning a generic already-applied error rather than duplicating state. Append after durable domain writes and transport reconciliation, but before client-visible notifications. Include only a `transportSynchronized` boolean and safe room codes in metadata; never include message text, attachment data, passwords, IPs, or auth tokens.

- [ ] **Step 4: Reconcile every live and map-only session before transport awaits**

Replace the existing synchronizer's assumptions that Global must always be inserted and that every eviction moves to Global. The shared helper receives the already-authorized membership list and an explicit `fallbackCode` (`'global'`, a private code, or `null`) computed from fresh rooms/restrictions. Its exported pure in-memory step is used by both the moderation path and existing leave/delete membership paths, and immediately assigns all matching sockets and `onlineUsersMap` entries:

```js
live.joinedServers = [...authoritativeMemberships];
live.bannedRooms = [...activeBannedRooms];
if (session) session.joinedServers = [...authoritativeMemberships];
if (session) session.bannedRooms = [...activeBannedRooms];
if (activeRoom === removedRoom) {
  live.serverCode = fallbackCode;
  if (session) session.serverCode = fallbackCode;
}
```

Only after all in-memory identities are updated, perform best-effort `leave(removedRoom)` and optional `join(fallbackCode)`. On any partial transport failure, clear identity and memberships, delete the map entry, set the closure's terminal quarantine flag for the initiating socket when applicable, best-effort leave both rooms, and disconnect. Never rejoin a forbidden room during rollback. After transport settles, append the audit row with its synchronization result, then send direct and room-safe events.

Delete or parameterize every old `if (!authoritativeServers.includes('global')) authoritativeServers.unshift('global')`, `live.serverCode = 'global'`, and `live.join('global')` branch in the reconciliation/eviction path. Global remains a normal fallback only when `chooseAccessibleRoom` explicitly selected it.

Timeout, clear-timeout, ban, and unban all recompute `activeBannedRooms` and publish it to every target socket/map-only session. Kick/ban additionally evict when needed. Unban rebroadcasts presence for that room so an online account can reappear where access is again allowed. Update every existing leave, room deletion, admin-demotion, join, and create call site to pass an explicit fallback and preserve current bans.

Emit to each target session:

```js
live.emit('room_access_updated', {
  username: targetUser.username,
  joinedServers: [...authoritativeMemberships],
  serverCode: fallbackCode,
  bannedRooms: [...activeBannedRooms]
});
live.emit('room_restriction_updated', {
  serverCode,
  banned: restrictionState.banned,
  timedOut: restrictionState.timedOut,
  timeoutUntil: restrictionState.timeoutUntil,
  bannedRooms: [...activeBannedRooms]
});
```

Send ordinary room members only a generic `system_message` such as `A member was removed by moderation.`; do not include actor, target, reason, report, or audit data.

- [ ] **Step 5: Run focused, lifecycle, and full tests GREEN**

Run:

```bash
cd backend
node test/moderation.test.js
node test/room-lifecycle.test.js
npm test
```

Expected: all tests pass, including transport failure and deferred interleaving regressions.

- [ ] **Step 6: Commit Task 3**

```bash
git add -- backend/server.js backend/test/moderation.test.js backend/test/room-lifecycle.test.js
git commit -m "feat: add room-scoped moderation actions"
```

---

### Task 4: Private Reports, Restriction List, and Append-Only Audit APIs

**Files:**
- Modify: `backend/server.js:415-1460`
- Modify: `backend/test/moderation.test.js`

**Interfaces:**
- Consumes: Task 1 models/policy and exact-room authorization.
- Produces: `report_moderation_target({ serverCode, targetUser, messageId, reason })`; `list_moderation_reports({ serverCode, status, before, limit })`; `resolve_moderation_report({ serverCode, reportId, status, resolution })`; `list_room_restrictions({ serverCode, targetUser, before, limit })`; `get_moderation_audit({ serverCode, before, limit })`; `get_automod({ serverCode })`; direct event `moderation_queue_updated`.
- Produces test fixture `reportingScenario({ reporter, room, target })`: it creates reporter, target, one exact-room moderator, one other-room moderator, one ordinary member socket, and a room-scoped message authored by target; it returns each socket plus all injected memory models.

- [ ] **Step 1: Add failing report, privacy, pagination, and audit immutability tests**

Add handler tests proving:

```js
test('ordinary member can report only a target or message in an accessible room', async () => {
  const setup = reportingScenario({ reporter: 'Alice', room: 'ABC123', target: 'Bob' });
  const ack = acknowledge();
  await setup.socket.trigger('report_moderation_target', {
    serverCode: 'ABC123', targetUser: 'Bob', messageId: VALID_MESSAGE_ID,
    reason: 'repeated personal attacks'
  }, ack.callback);
  assert.equal(ack.value().success, true);
  assert.equal(setup.ModerationReportModel.rows.length, 1);
  assert.equal(setup.ioInstance.outbound.some(item => item.room === 'ABC123' && item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.memberSocket.outbound.some(item => item.event === 'moderation_queue_updated'), false);
  assert.equal(setup.modSocket.outbound.some(item => item.event === 'moderation_queue_updated'), true);
});
```

Also assert all of the following:

- Report target must exist; optional message must exist, belong to the same room, and be authored by target.
- Mixed-case target input resolves to the canonical stored username; restriction queries use the lowercase normalized key.
- Reason length is 1-300 after NFKC normalization.
- The partial unique index rejects concurrent duplicate open reports with the same canonical reporter/room/target/message across processes. Within the deployed single backend process, the reporter account lock serializes duplicate checking plus a maximum of 10 reports per rolling 24 hours.
- Only a global admin or exact-room moderator can list/resolve reports, list restrictions, read AutoMod settings, or read audit rows.
- A room moderator in `ABC123` receives no data from `XYZ789`; an ordinary member receives `Permission denied.` without row counts.
- Pagination uses `(createdAt, _id)` descending, clamps `limit` to 1-50, and returns `{ items, nextCursor }`.
- Resolution `status` accepts only `resolved` or `dismissed`, requires a separate 1-300 character `resolution`, stamps resolver/time, and appends a `resolve_report` audit row without updating existing audit rows.
- Restriction list accepts an optional normalized `targetUser` filter for context-menu state and otherwise returns active bans and timeouts with target, expiry, and created time; reasons remain visible only to authorized moderators.
- A stale socket with an active room ban cannot submit a report or use moderator report/restriction/audit/AutoMod reads, even if its cached membership or room role says otherwise.
- Deleting a private room deletes its restriction and report rows but retains append-only audit rows; a cleanup failure follows the existing generic room-deletion failure path.

- [ ] **Step 2: Run report/API tests and record RED**

Run: `cd backend && node --test --test-name-pattern='report|restriction list|audit|pagination' test/moderation.test.js`

Expected: FAIL because the five APIs do not exist.

- [ ] **Step 3: Implement shared moderator-only authorization and opaque cursor parsing**

Use this cursor wire format:

```js
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
```

For each moderator read/mutation, call `loadRoomAccessState` first, then authorize the freshly loaded actor as `actor.role === 'admin'` or `serverCode !== 'global' && isCurrentRoomModerator(room, actor.username)`. Active bans fail before moderator eligibility. Do not rely on `socket.roomRole` or cached online-user data.

- [ ] **Step 4: Implement report submission and moderator-only APIs**

Register every API with `safeAck` and generic failure messages. Resolve reporter and target with `findUserByUsername`, retain canonical casing in reports, and use normalized keys for locks/restrictions. `report_moderation_target` runs under the reporter account lock then room lock, validates fresh unbanned access with `loadRoomAccessState`, validates the optional message relationship, checks the rolling rate bound, and creates the report. Treat duplicate-key code `11000` as a generic duplicate error. The account lock makes count-plus-create atomic for the deployed single process, while the partial unique index closes same-report races across MongoDB clients. Fetch live sockets and direct-emit only to sockets whose freshly loaded account is an eligible, unbanned moderator. `get_automod({ serverCode })` uses the same moderator-only authorization and returns the room's current normalized AutoMod settings without changing them.

List queries must use this keyset condition when a cursor is supplied:

```js
{
  serverCode,
  $or: [
    { createdAt: { $lt: cursor.date } },
    { createdAt: cursor.date, _id: { $lt: cursor.id } }
  ]
}
```

Fetch `limit + 1`, return the first `limit`, and generate `nextCursor` only when the extra row exists. Project only explicit safe fields. `resolve_moderation_report` acquires actor account -> room, verifies the report belongs to that room and is still open, saves the resolution, calls `appendAuditReliably` with the resolution audit row, and direct-emits the queue update only to currently eligible moderators.

Extend `delete_server` cleanup to call `RoomRestrictionModel.deleteMany({ serverCode })` and `ModerationReportModel.deleteMany({ serverCode })`. Do not delete `ModerationAudit` rows.

- [ ] **Step 5: Run privacy, API, and full tests GREEN**

Run:

```bash
cd backend
node test/moderation.test.js
npm test
```

Expected: no room-wide or global emission contains report, restriction reason, or audit payload.

- [ ] **Step 6: Commit Task 4**

```bash
git add -- backend/server.js backend/test/moderation.test.js
git commit -m "feat: add private moderation reports and audit APIs"
```

---

### Task 5: Server-Side AutoMod and Moderator Configuration

**Files:**
- Modify: `backend/server.js:1-1460`
- Modify: `backend/test/moderation.test.js`
- Modify: `backend/test/message-actions.test.js`

**Interfaces:**
- Consumes: `ChatServer.autoMod`, Task 1 normalization/policy, `ModerationAuditModel`.
- Produces: `createAutoModTracker({ maxKeys, now })`; `evaluateAutoMod({ text, resolvedText, username, serverCode, role, settings, tracker, now })`; Socket event `update_automod`.

- [ ] **Step 1: Add failing normalization, keyword, mention, repeat, exemption, and bounds tests**

Add pure evaluator tests using exact outcomes:

```js
test('AutoMod normalizes Unicode keywords and never returns blocked content', () => {
  const tracker = createAutoModTracker({ maxKeys: 100, now: () => 1_000 });
  assert.deepEqual(evaluateAutoMod({
    text: 'That is ＢＡＤ', resolvedText: 'That is ＢＡＤ', username: 'Alice', serverCode: 'ABC123',
    role: 'user', settings: { blockedKeywords: ['bad'], mentionLimit: 5, repeatLimit: 3, repeatWindowSeconds: 30 },
    tracker, now: new Date(1_000)
  }), { allowed: false, rule: 'blocked_keyword' });
});

test('AutoMod mention limit applies to admins while keyword and repeat rules exempt admins', () => {
  const tracker = createAutoModTracker({ maxKeys: 100, now: () => 1_000 });
  const settings = { blockedKeywords: ['bad'], mentionLimit: 1, repeatLimit: 2, repeatWindowSeconds: 30 };
  assert.equal(evaluateAutoMod({ text: 'bad', resolvedText: 'bad', username: 'Admin', serverCode: 'global', role: 'admin', settings, tracker, now: new Date(1_000) }).allowed, true);
  assert.deepEqual(evaluateAutoMod({ text: '@a @b', resolvedText: '{{PING:a|A}} {{PING:b|B}}', username: 'Admin', serverCode: 'global', role: 'admin', settings, tracker, now: new Date(1_000) }), { allowed: false, rule: 'mention_limit' });
});
```

Add real-handler tests proving:

- Three identical normalized messages across two sockets for the same account/room block at `repeatLimit: 3`; a different room and different account do not share the counter.
- Expired repeat-window entries are pruned and the tracker never exceeds 10,000 account/room keys.
- Blocked send is neither persisted nor broadcast; sender receives only `message_blocked` with `{ rule: 'content_policy' }`; audit metadata stores rule name and a SHA-256 digest, never raw text.
- Blocked edit leaves original message/history unchanged and is not emitted.
- Exact-room moderator or global admin can update that room's settings; moderator of another room cannot; only global admin can update Global settings.

- [ ] **Step 2: Run AutoMod tests and record RED**

Run: `cd backend && node --test --test-name-pattern='AutoMod|identical normalized|Blocked send|Blocked edit|update.*settings' test/moderation.test.js test/message-actions.test.js`

Expected: FAIL because the tracker, evaluator, and settings handler do not exist.

- [ ] **Step 3: Implement the bounded evaluator and tracker**

Create `normalizedRawText` from the bounded, neutralized pre-resolution user text using `value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()`. Keyword matching and the repeated-message key use only `normalizedRawText`; resolver-generated `{{PING:...}}` syntax can neither trigger nor bypass a keyword. Mention counting uses only the post-resolution canonical text with `/\{\{PING:[^}|]{1,20}\|[^}]{1,30}\}\}/g`. The configured mention limit applies to every role. Skip keyword and repeat rules only when `role === 'admin'`. Add tests where a display name contains a blocked keyword and where raw text contains a keyword adjacent to an `@mention`, proving the representation boundary.

`createAutoModTracker` stores `Map<"room\\0normalizedUsername", Map<normalizedText, number[]>>`, using `normalizeAccountKey(username)` so two sockets and mixed-case sessions share the counter. It prunes timestamps older than the configured window on every check, deletes empty entries, and evicts the oldest outer key while size exceeds `maxKeys`. It returns `{ recordAndCheck(key, normalizedText, limit, windowMs), prune(windowMs), size() }`.

Use Node's built-in `crypto.createHash('sha256')` for the redacted digest written to audit metadata.

- [ ] **Step 4: Enforce AutoMod before persistence/broadcast and add settings updates**

In both `chat_message` and `edit_message`, inside the existing room lock and after fresh account/room/restriction authorization, evaluate the normalized raw text plus resolved text before calling `MessageModel.create` or `.save()`. On rejection:

```js
socket.emit('message_blocked', { rule: 'content_policy' });
await appendAuditReliably({
  correlationId: new mongoose.Types.ObjectId().toString(),
  action: 'automod_block', serverCode,
  actorUsername: socket.username, actorRole: currentUser.role,
  actorRoomRole: currentRoomRole, targetUsername: socket.username,
  targetRole: currentUser.role, targetRoomRole: currentRoomRole,
  reason: 'Automated content policy',
  metadata: { rule: result.rule, contentDigest }
});
return;
```

`update_automod` validates the full settings object, acquires actor account -> room, re-loads actor/room and its active restriction through `loadRoomAccessState`, applies exact-room configuration authority only when unbanned, saves `room.autoMod`, calls `appendAuditReliably` with an `update_automod` audit row containing only numeric limits and keyword count, and returns the normalized settings to the authorized caller.

- [ ] **Step 5: Run focused, action, and full tests GREEN**

Run:

```bash
cd backend
node test/moderation.test.js
node test/message-actions.test.js
npm test
```

Expected: blocked text never appears in saved rows, emits, logs, or audit reason/metadata.

- [ ] **Step 6: Commit Task 5**

```bash
git add -- backend/server.js backend/test/moderation.test.js backend/test/message-actions.test.js
git commit -m "feat: add bounded server-side automod"
```

---

### Task 6: Single-File Moderation UI, Unban Flow, and Lobby State

**Files:**
- Modify: `chat.html:1-1980`
- Modify: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: `moderate_user`, report/list/resolve/restriction/audit/get/update APIs; login/switch `restriction`, login `defaultServerCode` and `bannedRooms`; `room_access_updated`, `room_restriction_updated`, `moderation_queue_updated`, `message_blocked`.
- Produces: `ChatClientHelpers.moderationActionsFor(context)`; `ChatClientHelpers.normalizeModerationPrompt(input)`; `ChatClientHelpers.applyLobbyState(elements, active)`; moderation center DOM and safe event handlers.

- [ ] **Step 1: Add failing client helper and source-contract tests**

Add these exact pure helper tests to `backend/test/client-smoke.test.js`:

```js
test('client moderation menu matches global and exact private-room policy', () => {
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'global', actorRole: 'admin', actorRoomRole: 'user', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: false, targetIsTimedOut: false,
    targetUsername: 'Member', isSelf: false
  }), ['timeout', 'ban']);
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'ABC123', actorRole: 'user', actorRoomRole: 'mod', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: true, targetIsTimedOut: false,
    targetUsername: 'Member', isSelf: false
  }), ['unban']);
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'XYZ789', actorRole: 'user', actorRoomRole: 'user', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: false, targetIsTimedOut: false,
    targetUsername: 'Member', isSelf: false
  }), []);
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'global', actorRole: 'admin', actorRoomRole: 'user', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: false, targetIsTimedOut: false,
    targetUsername: 'NYZhang1', isSelf: false
  }), []);
});

test('moderation prompt requires bounded reason and timeout duration', () => {
  assert.deepEqual(client.normalizeModerationPrompt({ action: 'timeout', reason: ' spam ', duration: '1h' }), { action: 'timeout', reason: 'spam', duration: '1h' });
  assert.equal(client.normalizeModerationPrompt({ action: 'timeout', reason: '', duration: '1h' }), null);
  assert.equal(client.normalizeModerationPrompt({ action: 'timeout', reason: 'spam', duration: '2h' }), null);
});
```

Add source/DOM smoke assertions proving:

- The Global context menu has no Kick path.
- The private menu includes Kick, Timeout/Clear Timeout, Ban/Unban only when helper output permits it.
- Every accessible non-self user context menu includes Report User, and every non-self message action menu includes Report Message; neither action grants moderation authority.
- Text returned by reports, restrictions, and audit APIs is inserted with `textContent`, never `innerHTML`.
- The page registers all four direct event handlers and uses `defaultServerCode` after login instead of hard-coding Global.
- Lobby state disables compose, attachment, emoji, typing, and message actions while keeping join/create controls enabled.
- A Global-banned client stores `bannedRooms`, disables the Global rail icon, refuses a local Global switch, updates the rail on unban, and keeps private rooms usable.
- Login and every successful room switch apply the returned timeout state; an expiry timer re-enables compose at `timeoutUntil` without requiring reconnect, but only if the timer still belongs to the current room/restriction version.
- Unban remains reachable from the moderator-center restriction list even though a banned target is absent from the room roster; stale target-restriction callbacks cannot open an action menu after a room switch.
- Closing/reopening the moderation center clears previous room-sensitive rows before loading the current room.

- [ ] **Step 2: Run client tests and record RED**

Run: `cd backend && node --test --test-name-pattern='moderation menu|moderation prompt|Global context|private menu|reports.*textContent|direct event|defaultServerCode|Lobby state|banned client|moderation center|stale restriction' test/client-smoke.test.js`

Expected: FAIL because the helper and moderation UI do not exist.

- [ ] **Step 3: Add pure client helpers before wiring DOM behavior**

Add to the existing frozen `ChatClientHelpers` object:

```js
moderationActionsFor(context) {
  const targetKey = String(context && context.targetUsername || '').trim().toLowerCase();
  if (!context || context.isSelf || context.targetRole === 'admin' ||
      targetKey === 'nyzhang1' || targetKey === 'system') return [];
  const authorized = context.actorRole === 'admin' ||
    (context.serverCode !== 'global' && context.actorRoomRole === 'mod');
  if (!authorized || context.targetRoomRole === 'mod' && context.actorRole !== 'admin') return [];
  if (context.targetIsBanned) return ['unban'];
  const actions = [];
  if (context.serverCode !== 'global') actions.push('kick');
  actions.push(context.targetIsTimedOut ? 'clear_timeout' : 'timeout');
  actions.push('ban');
  return actions;
},
normalizeModerationPrompt(input) {
  const allowed = new Set(['kick', 'timeout', 'clear_timeout', 'ban', 'unban']);
  const durations = new Set(['10m', '1h', '24h', '7d']);
  if (!input || !allowed.has(input.action) || typeof input.reason !== 'string') return null;
  const reason = input.reason.normalize('NFKC').trim();
  if (!reason || reason.length > 200) return null;
  if (input.action === 'timeout' && !durations.has(input.duration)) return null;
  return { action: input.action, reason, duration: input.action === 'timeout' ? input.duration : undefined };
},
applyLobbyState(elements, active) {
  elements.messageInput.disabled = active;
  elements.sendButton.disabled = active;
  elements.attachmentButton.disabled = active;
  elements.emojiButton.disabled = active;
  elements.infoBar.textContent = active ? 'Lobby — join or create a room to chat' : elements.roomLabel;
}
```

- [ ] **Step 4: Build the moderator context actions and confirmation flow**

Replace broad `isRoomMod` menu logic with `moderationActionsFor` using the active room and target's current row. Before rendering moderator actions, request `list_room_restrictions({ serverCode: currentServerCode, targetUser: u.username, limit: 1 })`; ignore stale callbacks after a room switch. Each action opens one existing-style modal that visibly names the room, action, and target, requires a reason, and shows the duration selector only for timeout. On confirmation emit:

```js
socket.emit('moderate_user', {
  serverCode: currentServerCode,
  targetUser: selectedUser.username,
  action: normalized.action,
  duration: normalized.duration,
  reason: normalized.reason
}, response => {
  const result = response || { error: 'No response from server.' };
  if (result.error) showAppAlert('Moderation failed', result.error);
  else showAppAlert('Moderation applied', 'The room restriction was updated.');
});
```

Add Report User to every accessible non-self user menu and Report Message to every non-self message action menu. Both use a 1-300 character reason dialog and emit `report_moderation_target` with the active `serverCode`, target username, and optional message ID. The UI is only a convenience; backend authorization remains authoritative.

- [ ] **Step 5: Add a compact moderator center with reports, restrictions/unban, audit, and AutoMod tabs**

Show its entry button only for a global admin or exact-room moderator. On open, clear prior rows, capture the requested room code, and ignore callbacks if `currentServerCode` changed. Render every returned value through `document.createElement` plus `textContent`.

Reports tab: open/resolved filter, Resolve and Dismiss buttons with required resolution. Restrictions tab: active ban/timeout rows, Unban and Clear Timeout buttons using the same reason modal. Audit tab: keyset “Load more.” AutoMod tab: call `get_automod` on open, then populate a 50-line keyword textarea and numeric mention/repeat/window fields; validate and save the full object with `update_automod`.

- [ ] **Step 6: Wire restriction events and authenticated lobby behavior**

On login use:

```js
const initialCode = Object.prototype.hasOwnProperty.call(res, 'defaultServerCode')
  ? res.defaultServerCode : 'global';
if (initialCode) switchServer(initialCode);
else enterLobby();
```

Initialize `myBannedRooms = new Set(res.bannedRooms || [])` and apply `res.restriction`. `renderServers` marks matching icons disabled with `aria-disabled="true"`, and `switchServer(code)` returns before emitting when `myBannedRooms.has(code)`. `handleSwitchResult` applies `response.restriction` only after the existing switch coordinator accepts that response. Maintain one `restrictionExpiryTimer`; applying state clears the old timer, disables compose while `timedOut`, and schedules a re-enable at `timeoutUntil` guarded by captured room code plus a monotonically increasing restriction version. `enterLobby()` sets `currentServerCode = null`, clears message/user lists and typing state, calls `applyLobbyState({ messageInput: msgInput, sendButton: sendBtn, attachmentButton, emojiButton, infoBar, roomLabel: '' }, true)`, and leaves server rail plus join/create enabled. `room_access_updated` replaces `myBannedRooms` from `data.bannedRooms`, rerenders the rail, and enters lobby when `data.serverCode === null`; otherwise it switches only if the code differs. `room_restriction_updated` also refreshes `myBannedRooms`, updates the rail, enters lobby if the active room became banned, and applies timeout state only when `data.serverCode === currentServerCode`. `message_blocked` displays the generic alert `Your message was blocked by this room's content policy.` `moderation_queue_updated` refreshes only when the moderator center is open for that exact room.

- [ ] **Step 7: Run client, backend, syntax, and credential tests GREEN**

Run:

```bash
cd backend
node test/client-smoke.test.js
npm test
node --check server.js
node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('../chat.html','utf8');for(const m of h.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)){if(m[1].trim())new vm.Script(m[1]);}"
cd ..
git diff --check
rg -n "mongodb(\\+srv)?://|gho_[A-Za-z0-9]+|ADMIN_PASSWORD=|MONGO_URI=" chat.html backend docs --glob '!docs/superpowers/plans/2026-08-08-room-moderation.md'
```

Expected: all tests and syntax checks pass; the credential scan prints no live credential values.

- [ ] **Step 8: Commit Task 6**

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "feat: add single-file moderation controls"
```

---

### Task 7: Cross-Cutting Security Regression and Release Verification

**Files:**
- Modify if a regression exposes a defect: `backend/server.js`, `chat.html`, and the test file that reproduces it.
- Test: `backend/test/moderation.test.js`
- Test: `backend/test/room-lifecycle.test.js`
- Test: `backend/test/message-actions.test.js`
- Test: `backend/test/chat-security.test.js`
- Test: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: verified moderation feature branch ready for final review and local merge.

- [ ] **Step 1: Add a final real-handler regression matrix for the complete policy**

Add one test that executes this matrix through registered Socket.IO handlers, not pure helpers:

```js
const cases = [
  ['global', 'admin', 'user', 'timeout', true],
  ['global', 'admin', 'timed-out-user', 'clear_timeout', true],
  ['global', 'admin', 'user', 'ban', true],
  ['global', 'admin', 'user', 'unban', true],
  ['global', 'admin', 'user', 'kick', false],
  ['global', 'mod', 'user', 'timeout', false],
  ['ABC123', 'mod', 'user', 'kick', true],
  ['ABC123', 'mod', 'user', 'timeout', true],
  ['ABC123', 'mod', 'timed-out-user', 'clear_timeout', true],
  ['ABC123', 'mod', 'user', 'ban', true],
  ['ABC123', 'mod', 'user', 'unban', true],
  ['XYZ789', 'mod-from-ABC123', 'user', 'ban', false],
  ['ABC123', 'mod', 'mod', 'ban', false],
  ['ABC123', 'admin', 'admin', 'ban', false],
  ['ABC123', 'admin', 'NYZhang1', 'ban', false],
  ['ABC123', 'admin', 'System', 'timeout', false]
];
```

For each row assert callback success/error, expected persistence mutation, audit count, target-only events, and absence of sensitive room-wide events.

- [ ] **Step 2: Run the final new regression and observe RED only if it catches a real gap**

Run: `cd backend && node --test --test-name-pattern='complete moderation policy matrix' test/moderation.test.js`

Expected: PASS if Tasks 1-6 fully implement the specification. If it fails, preserve the failing test, identify the exact missing production behavior, and make the smallest correction under RED/GREEN.

- [ ] **Step 3: Run the complete verification suite from a clean process**

Run:

```bash
cd backend
npm test
node --check server.js
node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('../chat.html','utf8');for(const m of h.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)){if(m[1].trim())new vm.Script(m[1]);}"
cd ..
git diff --check
git status --short
```

Expected: four backend suites plus `moderation.test.js` pass; syntax and diff checks exit 0; only intentional files are modified or untracked. Root `node_modules/`, `package.json`, and `package-lock.json` remain unstaged.

- [ ] **Step 4: Request two-stage code review and resolve every confirmed finding**

Use a specification reviewer first, then a code-quality/security reviewer. For each confirmed finding, add or tighten a failing regression, run it RED, implement the minimal fix, and rerun focused plus full tests. Do not alter behavior merely to satisfy speculative feedback without reproducing the issue.

- [ ] **Step 5: Commit any final regression fixes**

If Step 4 changed files:

```bash
git add -- chat.html backend/server.js backend/test/moderation.test.js backend/test/room-lifecycle.test.js backend/test/message-actions.test.js backend/test/chat-security.test.js backend/test/client-smoke.test.js
git commit -m "fix: close moderation security edge cases"
```

If Step 4 made no changes, do not create an empty commit.

- [ ] **Step 6: Finish the development branch using the user's standing choice**

Use `superpowers:finishing-a-development-branch`, choose local merge into `main`, rerun the full verification suite on merged `main`, and leave pushing/deploying for an explicit final publication step. Do not push remote `main`; the Render deployment branch remains `deploy-chat`.
