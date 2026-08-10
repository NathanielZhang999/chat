# Room Experience Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add synchronized unread/mention attention, bounded message pins, room descriptions/rules, per-room in-app notification preferences, and private global asymmetric blocking without changing the three-file production runtime.

**Architecture:** Keep MongoDB and `backend/server.js` authoritative for durable state, authorization, versioning, recipient-aware serialization, and account→room serialization. Keep pure version/coordinator/render policy helpers plus all accessible browser UI in `chat.html`; exercise backend behavior through injected in-memory models and the client through the existing VM-extracted `ChatClientHelpers` seam. Implement in six independently green stages: foundations, room details/notifications, pins, blocking/privacy, unread/mentions, then frontend policy and release gates.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, Express 4, Socket.IO 4, Mongoose 8, bcryptjs, plain inline HTML/CSS/JavaScript; no new dependency.

## Global Constraints

- Production runtime files remain exactly `backend/server.js`, `chat.html`, and unchanged `backend/package.json`; do not create another production JavaScript, CSS, HTML, data, migration, worker, service-worker, or configuration file.
- Do not change `backend/package.json`, either package lock, or dependencies. Run all commands from repository root `/home/natha/AI/chat`.
- The browser title remains exactly `Chat v1.3.2`.
- Preserve the current one-Node-process Render Free deployment with MongoDB persistence. No filesystem or timer state is authoritative.
- Keep the previously removed typing optimization, presence optimization, and history-rendering optimization removed. Do not add pagination, search, browser desktop notifications, push, a notification permission prompt, or a new sound.
- Preserve Global legacy history compatibility: reads use `{ $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] }`; every new Global message stores `serverCode: 'global'`.
- Lock order is identity allocation → normalized account lock(s), sorted for multiple accounts → room lock; never acquire in reverse. Every room mutation rechecks fresh `User`, `ChatServer`, and `RoomRestriction` state inside the room lock. Persisted bans override membership, ownership, moderation, and global-admin status.
- An active timeout denies metadata, pin, unpin, send, edit, reaction, typing, and deletion of another user's message; it permits reads, notification changes, read-cursor changes, and deletion of the actor's own message.
- Room metadata limits are 500 characters for `description` and 2,000 for `rules`. Pins are at most 20 per room. Blocks are at most 500 per normalized account. Notification levels are exactly `all`, `mentions`, and `none`.
- `metadataVersion`, `pinVersion`, account-room `version`, and account `blockVersion` are nonnegative integers. An accepted mutation increments its owning version atomically with its state; duplicate pin/unpin/block/unblock/read mutations are idempotent and do not manufacture a newer version.
- Legacy room documents with a missing `metadataVersion` or `pinVersion` are interpreted only as version `0`; their first compare-and-set predicate matches either missing or numeric zero, and `$inc` durably creates version `1`. Null, string, fractional, negative, or otherwise malformed stored versions fail closed.
- Client acceptance is scoped: metadata accepts only greater `metadataVersion` and blocks only greater `blockVersion`. Within one accepted block version, pins accept only greater `pinVersion`, and room notification/read state accepts only greater `version`, except equal byte-for-byte identical canonical state is idempotent. After a greater `blockVersion` is accepted, blocker-derived pin counts and room counts may authoritatively replace state at the same-or-greater owning version. Lower owning versions and unequal equal-version states within the same block version are ignored.
- Every feature callback validates its room/account generation token before inspecting even an error response. Every feature listener first checks that its captured socket is still the current socket. Socket replacement invalidates all feature coordinators and clears metadata, pin, block, room-state, attention, recent-activity-ID, and blocked-typing maps before any event version is considered.
- Normal history, live message, pin, room summary, reply, reaction, and blocked-message reveal payloads use explicit allowlists. Never emit Mongo internals, `history`, AutoMod settings, moderation internals, blocked content, or unrequested fields.
- Blocking is global, private, asymmetric, and never changes room membership, restrictions, moderation, presence, or the other account's state. The blocked account receives no block event or notice. Moderation/system notices and member/presence rows remain visible.
- Blocked-authored normal payloads are server-redacted before delivery. The placeholder may contain only message ID, canonical room, canonical author identity, timestamp, and `blocked: true`; it contains no text, attachment, reply, reactions, edit history, color, avatar, roles, or deletion content.
- A one-message reveal is allowed only after fresh room access and a fresh proof that the author remains blocked. It never changes the block, room cursor, unread, or mention state and omits history, internal fields, reaction identities, and reply content.
- Deleted messages retain the counting metadata needed for stable unread reconstruction (`serverCode`, immutable `authorKey`, immutable `notificationMentions`, `timestamp`, `_id`, and `deleted`). Ordinary safe serializers redact text, attachment, reply, reactions, and history. A later deletion never reduces unread or mention activity.
- Legacy messages without `authorKey` use `normalizeUsername(message.username)` then `normalizeAccountKey(legacyUsername)`; failure to normalize is fail-closed for author-dependent serialization/filtering. With a nonempty block list, a legacy reply without `authorKey` is omitted.
- New replies are derived from the exact-room stored target and contain only `{ id, authorKey, displayname, text }`. New messages store immutable normalized `authorKey` and immutable normalized `notificationMentions`; edits never change either field and never add unread/mention activity.
- Expected validation/authorization errors are generic and user-safe. Unexpected logs contain operation names and safe identifiers only—never message, attachment, description, rules, blocked-content, reply, password, token, or connection text.
- Metadata and pin mutations append moderation audits containing actor, room, action, timestamp, optional message ID, and only changed-field flags or description/rule lengths. Blocks, notification preferences, and read cursors are not audited.
- Preserve existing reduced-motion behavior. At widths at or below 700px, Room Info and Pins remain visible 44px controls and all other header actions move into one keyboard-operable 44px-target overflow menu that remains usable at 320px and 200% text zoom.
- Every task follows RED → GREEN → focused regression → diff review → scoped commit. Before each commit run `git diff --cached --exit-code -- backend/package.json package.json package-lock.json`; do not stage user-owned `node_modules/`, root `package.json`, root `package-lock.json`, or unrelated changes.
- The approved design baseline is commit `5aa022d`; whole-feature diff gates compare `5aa022d..HEAD` so all six stages are reviewed.

## File Map

- Modify `backend/server.js`: schemas/indexes, normalization, cursor and serializer helpers, model injection, access-aware delivery, feature socket handlers, delete/pin compensation, login/switch/join/restriction integration, and exported test interfaces.
- Modify `chat.html`: styles/markup, testable pure helpers, versioned feature state, socket wiring, sound/attention rules, dialogs/menus/focus, and responsive layout.
- Modify `backend/test/support/fakes.js`: Mongo-like comparisons, updates, projections, sessions, aggregate-free cursor queries, multi-socket emits, and deterministic model hooks needed by all new backend tests.
- Create `backend/test/room-experience-foundations.test.js`: schemas, indexes, normalizers, safe serializers, cursor helpers, and fakes.
- Create `backend/test/room-details-notifications.test.js`: metadata and notification policy, versions, multi-session state, lazy initialization, and cleanup.
- Create `backend/test/pins.test.js`: pin policy, bounds, recipient visibility, audits, edits/deletes, transaction and fallback races.
- Create `backend/test/blocking-privacy.test.js`: durable/private block behavior, session-cache linearization, payload redaction, reveal, live/history/reply/reaction/typing/pin filtering, reconnect, and concurrent login.
- Create `backend/test/unread-mentions.test.js`: cursor initialization/advancement, exact counts, immutable mentions, activity delivery, blocked authors, absence periods, multiple sessions, reconnect, and races.
- Modify `backend/test/client-smoke.test.js`: version/token/socket coordinators, UI policy, semantic/focus behavior, attention/sound rules, stale work rejection, mobile reachability, title, motion, and full client matrix.
- Modify `backend/test/message-actions.test.js`: immutable send metadata, backend-derived reply authorship, personalized live/edit/reaction/typing delivery, and deletion metadata regression coverage.
- Modify `backend/test/room-lifecycle.test.js`: login/switch/join/rejoin/leave/delete and room-state/block-state snapshot integration.
- Modify `backend/test/moderation.test.js`: fresh ban/timeout/role matrices for metadata/pins/personal state plus cursor advancement before restored access publication.

---

## Stage 1: Foundations, Safe Models, Serializers, and Fakes

### Task 1: Add durable schemas, pure policy helpers, and capable fakes

**Files:**
- Modify: `backend/server.js` near constants/normalizers (lines 10–390), schemas (lines 616–747), `createConnectionHandler` injection (lines 889–911), and exports (lines 3472–3520)
- Modify: `backend/test/support/fakes.js`
- Create: `backend/test/room-experience-foundations.test.js`

**Interfaces:**
- Produces `normalizeRoomText(value, maxLength): string|null`, `normalizeNotificationLevel(value): 'all'|'mentions'|'none'|null`, `authorKeyForMessage(message): string|null`, `extractNotificationMentions(text): string[]`, `roomMessageQuery(serverCode): object`, `cursorFromMessage(message): { lastReadAt: Date, lastReadMessageId: string }|null`, and `compareCursor(left, right): -1|0|1`.
- Produces `safeReplyForViewer(reply, blockedUserKeys): object|null`, `safeReactionsForViewer(reactions, blockedUserKeys): object`, `safeMessageForViewer(message, options): object|null`, `safeBlockedMessageReveal(message): object|null`, `safeRoomDetails(room, canEdit): object`, `safeRoomState(row, counts): object`, and `safeBlockState(row): object`.
- Produces injectable `RoomMemberStateModel` and `UserExperienceStateModel` properties in `createConnectionHandler(options)` with production defaults `RoomMemberState` and `UserExperienceState`.
- Extends `createMemoryModel` with nested-path queries and `$exists`, `$ne`, `$gte`, `$lte`, `$or`, `$and`; `$setOnInsert`, `$inc`, `$push` with `$each`/`$slice`, `$pull` object matching, `$addToSet`; `new`, `upsert`, `sort`, `limit`, `select`, `lean`, `deleteOne`, `deleteMany`, `updateMany`; and `db.transaction`/query `.session()` hooks without storing helper methods in rows.

- [ ] **Step 1: Write the failing foundations and fake-model tests**

Create tests with these exact names:

```js
test('room experience schemas expose exact defaults bounds and required indexes', () => {});
test('room text notification mention and cursor helpers enforce canonical values', () => {});
test('safe room message reply reaction and block serializers are explicit allowlists', () => {});
test('legacy authors and replies fail closed when block filtering cannot prove safety', () => {});
test('memory model supports atomic versioned array and cursor operations', async () => {});
test('connection handler accepts injected room-state and experience-state models', () => {});
```

In the schema test assert:

```js
assert.equal(ChatServer.schema.path('description').options.default, '');
assert.equal(ChatServer.schema.path('description').options.maxLength, 500);
assert.equal(ChatServer.schema.path('rules').options.maxLength, 2000);
assert.equal(ChatServer.schema.path('metadataVersion').options.min, 0);
assert.equal(ChatServer.schema.path('pinVersion').options.min, 0);
assert.equal(ChatServer.schema.path('pinnedMessages').options.validate.validator(Array(20).fill({})), true);
assert.equal(ChatServer.schema.path('pinnedMessages').options.validate.validator(Array(21).fill({})), false);
assert.ok(Message.schema.indexes().some(([keys]) =>
  keys.serverCode === 1 && keys.timestamp === -1 && keys._id === -1));
assert.ok(RoomMemberState.schema.indexes().some(([keys, options]) =>
  keys.usernameKey === 1 && keys.serverCode === 1 && options.unique));
assert.ok(RoomMemberState.schema.indexes().some(([keys]) =>
  keys.serverCode === 1 && keys.usernameKey === 1));
assert.ok(UserExperienceState.schema.indexes().some(([keys, options]) =>
  keys.usernameKey === 1 && options.unique));
```

Assert `extractNotificationMentions('{{PING:Alice|Alice}} {{PING:everyone|everyone}} {{PING:ALICE|Alice}}')` is `['alice', '*']`, cursor comparison orders timestamp then ObjectId string, a blocked envelope has exactly `['_id','serverCode','username','authorKey','timestamp','blocked']`, reveal has exactly `['_id','serverCode','username','displayName','authorKey','timestamp','text','attachment','edited','deleted']`, and none of the serializers contain `history`, Mongo `__v`, or AutoMod fields.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test backend/test/room-experience-foundations.test.js
```

Expected: FAIL because the models/helpers are absent and the memory fake cannot execute versioned array/cursor updates.

- [ ] **Step 3: Implement schemas, indexes, and pure helpers**

Add these durable shapes to `backend/server.js`:

```js
const PinnedMessageSchema = new mongoose.Schema({
  messageId: { type: mongoose.Schema.Types.ObjectId, required: true },
  pinnedAt: { type: Date, required: true },
  pinnedBy: { type: String, required: true, maxLength: 20 }
}, { _id: false });

// ChatServerSchema additions
description: { type: String, default: '', maxLength: 500 },
rules: { type: String, default: '', maxLength: 2000 },
metadataVersion: { type: Number, default: 0, min: 0 },
pinnedMessages: {
  type: [PinnedMessageSchema], default: [],
  validate: { validator: value => Array.isArray(value) && value.length <= 20 }
},
pinVersion: { type: Number, default: 0, min: 0 }
```

Add `authorKey`, `notificationMentions`, and the four-field reply schema to `MessageSchema`; add the exact message index. Add timestamped `RoomMemberState` and `UserExperienceState` schemas with the spec fields/defaults/enums/bounds and exact indexes. Register/export `ChatServer`, `Message`, `RoomMemberState`, and `UserExperienceState` for schema tests.

Implement the helpers with these rules:

```js
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
function roomMessageQuery(serverCode) {
  return serverCode === 'global'
    ? { $or: [{ serverCode: 'global' }, { serverCode: { $exists: false } }, { serverCode: null }] }
    : { serverCode };
}
```

Parse only exact canonical `{{PING:user|display}}` tokens; normalize usernames and represent exact `everyone|everyone` as `*`. Implement timestamp then 24-hex-ID cursor ordering. All safe serializers build fresh objects from documented fields rather than cloning/spreading stored documents. `safeMessageForViewer` returns the six-field blocked envelope before touching content, filters reaction identity arrays by blocked normalized username, strips blocked new-reply previews, and strips every legacy reply for a viewer whose block set is nonempty.

- [ ] **Step 4: Upgrade the shared fakes and inject models**

Keep `FakeSocket.trigger` backward compatible, but include the new room/message payload events in its default `serverCode`/`clientContextId` injection. Give `FakeIo` a `fetchSockets()` list and preserve direct-vs-room outbound records. Implement update operators as Mongo-like operations in deterministic order: `$setOnInsert` only on upsert creation, then `$set`, `$inc`, `$addToSet`, `$push`, `$pull`. Match nested fields and arrays without interpreting untrusted prototype keys. Query `.session(session)` records the supplied session and returns the chain.

Add to `createConnectionHandler`:

```js
RoomMemberStateModel = RoomMemberState,
UserExperienceStateModel = UserExperienceState
```

Register handlers without requiring either model to have methods unrelated to the event under test.

- [ ] **Step 5: Run GREEN and foundation regressions**

Run:

```bash
node --test backend/test/room-experience-foundations.test.js backend/test/chat-security.test.js backend/test/message-actions.test.js
node --check backend/server.js
git diff --check
```

Expected: all tests pass, syntax exits 0, and the package files are unchanged.

- [ ] **Step 6: Review and commit Stage 1**

Run:

```bash
git diff -- backend/server.js backend/test/support/fakes.js backend/test/room-experience-foundations.test.js
git diff --exit-code -- backend/package.json package.json package-lock.json
git add -- backend/server.js backend/test/support/fakes.js backend/test/room-experience-foundations.test.js
git commit -m "feat: add room experience foundations"
```

Verify the diff contains only allowlist helpers, schemas/indexes, injection, exports, and fake support; no handler changes or package changes.

---

## Stage 2: Room Details and Notification State

### Task 2: Implement versioned room details

**Files:**
- Modify: `backend/server.js` inside `createConnectionHandler` before existing moderation handlers
- Create: `backend/test/room-details-notifications.test.js`
- Modify: `backend/test/moderation.test.js`

**Interfaces:**
- Consumes `normalizeRoomText`, `loadRoomAccessState`, `withRoomMutationLock`, `appendAuditReliably`, and `safeRoomDetails` from Task 1.
- Produces `canEditRoomDetails({ serverCode, access }): boolean` and socket handlers `get_room_details({ serverCode }, ack)` and `update_room_details({ serverCode, description, rules }, ack)`.
- Success acknowledgement: `{ success: true, serverCode, description, rules, metadataVersion, canEdit }`.
- Event: `room_details_updated` with `{ serverCode, description, rules, metadataVersion }` to every freshly authorized live session; no content is sent to a banned/stale room socket.

- [ ] **Step 1: Write failing metadata tests**

Add these exact tests:

```js
test('room details are readable by fresh authorized readers and denied after a ban', async () => {});
test('private owner and global admin edit private metadata while room moderators cannot', async () => {});
test('only global admins edit Global metadata and active timeouts deny mutations', async () => {});
test('room detail bounds normalization versions and duplicate writes are exact', async () => {});
test('legacy missing metadataVersion compares as zero and first mutation persists one', async () => {});
test('metadata events omit stale banned sessions and acknowledgements use canonical rooms', async () => {});
test('metadata audits contain lengths and changed flags but never room text', async () => {});
test('complete metadata permission matrix uses fresh users rooms and restrictions', async () => {});
```

Use `createMemoryModel` rows for owner, exact moderator, other-room moderator, ordinary member, global admin, timed-out owner, and banned admin. Assert NFKC-trimmed accepted values, lengths 500/2000 accepted, 501/2001 rejected, a same-value update returns the current version without an audit/event, and a changed update increments exactly once. Serialize all acks/events/audits/logs and assert secret description/rules strings occur only in authorized detail acks/events and never in audits/logs.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-name-pattern='room details|metadata|complete metadata' backend/test/room-details-notifications.test.js backend/test/moderation.test.js
```

Expected: FAIL because the handlers and metadata policy do not exist.

- [ ] **Step 3: Implement fresh metadata access and versioned update**

Validate object shape and canonical room before locking. For reads and writes, take the actor's account lock then the room lock, reload access, deny bans/nonaccess generically, and return `safeRoomDetails(access.room, canEditRoomDetails({ serverCode, access }))` for reads. For writes, enforce private owner-or-global-admin / Global-global-admin policy and timeout denial, compare canonical strings, then make one room-document update. When the observed version is zero, the compare-and-set predicate accepts either `{ metadataVersion: 0 }` or `{ metadataVersion: { $exists: false } }`; all later versions match exactly:

```js
const versionPredicate = currentVersion === 0
  ? { $or: [{ metadataVersion: 0 }, { metadataVersion: { $exists: false } }] }
  : { metadataVersion: currentVersion };
const updated = await ChatServerModel.findOneAndUpdate(
  { code: serverCode, ...versionPredicate },
  { $set: { description, rules }, $inc: { metadataVersion: 1 } },
  { new: true }
);
```

Treat a lost compare-and-set as `{ error: 'Room details changed. Reload and try again.' }`. Same-value writes are idempotent and return the current version. Append `room_details_update` with `metadata: { descriptionChanged, rulesChanged, descriptionLength, rulesLength }`, never content. If the audit exhausts its existing two reliable attempts, keep the accepted domain mutation, log redacted `moderation_audit_write`, and return success.

Discover live sockets, group by normalized account, fresh-check access under the room lock, and direct-emit the allowlisted event only to actual room members or a global-admin session actively inspecting that exact room. Do not notify unrelated ghost admins and do not use `io.to(serverCode)` for metadata content.

- [ ] **Step 4: Run GREEN and regressions**

Run:

```bash
node --test backend/test/room-details-notifications.test.js
node --test --test-name-pattern='metadata|timeout|banned|audit' backend/test/moderation.test.js
node --check backend/server.js
git diff --check
```

Expected: all pass; existing moderation timeout/ban semantics remain unchanged.

- [ ] **Step 5: Review and commit Task 2**

Run:

```bash
git diff -- backend/server.js backend/test/room-details-notifications.test.js backend/test/moderation.test.js
git add -- backend/server.js backend/test/room-details-notifications.test.js backend/test/moderation.test.js
git commit -m "feat: add versioned room details"
```

### Task 3: Implement durable notification preferences and complete room-state snapshots

**Files:**
- Modify: `backend/server.js` login, switch, join/create, leave/delete, moderation access-restoration, and new personal-state helpers/handlers
- Modify: `backend/test/room-details-notifications.test.js`
- Modify: `backend/test/room-lifecycle.test.js`
- Modify: `backend/test/moderation.test.js`

**Interfaces:**
- Produces `newestRoomMessage(MessageModel, serverCode, { session = null }): message|null`, `ensureRoomState({ usernameKey, serverCode, session }): RoomMemberState`, `loadRoomStateSnapshot({ usernameKey, serverCode, blockedUserKeys, session }): object`, and `advanceRoomCursorToNewest({ usernameKey, serverCode, session = null })`.
- Produces `update_room_notification({ serverCode, level }, ack)` and `room_notification_updated`.
- Complete canonical room-state shape used here and later: `{ serverCode, usernameKey, notificationLevel, lastReadAt, lastReadMessageId, unreadCount, mentionCount, version, blockVersion }`.

- [ ] **Step 1: Write failing room-state tests**

Add exact tests:

```js
test('legacy room state initializes at the newest exact-room message under account then room locks', async () => {});
test('legacy Global cursor initialization includes missing and null serverCode messages', async () => {});
test('notification updates allow timed-out readers deny banned readers and validate exact levels', async () => {});
test('notification and cursor mutations share one version and events carry complete state', async () => {});
test('duplicate notification writes are idempotent and synchronize every account session', async () => {});
test('login returns safe room summaries and actual-member room attention without admin ghost counts', async () => {});
test('switch returns details notification pin count attention and filtered history keys', async () => {});
test('leave retains room state while deletion removes every state row for that room', async () => {});
test('join rejoin and restored access advance the cursor before publishing access', async () => {});
test('a failed membership or access grant leaves only a harmless early cursor advance', async () => {});
```

The login/switch expectations should be exact objects, not source matches. A legacy cursor uses the newest `(timestamp,_id)` tuple and version `0`; an empty room uses `{ lastReadAt: null, lastReadMessageId: null }`. Verify update emits to two live Alice sessions even when only one is viewing the room, but emits nothing to Bob.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-name-pattern='legacy room state|notification|login returns safe|switch returns details|leave retains|join rejoin|failed membership' backend/test/room-details-notifications.test.js backend/test/room-lifecycle.test.js backend/test/moderation.test.js
```

Expected: FAIL on absent state initialization, handler, response fields, and cleanup.

- [ ] **Step 3: Implement room-state initialization and notification mutation**

`ensureRoomState` runs only while its caller holds the normalized account lock then room lock. Read by `{ usernameKey, serverCode }`; when absent, query newest with `roomMessageQuery(serverCode)`, `.sort({ timestamp: -1, _id: -1 }).limit(1)`, then upsert with `$setOnInsert` default level/version and newest cursor. A duplicate-key retry reloads the winning row.

`loadRoomStateSnapshot` always returns every canonical field. Its counts may be zero until Stage 5 implements exact calculation; define and call `countRoomAttention({ usernameKey, serverCode, cursor, blockedUserKeys })` now so later work replaces one seam without changing payloads.

`update_room_notification` validates before locks, then executes `withAccountTransitionLock(socket.username, () => withRoomMutationLock(serverCode, applyNotificationMutation))`, where `applyNotificationMutation` reloads access, permits active timeout, denies ban/nonaccess, ensures state, and atomically `$set` + `$inc` only when the level changes. After durable success, fetch every live socket for the normalized account and synchronously direct-emit the same complete snapshot before ack. Do not append moderation audit data.

- [ ] **Step 4: Integrate initialization with lifecycle operations**

Inside login's existing account lock, load durable block state, then acquire and release each actual membership's room lock sequentially before calling `ensureRoomState`; never initialize multiple rooms without their room locks and never hold two room locks together. Set socket/session caches only after those reads. Return room summaries as allowlists (`code`, `name`, `owner`, `metadataVersion`, `pin: { serverCode, pinCount, pinVersion, blockVersion }`) plus `roomStates`, `blockState`, and `attentionSnapshots`; never return whole Mongoose rooms. Only actual current memberships receive room-state/attention snapshots. A global admin's inspectable ghost room may be returned as an access summary only after explicit discovery/switch, and it never produces reconstructed or live attention.

Before private join/create membership save and before an unban/restored-Global-access write is published, hold account→room locks and call `advanceRoomCursorToNewest`. If the later grant fails, do not roll back the cursor. On a subsequent successful grant, repeat the advance. Leave/kick/ban retain rows. In `delete_server`, call `RoomMemberStateModel.deleteMany({ serverCode })` after the room document deletion and report a generic deletion failure if cleanup fails.

Restructure blocker-sensitive switch preparation so the requester account lock encloses the room lock, fresh access check, history query, safe blocker-aware serialization, session transport change, and synchronous acknowledgement. No block mutation can commit between history serialization and ack. Extend switch success with exact keys:

```js
{
  serverCode,
  history,
  roomRole,
  restriction,
  details: { description, rules, metadataVersion, canEdit },
  notification: completeRoomState,
  pin: { serverCode, pinCount, pinVersion, blockVersion },
  attention: { unreadCount, mentionCount },
}
```

- [ ] **Step 5: Run GREEN and Stage 2 gate**

Run:

```bash
node --test backend/test/room-details-notifications.test.js backend/test/room-lifecycle.test.js backend/test/moderation.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
```

Expected: the full current backend suite passes; metadata and notification state are independently usable before pins/blocking/unread UI is added.

- [ ] **Step 6: Review and commit Task 3**

Run:

```bash
git diff -- backend/server.js backend/test/room-details-notifications.test.js backend/test/room-lifecycle.test.js backend/test/moderation.test.js
git add -- backend/server.js backend/test/room-details-notifications.test.js backend/test/room-lifecycle.test.js backend/test/moderation.test.js
git commit -m "feat: persist room notification state"
```

---

## Stage 3: Bounded Recipient-Aware Pins

### Task 4: Implement pin policy, summaries, and recipient-aware events

**Files:**
- Modify: `backend/server.js`
- Create: `backend/test/pins.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/moderation.test.js`

**Interfaces:**
- Produces `canManagePins({ serverCode, access }): boolean`, `loadVisiblePins({ room, blockedUserKeys }): Promise<object[]>`, `visiblePinCountSnapshot({ room, blockedUserKeys, blockVersion }): Promise<{ serverCode, pinCount, pinVersion, blockVersion }>`, `visiblePinSnapshot({ room, blockedUserKeys, blockVersion }): Promise<{ serverCode, pins, pinCount, pinVersion, blockVersion }>`, `list_pinned_messages`, and `set_message_pin`. The four-field count snapshot is the single shape embedded in login, switch, mutation, deletion, and event responses.
- Pin summary allowlist: `{ messageId, authorKey, username, displayName, text, attachmentSummary, messageTimestamp, pinnedAt, pinnedBy }`; `attachmentSummary` is `'Image Attachment'` or `null`, never attachment data.
- Mutation ack: `{ success: true, messageId, pinned, pin: { serverCode, pinCount, pinVersion, blockVersion } }` using the request's canonical `clientContextId` only for callback token matching on the client.
- Event: `message_pin_updated` with `{ messageId, pinned, pin: { serverCode, pinCount, pinVersion, blockVersion } }`, personalized per recipient. It never includes pin bodies; an open exact-room Pins panel refetches `list_pinned_messages`. List responses return the same four fields at top level plus `pins`.

- [ ] **Step 1: Write failing pin tests**

Create exact tests:

```js
test('private pin policy allows owner exact moderator and global admin only', async () => {});
test('Global pins allow global admins only and timeouts deny every pin mutation', async () => {});
test('pins require a live exact-room message and enforce a hard limit of twenty', async () => {});
test('duplicate pin and unpin requests are idempotent without version churn', async () => {});
test('pin array and pinVersion change in the same compare-and-set room update', async () => {});
test('legacy missing pinVersion compares as zero and first pin mutation persists one', async () => {});
test('pin lists reload current edited message content and omit deleted or missing targets', async () => {});
test('pin summaries and counts omit authors blocked by each recipient not the pinning moderator', async () => {});
test('pin events are fresh-access checked recipient-aware and monotonically versioned', async () => {});
test('pin audits include safe IDs and actors but never message or attachment content', async () => {});
test('complete pin permission matrix respects bans timeouts exact-room roles and Global policy', async () => {});
```

Test the 20th insert succeeds and 21st fails with `{ error: 'Pin limit reached.' }`. Use a target whose stored `serverCode` differs from the request and assert no room update/audit/event. Edit its stored text between two list calls and assert the second summary changes without changing `pinVersion`.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-name-pattern='pin|complete pin' backend/test/pins.test.js backend/test/message-actions.test.js backend/test/moderation.test.js
```

Expected: FAIL because pin schemas exist but handlers/policy/personalized summaries do not.

- [ ] **Step 3: Implement pin reads and mutation CAS**

Validate `serverCode`, 24-hex `messageId`, boolean `pinned`, and positive safe `clientContextId`. Within the actor account lock then room lock reload access and target, deny a ban/nonaccess/timeout/role mismatch, and require a nondeleted exact-room target. `list_pinned_messages` uses the same requester account→room lock nesting so its blocker-sensitive serialization and acknowledgement linearize with `set_user_block`. Normalize legacy target authors with `authorKeyForMessage`; fail closed if missing.

For pin, reject at 20, then update only the observed version and absent target. For unpin, update only the observed version and present target. Use `$push`/`$pull` plus `$inc: { pinVersion: 1 }` in one `findOneAndUpdate`. When the observed version is zero, match missing-or-zero exactly as required by the legacy constraint. If another write wins, reload under the lock and retry once; if the desired state already exists, return idempotent current state. Every accepted state change creates one `pin_message` or `unpin_message` audit with message ID and no content.

`loadVisiblePins` reads every referenced message through exact IDs, rejects missing/deleted/wrong-room rows, applies author fallback, filters blocked authors, and builds summaries in room pin-array order. `list_pinned_messages` does a fresh access check and returns `{ success: true, serverCode, pins, pinCount, pinVersion, blockVersion }`. Event delivery fresh-checks room access per account and targets actual room members on all their sessions plus a global-admin session actively inspecting the exact room; it does not notify unrelated ghost admins. It reads each live session's current block cache immediately before its synchronous direct emit.

- [ ] **Step 4: Integrate recipient-visible pin counts into login/switch/room summaries**

Replace raw pin-array lengths in Task 3 with `visiblePinCountSnapshot({ room, blockedUserKeys, blockVersion }).pinCount`. A blocked pin remains durably pinned for moderators and unblocked viewers but is absent from the blocker’s login summaries, switch result, Pins list, and `message_pin_updated`. Do not eagerly send pin bodies at login or switch—only counts/version; bodies load on `list_pinned_messages`.

- [ ] **Step 5: Run GREEN and commit Task 4**

Run:

```bash
node --test backend/test/pins.test.js backend/test/message-actions.test.js backend/test/moderation.test.js backend/test/room-details-notifications.test.js
node --check backend/server.js
git diff --check
git diff -- backend/server.js backend/test/pins.test.js backend/test/message-actions.test.js backend/test/moderation.test.js
git add -- backend/server.js backend/test/pins.test.js backend/test/message-actions.test.js backend/test/moderation.test.js
git commit -m "feat: add bounded room pins"
```

### Task 5: Make message deletion and pin removal transactional or reliably compensating

**Files:**
- Modify: `backend/server.js` transaction helper and `delete_message`
- Modify: `backend/test/pins.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/support/fakes.js`

**Interfaces:**
- Produces `sharedTransactionConnection(models): connection|null`, `runPersistence(operation, connection): Promise<value>`, `removePinBeforeFallbackDelete({ room, message, blockVersion })`, and `restorePinAfterFailedDelete({ room, priorPin, blockVersion })`.
- Existing `delete_message(data, ack?)` returns/acknowledges `{ success: true, messageId, pin: { serverCode, pinCount, pinVersion, blockVersion } }` or a generic `{ error: 'Failed to delete message.' }`; callers that omit the optional ack remain supported.

- [ ] **Step 1: Write failing deletion race tests**

Add exact tests:

```js
test('transactional pinned deletion marks deleted and pulls pin with one committed pinVersion', async () => {});
test('unpinned deletion does not advance pinVersion', async () => {});
test('fallback deletion pulls and versions the pin before saving the message', async () => {});
test('fallback delete failure restores the exact prior pin and advances pinVersion again', async () => {});
test('restore retry success publishes only the final authoritative pin snapshot', async () => {});
test('exhausted restore leaves the message safely unpinned emits newer state and logs no content', async () => {});
test('pin and delete races serialize under one room lock with no dangling live pin', async () => {});
test('edits preserve pin identity and are reflected by the next pin read', async () => {});
```

Use `deferred()` gates to start deletion, queue pin/unpin, and prove operation order. For the failed fallback, begin at `pinVersion: 7`, assert pull produces 8 and compensation produces 9. On exhausted restoration assert message remains undeleted, pin absent, emitted `pinVersion` is 8, ack is generic, and serialized logs/events omit message text/attachment.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-name-pattern='transactional pinned deletion|fallback deletion|restore|pin and delete|edits preserve pin' backend/test/pins.test.js backend/test/message-actions.test.js
```

Expected: FAIL because deletion currently changes only `Message.deleted`.

- [ ] **Step 3: Implement transaction and fallback protocols**

Generalize the current moderation connection check without changing moderation behavior. A connection is usable only when `MessageModel` and `ChatServerModel` share it and expose `transaction`.

Restructure `delete_message` so the actor account lock encloses the room lock; do not rely on the current pre-lock message lookup or cached socket authority. Inside those locks, reload fresh access, target message, and room after authorization. If pinned and transactions exist, execute both session-bound operations together: mark/save deleted message and `$pull` pin + `$inc` version. If no transaction, atomically pull/version first, then save `deleted = true`. If save fails, attempt twice to restore the exact prior `{ messageId, pinnedAt, pinnedBy }` with `$push` and `$inc`; verify after each attempt. A successful restore emits only the restored version snapshot. Exhausted restore does not re-delete or expose content; emit the unpinned authoritative snapshot and call `logUnexpectedError(logger, 'delete_message_pin_restore', error)`.

Only emit `message_deleted` after the message save/transaction commits. Use personalized pin events whenever pin visibility changed. Keep deleted counting metadata intact.

- [ ] **Step 4: Run GREEN and Stage 3 gate**

Run:

```bash
node --test backend/test/pins.test.js backend/test/message-actions.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
```

Expected: full backend suite passes and every recipient-visible pin-set transition has a strictly greater version.

- [ ] **Step 5: Review and commit Task 5**

Run:

```bash
git diff -- backend/server.js backend/test/pins.test.js backend/test/message-actions.test.js backend/test/support/fakes.js
git add -- backend/server.js backend/test/pins.test.js backend/test/message-actions.test.js backend/test/support/fakes.js
git commit -m "fix: serialize pinned message deletion"
```

---

## Stage 4: Private Global Asymmetric Blocking

### Task 6: Implement durable block state and enforce recipient privacy across every content path

**Files:**
- Modify: `backend/server.js` account-session helpers, login, switch/history, message/pin delivery, reply/reaction/typing/edit/delete handlers, and new block/reveal handlers
- Create: `backend/test/blocking-privacy.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/room-lifecycle.test.js`
- Modify: `backend/test/pins.test.js`
- Modify: `backend/test/support/fakes.js`

**Interfaces:**
- Consumes `UserExperienceStateModel`, author/reply/reaction/message allowlists, pin snapshots, account locks, room access, and live-socket discovery.
- Produces `ensureBlockState(usernameKey): UserExperienceState`, `blockSetFromState(row): Set<string>`, `replaceAccountBlockCaches(sockets, usernameKey, state): void`, `emitPersonalizedRoomEvent({ serverCode, event, buildPayload }): Promise<void>`, and `refreshBlockerSessions({ usernameKey, state, sockets }): Promise<void>`.
- Produces `set_user_block({ username, blocked }, ack)` with `{ success: true, usernameKey, username, blockedUsers, blockVersion }` and `user_block_updated` with the same account-scoped state.
- Produces `get_blocked_message({ serverCode, messageId, clientContextId }, ack)` with `{ success: true, serverCode, messageId, clientContextId, blockVersion, message }`, where `message` is the one-message reveal allowlist from Task 1.
- Socket/session cache fields are `blockedUserKeys: Set<string>` and `blockVersion: number`; `onlineUsersMap` stores serializable `blockedUsers: string[]` and `blockVersion` for map-only session reconciliation.

- [ ] **Step 1: Write failing durable-state, privacy, and linearization tests**

Create these exact tests in `backend/test/blocking-privacy.test.js`:

```js
test('authenticated users block existing accounts but cannot block themselves or a missing account', async () => {});
test('block arrays are bounded at five hundred and duplicate block or unblock is idempotent', async () => {});
test('block state and blockVersion change atomically under the blocker account lock', async () => {});
test('blocking is private asymmetric global and never changes memberships restrictions or presence', async () => {});
test('all live blocker sessions replace block caches before acknowledgement', async () => {});
test('concurrent login serializes with blocking and reloads the winning durable block set', async () => {});
test('live delivery linearizes entirely before or after synchronous cache replacement', async () => {});
test('history sends an explicit content-free placeholder for blocked authors', async () => {});
test('live messages from blocked authors reveal no content to blocker sessions', async () => {});
test('personalized content reaches only sockets actively viewing the exact room', async () => {});
test('reply previews reactions typing edits and pins are filtered per current block cache', async () => {});
test('legacy reply previews disappear for any viewer with a nonempty block list', async () => {});
test('missing or malformed legacy author identity fails closed without content disclosure', async () => {});
test('blocked-message reveal requires fresh access exact room context and a currently blocked author', async () => {});
test('blocked-message reveal omits history reaction identities and reply content without changing state', async () => {});
test('moderation system and presence events remain visible across a block', async () => {});
test('block updates refresh room attention pin counts typing and active history on every blocker session', async () => {});
test('unblocking refetches active history without advancing unrelated room cursors', async () => {});
test('blocked account receives no event acknowledgement or observable state change', async () => {});
test('all normal content serializers reject internal Mongo AutoMod and edit-history fields', async () => {});
```

Extend existing suites with exact regression names:

```js
test('new replies persist immutable authorKey from the exact-room source', async () => {});
test('reaction updates remove identities blocked by each recipient', async () => {});
test('typing from a blocked author is suppressed only for blocker sessions', async () => {});
test('switch history is blocker-filtered and preserves Global legacy compatibility', async () => {});
test('recipient pin counts change after block without changing room pinVersion', async () => {});
```

Use secret sentinels in blocked message text, base64 attachment, reply text, edit history, avatar URL, and reaction usernames. Serialize every blocker ack/event/history/pin response/log and assert no sentinel occurs. Assert the placeholder's `Object.keys(blockedEnvelope).sort()` exactly equals the six-field contract. In the linearization test gate message authorization, complete a synchronous emit, then commit block replacement; repeat with block replacement first and assert the next emit is placeholder-only.

- [ ] **Step 2: Run the complete blocking RED set**

Run:

```bash
node --test --test-name-pattern='block|blocked|personalized content|reply previews|reaction updates remove|typing from|switch history.*blocker|recipient pin counts' backend/test/blocking-privacy.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/pins.test.js
```

Expected: FAIL on missing block handlers/cache state and on current room-wide content broadcasts.

- [ ] **Step 3: Implement durable private block mutation under the account lock**

Validate the request is a plain object, canonicalize `username`, resolve the target with `findUserByUsername`, canonicalize target display casing, reject only self or a missing account generically, and run the entire mutation under `withAccountTransitionLock(socket.username, applyBlockMutation)`, where `applyBlockMutation` performs the compare-and-set and synchronous cache publication described below. Global admins, room owners, and moderators may be blocked like any other account; their moderation/system notices remain visible under the separate event policy. Fetch live sockets before the compare-and-set while the account lock excludes login. Ensure the owner document by normalized key.

For a new block, reject length 500 and atomically use `$push: { blockedUsers: { usernameKey, username, createdAt } }` plus `$inc: { blockVersion: 1 }` against the observed version and absence. For unblock use `$pull` plus `$inc` against presence. Reload and treat the already-desired state as idempotent. Never create a moderation audit.

After durable success and still under the account lock, call a non-async cache replacement loop:

```js
function replaceAccountBlockCaches(sockets, usernameKey, state) {
  const blockedUsers = state.blockedUsers.map(item => item.usernameKey);
  for (const live of sockets) {
    const session = onlineUsersMap.get(live.id);
    if (normalizeAccountKey(live.username || session?.username) !== usernameKey) continue;
    live.blockedUserKeys = new Set(blockedUsers);
    live.blockVersion = state.blockVersion;
    if (session) {
      session.blockedUsers = [...blockedUsers];
      session.blockVersion = state.blockVersion;
    }
  }
}
```

There is no `await` between assigning a live cache and its account-scoped `user_block_updated` emit. Refresh room attention and recipient-visible pin counts for every accessible actual membership, clear blocked-author entries from each live `typingUsers` equivalent server/session cache, and emit replacement snapshots carrying the new block version. Then acknowledge. The target account is never inspected for live sockets and never notified.

During login, inside the same account lock, load `UserExperienceState`, set both socket and `onlineUsersMap` caches before room joins/presence publication, and include `safeBlockState` in the login ack.

- [ ] **Step 4: Replace content broadcasts with fresh-access personalized delivery**

Implement `emitPersonalizedRoomEvent` by fetching sockets, selecting only sockets whose exact canonical `socket.serverCode` equals the event room, grouping those normalized accounts, loading fresh room access per account, skipping banned/nonaccess sessions, then invoking `buildPayload({ live, access, blockedUserKeys, blockVersion })`. Immediately re-read `live.blockedUserKeys` and `live.blockVersion` before the synchronous `live.emit`. A `null` payload suppresses the event. Inactive sessions receive only `room_activity` and account-scoped state events; they never receive another room's message/history/edit/reaction/typing/delete payload.

Apply it to:

```text
chat_message        blocked author => six-field placeholder; otherwise safe message allowlist
message_edited      blocked author => suppress; otherwise safe edit allowlist
reaction_updated    blocked message author => suppress; otherwise filter blocked reacting identities
typing              blocked typing author => suppress; otherwise existing complete typing payload
message_deleted     blocked author => suppress; otherwise ID/room allowlist
message_pin_updated recipient-specific count/version from Task 4; never pin bodies
```

System messages, moderation notifications, room access/restriction events, and online member lists keep their existing delivery because they reveal no blocked-authored message content. Presence rows remain intact.

Use the same serializers for switch history and pin list. `createReplySnapshot` now includes normalized immutable `authorKey`; the send handler accepts only client `replyTo.id`, loads an exact-room nondeleted source, and derives all four fields. Never copy client display/text/author fields.

- [ ] **Step 5: Implement one-message reveal and post-block refresh**

`get_blocked_message` validates all three fields, captures canonical room/context, then takes account→room locks. Reload access and the exact message. Require access, no ban, exact room, a provable author key, and membership of that key in fresh durable `UserExperienceState`—not merely the socket cache. Return only `safeBlockedMessageReveal` plus the fresh `blockVersion`; it excludes reply entirely and collapses reactions to no field. A deleted target may still be individually revealed under the same authorization, but the safe response never includes its edit history or reaction/reply internals.

After block/unblock, every blocker session invalidates cached Pins data and receives refreshed attention/pin count events. If it has an active room, emit an account-private `room_refresh_required` with `{ serverCode, blockVersion }`; the client will token-check and refetch that room in Task 8. This event contains no target username. Unblock does not advance any room cursor.

- [ ] **Step 6: Run GREEN, privacy scan, and Stage 4 gate**

Run:

```bash
node --test backend/test/blocking-privacy.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/pins.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
if rg -n 'BLOCKED_TEXT_SENTINEL|BLOCKED_ATTACHMENT_SENTINEL|BLOCKED_REPLY_SENTINEL' backend/server.js; then exit 1; else echo 'production privacy sentinel scan clean'; fi
```

Expected: all tests pass; no blocked-content sentinel is present in production source or observable blocker output.

- [ ] **Step 7: Review and commit Task 6**

Inspect every outbound content site with:

```bash
rg -n "emit\('(chat_message|message_edited|reaction_updated|typing|message_deleted|message_pin_updated)'|history:" backend/server.js
git diff -- backend/server.js backend/test/blocking-privacy.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/pins.test.js backend/test/support/fakes.js
git add -- backend/server.js backend/test/blocking-privacy.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/pins.test.js backend/test/support/fakes.js
git commit -m "feat: enforce private user blocking"
```

Confirm no normal user-content path uses `io.to(room).emit`, every block cache replacement precedes ack, and no target notification exists.

---

## Stage 5: Exact Unread and Mention State

### Task 7: Implement immutable send metadata, monotonic read cursors, exact snapshots, and room activity

**Files:**
- Modify: `backend/server.js` mention parsing/send, room-state counting, mark-read, personalized activity, login/switch/join/restored-access integration
- Create: `backend/test/unread-mentions.test.js`
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/room-lifecycle.test.js`
- Modify: `backend/test/room-details-notifications.test.js`
- Modify: `backend/test/blocking-privacy.test.js`
- Modify: `backend/test/moderation.test.js`

**Interfaces:**
- Produces `countRoomAttention({ usernameKey, serverCode, cursor, blockedUserKeys }): Promise<{ unreadCount, mentionCount }>` and `isNotificationMention(message, usernameKey): boolean`.
- Produces `mark_room_read({ serverCode, messageId }, ack)` and account-scoped `room_read_updated`, both carrying the complete room-state shape from Task 3.
- Produces personalized `room_activity` payload `{ serverCode, messageId, timestamp, authorKey, mentioned, blockVersion }`; only a newly created normal message can produce it.
- New `MessageModel.create` fields are always `authorKey: normalizeAccountKey(access.user.username)` and `notificationMentions: extractNotificationMentions(cleanText)`.

- [ ] **Step 1: Write failing cursor, count, and immutable metadata tests**

Create exact tests:

```js
test('new messages store immutable normalized author and canonical send-time mentions', async () => {});
test('everyone mention stores the reserved star exactly once', async () => {});
test('edits do not change mention metadata or create activity', async () => {});
test('exact unread counts include only newer messages from another unblocked author', async () => {});
test('exact mention counts use immutable usernames and everyone while deleted rows still count', async () => {});
test('blocked authors own messages system notices reactions pins and moderation never add activity', async () => {});
test('mark read rejects wrong-room IDs and monotonically advances timestamp then id', async () => {});
test('duplicate and older mark-read requests are idempotent without version churn', async () => {});
test('mark read allows active timeout denies active ban and synchronizes all account sessions', async () => {});
test('notification and read updates cannot lose each other under their shared version', async () => {});
test('room activity reaches inactive actual members but not admin ghost viewers nonmembers or banned users', async () => {});
test('room activity carries the recipient current blockVersion and normalized message tuple', async () => {});
test('login reconnect and account events replace exact counts from MongoDB', async () => {});
test('absence-period messages never become unread after leave kick ban rejoin or restored Global access', async () => {});
test('unblocking may expose newer unread messages without silently advancing any cursor', async () => {});
test('Global counts include legacy room rows only after a feature cursor and new sends remain canonical', async () => {});
test('out-of-order read and activity operations converge on the newest cursor and exact counts', async () => {});
test('complete attention policy matrix covers levels blocks memberships restrictions sessions and reconnects', async () => {});
```

Use messages sharing timestamps with ascending ObjectIds to prove the tie breaker. Establish a cursor before creating a legacy-style Global row so the compatibility query is exercised without violating the rule that pre-feature rows are hidden by lazy initialization. Delete an unread mentioned message and assert exact counts are unchanged while its safe history payload is redacted.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-name-pattern='immutable normalized|everyone mention|exact unread|exact mention|mark read|room activity|absence-period|unblocking may|Global counts|out-of-order read|complete attention' backend/test/unread-mentions.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/room-details-notifications.test.js backend/test/blocking-privacy.test.js backend/test/moderation.test.js
```

Expected: FAIL because counts are placeholder zeroes and send/read/activity logic is absent.

- [ ] **Step 3: Persist immutable creation metadata and preserve deletion counting fields**

After ping resolution and AutoMod acceptance but before `MessageModel.create`, compute:

```js
const authorKey = normalizeAccountKey(access.user.username);
const notificationMentions = extractNotificationMentions(cleanText);
```

Persist both fields with canonical `serverCode`. `notificationMentions` is deduplicated and contains only normalized usernames or `*`. Do not assign either in edit/delete handlers. On delete, leave `authorKey`, `notificationMentions`, timestamp, room, and `_id` stored; safe serializers redact content. Reply snapshots use the source's immutable/fallback author key but do not contribute mention activity.

- [ ] **Step 4: Implement exact indexed count reconstruction**

Build the newer-than-cursor predicate as:

```js
const newer = cursor && cursor.lastReadAt
  ? { $or: [
      { timestamp: { $gt: cursor.lastReadAt } },
      { timestamp: cursor.lastReadAt, _id: { $gt: cursor.lastReadMessageId } }
    ] }
  : {};
```

Combine it with `roomMessageQuery(serverCode)` using `$and`, query only `_id serverCode timestamp username authorKey notificationMentions deleted`, and apply author fallback in application code. Count a row iff author identity is provable, is not the reader, and is not currently blocked. Count mention iff its immutable array contains the reader key or `*`. Do not exclude `deleted: true`. This query uses `{ serverCode: 1, timestamp: -1, _id: -1 }` for canonical rooms; retain the explicit Global compatibility branch.

- [ ] **Step 5: Implement monotonic mark-read and account-scoped replacement events**

Validate exact room/message IDs, acquire account→room locks, reload access (timeout allowed; ban denied), load target by ID, verify it matches `roomMessageQuery(serverCode)` and is a visible chronological message envelope, ensure room state, and compare target tuple with stored tuple. If target is older/equal, return the identical complete snapshot/version. If newer, compare-and-set the observed room-state version while setting the target tuple and incrementing once. Reload exact counts using the current durable block set.

Before ack, synchronously direct-emit `room_read_updated` with the complete state to every live normalized-account session. Because notification and cursor share one version, both `room_notification_updated` and `room_read_updated` always include current level, cursor, both exact counts, and version.

- [ ] **Step 6: Emit recipient-specific inactive-room activity after successful creation**

After durable message creation, fetch live sockets and group accounts. For each account, reload the user/restriction/actual membership. Eligibility requires an actual `user.servers` membership (including Global membership explicitly), no active ban, author differs, and author not in that recipient's immediately re-read block cache. Global-admin ghost access alone is insufficient. Emit to all sessions of an eligible account even when none has `socket.serverCode === message.serverCode`.

`mentioned` comes from immutable message metadata. No edit, delete, reaction, pin, typing, system, presence, or moderation handler calls the activity emitter. After emit, exact login/reconnect/read/block snapshots remain authoritative replacements.

- [ ] **Step 7: Re-run lifecycle race and exact snapshot tests**

Run:

```bash
node --test backend/test/unread-mentions.test.js backend/test/room-details-notifications.test.js backend/test/blocking-privacy.test.js
node --test backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/moderation.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
```

Expected: all backend tests pass; counts agree live/reconnect, cursor never moves backward, and absence-period messages remain behind the advanced cursor.

- [ ] **Step 8: Review and commit Task 7**

Run:

```bash
git diff -- backend/server.js backend/test/unread-mentions.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/room-details-notifications.test.js backend/test/blocking-privacy.test.js backend/test/moderation.test.js
git add -- backend/server.js backend/test/unread-mentions.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/room-details-notifications.test.js backend/test/blocking-privacy.test.js backend/test/moderation.test.js
git commit -m "feat: synchronize unread mention state"
```

Confirm the only `room_activity` call site is the successful new-message path and every count path uses current block state.

---

## Stage 6: Frontend, Mobile, Accessibility, Full Policy, and Release Gate

### Task 8: Add version-safe client state and the complete accessible room experience UI

**Files:**
- Modify: `chat.html` styles, markup, `ChatClientHelpers`, client state, socket setup, switch/login/render/menu code
- Modify: `backend/test/client-smoke.test.js`
- Modify: `backend/test/moderation.test.js` for the final backend cross-feature policy matrix

**Interfaces:**
- Produces pure helpers `acceptVersionedState(current, incoming, kind)`, `acceptPinBodies(current, incoming)`, `createScopedGenerationCoordinator()`, `createRecentIdSet(limit = 256)`, `applyRoomActivity(state, activity, recentIds)`, `attentionPresentation(state)`, `soundPolicy(level, mentioned, blocked = false)`, `isMarkReadEligible(context)`, `messageActionsFor(context)`, `blockActionFor(context)`, `createFocusDialogController(options)`, `createMenuController(options)`, and `headerLayoutContract(width, textScale)` inside the existing delimited helper block.
- Produces client maps `roomDetailsByCode`, `pinsByRoom`, `roomStateByCode`, `attentionByRoom`, `recentActivityIdsByRoom`, `blockedUsersByKey`, and scalar `acceptedBlockVersion`.
- Produces accessible DOM IDs `room-info-btn`, `pins-btn`, `header-overflow-btn`, `header-overflow-menu`, `room-info-modal`, `room-info-title`, `room-description`, `room-rules`, `room-notification-level`, `room-info-edit`, `room-info-save`, `pins-modal`, `pins-title`, `pins-list`, `blocked-users-list`, and `blocked-users-empty`—each exactly once.

- [ ] **Step 1: Write failing pure client state and race tests**

Add exact tests to `backend/test/client-smoke.test.js`:

```js
test('version acceptance is strict for metadata pins and blocks and identical-idempotent for room state', () => {});
test('pin body hydration accepts only the current unloaded pin and block version', () => {});
test('a greater accepted block version replaces an equal pin version visible count', () => {});
test('scoped feature generations reject late close reopen room switch and account callbacks before inspection', () => {});
test('socket replacement clears every feature map and old-socket listeners are inert', () => {});
test('room activity ignores old block versions cursor-covered tuples and bounded duplicate IDs', () => {});
test('exact read snapshots replace speculative counts across tabs and devices', () => {});
test('a greater accepted block version authoritatively replaces equal-version room counts', () => {});
test('attention presentation follows all mentions none and caps visible counts at 99+', () => {});
test('sound policy permits all traffic for all mentions only for mentions and none for none', () => {});
test('blocked placeholders are silent at every notification level', () => {});
test('mark-read policy requires active room visible document and bottom scroll', () => {});
test('block update invalidates pin cache typing history replies and reactions before refetch', () => {});
test('event before acknowledgement still settles the current metadata pin and block controls', () => {});
test('block refresh suppresses only its programmatic mark-read and later live messages resume normal reads', () => {});
```

The version test must reject equal-but-different room state and accept equal-identical room state without mutation. The activity test feeds versions 4 then 3, same ID twice, a tuple equal to the accepted cursor, and 300 unique IDs; assert at most 256 recent IDs remain and only valid newer events increment.

- [ ] **Step 2: Run client helper RED**

Run:

```bash
node --test --test-name-pattern='version acceptance|pin body hydration|scoped feature|socket replacement clears|room activity|exact read snapshots|greater accepted block|attention presentation|sound policy|blocked placeholders|mark-read policy|block update invalidates|block refresh|event before acknowledgement' backend/test/client-smoke.test.js
```

Expected: FAIL because the feature state helpers/maps do not exist.

- [ ] **Step 3: Implement pure version, generation, activity, attention, and sound helpers**

`acceptVersionedState` validates canonical identity plus a nonnegative integer version. Metadata and blocks accept only a greater owning version. Every block-dependent pin, room-state, attention, or activity payload must have `blockVersion` exactly equal to the accepted account block version; older payloads are stale, while newer payloads wait for the preceding ordered `user_block_updated` replacement rather than being interpreted with an obsolete block map. For pins, a newly accepted greater block version authoritatively replaces recipient-visible count state when `pinVersion` is not lower; within the same block version, only a greater `pinVersion` replaces, except an equal identical snapshot is idempotent. For room state, when the block version has advanced and is already accepted, accept the authoritative replacement if its room-state version is not lower, even when counts changed at the same room version. Within the same block version, a greater room-state version replaces, a lower version rejects, and an equal version succeeds only when notification level, cursor, counts, and version are identical. Pin bodies are lazy data rather than a newer pin mutation: `acceptPinBodies` may hydrate an unloaded cache only when room, `pinVersion`, `pinCount`, and `blockVersion` exactly match the already accepted count snapshot and the request token is current.

`createScopedGenerationCoordinator` stores one monotonically increasing generation per scope string and an overall socket generation. `begin(scope, identity)` returns a frozen token; `isCurrent(token, identity)` checks socket generation, scope generation, and identity; `invalidate(scope)` and `invalidateAll()` increment before clearing. Call `isCurrent` before reading `response.error`.

`applyRoomActivity` checks matching canonical room, activity block version exactly equal to accepted block version, tuple strictly after accepted cursor, and unseen ID; then increments exact local integers and inserts into FIFO recent IDs. Account `room_read_updated`, `room_notification_updated`, login, switch, and block replacement overwrite state/counts and clear IDs at/before the accepted cursor.

`attentionPresentation` returns `{ badgeText, ariaLabel, title, visible }`: `all` prefers `@mentionCount`, otherwise unread; `mentions` shows only `@mentionCount`; `none` is hidden and names no counts. Format values above 99 as `99+` / `@99+`. `soundPolicy('all', false, false)` is `msg`, `soundPolicy('all', true, false)` is `ping`, `soundPolicy('mentions', true, false)` is `ping`, and every blocked or remaining case is `null`. `isMarkReadEligible` also requires that no read-suppression token is active for the exact room generation.

- [ ] **Step 4: Write failing markup, dialog, menu, rendering, and responsive tests**

Add exact tests:

```js
test('room rail entries are semantic buttons with notification-aware labels and silent badges', () => {});
test('Room Info and Pins dialogs have labelled modal semantics initial focus Escape and focus restoration', () => {});
test('Room Info exposes read content edit save and notification controls by exact policy', () => {});
test('newly joined rooms open Room Info once after a successful join', () => {});
test('pending joined Room Info intent is consumed only by the exact accepted room switch generation', () => {});
test('older in-flight switch completion cannot cancel a queued joined-room info intent', () => {});
test('Pins load bodies only when opened and stale room pin acknowledgements are ignored', () => {});
test('message and member menus expose exact pin block and unblock actions', () => {});
test('blocked rows are collapsed content-free controls and Show is independently expanded', () => {});
test('blocked user settings permit recovery and unblocking without target disclosure', () => {});
test('author avatar member and menu triggers support Enter Space aria-haspopup and aria-expanded', () => {});
test('menus focus the first item close on Escape or outside activation and restore trigger focus', () => {});
test('message actions remain keyboard and coarse-pointer reachable without hover', () => {});
test('mobile header keeps Room Info and Pins visible and moves every other action into one overflow menu', () => {});
test('responsive header contract maps 320px and 200 percent text scale to reachable 44px targets', () => {});
test('new UI preserves reduced motion and the exact Chat v1.3.2 title', () => {});
```

Use static DOM-ID uniqueness/source assertions plus small fake-element tests of the pure dialog/menu controllers; do not add jsdom. Assert there is no `aria-live` on room attention badges. Assert the `@media (max-width: 700px)` rule leaves `#room-info-btn` and `#pins-btn` displayed with `min-width/min-height: 44px`, shows the overflow trigger, and hides/moves invite/leave/delete/join/moderate/settings/logout direct controls. Bind those exact CSS selectors to `headerLayoutContract`; its 320px/2.0-scale case must place Room Info, Pins, and Overflow in three nonoverlapping 44px slots. This is a deterministic CSS contract, not a claim of real-browser computed geometry; record a manual 320px/200%-zoom browser check when a browser engine is available.

- [ ] **Step 5: Run UI RED**

Run:

```bash
node --test --test-name-pattern='room rail entries|Room Info|older in-flight|Pins load|message and member menus|blocked rows|blocked user settings|author avatar|menus focus|coarse-pointer|mobile header|320px|Chat v1.3.2' backend/test/client-smoke.test.js
```

Expected: FAIL on absent markup/controllers and current div-based room/member/author triggers.

- [ ] **Step 6: Add accessible markup, styling, and focus/menu controllers**

Add compact always-visible Room Info and Pins `<button>` elements next to the title. Add both modal containers with `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, close buttons, initial-focus targets, and no inline secret-bearing HTML. Add a notification `<select>` with exact values. Authorized editors see explicit Edit and Save; readers receive readonly text blocks. Add `Blocked Users` inside Profile Settings with an empty state and per-user Unblock buttons.

Build all dynamic strings with `textContent`/`appendTextElement`. Convert the static Global rail entry, dynamic room entries, add-room trigger, online member rows, message author/avatar triggers, and action menu triggers to `<button type="button">` or keyboard-equivalent controls. `createFocusDialogController` captures trigger, focuses configured first control after open, handles Escape, and restores connected trigger on close. `createMenuController` sets `aria-expanded`, focuses first enabled menu item, handles Enter/Space/Escape/outside pointer, and restores focus.

For coarse pointers, show `.msg-actions` on `@media (hover: none), (pointer: coarse)` and make every action at least 44px. Preserve existing reduced-motion overrides and never add `transition: all`.

- [ ] **Step 7: Wire login/switch/versioned events and room attention**

On login, replace all maps from the safe snapshots before rendering rooms. On switch success, activate the room generation first, accept metadata/pin/room-state versions, render blocker-filtered history, then attempt mark-read only if `document.visibilityState === 'visible'` and `ChatClientHelpers.isNearScrollEnd(chatWindow)`. After each accepted live message or locally submitted message is rendered, schedule `maybeMarkCurrentRoomRead()` once so an already-visible bottom-of-chat session does not retain a false unread badge.

Bind `scroll` and `visibilitychange` to `maybeMarkCurrentRoomRead()`. It selects the last rendered `.msg[data-id]` in the open room and emits `mark_room_read`; the callback token includes room and generation. Do not mark from an inactive room, hidden document, or nonbottom scroll.

Every new feature event installed in `setupSocket(activeSocket)` starts with:

```js
if (activeSocket !== socket) return;
```

Apply version gates to `room_details_updated`, `message_pin_updated`, `room_notification_updated`, `room_read_updated`, `room_activity`, and `user_block_updated`. `room_activity` may update an inactive rail badge without switching/joining. Existing incoming-message sound calls use `soundPolicy(currentRoomLevel, mentioned, data.blocked === true)` and no sound is added; blocked envelopes are always silent.

- [ ] **Step 8: Wire Room Info, Pins, pin/block menus, reveal, and refresh**

Room Info open renders any already accepted cached details immediately, creates a room-scoped token, and emits `get_room_details`. The callback first validates its token; a greater version replaces the cache, while an equal identical read completes without mutation. Save emits normalized current room/fields and checks the save token before inspecting response. Notification change emits `update_room_notification` and applies the complete state via room version rules. After successful `join_server`, queue the joined-room switch and capture that exact switch request/queue token in a frozen pending Room Info intent. Consume it only when `handleSwitchResult` accepts that same token and room, then open Room Info once. Older already-in-flight switch completions leave the newer intent untouched; only a later superseding user switch intent invalidates it. Room creation uses the same successful-new-membership intent.

Pins open invalidates its prior token, emits `list_pinned_messages`, and renders summaries only when the token is current and `acceptPinBodies` proves the response hydrates the exact accepted pin/block version. Pin/Unpin actions come from current server-provided permission state and use the composition context's `clientContextId`. A `message_pin_updated` event updates count/version only; if the exact-room Pins panel is open, invalidate its body cache and refetch through a new token. Never request or emit pin bodies at login/switch.

Member and message-author menus show `Block` unless self/already blocked and `Unblock` when blocked; moderation actions remain separate. A blocked message renderer ignores all unexpected fields, creates `Blocked message — Show`, and sets `aria-expanded=false`. Show sends exact room/message/context; only a current token response can append the one-message safe content and set expanded true. It never alters global block UI.

On `user_block_updated`, synchronously replace the map/version, clear cached pins and recent activity, remove blocked typing users, invalidate all unrelated open feature callbacks, and close author/member menus. Preserve the exact currently pending block-mutation token; if the authoritative state reflects that pending target/desired value, settle its control from the event while leaving the token valid for an idempotent later acknowledgement. Before awaiting anything, replace the active message DOM—including reply previews and reaction details—with a content-free loading state so a newly blocked author's already-rendered content cannot remain visible. On `room_refresh_required`, verify current socket, block version, room, and generation, then force an exact-room switch refresh with `forceRefresh: true` and `suppressAutoRead: true`; the existing same-room fast path must not skip it. Arm a room-generation read-suppression token before rendering and keep it through programmatic history scrolling. After the final refresh render/scroll animation frame, disarm it without calling `mark_room_read`; subsequent live messages immediately return to normal visible-at-bottom read behavior. A refresh rebuilds message DOM, reply previews, reaction details, and pin counts from server-safe payloads. Unblocking uses this path and does not advance the cursor merely because the refetch scrolled or completed.

For metadata, pin, and block mutations, the initiating event may arrive before its acknowledgement. Every callback first validates either its still-current pending token or the matching event-settled receipt for that same immutable operation identity, then finishes the control. It applies the response only if it is a newer acceptable version. An equal response after the event is a successful no-op for state but still finalizes the same control; a newer operation clears the old receipt, so a stale acknowledgement cannot settle newer work.

- [ ] **Step 9: Implement the 700px overflow layout**

At desktop widths preserve current direct actions. At `max-width: 700px`, keep title shrink-safe, keep `room-info-btn` and `pins-btn` as 44px compact icon/text controls, display one `header-overflow-btn` at 44px, and place invite/leave/delete/join/moderate/settings/logout buttons in `header-overflow-menu` as full-width 44px items. The menu controller provides keyboard behavior and focus restoration. Implement `headerLayoutContract` from the same 44px/gap/breakpoint constants and keep the static CSS contract test coupled to those selectors. Use wrapping/min-width rules so 320px does not clip or overlap; do not remove any action from the DOM based on authorization—update its hidden/disabled state in the existing switch/access render path.

- [ ] **Step 10: Run client GREEN and cross-feature policy matrices**

Run:

```bash
node --test backend/test/client-smoke.test.js
node --test --test-name-pattern='complete metadata|complete pin|complete attention|block|socket replacement|room switch|timeout|ban' backend/test/*.test.js
```

Add the backend matrix to `backend/test/moderation.test.js` and the two client matrices to `backend/test/client-smoke.test.js` with these exact names:

```js
test('complete room experience backend policy matrix has no stale authority or content leak', async () => {});
test('complete client race matrix rejects old socket room dialog pin block read and activity work', () => {});
test('complete mobile keyboard matrix keeps every authorized action reachable', () => {});
```

The backend matrix iterates Global/private × admin/owner/exact-mod/other-mod/member/nonmember × active/timeout/banned × blocked/unblocked. The client race matrix performs socket replacement, A→B switch, close/reopen, older metadata/pin/block/read events, duplicate activity, and late reveal; assert only current B/current socket/current versions alter maps or DOM.

- [ ] **Step 11: Run the fresh release gate**

Run exactly:

```bash
npm test --prefix backend
node --check backend/server.js
node --check backend/test/client-smoke.test.js
node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('chat.html','utf8');const s=[...h.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]).filter(c=>c.trim());s.forEach((c,i)=>new vm.Script(c,{filename:'chat-inline-'+(i+1)+'.js'}));console.log('inline scripts:',s.length);"
node -e "const fs=require('fs');const h=fs.readFileSync('chat.html','utf8').replace(/<script(?:\\s[^>]*)?>[\\s\\S]*?<\\/script>/gi,'');const ids=[...h.matchAll(/\\sid=\"([^\"]+)\"/g)].map(m=>m[1]);const d=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];if(d.length)throw new Error('duplicate ids: '+d.join(','));console.log('unique static ids:',ids.length);"
node -e "const fs=require('fs');const h=fs.readFileSync('chat.html','utf8');const titles=[...h.matchAll(/<title>([^<]*)<\\/title>/gi)].map(m=>m[1]);if(titles.length!==1||titles[0]!=='Chat v1.3.2')throw new Error('unexpected titles: '+JSON.stringify(titles));console.log(titles[0]);"
git diff --check
if rg -n --ignore-case 'gh[pousr]_[A-Za-z0-9]{20,}|mongodb(\\+srv)?:\\/\\/[^[:space:]]+:[^[:space:]]+@|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' backend/server.js chat.html backend/test docs/superpowers/plans/2026-08-10-room-experience-features.md; then exit 1; else echo 'credential scan clean'; fi
git status --short
git diff --stat 5aa022d..HEAD
git diff --exit-code -- backend/package.json package.json package-lock.json
git diff --cached --exit-code -- backend/package.json package.json package-lock.json
git diff --exit-code 5aa022d..HEAD -- backend/package.json package.json package-lock.json
```

Expected: the complete backend suite passes; server/test/client syntax compiles; HTML IDs are unique; the only title is `Chat v1.3.2`; no whitespace error or live credential is found; package files have no diff; `git status` still shows user-owned root dependency artifacts untracked and unstaged.

- [ ] **Step 12: Perform whole-branch security/concurrency review and fix findings test-first**

Review the complete branch diff against the approved design, specifically:

```text
1. identity → account(s) → room lock order and finally-release behavior
2. fresh ban/timeout/membership/role checks inside every mutation lock
3. synchronous block-cache replacement and delivery linearization
4. explicit allowlists for history/live/reveal/reply/reaction/pin/login/switch
5. version ownership, atomic increments, idempotency, and client strictness
6. pin/delete transaction and fallback compensation version sequence
7. cursor monotonicity, Global compatibility, deleted-row count stability, absence grants
8. old-socket and room/account-generation invalidation before response inspection
9. no block notification, no content in audit/log paths, no admin ghost notifications
10. keyboard/focus/mobile/reduced-motion behavior and no unreachable header action
```

For every Critical or Important finding, first add a named regression to the owning test file, run that test RED, implement the smallest fix in `backend/server.js` or `chat.html`, rerun GREEN, and repeat the complete release gate. Do not waive a finding without an observable test demonstrating that the claimed invariant already holds.

- [ ] **Step 13: Commit the frontend and any reviewed corrections**

Run:

```bash
git diff -- chat.html backend/test/client-smoke.test.js backend/server.js backend/test
git add -- chat.html backend/test/client-smoke.test.js
git add -- backend/server.js backend/test/room-experience-foundations.test.js backend/test/room-details-notifications.test.js backend/test/pins.test.js backend/test/blocking-privacy.test.js backend/test/unread-mentions.test.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/moderation.test.js backend/test/support/fakes.js
git commit -m "feat: add accessible room experience UI"
```

If the security/concurrency review produced no backend/test changes after Task 7, the second `git add` is a no-op. Confirm the commit excludes `backend/package.json`, root package files, `node_modules/`, and unrelated user files.

- [ ] **Step 14: Final post-commit verification and branch handoff**

Run the entire Step 11 gate again against committed `HEAD`, then:

```bash
git status --short
git log --oneline -6
git diff --check 5aa022d..HEAD
```

Expected: all verification is fresh and green; only the intended runtime/test/plan files changed across the feature commits; package files remain unchanged; nothing has been pushed. Use `superpowers:finishing-a-development-branch` only after this evidence and the whole-branch review are clean.

## Completion Criteria

- Stage 1 independently supplies schemas/indexes/injection/fakes/allowlists without changing runtime behavior.
- Stage 2 independently supplies readable/versioned room details and synchronized notification preferences with safe login/switch state.
- Stage 3 independently supplies exact-role bounded pins and race-safe deletion with strictly increasing recipient-visible versions.
- Stage 4 independently prevents blocked content from crossing the backend boundary while preserving private asymmetric recovery/reveal behavior.
- Stage 5 independently makes unread/mention cursors exact, durable, monotonic, blocker-aware, multi-session, and reconnect-consistent.
- Stage 6 exposes all five features through version/token/socket-safe, keyboard/mobile accessible UI while preserving `Chat v1.3.2`, reduced motion, the three-file runtime, and the removed performance behavior.
- The final full suite, syntax checks, inline compilation, static ID/title checks, diff hygiene, credential scan, policy matrices, and whole-branch security/concurrency review all pass before any push.
