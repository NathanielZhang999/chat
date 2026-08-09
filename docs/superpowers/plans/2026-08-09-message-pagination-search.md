# Message Pagination and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe initial history, cursor-based older-message loading, and bounded current-room search without changing the three-file production architecture.

**Architecture:** A shared viewer-aware serializer and `(timestamp, _id)` keyset helpers feed initial switch history, `list_messages`, and `search_messages`. Every read executes under the existing account-then-room authorization boundary, while one client read coordinator rejects stale room, cursor, and search responses and preserves scroll position when older rows are prepended.

**Tech Stack:** Node.js, Express, Socket.IO, Mongoose/MongoDB Atlas, browser JavaScript in one `chat.html`, Node's built-in test runner, existing in-memory Socket.IO/model fakes.

## Global Constraints

- Production remains exactly `chat.html`, `backend/server.js`, and `backend/package.json`; tests and documentation are non-runtime files.
- Add no dependency and do not modify `backend/package.json` unless an independently reviewed blocker proves it necessary.
- Optimize for one free-plan Render web-service process plus MongoDB Atlas.
- Global Chat retains legacy messages whose `serverCode` is missing or `null`.
- Active room bans block initial history, pagination, search, and privileged message reads for every role; timeouts still permit reading and search.
- Global-admin membership bypass never bypasses an active persisted ban.
- All room reads use fresh persisted User, room, membership, moderator, and restriction state.
- Lock order remains identity allocation -> account transition -> room mutation; never reverse it.
- Normal history and search never expose Message `history`, `__v`, internal database fields, deleted content to unauthorized viewers, raw attachment bodies in search results, or query/message content in logs.
- Search is current-room only, case-insensitive substring matching over current non-deleted text, with NFKC normalization, 2–80 characters, at most 20 results, and bounded rate limiting.
- Page size defaults to 20 and is clamped to at most 50; cursors are opaque validated `(timestamp, _id)` values.
- Client acknowledgements mutate state only when normalized room, client context, room epoch, and request identity still match.
- No push occurs from task workers. After task and whole-branch reviews pass, the controller locally merges, verifies again, and pushes the tested commit to GitHub's `deploy-chat` branch. Preserve and publish `backup/pre-public-ready-features-2026-08-08` as the rollback point.
- Never stage the user-owned root `node_modules/`, `package.json`, or `package-lock.json`.

---

### Task 1: Add Safe Message Serialization, Cursor Primitives, and Indexes

**Files:**
- Modify: `backend/server.js:240-285`
- Modify: `backend/server.js:646-663`
- Modify: `backend/server.js:3360-3410`
- Test: `backend/test/message-actions.test.js`

**Interfaces:**
- Produces: `messageRoomQuery(serverCode: string): object`
- Produces: `messageCursorQuery(cursor: { date: Date, id: string } | null): object`
- Produces: `nextMessagePage(rows: object[], limit: number): { page: object[], nextCursor: string | null }`
- Produces: `normalizeMessageSearchQuery(value: unknown): string | null`
- Produces: `safeMessageForViewer(message: object, viewer: { username: string, role: string, roomRole: string }, options?: { search?: boolean }): object`
- Consumes: existing `encodeCursor`, `decodeCursor`, `normalizePageLimit`, `sanitizeAttachment`, `normalizeServerCode`, and `isValidObjectId`.

- [ ] **Step 1: Write failing serializer and query-helper tests**

Add direct tests that construct a stored message containing every public field plus `history`, `__v`, an arbitrary secret field, attachment, reply content, and reactions. Assert an ordinary serialized message has only the approved keys and sanitized attachment; a non-owner deleted row has empty content/reply/reactions; an author/admin/current exact-room moderator retains the current deleted content allowed by existing policy; search rows omit attachment and reactions; and no result contains `history` or `__v`.

```js
test('safeMessageForViewer allowlists ordinary and deleted history fields', () => {
  const stored = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'Alice',
    displayName: 'Alice', role: 'user', roomRole: 'user', color: '#123456', avatarUrl: '',
    text: 'current', attachment: null, replyTo: { id: '507f1f77bcf86cd799439012', displayname: 'Bob', text: 'reply' },
    reactions: { '👍': ['Bob'] }, edited: true, deleted: false,
    timestamp: new Date('2026-08-09T00:00:00.000Z'),
    history: [{ text: 'old secret' }], __v: 7, secret: 'never return'
  };
  const approvedKeys = [
    '_id', 'serverCode', 'username', 'displayName', 'role', 'roomRole', 'color',
    'avatarUrl', 'text', 'attachment', 'replyTo', 'reactions', 'edited', 'deleted', 'timestamp'
  ];
  const ordinary = safeMessageForViewer(stored, { username: 'Bob', role: 'user', roomRole: 'user' });
  assert.deepEqual(Object.keys(ordinary).sort(), approvedKeys.sort());
  assert.equal('history' in ordinary, false);
  assert.equal('__v' in ordinary, false);

  const deleted = safeMessageForViewer({ ...stored, deleted: true }, {
    username: 'Bob', role: 'user', roomRole: 'user'
  });
  assert.equal(deleted.text, '');
  assert.equal(deleted.attachment, null);
  assert.deepEqual(deleted.reactions, {});
  assert.equal(deleted.replyTo, null);
});

test('message keyset query and next cursor handle equal timestamps without duplicates', () => {
  const cursor = { date: new Date('2026-08-09T00:00:00.000Z'), id: '507f1f77bcf86cd799439020' };
  assert.deepEqual(messageCursorQuery(cursor), { $or: [
    { timestamp: { $lt: cursor.date } },
    { timestamp: cursor.date, _id: { $lt: cursor.id } }
  ] });
  const rows = Array.from({ length: 21 }, (_, index) => ({
    _id: `507f1f77bcf86cd799439${String(40 - index).padStart(3, '0')}`,
    timestamp: new Date(1_800_000_000_000 - index)
  }));
  const result = nextMessagePage(rows, 20);
  assert.equal(result.page.length, 20);
  assert.ok(result.nextCursor);
});

test('search normalization accepts bounded NFKC text and rejects malformed input', () => {
  assert.equal(normalizeMessageSearchQuery('  cafe\u0301  '), 'café');
  for (const value of [null, {}, 'x', 'x'.repeat(81)]) {
    assert.equal(normalizeMessageSearchQuery(value), null);
  }
});
```

- [ ] **Step 2: Run the focused tests and capture RED**

Run: `cd backend && node --test --test-name-pattern='safeMessageForViewer|message keyset|search normalization' test/message-actions.test.js`

Expected: FAIL because the new helpers are not exported and the Message schema lacks the compound index.

- [ ] **Step 3: Implement pure helpers and the Message index**

Add the index immediately after `MessageSchema`:

```js
MessageSchema.index({ serverCode: 1, timestamp: -1, _id: -1 });
MessageSchema.index({ timestamp: -1, _id: -1 });
```

Implement strict room/cursor/query helpers. Global keeps the existing legacy `$or`:

```js
function messageRoomQuery(serverCode) {
  return serverCode === 'global'
    ? { $or: [
        { serverCode: 'global' },
        { serverCode: { $exists: false } },
        { serverCode: null }
      ] }
    : { serverCode };
}

function messageCursorQuery(cursor) {
  if (!cursor) return {};
  return { $or: [
    { timestamp: { $lt: cursor.date } },
    { timestamp: cursor.date, _id: { $lt: cursor.id } }
  ] };
}

function nextMessagePage(rows, limit) {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: hasMore && last ? encodeCursor(last.timestamp, last._id) : null
  };
}

function normalizeMessageSearchQuery(value) {
  if (typeof value !== 'string') return null;
  const query = value.normalize('NFKC').trim();
  return query.length >= 2 && query.length <= 80 ? query : null;
}
```

Implement `safeMessageForViewer` by constructing a new object field-by-field. Normalize `_id` to a string, sanitize attachments, shallow-copy only bounded reply fields and reactions, never spread the stored document, and apply deleted/search redaction before returning.

Export the five helpers through `module.exports` for direct tests.

- [ ] **Step 4: Run focused and adjacent tests**

Run: `cd backend && node --test test/message-actions.test.js test/chat-security.test.js`

Expected: PASS with zero failures.

- [ ] **Step 5: Review and commit Task 1**

Review `git diff -- backend/server.js backend/test/message-actions.test.js` for field allowlisting and schema-index exactness.

```bash
git add -- backend/server.js backend/test/message-actions.test.js
git commit -m "fix: serialize message history safely"
```

---

### Task 2: Paginate Initial History and Add `list_messages`

**Files:**
- Modify: `backend/server.js:807-850`
- Modify: `backend/server.js:2870-2985`
- Test: `backend/test/room-lifecycle.test.js`
- Test support: `backend/test/support/fakes.js`

**Interfaces:**
- Consumes: Task 1 `messageRoomQuery`, `messageCursorQuery`, `nextMessagePage`, and `safeMessageForViewer`.
- Produces: switch acknowledgement `{ history, nextCursor, roomRole, restriction }`.
- Produces: Socket.IO `list_messages(payload, ack)` where payload is `{ serverCode, clientContextId, cursor?, limit? }` and acknowledgement is `{ messages, nextCursor, serverCode, clientContextId }` or `{ error }`.

- [ ] **Step 1: Add failing real-handler history tests**

Add fixtures with more than 20 messages, equal-timestamp ObjectIds, deleted rows, internal edit history, legacy Global rows, and query deferrals. Register the real connection handler and assert:

```js
test('switch_server returns a safe initial page and cursor', async () => {
  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);
  const response = ack.value();
  assert.equal(response.history.length, 20);
  assert.ok(response.nextCursor);
  assert.deepEqual(response.history.map(row => row._id), expectedRows.slice(0, 20).reverse().map(row => row._id));
  assert.equal(response.history.some(row => 'history' in row || '__v' in row), false);
});

test('list_messages paginates timestamp ties without gaps or duplicates', async () => {
  const firstAck = acknowledge();
  await socket.trigger('list_messages', {
    serverCode: 'ABC123', clientContextId: 4, limit: 20
  }, firstAck.callback);
  const first = firstAck.value();
  const secondAck = acknowledge();
  await socket.trigger('list_messages', {
    serverCode: 'ABC123', clientContextId: 4, cursor: first.nextCursor, limit: 20
  }, secondAck.callback);
  const second = secondAck.value();
  assert.equal(new Set([...first.messages, ...second.messages].map(row => row._id)).size, 40);
});
```

Build `expectedRows` directly in the fixture before the snippet. Add separate real-handler cases that defer the Message query, complete a ban under the same account/room locks, release the query, and assert `{ error: 'Permission denied.' }`; store a future `timeoutUntil` instead and assert the page succeeds. Also test invalid/missing cursor, noninteger limit, maximum clamping, intended-room mismatch, invalid context, terminal `nextCursor: null`, missing/deleted rooms, and legacy Global `serverCode` variants.

- [ ] **Step 2: Run the focused lifecycle tests and capture RED**

Run: `cd backend && node --test --test-name-pattern='safe initial page|list_messages|legacy Global pagination' test/room-lifecycle.test.js`

Expected: FAIL because switch history still returns 100 rows and no `list_messages` handler exists.

- [ ] **Step 3: Upgrade only the query fake capabilities required by real-handler tests**

In `backend/test/support/fakes.js`, extend the in-memory query adapter to support the exact nested `$and`/`$or`, `$lt`, `$exists`, sort, limit, and lean chain used by message pagination. Keep prior fake semantics unchanged and add a direct fake regression if the change is nontrivial.

- [ ] **Step 4: Create one locked message-read helper inside `createConnectionHandler`**

Implement a helper that validates the current room/context, acquires account then room lock, reloads access, derives fresh room role, runs the bounded operation, and invokes the safe acknowledgement before releasing the room boundary:

```js
async function deliverMessageRead({ serverCode, clientContextId, callback, operation }) {
  return withAccountTransitionLock(socket.username, () =>
    withRoomMutationLock(serverCode, async () => {
      const access = await loadRoomAccessState({
        UserModel, ChatServerModel, RoomRestrictionModel,
        username: socket.username, serverCode
      });
      if (!access.room || !access.allowed || socket.serverCode !== serverCode ||
          !canAccessRoom(socket, serverCode)) {
        callback({ error: 'Permission denied.' });
        return;
      }
      const roomRole = currentRoomRole(access.room, access.user.username);
      callback(await operation({ access, roomRole, clientContextId }));
    })
  );
}
```

Do not use cached `socket.role` or cached moderator state to serialize privileged deleted content.

- [ ] **Step 5: Refactor `switch_server` initial history**

Move the bounded query into the successful account-then-room switch boundary so authorization, query, serialization, transport transition, and acknowledgement ordering cannot disclose a page after a completed ban. Query 21 newest rows, use `nextMessagePage(rows, 20)`, serialize with fresh `access.user.role` and `roomRole`, reverse only the returned page for chronological rendering, and include `nextCursor`.

Preserve fail-closed transport behavior and existing presence broadcasts. If moving the query changes a deliberate concurrency test, update its release ordering without weakening the post-ban disclosure assertion.

- [ ] **Step 6: Implement `list_messages`**

Validate exactly:

```js
const serverCode = normalizeServerCode(data?.serverCode);
const clientContextId = normalizeClientContextId(data?.clientContextId);
const limit = normalizePageLimit(data?.limit);
const cursor = data?.cursor == null ? null : decodeCursor(data.cursor);
if (!serverCode || clientContextId === null || limit === null ||
    (data?.cursor != null && !cursor) || serverCode !== socket.serverCode) {
  return callback({ error: 'Invalid input format.' });
}
```

Build the Mongo filter with `$and: [messageRoomQuery(serverCode), messageCursorQuery(cursor)]`, sort newest first, fetch `limit + 1`, serialize with fresh access, reverse the page, and echo the accepted room/context.

- [ ] **Step 7: Run focused and full lifecycle tests**

Run: `cd backend && node --test --test-name-pattern='switch_server|list_messages|history|ban|timeout' test/room-lifecycle.test.js`

Expected: PASS.

Run: `cd backend && node test/room-lifecycle.test.js`

Expected: PASS with zero failures.

- [ ] **Step 8: Review and commit Task 2**

Confirm every database query is bounded, every acknowledgement echoes room/context, and no read reverses the lock order.

```bash
git add -- backend/server.js backend/test/room-lifecycle.test.js backend/test/support/fakes.js
git commit -m "feat: paginate room message history"
```

---

### Task 3: Add Bounded Current-Room Message Search

**Files:**
- Modify: `backend/server.js:20-45`
- Modify: `backend/server.js:331-375`
- Modify: `backend/server.js:807-850`
- Modify: `backend/server.js` near `list_messages`
- Test: `backend/test/message-actions.test.js`
- Test: `backend/test/room-lifecycle.test.js`

**Interfaces:**
- Consumes: Task 1 `normalizeMessageSearchQuery`, `messageRoomQuery`, `safeMessageForViewer` and existing `escapeRegExp`.
- Consumes: Task 2 `deliverMessageRead` authorization boundary.
- Produces: `messageSearchRateLimiter` with 30 attempts per rolling 60 seconds and at most 10,000 keys.
- Produces: Socket.IO `search_messages({ serverCode, clientContextId, query, requestId }, ack)` returning `{ results, serverCode, clientContextId, requestId }` or `{ error }`.

- [ ] **Step 1: Write failing real-handler search tests**

Add tests proving:

```js
test('search_messages escapes substring input and isolates the active room', async () => {
  let observedFilter;
  const MessageModel = { find(filter) { observedFilter = filter; return boundedQuery([matchingRow]); } };
  const { socket } = registerMessages({ MessageModel });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  const ack = acknowledge();
  await socket.trigger('search_messages', {
    serverCode: 'ABC123', clientContextId: 4, query: 'a+b', requestId: 9
  }, ack.callback);
  const response = ack.value();
  assert.deepEqual(response.results.map(row => row._id), ['matching-current-room-id']);
  assert.equal(response.results.some(row => row.attachment || row.reactions || row.history), false);
  assert.equal(observedFilter.$and[2].text.source, 'a\\+b');
});
```

Define `matchingRow` and `boundedQuery` in the test next to the fixture using the existing `queryResult` chain shape. Add one search fixture containing a deleted row whose current text and edit history include `secret`; assert the handler's query contains `{ deleted: { $ne: true } }` and returns no row. Add a deferred real-handler case that pauses immediately before the locked search query, completes a ban, resumes the request, and asserts `{ error: 'Permission denied.' }`. Also cover timeout allowance, global-admin active-ban denial, malformed types, NFKC normalization, 1/2/80/81-character boundaries, nonpositive or noninteger request IDs, room/context mismatch, maximum 20 results, rate-limit exhaustion/reset, generic error logging, and query-content redaction from logs.

- [ ] **Step 2: Run the focused search tests and capture RED**

Run: `cd backend && node --test --test-name-pattern='search_messages|search normalization|search rate' test/message-actions.test.js test/room-lifecycle.test.js`

Expected: FAIL because the handler and search limiter are absent.

- [ ] **Step 3: Add a dedicated bounded search limiter**

Create one server-level limiter:

```js
const messageSearchRateLimiter = createRateLimiter({
  maxEntries: MAX_RATE_LIMIT_KEYS,
  maxAttempts: 30,
  windowMs: 60 * 1000
});
```

Inject it as `searchRateLimiter = messageSearchRateLimiter` in `createConnectionHandler`. Key requests by normalized account and transport address:

```js
const key = authRateLimitKey(socket, 'message_search', normalizeAccountKey(socket.username));
if (!searchRateLimiter.check(key)) return callback({ error: 'Too many requests. Try again later.' });
```

- [ ] **Step 4: Implement `search_messages` through the locked read helper**

Require a plain-object payload, normalized active room, positive safe integer context/request IDs, and normalized query. Escape the normalized query before creating the regex:

```js
const textPattern = new RegExp(escapeRegExp(query), 'i');
const filter = {
  $and: [
    messageRoomQuery(serverCode),
    { deleted: { $ne: true } },
    { text: textPattern }
  ]
};
```

Select only search-required fields, sort `{ timestamp: -1, _id: -1 }`, limit 20, and use `safeMessageForViewer(..., { search: true })`. A search result must include ID, author/display metadata, edited state, text, timestamp, and room code, but no attachment body, reply snapshot, reactions, edit history, or internal field.

Log only the event name and error type through `logUnexpectedError`; never log `query`, regex source, or returned text.

- [ ] **Step 5: Run search, moderation, and message tests**

Run: `cd backend && node --test --test-name-pattern='search_messages|ban|timeout|moderation' test/message-actions.test.js test/moderation.test.js`

Expected: PASS.

Run: `cd backend && node test/message-actions.test.js`

Expected: PASS with zero failures.

- [ ] **Step 6: Review and commit Task 3**

Confirm the regex is escaped, the room filter cannot be overridden, deleted rows are excluded before matching, and the query never appears in logs.

```bash
git add -- backend/server.js backend/test/message-actions.test.js backend/test/room-lifecycle.test.js
git commit -m "feat: add bounded room message search"
```

---

### Task 4: Add the Client Read Coordinator and Older-Message UI

**Files:**
- Modify: `chat.html:80-115`
- Modify: `chat.html:520-620`
- Modify: `chat.html:620-1320`
- Modify: `chat.html:2860-2980`
- Modify: `chat.html:3210-3410`
- Test: `backend/test/client-smoke.test.js`

**Interfaces:**
- Produces: `ChatClientHelpers.createMessageReadCoordinator({ onOlderPendingChange, onSearchPendingChange })`.
- Produces: `ChatClientHelpers.prependScrollTop({ oldScrollHeight, oldScrollTop, newScrollHeight }): number`.
- Produces: `ChatClientHelpers.uniqueMessages(existingIds: Set<string>, messages: object[]): object[]`.
- Consumes: switch response `history` and `nextCursor`; `list_messages` response `{ messages, nextCursor, serverCode, clientContextId }`.

- [ ] **Step 1: Write failing coordinator and scroll tests**

Add executable helper tests, not source-token checks:

```js
test('message read coordinator rejects stale room and older-page acknowledgements', () => {
  const coordinator = helpers.createMessageReadCoordinator();
  coordinator.activate('ABC123', 4, 'cursor-a');
  const token = coordinator.beginOlder();
  coordinator.activate('XYZ789', 5, 'cursor-b');
  assert.equal(coordinator.finishOlder(token, {
    serverCode: 'ABC123', clientContextId: 4, messages: [], nextCursor: null
  }), null);
});

test('prepend scroll preserves the visible anchor and history rows deduplicate', () => {
  assert.equal(helpers.prependScrollTop({
    oldScrollHeight: 800, oldScrollTop: 120, newScrollHeight: 1100
  }), 420);
  assert.deepEqual(helpers.uniqueMessages(new Set(['2']), [{ _id: '1' }, { _id: '2' }]), [{ _id: '1' }]);
});
```

Cover one pending older request at a time, cursor replacement only on accepted ack, invalidation on room/lobby/access/socket changes, lost acknowledgement reset, and terminal `nextCursor` behavior.

- [ ] **Step 2: Run focused client tests and capture RED**

Run: `cd backend && node --test --test-name-pattern='message read coordinator|prepend scroll|older message' test/client-smoke.test.js`

Expected: FAIL because the helpers and controls do not exist.

- [ ] **Step 3: Implement pure coordinator helpers**

Use monotonically increasing epochs and frozen request tokens. `beginOlder()` must fail when no room, no cursor, or a request is pending. `finishOlder()` must validate token epoch, room, context, echoed response room/context, and current pending identity before returning accepted data and clearing pending state.

`invalidate()` increments the epoch, clears room/context/cursor, and calls both pending-control callbacks with `false`. Do not make DOM calls inside the pure coordinator.

- [ ] **Step 4: Add the Load Older control and styling**

Place a compact `#load-older-messages` button as the first child of `#chat-window` through a lightweight history-controls wrapper. It must be keyboard accessible, hidden without a cursor, disabled while pending, and must not reduce the mobile chat viewport.

Do not add a fourth runtime file or inline event state in generated message HTML.

- [ ] **Step 5: Wire initial switch history and older pages**

On accepted switch:

```js
messageReadCoordinator.activate(
  targetServerCode,
  compositionContextCoordinator.current().clientContextId,
  response.nextCursor || null
);
loadHistory(response.history, { replace: true });
renderOlderControl();
```

`loadOlderMessages()` obtains a token, emits `list_messages`, and makes the coordinator guard the acknowledgement callback's first state-changing statement. On acceptance:

1. record `oldScrollHeight` and `oldScrollTop`;
2. deduplicate incoming IDs;
3. prepend each row without animation;
4. set `chatWindow.scrollTop` to `prependScrollTop(...)`;
5. render the updated cursor/control.

Refactor `appendMessage` to support an explicit insertion target or add a focused `renderMessageElement` helper so pagination can prepend without duplicating rendering logic. Initial history still performs one final automatic bottom scroll; older pages never do.

- [ ] **Step 6: Invalidate message reads at every access boundary**

Call `messageReadCoordinator.invalidate()` before clearing or changing room UI in accepted switch, `enterLobby`, kick/ban/access loss, logout, socket replacement, and forced privilege/access reset. Re-enable controls on invalidation even if an acknowledgement never arrives.

- [ ] **Step 7: Run client and lifecycle tests**

Run: `cd backend && node test/client-smoke.test.js`

Expected: PASS.

Run: `cd backend && node --test --test-name-pattern='switch_server|list_messages' test/room-lifecycle.test.js`

Expected: PASS.

- [ ] **Step 8: Review and commit Task 4**

Confirm older pages preserve the visible anchor, no page callback can mutate a later room, and the initial history path still scrolls once without entrance animation.

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "feat: load older room messages"
```

---

### Task 5: Add Search UI and Guard Privileged Message Modals

**Files:**
- Modify: `chat.html:80-115`
- Modify: `chat.html:350-620`
- Modify: `chat.html:620-1320`
- Modify: `chat.html:2860-2980`
- Modify: `chat.html:3150-3220`
- Test: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: Task 4 message-read coordinator.
- Produces: Search modal controls `#message-search-modal`, `#message-search-input`, `#message-search-submit`, `#message-search-results`, and `#message-search-status`.
- Consumes: `search_messages` response `{ results, serverCode, clientContextId, requestId }`.
- Produces: guarded room-context tokens for `get_edit_history` and `get_deleted_message` callbacks.

- [ ] **Step 1: Write failing search-state and modal-read tests**

Add executable tests proving latest-search wins, older response rejection, close/reopen and room-switch invalidation, lost acknowledgement control reset, safe text rendering, and context-guarded edit/deleted responses:

```js
test('latest accepted room search wins and close invalidates late results', () => {
  const coordinator = helpers.createMessageReadCoordinator();
  coordinator.activate('ABC123', 7, null);
  const first = coordinator.beginSearch();
  const second = coordinator.beginSearch({ supersede: true });
  const response = token => ({
    serverCode: token.roomCode,
    clientContextId: token.clientContextId,
    requestId: token.requestId,
    results: []
  });
  assert.equal(coordinator.finishSearch(first, response(first)), null);
  assert.ok(coordinator.finishSearch(second, response(second)));
  coordinator.closeSearch();
  assert.equal(coordinator.finishSearch(second, response(second)), null);
});

test('room read token rejects edit history after a switch', () => {
  const token = coordinator.beginDetail('ABC123', 7, 'message-id');
  coordinator.activate('XYZ789', 8, null);
  assert.equal(coordinator.finishDetail(token), false);
});
```

Use a controlled DOM/socket VM test to prove hostile result text is inert, the acknowledgement guard precedes DOM mutation, and exact search room/context/request values are sent.

- [ ] **Step 2: Run focused client tests and capture RED**

Run: `cd backend && node --test --test-name-pattern='latest accepted room search|search modal|room read token' test/client-smoke.test.js`

Expected: FAIL because search/detail coordination and modal wiring are absent.

- [ ] **Step 3: Extend the coordinator for search and detail requests**

`beginSearch({ supersede: true })` increments a search request ID, clears pending state for the older request, and returns a frozen token containing epoch, room, context, and request ID. `finishSearch` accepts only the exact latest token plus echoed room/context/request values.

`beginDetail(messageId)` returns a token bound to the active room/context and message. `finishDetail(token)` returns true only while that exact room epoch remains active. Search close invalidates only search tokens; full room/access invalidation rejects every token.

- [ ] **Step 4: Add compact search controls and modal**

Add a `Search` header button visible only with an active accessible room. The modal uses the existing modal visual language and includes bounded `maxlength="80"`, Search, and Close controls. Escape submits; Enter searches; empty/short input shows a local validation message without emitting.

Render each result using `textContent`/`appendTextElement` for author, exact timestamp, and snippet. Reuse trusted mention formatting only after the server returns sanitized current text. Do not use result text in `innerHTML` unless it passes the existing trusted message formatter exactly as live messages do.

- [ ] **Step 5: Wire `search_messages` with latest-request semantics**

The acknowledgement callback begins with the token guard:

```js
socket.emit('search_messages', payload, response => {
  const accepted = messageReadCoordinator.finishSearch(token, response);
  if (!accepted) return;
  renderSearchResults(accepted.results);
});
```

Search results remain separate from `#chat-window`. Clicking a result already present in the live DOM scrolls and highlights it; otherwise show `This message is outside the loaded history.` without requesting hidden context.

- [ ] **Step 6: Guard edit-history and deleted-message callbacks**

Before emitting, capture a detail token containing current room/context/message ID. The callback's first state-changing operation must be `finishDetail(token)`. Close the modal and invalidate detail state on switch, lobby, kick/ban, logout, or socket replacement. A stale response must not reveal original or edit-history content in a later room.

- [ ] **Step 7: Run client and full focused backend tests**

Run: `cd backend && node test/client-smoke.test.js`

Expected: PASS.

Run: `cd backend && node --test test/message-actions.test.js test/room-lifecycle.test.js`

Expected: PASS with zero failures.

- [ ] **Step 8: Review and commit Task 5**

Confirm every search/detail callback is epoch-guarded before DOM mutation, result text is inert, and search controls reset after lost acknowledgements.

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "feat: add room message search interface"
```

---

### Task 6: Cross-Cutting Privacy Matrix and Release Verification

**Files:**
- Modify: `backend/test/message-actions.test.js`
- Modify: `backend/test/room-lifecycle.test.js`
- Modify: `backend/test/client-smoke.test.js`
- Modify only if a regression proves a defect: `backend/server.js`, `chat.html`

**Interfaces:**
- Consumes: every Task 1–5 interface.
- Produces: one release-gate matrix proving initial history, pagination, search, client epochs, and serializer privacy together.

- [ ] **Step 1: Add the complete read-policy matrix**

Create table-driven real-handler cases for:

```js
const readMatrix = [
  ['member', 'private', 'active', 'initial', true],
  ['member', 'private', 'timeout', 'page', true],
  ['member', 'private', 'timeout', 'search', true],
  ['member', 'private', 'ban', 'page', false],
  ['room-mod', 'same-private', 'active', 'search', true],
  ['room-mod', 'other-private', 'active', 'search', false],
  ['admin', 'private-nonmember', 'active', 'page', true],
  ['admin', 'private-nonmember', 'ban', 'search', false],
  ['member', 'global', 'active', 'page', true],
  ['member', 'global', 'ban', 'search', false]
];
```

Each allowed row asserts room isolation, safe fields, cursor/request echo, and no edit-history leakage. Each denied row asserts no query result disclosure. Add races where ban/demotion completes while a page, search, edit-history, or deleted-message lookup is deferred; the completed revocation must win before acknowledgement.

- [ ] **Step 2: Add client integration regressions**

Use the controlled VM/DOM/socket harness to simulate switch A -> pending older/search/detail -> switch B/lobby -> late A acknowledgements. Assert B's DOM, cursors, modal, scroll, and controls remain unchanged. Simulate duplicate cursor boundary rows plus intervening live edit/delete events and assert one row per ID with the latest mutation visible.

- [ ] **Step 3: Run the new matrix and capture the expected result**

Run: `cd backend && node --test --test-name-pattern='complete message read policy matrix|stale message read integration' test/message-actions.test.js test/room-lifecycle.test.js test/client-smoke.test.js`

Expected: PASS if Tasks 1–5 fully satisfy the design. If it fails, preserve the focused failure, make the minimal production correction, and rerun until GREEN.

- [ ] **Step 4: Run the full release gate**

Run: `cd backend && npm test`

Expected: all test files pass with zero failures.

Run: `node --check backend/server.js`

Expected: exit 0.

Compile every non-empty inline `chat.html` script with `vm.Script`; expected: every script compiles.

Run duplicate-ID validation over `chat.html`; expected: zero duplicate IDs.

Run: `git diff --check`

Expected: exit 0.

Run a high-confidence credential scan over changed files; expected: no live token, password-bearing Atlas URI, or private key. The inert test URI `mongodb://database/chat` is allowed.

- [ ] **Step 5: Verify architecture and deployment constraints**

Confirm:

- only `chat.html` and `backend/server.js` changed in production;
- `backend/package.json` and dependencies are unchanged;
- every Message query is bounded and indexed where possible;
- legacy Global rows remain visible;
- active bans deny every read path while timeouts allow them;
- no query/message content appears in logs;
- root user-owned untracked files are unstaged; and
- the backup tag still resolves to `857e2f1`.

- [ ] **Step 6: Review and commit Task 6**

```bash
git add -- backend/test/message-actions.test.js backend/test/room-lifecycle.test.js backend/test/client-smoke.test.js backend/server.js chat.html
git commit -m "test: cover complete message read policy"
```

If `backend/server.js` or `chat.html` is unchanged during this task, omit it from `git add`.

---

## Controller Review and Publication Gate

After all six tasks:

1. Request one whole-branch review against `docs/superpowers/specs/2026-08-09-message-pagination-search-design.md`, explicitly checking privacy serialization, ban/read races, cursor correctness, regex safety, stale client callbacks, scroll anchoring, indexes, and three-file architecture.
2. Address all Critical and Important findings with focused RED/GREEN regressions, then request one scoped re-review.
3. Run the full verification gate fresh from the controller.
4. Merge the verified feature branch locally into `main` using fast-forward when possible.
5. Run the full suite and syntax/hygiene checks again on merged `main`.
6. Use the GitHub publication workflow to push the verified `main` commit to `origin/deploy-chat`, not remote `main`, so Render deploys the tested branch.
7. Push annotated tag `backup/pre-public-ready-features-2026-08-08` if it is not already present remotely.
8. Verify the remote `deploy-chat` SHA equals local `main` and report the commit/tag. Do not force-push; if remote history diverged, stop and inspect before publishing.

## Completion Criteria

- Initial history returns 20 safe messages and an opaque next cursor.
- Older pages are complete, ordered, deduplicated, and preserve scroll position.
- Current-room search is bounded, escaped, rate-limited, privacy-safe, and latest-request-wins.
- No normal history/search response contains edit history or internal database fields.
- Bans block every read path, timeouts do not, and completed revocations cannot leak late results.
- Runtime remains exactly three files with no dependency change.
- Full verification and independent review are clean on the published commit.
