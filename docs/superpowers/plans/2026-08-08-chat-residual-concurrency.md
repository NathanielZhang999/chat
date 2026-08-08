# Chat Residual Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining account-publication, room-deletion, and frontend-wiring races on the single-instance Render deployment.

**Architecture:** Retain the global identity-allocation lock, add keyed per-account transition locks, and make the final room switch plus room deletion share the existing keyed room lock. Move rejected-switch state/DOM effects into an extracted production wiring helper whose behavior is executed by the Node VM smoke harness.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, Express 4, Socket.IO 4, Mongoose 8, bcryptjs, plain inline HTML/CSS/JavaScript.

## Global Constraints

- The production chat application remains exactly `chat.html`, `backend/server.js`, and `backend/package.json`.
- Do not create another production JavaScript, CSS, HTML, README, environment, helper, dependency, framework, or build-system file.
- Test-only files remain under `backend/test/`; no MongoDB schema or migration changes.
- The backend deployment is one Node.js process on a Render Free web-service instance.
- MongoDB remains authoritative for user membership, global role, profile, rooms, and messages.
- Preserve Socket.IO event names, acknowledgement object shapes, room roles, visible workflows, and global-administrator ghost access.
- Every concurrency regression uses controlled deferred promises and real handlers registered by `createConnectionHandler`.
- Locks always release in `finally`; metadata-only error logging must not include raw payloads, credentials, messages, attachments, or replies.

---

### Task 1: Serialize account state publication

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/test/room-lifecycle.test.js`
- Test support: `backend/test/support/fakes.js`

**Interfaces:**
- Preserves `withIdentityMutationLock(operation)` for global case-insensitive name allocation.
- Produces `withAccountTransitionLock(username, operation)`, keyed by normalized lowercase username and exported for focused testing.
- Login, room leave, global-role changes, and profile changes use the keyed lock before publishing account state.

- [ ] **Step 1: Add failing keyed-lock and concurrent-publication tests**

Append tests using the existing `deferred()` helper. The keyed-lock unit test must prove same-account serialization, different-account independence, lowercase key normalization, and release after rejection:

```js
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
```

Add these real-handler regressions with two registered sockets, one same-account map-only session (`onlineUsersMap.set('map-only', ...)` with no corresponding fetched socket), and controlled `UserModel.findOne()`/`save()` promises:

| Test name | Deferred interleaving | Required assertions |
| --- | --- | --- |
| `login cannot publish membership removed by a concurrent leave` | First regex user read returns a detached `['global', 'ABC123']` login snapshot; pause the first bcrypt comparison; complete `leave_server('ABC123')` against the canonical user; resume comparison/login. | Login acknowledgement `joinedServers` equals `['global']`; both sockets, their map entries, and the map-only entry equal `['global']`; neither transport contains `ABC123`. |
| `login cannot retain ghost access after concurrent global-admin demotion` | First regex read returns a detached admin snapshot; pause bcrypt; complete `demote_global_admin` against the canonical target; resume login and attempt `switch_server('ABC123')`. | Login acknowledgement, both socket/map pairs, and the map-only entry have role `user`; switch acknowledgement is `Permission denied.`; no private transport membership exists. |
| `login overlapping profile update publishes the final profile` | First regex user read returns a detached old-profile login snapshot; pause the first bcrypt comparison; complete `update_profile` against the canonical user; resume comparison/login. | Login acknowledgement, both sockets, and all matching online-map entries contain the new display name, color, and avatar URL; no old-profile value is republished. |
| `profile update reconciles a session that becomes live during the write` | Pause the canonical profile document's `save()`; after save begins, add a second authenticated socket/map entry with old profile fields; release save. | Before the acknowledgement, both sockets, their map entries, and the map-only entry contain the new display name, color, and avatar URL. |

For each test, construct two sockets with the same `FakeIo`, `onlineUsersMap`, and model doubles by setting unique socket IDs before calling `createConnectionHandler(overrides)(socket)`. Use `deferred()` to signal both “operation reached” and “operation may continue” rather than timing delays.

The test doubles must return a freshly read authoritative user document inside the account lock; they must not reuse one mutable object in a way that makes stale publication impossible by accident.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test-reporter=spec backend/test/room-lifecycle.test.js
```

Expected: the new lock export is absent and the concurrent login/profile assertions fail against stale published state.

- [ ] **Step 3: Add the keyed account lock**

Keep the existing global identity-allocation lock. Add:

```js
const accountTransitionTails = new Map();

async function withAccountTransitionLock(username, operation) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return operation();
  const previous = accountTransitionTails.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  accountTransitionTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (accountTransitionTails.get(key) === current) accountTransitionTails.delete(key);
  }
}
```

Export `withAccountTransitionLock` from `backend/server.js`.

- [ ] **Step 4: Make login publish only freshly locked account state**

Verify the submitted password before the account lock. Inside `withAccountTransitionLock(user.username, ...)`:

1. re-fetch the user case-insensitively;
2. reject if it disappeared or the current stored password no longer matches;
3. normalize missing `servers`/`displayName` and save if required;
4. query the visible server list from the fresh role/membership;
5. set socket fields, join `global`, populate `onlineUsersMap`, broadcast, and build the acknowledgement from that fresh document.

No socket identity, room, or online-map mutation occurs before the locked fresh read and all fallible success dependencies complete.

- [ ] **Step 5: Lock leave, demotion, and profile publication**

For `leave_server`, acquire `withAccountTransitionLock(socket.username, ...)`, re-fetch the user inside it, persist membership removal, then fetch live sockets after the write and call `synchronizeMembership` before acknowledging. Moderator cleanup remains after transport revocation and cannot restore access.

After reconciling fetched sockets, `synchronizeMembership` and `synchronizeProfile` must also scan `onlineUsersMap.values()` by normalized username so a matching entry is updated even when its socket is absent from `fetchLiveSockets()`. Global-role reconciliation must do the same independent map scan. For a map-only entry, update cached membership/role/profile synchronously and force its cached `serverCode` to `global` when access was revoked; transport eviction applies only when a live socket exists.

For global role change, acquire the target account lock, re-fetch the target inside it, save the new role, fetch live sockets after the write, synchronize every socket/map entry, evict invalid ghost views, and acknowledge only after reconciliation.

For profile update, preserve global name allocation with this fixed lock order: call `withIdentityMutationLock` first, then `withAccountTransitionLock(socket.username, ...)`; inside the nested callback, read the fresh user first, compare `dName` to that document's current display name, run the collision query only when those values differ case-insensitively, save the profile, call `fetchLiveSockets()`, call `synchronizeProfile()`, and return the acknowledgement payload. Do not base the collision decision on `socket.displayName`.

No code path may acquire the two locks in the reverse order.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test-reporter=spec backend/test/room-lifecycle.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
```

Expected: all pass with no warnings or unhandled rejections.

- [ ] **Step 7: Commit Task 1**

```bash
git add backend/server.js backend/test/room-lifecycle.test.js backend/test/support/fakes.js
git commit -m "fix: serialize account state publication"
```

---

### Task 2: Make room deletion and switching one serialized transition

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/test/room-lifecycle.test.js`

**Interfaces:**
- Consumes `withRoomMutationLock(serverCode, operation)`.
- Produces deletion whose live-socket snapshot occurs inside the room lock and switching whose final existence/access check plus transport commit occurs inside that same lock.

- [ ] **Step 1: Add failing late-switch/deletion tests**

Add these exact real-handler interleavings:

| Test name | Deferred interleaving | Required assertions |
| --- | --- | --- |
| `deletion snapshots after a queued switch commits` | Hold `ABC123`'s room lock with an authorized deferred message persistence; add a late authenticated socket to `FakeIo.sockets`; start `switch_server('ABC123')` and let its history preparation finish so its final transition is queued first; start `delete_server`; release message persistence; then await switch and deletion. Do not await switch acknowledgement before releasing the held lock. | The order log records the late socket joining `ABC123` before deletion calls `FakeIo.fetchSockets()`; deletion succeeds; the late socket and its map entry end in `global`; transport membership and cached membership exclude `ABC123`. |
| `a switch waiting behind deletion cannot join the deleted room` | Pause `ChatServerModel.deleteOne()` after deletion acquires the room lock; start `switch_server('ABC123')`; complete deletion; await switch. | Switch acknowledgement is `{ error: 'Server not found.' }`; its old room and cached state remain; it never joins `ABC123`. |

Use explicit “entered”, “history prepared”, and “release” deferreds for the held mutation/delete operation. After resolving the history-prepared gate, allow the switch handler's continuation to enqueue its room-lock operation before invoking `delete_server`; do not use timeouts or sleeps.

Instrument `FakeIo.fetchSockets()` call order so the first test proves deletion fetches its authoritative socket list only after it acquires the room lock.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test-reporter=spec backend/test/room-lifecycle.test.js
```

Expected: the late switched socket remains in `ABC123`, reproducing residual I9.

- [ ] **Step 3: Move deletion preflight inside the room lock**

Keep initial input validation outside. Inside `withRoomMutationLock(serverCode, async () => { ... })`, in this order:

1. re-fetch the room;
2. revalidate delete permission;
3. call `fetchLiveSockets()` before the first destructive write;
4. delete the room document;
5. synchronously strip cached membership from every fetched socket/map entry;
6. evict/move affected transports and emit authoritative access updates;
7. emit `server_deleted`;
8. attempt message and user cleanup independently;
9. return the existing success/error acknowledgement object.

There must be no socket snapshot captured outside the room lock and reused inside it.

- [ ] **Step 4: Put the final switch commit inside the same room lock**

History/role preparation may remain outside the lock. Wrap only the final authoritative boundary:

```js
const result = await withRoomMutationLock(serverCode, async () => {
  const currentRoom = await ChatServerModel.findOne({ code: serverCode });
  if (!currentRoom) return { error: 'Server not found.' };
  if (!canAccessRoom(socket, serverCode)) return { error: 'Permission denied.' };

  const oldCode = socket.serverCode;
  if (oldCode && oldCode !== serverCode) await Promise.resolve(socket.leave(oldCode));
  socket.serverCode = serverCode;
  await Promise.resolve(socket.join(serverCode));
  if (onlineUsersMap.has(socket.id)) onlineUsersMap.get(socket.id).serverCode = serverCode;
  return { success: true, oldCode };
});
```

On an error result, acknowledge it without UI/transport mutation. On success, acknowledge prepared history/role before starting presence broadcasts, using `result.oldCode`.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test-reporter=spec backend/test/room-lifecycle.test.js
node --test-reporter=spec backend/test/message-actions.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
```

Expected: all tests pass; deletion/action lock-order tests have no hangs.

- [ ] **Step 6: Commit Task 2**

```bash
git add backend/server.js backend/test/room-lifecycle.test.js
git commit -m "fix: serialize deletion and room switches"
```

---

### Task 3: Make frontend tests own the mutation boundary

**Files:**
- Modify: `chat.html`
- Modify: `backend/test/client-smoke.test.js`

**Interfaces:**
- Replaces `evaluateSwitchResult(...)` with `applySwitchResult({ currentServerCode, targetServerCode, response, showAlert, applySuccess })`.
- Keeps `bindConnectErrorRecovery(...)`, which registers and owns the actual connection-error effects.
- The production `handleSwitchResult` supplies its complete success state/DOM transition as `applySuccess`; it performs no room/DOM mutation outside that callback.

- [ ] **Step 1: Write failing production-helper behavior tests**

Replace the vacuous rejected-switch test with:

```js
test('production switch helper owns rejection and success mutation boundaries', () => {
  const helpers = loadHelpers();
  const alerts = [];
  const mutations = [];

  const rejected = helpers.applySwitchResult({
    currentServerCode: 'AAAAAA',
    targetServerCode: 'BBBBBB',
    response: { error: 'Denied.' },
    showAlert: (...args) => alerts.push(args),
    applySuccess: (...args) => mutations.push(args)
  });
  assert.equal(rejected.currentServerCode, 'AAAAAA');
  assert.deepEqual(alerts, [['Error', 'Denied.']]);
  assert.deepEqual(mutations, []);

  const accepted = helpers.applySwitchResult({
    currentServerCode: 'AAAAAA',
    targetServerCode: 'BBBBBB',
    response: { history: [], roomRole: 'user' },
    showAlert: () => { throw new Error('must not alert'); },
    applySuccess: (code, response) => mutations.push([code, response.roomRole])
  });
  assert.equal(accepted.currentServerCode, 'BBBBBB');
  assert.deepEqual(mutations, [['BBBBBB', 'user']]);
});
```

Replace the existing connection-error test with this table-driven production-helper test so both negative branches execute the registered callback and prove they are mutation-free:

```js
test('production connect-error binding mutates auth controls only for the active socket and modal', () => {
  const helpers = loadHelpers();

  for (const scenario of [
    { name: 'active socket and modal', current: true, modal: true, expectedDisabled: false, expectedErrors: 1 },
    { name: 'stale socket', current: false, modal: true, expectedDisabled: true, expectedErrors: 0 },
    { name: 'closed modal', current: true, modal: false, expectedDisabled: true, expectedErrors: 0 }
  ]) {
    const handlers = {};
    const activeSocket = { on(event, handler) { handlers[event] = handler; } };
    const otherSocket = {};
    const authButton = { disabled: true };
    const errors = [];

    helpers.bindConnectErrorRecovery({
      activeSocket,
      getCurrentSocket: () => scenario.current ? activeSocket : otherSocket,
      isAuthModalActive: () => scenario.modal,
      authButton,
      showError: (message, success) => errors.push({ message, success })
    });
    assert.equal(typeof handlers.connect_error, 'function', scenario.name);
    handlers.connect_error();
    assert.equal(authButton.disabled, scenario.expectedDisabled, scenario.name);
    assert.equal(errors.length, scenario.expectedErrors, scenario.name);
    if (scenario.expectedErrors) {
      assert.deepEqual(errors[0], {
        message: 'Unable to connect. Check the backend URL and try again.',
        success: false
      });
    }
  }
});
```

- [ ] **Step 2: Run the client smoke test and verify RED**

Run:

```bash
node --test-reporter=spec backend/test/client-smoke.test.js
```

Expected: FAIL because `applySwitchResult` does not exist and the old helper merely returns a decision.

- [ ] **Step 3: Implement the state-owning switch helper inline**

Inside the existing testable inline helper block, replace `evaluateSwitchResult` with:

```js
applySwitchResult({
  currentServerCode,
  targetServerCode,
  response,
  showAlert,
  applySuccess
}) {
  const normalizedResponse = response || { error: 'No response from server.' };
  if (normalizedResponse.error) {
    showAlert('Error', normalizedResponse.error);
    return { accepted: false, currentServerCode, response: normalizedResponse };
  }
  applySuccess(targetServerCode, normalizedResponse);
  return { accepted: true, currentServerCode: targetServerCode, response: normalizedResponse };
}
```

Refactor `handleSwitchResult` so its only operation is calling this helper. Put every successful mutation—`currentServerCode`, `myRoomRole`, icon classes, typing state, buttons, chat clearing, compose cancellation, safe title construction, and history loading—inside the `applySuccess` callback. It must not compute or mutate room-specific DOM state before the helper accepts the result.

- [ ] **Step 4: Verify connection-error ownership**

Keep `bindConnectErrorRecovery` as the exact function production `setupSocket` calls. It must register `connect_error` itself and directly own button/status mutation through the supplied adapters. The test above invokes that same extracted function and executes all three registered-callback cases.

- [ ] **Step 5: Run client and full verification**

Run:

```bash
node --test-reporter=spec backend/test/client-smoke.test.js
npm test --prefix backend
sed -n '/<script>/,/<\/script>/p' chat.html | sed '1d;$d' | node --check -
git diff --check
```

Expected: all pass; no dynamic untrusted `innerHTML` regression.

- [ ] **Step 6: Commit Task 3**

```bash
git add chat.html backend/test/client-smoke.test.js
git commit -m "test: cover frontend mutation boundaries"
```

---

## Final verification

After all three task reviews are clean, run:

```bash
npm test --prefix backend
node --check backend/server.js
sed -n '/<script>/,/<\/script>/p' chat.html | sed '1d;$d' | node --check -
rg -n "DragonNYZ0924|bcrypt\\.hash\\([[:space:]]*['\"]" backend/server.js chat.html backend/package.json
rg -n 'innerHTML[[:space:]]*=.*\$\{' chat.html
git diff --check febac64..HEAD
git status --short
```

Expected: tests and syntax pass; both scans return no matches; diff check prints nothing; the isolated worktree is clean.
