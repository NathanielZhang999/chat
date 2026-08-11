# Chat Usability Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-synchronized Dark/Light appearance settings, a shared drag/drop/paste image-compression workflow, and accessible keyboard shortcuts without restoring the removed room-experience feature bundle.

**Architecture:** `backend/server.js` stores and publishes a strictly allowlisted, versioned appearance snapshot on the existing User model. `chat.html` owns rendering, a per-account startup cache, attachment intake, and keyboard dispatch through testable pure helpers plus guarded runtime coordinators. The production runtime remains two files, while focused Node tests exercise registered socket handlers and extracted client behavior.

**Tech Stack:** Node.js, Express, Socket.IO, Mongoose/MongoDB, browser DOM/FileReader/Image/Canvas APIs, CSS custom properties, localStorage, and Node's built-in test runner.

## Global Constraints

- The deployed runtime remains exactly `backend/server.js` and `chat.html`.
- Do not add or change dependencies or package files.
- Preserve the exact browser title `Chat v1.3.2`.
- Do not restore room descriptions/rules, pins, unread/mention badges, per-room notifications, user blocking, message search, or pagination.
- Appearance values are exactly: theme `dark|light`; text scale `100|112.5|125`; compact messages boolean; motion `system|reduce`.
- Defaults are Dark, 100% text, comfortable messages, and Follow device motion.
- The server is authoritative after authentication; local appearance cache is per normalized account and contains only server-accepted snapshots.
- Image input accepts exactly JPEG, PNG, and WebP; one image; at most 10 MiB input; width/height at most 16,384; at most 40,000,000 decoded pixels; longest output edge 800; JPEG quality 0.8.
- Keyboard bindings are exactly Escape, Alt+ArrowUp/Down, Ctrl/Cmd+Comma, Ctrl/Cmd+U, and `?`.
- Socket.IO reconnects may reuse one JavaScript object: client authority tokens must include a connection/authentication generation, and disconnect requires a fresh successful login before composition or shortcuts resume.
- Disconnect, logout, socket replacement, or account change must clear prior room/member/role/typing/dialog/composition state before another account can authenticate; a delayed or failed initial switch cannot restore it.
- Every UI-mutating authenticated socket listener and asynchronous acknowledgement must reject a stale socket, connection/authentication generation, and relevant room/message context before inspecting response data or mutating DOM, dialogs, cache, audio, navigation, room state, or errors.
- Combined lock order remains identity allocation -> normalized account transition -> room mutation. Never acquire an account lock while holding a room lock.
- All changes use test-driven development: focused RED before production edits, then focused GREEN, relevant regression suites, review, and a scoped commit.
- Preserve user-owned untracked root `node_modules/`, `package.json`, and `package-lock.json`; never stage or modify them.
- Push normally, without force, to the existing `deploy-chat` branch only after the final whole-branch review and release gate pass.

## File Map

- Modify `backend/server.js`: preference constants, normalization, User schema, auth payloads, versioned update handler, all-session publication, exports.
- Modify `chat.html`: semantic theme tokens, appearance controls/state/cache, shared image intake, drop/paste behavior, keyboard dispatcher, shortcut help.
- Create `backend/test/preferences.test.js`: backend normalization, auth payload, CAS, concurrency, publication, failure, and privacy tests.
- Modify `backend/test/client-smoke.test.js`: executable appearance, attachment, keyboard, race, accessibility, and runtime-wiring tests.
- Modify `backend/test/room-lifecycle.test.js` only if an existing login/register fixture needs the new safe payload asserted or normalized.
- Modify `backend/test/support/fakes.js` only when a focused RED proves the shared memory model lacks an operator required by the real versioned update query.

Client runtime testing remains dependency-free. Extend `client-smoke.test.js` with small controlled `EventTarget`, element/classList, localStorage, FileReader, Image, canvas, matchMedia, and focus doubles. Production logic that needs these services must live in dependency-injected `ChatClientHelpers` controllers; tests instantiate the actual exported production controllers rather than copying their logic. Static CSS/DOM tests may prove exact selectors, attributes, labels, bounds, and absence of zoom disabling, but they must not claim rendered contrast, geometry, or reachability without a browser engine. Those claims remain exclusively in the manual browser gate.

---

### Task 1: Preference Foundations and Authentication Snapshots

**Files:**
- Modify: `backend/server.js:1-120`
- Modify: `backend/server.js:616-626`
- Modify: `backend/server.js:1505-1647`
- Modify: `backend/server.js:3472-3515`
- Create: `backend/test/preferences.test.js`
- Modify if required by RED: `backend/test/support/fakes.js`

**Interfaces:**
- Produces: `DEFAULT_APPEARANCE_PREFERENCES`, an immutable `{ theme, textScale, compactMessages, motion }` object.
- Produces: `normalizeAppearancePreferences(value): Preferences | null` for strict client writes.
- Produces: `normalizeStoredAppearancePreferences(value): Preferences` for safe legacy reads.
- Produces: `normalizePreferencesVersion(value): number | null` and `storedPreferencesVersion(value): number`.
- Produces: `safePreferencesSnapshot(user): { preferences, preferencesVersion }`.
- Changes registration and login success payloads to include the safe snapshot.
- Later tasks consume the same property names without aliases.

- [ ] **Step 1: Write failing normalization, schema, registration, and login tests**

Create `backend/test/preferences.test.js` with exact tests named:

```js
test('appearance preferences accept only the complete strict allowlist', () => {
  const base = { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' };
  for (const [key, values] of Object.entries({
    theme: ['dark', 'light'],
    textScale: [100, 112.5, 125],
    compactMessages: [false, true],
    motion: ['system', 'reduce']
  })) {
    for (const value of values) {
      const candidate = { ...base, [key]: value };
      assert.deepEqual(normalizeAppearancePreferences(candidate), candidate);
    }
  }
  for (const missingKey of Object.keys(base)) {
    const candidate = { ...base };
    delete candidate[missingKey];
    assert.equal(normalizeAppearancePreferences(candidate), null);
  }
  for (const invalid of [
    null,
    { ...base, theme: 'system' },
    { ...base, textScale: 90 },
    { ...base, compactMessages: 'true' },
    { ...base, motion: 'force' },
    { ...base, extra: true }
  ]) assert.equal(normalizeAppearancePreferences(invalid), null);
});

test('stored appearance preferences safely default legacy and malformed fields', () => {
  assert.deepEqual(normalizeStoredAppearancePreferences(undefined), {
    theme: 'dark', textScale: 100,
    compactMessages: false, motion: 'system'
  });
  assert.deepEqual(normalizeStoredAppearancePreferences({
    theme: 'light', textScale: null,
    compactMessages: true, motion: 'unexpected'
  }), {
    theme: 'light', textScale: 100,
    compactMessages: true, motion: 'system'
  });
});

test('preference versions accept only non-negative safe integers', () => {
  assert.equal(normalizePreferencesVersion(0), 0);
  assert.equal(normalizePreferencesVersion(4), 4);
  for (const value of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizePreferencesVersion(value), null);
  }
  assert.equal(storedPreferencesVersion(undefined), 0);
});

test('preference version schema rejects fractions and unsafe integers', async () => {
  const path = UserSchema.path('preferencesVersion');
  const validate = value => new Promise((resolve, reject) =>
    path.doValidate(value, error => error ? reject(error) : resolve()));
  await validate(0);
  await validate(1);
  await validate(Number.MAX_SAFE_INTEGER);
  await assert.rejects(validate(-1));
  await assert.rejects(validate(1.5));
  await assert.rejects(validate(Number.MAX_SAFE_INTEGER + 1));
});

test('user schema persists every exact appearance path default type and enum', () => {
  const expected = {
    'preferences.theme': { instance: 'String', enumValues: ['dark', 'light'], defaultValue: 'dark' },
    'preferences.textScale': { instance: 'Number', enumValues: [100, 112.5, 125], defaultValue: 100 },
    'preferences.compactMessages': { instance: 'Boolean', enumValues: [], defaultValue: false },
    'preferences.motion': { instance: 'String', enumValues: ['system', 'reduce'], defaultValue: 'system' }
  };
  for (const [name, contract] of Object.entries(expected)) {
    const path = UserSchema.path(name);
    assert.ok(path, `missing schema path ${name}`);
    assert.equal(path.instance, contract.instance);
    assert.deepEqual(path.options.enum || path.enumValues || [], contract.enumValues);
    assert.equal(path.getDefault(null), contract.defaultValue);
  }
  const TestUser = mongoose.models.AppearanceSchemaTestUser ||
    mongoose.model('AppearanceSchemaTestUser', UserSchema.clone());
  const document = new TestUser({ username: 'schema_user', password: 'hash' });
  assert.deepEqual(document.preferences.toObject(), {
    theme: 'dark', textScale: 100, compactMessages: false, motion: 'system'
  });
  document.preferences.theme = 'system';
  assert.ok(document.validateSync().errors['preferences.theme']);
  document.preferences.theme = 'dark';
  document.preferences.textScale = 90;
  assert.ok(document.validateSync().errors['preferences.textScale']);
  document.preferences.textScale = 100;
  document.preferences.motion = 'force';
  assert.ok(document.validateSync().errors['preferences.motion']);
});
```

Also add `registration and login return only the safe appearance snapshot`. Use the existing `createConnectionHandler` dependency injection and FakeSocket patterns from `room-lifecycle.test.js`: register a new account and require exact default preferences/version; seed a login user whose stored preference object contains `secretSentinel: 'PREFERENCE_SECRET'` plus one malformed field; serialize both acknowledgements and require only `theme`, `textScale`, `compactMessages`, `motion`, and `preferencesVersion`, with no sentinel. Export `UserSchema` for the direct schema validator and do not expose live User documents to the client.

Add `appearance preferences never enter presence room message or moderation payloads`. Execute a registered login with non-default preferences and a sentinel extra stored key, inspect `onlineUsersMap`, every `online_users`/`system_message` event, serialized room data, and representative message/moderation fixture payloads, and require absence of `preferences`, `preferencesVersion`, and the sentinel everywhere except the explicit auth snapshot.

- [ ] **Step 2: Run the Task 1 tests and capture RED**

Run:

```bash
node --test --test-name-pattern='appearance preferences|preference version|user schema|appearance path|registration and login return only|preferences never enter' backend/test/preferences.test.js
```

Expected: FAIL because the preference helpers, schema fields, and auth response fields do not exist.

- [ ] **Step 3: Implement exact preference normalization and schema defaults**

Add near the other normalization helpers in `backend/server.js`:

```js
const DEFAULT_APPEARANCE_PREFERENCES = Object.freeze({
  theme: 'dark',
  textScale: 100,
  compactMessages: false,
  motion: 'system'
});
const APPEARANCE_KEYS = Object.freeze(Object.keys(DEFAULT_APPEARANCE_PREFERENCES));
const APPEARANCE_THEMES = new Set(['dark', 'light']);
const APPEARANCE_TEXT_SCALES = new Set([100, 112.5, 125]);
const APPEARANCE_MOTIONS = new Set(['system', 'reduce']);

function normalizeAppearancePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).length !== APPEARANCE_KEYS.length ||
      APPEARANCE_KEYS.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return null;
  if (!APPEARANCE_THEMES.has(value.theme) ||
      !APPEARANCE_TEXT_SCALES.has(value.textScale) ||
      typeof value.compactMessages !== 'boolean' ||
      !APPEARANCE_MOTIONS.has(value.motion)) return null;
  return Object.freeze({
    theme: value.theme,
    textScale: value.textScale,
    compactMessages: value.compactMessages,
    motion: value.motion
  });
}

function normalizeStoredAppearancePreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.freeze({
    theme: APPEARANCE_THEMES.has(source.theme) ? source.theme : 'dark',
    textScale: APPEARANCE_TEXT_SCALES.has(source.textScale) ? source.textScale : 100,
    compactMessages: typeof source.compactMessages === 'boolean' ? source.compactMessages : false,
    motion: APPEARANCE_MOTIONS.has(source.motion) ? source.motion : 'system'
  });
}

function normalizePreferencesVersion(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function storedPreferencesVersion(value) {
  return normalizePreferencesVersion(value) ?? 0;
}
function safePreferencesSnapshot(user) {
  return {
    preferences: normalizeStoredAppearancePreferences(user && user.preferences),
    preferencesVersion: storedPreferencesVersion(user && user.preferencesVersion)
  };
}
```

Add schema fields with these exact nested definitions and version validator:

```js
preferences: {
  theme: { type: String, enum: ['dark', 'light'], default: 'dark' },
  textScale: { type: Number, enum: [100, 112.5, 125], default: 100 },
  compactMessages: { type: Boolean, default: false },
  motion: { type: String, enum: ['system', 'reduce'], default: 'system' }
},
preferencesVersion: {
  type: Number,
  default: 0,
  validate: value => Number.isSafeInteger(value) && value >= 0
}
```

Export all five interfaces required by the tests.

- [ ] **Step 4: Add safe registration and login payloads**

Registration returns:

```js
return { success: true, ...safePreferencesSnapshot(createdUser) };
```

Capture the result of `UserModel.create` rather than discarding it. Login spreads `safePreferencesSnapshot(user)` into the existing successful response. Do not place preferences in `onlineUsersMap`, presence payloads, room summaries, messages, moderation audit records, or logs.

- [ ] **Step 5: Run focused GREEN and adjacent authentication regressions**

Run:

```bash
node --test --test-name-pattern='appearance preferences|preference version|user schema|appearance path|registration and login return only|preferences never enter|login|register' backend/test/preferences.test.js backend/test/room-lifecycle.test.js backend/test/chat-security.test.js
node --check backend/server.js
```

Expected: all selected tests PASS and syntax exits 0.

- [ ] **Step 6: Review and commit Task 1**

Review exact schema defaults, safe allowlists, registration legacy behavior, and absence from presence/message/audit payloads. Stage only Task 1 files and commit:

```bash
git add -- backend/server.js backend/test/preferences.test.js backend/test/support/fakes.js backend/test/room-lifecycle.test.js
git commit -m "feat: add appearance preference foundations"
```

Omit any listed path that remained unchanged.

---

### Task 2: Versioned Cross-Device Preference Synchronization

**Files:**
- Modify: `backend/server.js:1080-1205`
- Modify: `backend/server.js:1650-1765`
- Modify: `backend/test/preferences.test.js`
- Modify if required by RED: `backend/test/support/fakes.js`

**Interfaces:**
- Consumes: Task 1 normalization, snapshots, User schema, account lock, `fetchLiveSockets`, and `onlineUsersMap` discovery patterns.
- Produces: `update_preferences({ preferences, expectedVersion }, callback)`.
- Produces: direct `preferences_updated({ preferences, preferencesVersion })` events to all same-account live sessions.
- Produces: `applyPreferencesSnapshotToSessions(sockets, username, snapshot)` for deterministic tests.
- Produces: `readRawPreferencesVersion(UserModel, user)` returning `{ exists, value }` without Mongoose Number-path casting.

- [ ] **Step 1: Write failing real-handler synchronization tests**

Add exact tests named:

```text
preference update requires authentication and an exact complete payload
preference update atomically increments the expected version
legacy version zero compare-and-swap matches missing stored version
malformed and maximum stored preference versions fail closed without overwrite
concurrent devices publish only the preference winner
stale preference update returns the current safe snapshot without writing
preference publication reaches every same-account session before acknowledgement
preference acknowledgement remains inside the account lock
preference recipient discovery failure occurs before persistence
one throwing preference recipient cannot change committed success
preference database failure publishes nothing and returns a generic error
preference events and logs never contain unknown or hostile keys
```

Every test invokes the registered `update_preferences` handler through FakeSocket. The first test iterates unauthenticated, missing object, each individually missing preference field, extra field, invalid enum, non-boolean compact value, and invalid version inputs and requires zero model calls. It also table-drives every allowed theme, all three text scales, both compact booleans, and both motion values so no single-combination implementation passes. The increment test starts at version 3, submits expected 3, and asserts an exact version-4 snapshot in Mongo, events, and acknowledgement. The missing-version test records the exact `$or` filter and requires version 1. The malformed test injects raw-version reads for negative, fractional, numeric-string, nonnumeric-string, and `Number.MAX_SAFE_INTEGER` values and requires no update/event and the generic unavailable acknowledgement.

Use separate proofs for lock serialization and CAS loss. First, register two FakeSockets with usernames differing only by case and require their handlers to serialize under the normalized account lock. Second, inject an external database winner at `findOneAndUpdate`: mutate the stored preferences/version to a distinct valid snapshot, return null from the attempted CAS, and require the handler to reload and return that winner. This mutation-sensitive case must fail if the production version predicate or reload is removed. For publication ordering, make a target socket event listener observe whether the initiating acknowledgement has fired; require event first, acknowledgement second. For deterministic lock lifetime, gate preference `findOneAndUpdate` while Alice's account lock is held, enqueue a direct `withAccountTransitionLock('ALICE', contender)` that records entry, release the database gate, and require exact order `preferences_updated event -> preference acknowledgement -> contender entered`; moving the acknowledgement outside the lock must invert the last two entries and fail. Inject a rejecting `fetchLiveSockets` and require zero writes. Inject one recipient whose `emit` throws between two healthy recipients and require the committed version, healthy events, redacted log, and success acknowledgement.

- [ ] **Step 2: Run Task 2 RED**

Run:

```bash
node --test --test-name-pattern='preference update|legacy version zero|malformed and maximum|concurrent devices|preference publication|preference acknowledgement|preference recipient|throwing preference|preference database|preference events' backend/test/preferences.test.js
```

Expected: FAIL because `update_preferences` is unregistered and the publication helper is absent.

- [ ] **Step 3: Implement versioned persistence under the account lock**

Inside the handler, normalize before mutation and then reload under the normalized account lock. The callback for every lock-owned outcome is invoked inside the lock. Discover recipients before persistence; after persistence, isolate per-recipient emit failures and still acknowledge the truthful committed success:

```js
socket.on('update_preferences', async (data, callback) => {
  callback = safeAck(callback);
  if (terminallyClosed) return callback({ error: 'Connection unavailable.' });
  if (!socket.username) return callback({ error: 'Not authenticated.' });
  const preferences = normalizeAppearancePreferences(data && data.preferences);
  const expectedVersion = normalizePreferencesVersion(data && data.expectedVersion);
  if (!preferences || expectedVersion === null) {
    return callback({ error: 'Invalid input format.' });
  }
  let acknowledged = false;
  const respond = payload => {
    acknowledged = true;
    callback(payload);
  };
  try {
    await withAccountTransitionLock(socket.username, async () => {
      const currentUser = await findUserByUsername(UserModel, socket.username);
      if (!currentUser) return respond({ error: 'User not found.' });
      const rawStoredVersion = await readRawPreferencesVersionFn(UserModel, currentUser);
      const rawVersion = rawStoredVersion.exists ? rawStoredVersion.value : 0;
      if (!Number.isSafeInteger(rawVersion) || rawVersion < 0 ||
          rawVersion === Number.MAX_SAFE_INTEGER) {
        logUnexpectedError(logger, 'update_preferences_stored_version', new Error('InvalidPreferenceVersion'));
        return respond({ error: 'Appearance settings unavailable.' });
      }
      const current = safePreferencesSnapshot(currentUser);
      if (current.preferencesVersion !== expectedVersion) {
        return respond({ error: 'Settings changed on another device.', ...current });
      }
      let recipients;
      try {
        recipients = await fetchLiveSockets();
      } catch (err) {
        logUnexpectedError(logger, 'update_preferences_session_discovery', err);
        return respond({ error: 'Failed to update appearance settings.' });
      }
      const versionFilter = expectedVersion === 0
        ? { $or: [{ preferencesVersion: 0 }, { preferencesVersion: { $exists: false } }] }
        : { preferencesVersion: expectedVersion };
      const updated = await UserModel.findOneAndUpdate(
        { username: currentUser.username, ...versionFilter },
        { $set: { preferences }, $inc: { preferencesVersion: 1 } },
        { new: true, runValidators: true }
      );
      if (!updated) {
        const winner = await findUserByUsername(UserModel, currentUser.username);
        return respond({ error: 'Settings changed on another device.', ...safePreferencesSnapshot(winner) });
      }
      const snapshot = safePreferencesSnapshot(updated);
      applyPreferencesSnapshotToSessions(recipients, currentUser.username, snapshot, logger);
      return respond({ success: true, ...snapshot });
    });
  } catch (err) {
    logUnexpectedError(logger, 'update_preferences', err);
    if (!acknowledged) callback({ error: 'Failed to update appearance settings.' });
  }
});
```

`applyPreferencesSnapshotToSessions` filters live sockets by normalized account and synchronously emits only `preferences_updated` to each match. Each emit has its own try/catch and safe `update_preferences_notification` log so one broken recipient cannot stop later recipients or turn a durable success into a failure acknowledgement. It does not copy preferences into `onlineUsersMap`, presence state, or room state, and performs no await after the final authority decision and before emissions.

The production `readRawPreferencesVersion` uses `UserModel.collection.findOne({ _id: user._id }, { projection: { preferencesVersion: 1 } })` and `hasOwnProperty` so BSON strings/fractions cannot be silently cast to Number-path values. `createConnectionHandler` accepts `readRawPreferencesVersionFn = readRawPreferencesVersion` for deterministic tests. When an injected model has no raw collection, the helper may fall back to an own-property check only in that test-double environment. Add a real `UserSchema` hydration characterization proving why the raw projection is required, then make the injected raw-reader cases authoritative for handler behavior.

- [ ] **Step 4: Upgrade only the fake operators proven missing by RED**

If the real query fails because the memory model lacks `$inc`, `$exists`, or nested-object cloning, extend `backend/test/support/fakes.js` with exact Mongo-equivalent behavior and add a direct fake regression. Do not weaken the production query to accommodate a partial fake.

- [ ] **Step 5: Run focused and account-transition GREEN**

Run:

```bash
node --test backend/test/preferences.test.js
node --test --test-name-pattern='account transition|profile update|login overlapping|logout all' backend/test/room-lifecycle.test.js
npm test --prefix backend
node --check backend/server.js
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 6: Review and commit Task 2**

Review CAS behavior for legacy version 0, all-session normalization, event-before-ack ordering, no preference data in presence, and redacted logs. Commit only changed Task 2 files:

```bash
git add -- backend/server.js backend/test/preferences.test.js backend/test/support/fakes.js
git commit -m "feat: synchronize appearance preferences"
```

---

### Task 3: Appearance UI, Cache, and Runtime Motion Policy

**Files:**
- Modify: `chat.html:8-340`
- Modify: `chat.html:353-405`
- Modify: `chat.html:623-1350`
- Modify: `chat.html:1350-1490`
- Modify: `chat.html:2230-2460`
- Modify: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: Task 1/2 `{ preferences, preferencesVersion }` auth payloads and `preferences_updated` event.
- Produces: `ChatClientHelpers.createSessionContextCoordinator()`, `createSessionDispatchGuard(dependencies)`, `createAuthenticatedListenerTable(dependencies)`, `createAuthenticatedSocketBinder(dependencies)`, `createAcknowledgementHandlerMap(dependencies)`, `createGuardedAcknowledgementAdapter(dependencies)`, `createUnauthenticatedStateSanitizer(dependencies)`, `defaultAppearancePreferences`, `normalizeAppearancePreferences`, `normalizeStoredAppearanceSnapshot`, `appearanceCacheKey(backendUrl, username)`, `acceptVersionedPreferences`, `effectiveReducedMotion`, `readAppearanceForm`, `applyAppearanceForm`, `createAppearanceController(dependencies)`, and `createAppearanceRuntimeBridge(dependencies)`.
- Produces runtime: `applyAppearanceSnapshot`, `saveAppearanceSettings`, `enterSanitizedUnauthenticatedState`, `bindAuthenticatedSocketEvents`, and `openSettings('appearance')`.
- Later keyboard task calls `openSettings('appearance')`.

- [ ] **Step 1: Write failing pure-helper and runtime appearance tests**

Add exact tests to `client-smoke.test.js` named:

```text
client appearance normalization matches the server allowlist
appearance cache keys are normalized and account scoped
identical usernames on different backend origins never share appearance cache
corrupt appearance cache falls back without throwing
appearance cache ignores throwing reads and writes only authoritative snapshots
same-object disconnect and reconnect invalidate authenticated appearance work
login clicked while disconnected authenticates on the connected generation
disconnect and account change sanitize prior room state before another account authenticates
sanitized sessions reject prior socket events and delayed room and detail callbacks
versioned appearance accepts newer and idempotent equal snapshots but rejects older snapshots
login appearance overrides a stale per-account cache
appearance form reads and renders all exact values
appearance controls expose exact labels options and associations
effective reduced motion combines the account preference and device query
appearance save sends the complete expected-version payload and rejects stale acknowledgements
preference events from replaced sockets and older versions have no effect
light theme and compact mode expose semantic attributes tokens and touch-target rules
dark and light semantic text colors meet WCAG contrast ratios
```

The normalizer test iterates every allowed theme, all three scales, both compact booleans, both motion values, every missing key, extra keys, and wrong types. The origin test requires distinct keys for `https://one.example` and `https://two.example` with username `Alice`, while case/trailing-slash variants of one origin/account produce one key. The version test explicitly covers lower, equal-identical, equal-conflicting, and newer snapshots. The controls test parses production markup and requires each label's `for` to match its control ID plus exact visible option/choice copy: Dark/Light, Normal/Large/Extra Large, Off/On, and Follow device/Reduce motion. The runtime tests instantiate the production session, dispatch, authenticated-event binder, guarded-acknowledgement adapter, sanitizer, and appearance controllers through the extracted helper block. The appearance dependency object contains `getSessionContext`, `getBackendUrl`, `getUsername`, `storage`, `rootElement`, `formElements`, `deviceReducedMotion`, `onStatus`, and `emitUpdate`. The controller owns provisional-cache application, version acceptance, form rendering, save tokens, connection-generation/active-socket acknowledgement guards, cache writes, and preference-event application. Tests use two backend URLs, two distinct socket objects, and one socket object whose id/connection generation changes across disconnect/reconnect; wrong-origin, stale-object, and stale-generation callbacks/events perform zero root/form/cache/status mutations. Storage doubles separately throw from `getItem` and `setItem`; both errors are ignored, and spies require zero writes for provisional cache application, form edits, pending saves, failed login, stale callback/token errors, and rejected events. An active current save's version-mismatch response carrying a newer authoritative snapshot must apply and cache that snapshot; only accepted login/event/save or current stale-version reconciliation may call `setItem`. The disconnected-login test queues only a provisional backend/account candidate, advances the session generation on `connect`, creates the authoritative auth token at the actual `login`/`register` emit, and accepts that connected-generation acknowledgement; repeat after same-object disconnect/reconnect. The sanitization test instantiates the production `createUnauthenticatedStateSanitizer` with the real dependency categories and seeds `ALICE_PRIVATE_MESSAGE_SENTINEL`, Alice-only member rows, current-room/server caches, role/typing state, attachment state, and room-scoped dialogs; disconnect/account change must blank or reset all of them before Bob can authenticate. Bob's login success keeps that surface blank through a gated initial switch acknowledgement, a failed switch acknowledgement, and the no-access lobby result. The temporal-boundary test uses `createAuthenticatedSocketBinder` with the actual listener table and `createGuardedAcknowledgementAdapter` with the actual switch/edit-history/deleted-message success/error handlers; it may not reconstruct callback logic. After Bob's login it delivers an Alice-bound old-socket chat/member event, a delayed room-switch acknowledgement containing Alice history, delayed edit-history and deleted-message success acknowledgements, and delayed error acknowledgements containing `ALICE_PRIVATE_ERROR_SENTINEL`. Assert zero DOM, modal, alert, cache, audio, navigation, status, or room-state mutation for both socket replacement and same-object disconnect/reconnect. The form test round-trips every value; the motion test covers `system` with both device states and `reduce` with both device states. The semantic-token test requires critical selectors for authentication, chat/history, modals, emoji/context pickers, server/online sidebars, moderator rows, inputs, buttons, disabled states, error/success/warning states, and focus rings to consume semantic variables rather than their prior hard-coded dark colors. The runtime bridge test invokes the disconnected queued-auth path, connected login failure, login success, Save, and a registered `preferences_updated` listener with exact backend/socket/generation identities; deleting any one production delegation or substituting the wrong context must fail. A narrow source assertion requires the real auth callback, Save button, socket event table, and request callbacks to delegate into these production bridge/guard/sanitizer interfaces, while all behavior executes the extracted production controllers with controlled doubles.

- [ ] **Step 2: Run Task 3 RED**

Run:

```bash
node --test --test-name-pattern='appearance|reduced motion|light theme|compact mode|preference events|semantic text colors|contrast|login clicked while disconnected|disconnect and account change|sanitized sessions reject' backend/test/client-smoke.test.js
```

Expected: FAIL for missing helpers, UI controls, event handler, and runtime functions.

- [ ] **Step 3: Add semantic color, scale, density, and motion tokens**

Replace direct appearance-critical colors with variables such as:

```css
:root,
:root[data-theme="dark"] {
  --page-bg: #202225;
  --panel-bg: #36393f;
  --panel-subtle: #2f3136;
  --input-bg: #202225;
  --text-strong: #ffffff;
  --text-normal: #dcddde;
  --text-muted: #b5bac1;
  --border-color: #202225;
  --overlay-bg: rgba(0, 0, 0, 0.85);
  --hover-bg: rgba(4, 4, 5, 0.07);
}
:root[data-theme="light"] {
  --page-bg: #e3e5e8;
  --panel-bg: #ffffff;
  --panel-subtle: #f2f3f5;
  --input-bg: #ebedef;
  --text-strong: #1e1f22;
  --text-normal: #2e3338;
  --text-muted: #4e5965;
  --border-color: #c8ccd0;
  --overlay-bg: rgba(24, 26, 29, 0.58);
  --hover-bg: rgba(78, 80, 88, 0.08);
}
:root[data-text-scale="112.5"] { font-size: 112.5%; }
:root[data-text-scale="125"] { font-size: 125%; }
:root[data-density="compact"] .msg { padding-block: 0.2rem; margin-top: 2px; gap: 10px; }
:root[data-density="compact"] .msg-avatar { width: 34px; height: 34px; }
:root[data-motion="reduce"] *,
:root[data-motion="reduce"] *::before,
:root[data-motion="reduce"] *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
```

Audit every visible modal, header, message, picker, input, context menu, sidebar, moderator row, and disabled state for semantic variables. Do not make message text, inputs, or buttons smaller in compact mode.

The contrast test extracts exact semantic hex tokens for both themes, converts sRGB to relative luminance, and table-drives every declared foreground/surface pairing. It requires at least 4.5:1 for strong, normal, muted/timestamp, placeholder/help/status, primary/link, error, success, warning, disabled, badge foreground, and button foreground text against each surface on which the selector audit says it is used. Define separate `--error-text`/`--error-surface`/`--on-error`, `--success-*`, and `--warning-*` tokens where one color cannot satisfy both text and filled-control roles. Focus rings, borders, and other non-text indicators require at least 3:1 against both adjacent surfaces. This deterministic token check still does not claim the browser's computed cascade; the manual browser gate owns rendered contrast.

- [ ] **Step 4: Add exact Appearance controls and pure client helpers**

Add selects/checkboxes with IDs:

```text
appearance-theme
appearance-text-scale
appearance-compact
appearance-motion
save-appearance-btn
appearance-status
```

Use real `<label for>` associations. Theme options are exactly Dark/Light; text options Normal/Large/Extra Large; compact choices Off/On; motion options Follow device/Reduce motion.

Add strict client normalizers mirroring the server. `acceptVersionedPreferences(current, candidate)` returns:

```js
{ accepted: boolean, changed: boolean, snapshot: { preferences, preferencesVersion } }
```

`defaultAppearancePreferences()` returns a fresh frozen default object. `normalizeStoredAppearanceSnapshot(value)` returns null unless the cache object has a strict complete preference object and non-negative safe version. An equal version is accepted only when its normalized content exactly equals current content; conflicting equal-version content is rejected. The cache key is `pro_chat_appearance:${encodeURIComponent(origin)}:${accountKey}`, where `origin` is the canonical `.origin` from `normalizeBackendUrl(backendUrl)` and `accountKey` is the normalized username. `readAppearanceForm` returns the four strict typed fields; `applyAppearanceForm` assigns all four controls and no profile controls.

Implement both normalizations inside `appearanceCacheKey(backendUrl, username)`: canonicalize the backend through the existing `normalizeBackendUrl`, reduce it to `new URL(normalized).origin`, NFKC-normalize/trim/lowercase the username, and require the same username shape already accepted by authentication. Return null if either component is invalid. Do not reference the backend-only `normalizeAccountKey` function from browser code.

Remove `maximum-scale=1.0` and `user-scalable=no` from the viewport meta tag so browser zoom remains available. Add a client regression requiring the production viewport to permit zoom.

- [ ] **Step 5: Wire startup cache, login authority, save, and same-account events**

Maintain:

```js
let appearanceSnapshot = {
  preferences: ChatClientHelpers.defaultAppearancePreferences(),
  preferencesVersion: 0
};
```

On a login attempt, read only the candidate backend-origin-plus-account cache and apply it as provisional presentation. On login failure, return to defaults. On login success, apply the server snapshot, store it under the authenticated backend/account key, and render the form. `saveAppearanceSettings` emits exact `{ preferences, expectedVersion }`, disables only the Appearance Save control, and accepts a callback only from the active socket and the still-current request epoch. A stale-response error containing a safe current snapshot reconciles it. `preferences_updated` starts with `if (activeSocket !== socket) return;` and passes the version reducer before DOM or cache mutation.

`prefersReducedMotion()` becomes:

```js
const prefersReducedMotion = () => ChatClientHelpers.effectiveReducedMotion(
  appearanceSnapshot.preferences,
  typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
);
```

`createAppearanceController` exposes these exact methods:

```text
resetToDefaults(): snapshot
applyProvisionalCache(backendUrl, username): snapshot
acceptAuthoritative(backendUrl, username, candidate): { accepted, changed, snapshot }
beginSave(preferences): { token, payload } | null
finishSave(token, socketReference, response): { accepted, changed, snapshot } | null
handleEvent(socketReference, response): { accepted, changed, snapshot } | null
current(): snapshot
```

`createSessionContextCoordinator` exposes `replace(socket)`, `connected(socket)`, `disconnect(socket)`, `authenticate(socket)`, `invalidate()`, `snapshot()`, and `matches(snapshot)`. Every state transition increments a safe local generation. A matching snapshot requires the same socket reference, exact generation, connected state, and authenticated state.

`createSessionDispatchGuard({ sessionCoordinator, getActiveSocket, getCurrentRoomCode, getClientContextId })` exposes `capture(socketReference, context)`, `acceptSocket(bindingToken, payloadContext)`, and `acceptCallback(requestToken, responseContext)`. Tokens are frozen allowlists containing the exact authenticated session snapshot plus optional canonical `serverCode`, positive `clientContextId`, and normalized `messageId`. Both acceptance methods return false before reading payload/response content unless the exact active socket and authenticated generation still match; supplied room/context/message fields must equal the token and current state. `bindAuthenticatedSocketEvents(socketReference, authenticatedSnapshot)` registers every UI-mutating listener with a first-statement dispatch-guard check, records the exact handler references, and returns an idempotent `unbind()` that removes them. Successful authentication unbinds any prior group and installs one new group. Every existing acknowledgement that can mutate UI—including switch history, edit history, deleted message, moderation/settings/dialog responses, profile/room operations, and errors—captures a dispatch token at its real emit and validates it before reading the callback response. The room-switch and all other request coordinators expose/reset through the sanitizer so queued requests cannot outlive the generation.

`createAuthenticatedListenerTable(dependencies)` is an exported dependency-injected factory in the helper block. Its dependency allowlist is the real UI owners used by authenticated events (message/history/member renderers, edit/delete/reaction/typing handlers, access/role/profile/system handlers, sound/read schedulers, and safe status owner), and it returns the exact production event-name to `{ contextFromPayload, handle }` table. `createAuthenticatedSocketBinder({ socket, bindingToken, dispatchGuard, listenerTable })` is the extracted implementation behind `bindAuthenticatedSocketEvents`. Each wrapper first calls `dispatchGuard.acceptSocket(bindingToken)` before inspecting payload fields, then validates the extracted room/context before invoking the handler. It records exact wrapper references for `socket.off` and returns an idempotent `unbind()`.

`createAcknowledgementHandlerMap(dependencies)` is the exported dependency-injected factory for the exact production success/error owners used by switch history, edit history, deleted message, moderation/settings/dialog, profile, and room-operation responses. `createGuardedAcknowledgementAdapter({ dispatchGuard, handlers })` exposes `capture(kind, socketReference, context): callback`; the returned callback checks its frozen request token before reading any response field, validates echoed context when applicable, then delegates the unchanged response to the selected production handler. The real emit sites build their maps through `createAcknowledgementHandlerMap` and use this adapter rather than ad-hoc closures. Runtime and sentinel tests both obtain the listener table and handler map from these exact exported factories; neither reconstructs production behavior. Removing a guard, factory entry, or runtime delegation must fail behaviorally.

`createUnauthenticatedStateSanitizer(dependencies)` exposes `sanitize(reason)` and owns the complete production clearing sequence through injected exact owners: clear history/member DOM and maps; clear current/selected room and server caches; reset roles, typing, composition, and attachment state; close room-scoped dialogs through their owner cleanup functions; invalidate request/privilege/switch coordinators; unbind authenticated socket listeners; clear audio/navigation work; then show the authentication surface over a blank lobby. It is idempotent and never restores old state on a failed later switch. Production `enterSanitizedUnauthenticatedState` is a one-line delegation to this extracted sanitizer so the Alice/Bob sentinel test mutation-tests the real clearing logic rather than a fake callback.

`createAppearanceRuntimeBridge` exposes `selectAuthCandidate(backendUrl, username)`, `beginConnectedAuth(socketReference)`, `finishAuth(authToken, backendUrl, username, response)`, `save(preferences)`, `bindSocket(socketReference)`, and `invalidate()`. `selectAuthCandidate` applies only the provisional account-scoped cache and may be called while disconnected; it never captures authenticated authority. `beginConnectedAuth` is called immediately before the real login/register emit and returns null unless the exact socket generation is connected, otherwise returning the authoritative token for that generation. `bindSocket` installs generation-aware `connect`, `disconnect`, and `preferences_updated` listeners and returns `unbind()`. Production creates one session coordinator plus appearance controller/bridge with the real DOM, localStorage, socket getter, backend URL getter, and matchMedia callback. On disconnect of the active socket, the bridge invalidates pending work and calls one production `enterSanitizedUnauthenticatedState` owner that clears chat history, online-member DOM/state, room/server caches and selection, role and typing state, composition and attachment work, room-scoped dialogs, and privileged/request coordinators before showing the authentication modal with a connection-lost message. Logout, socket replacement, and account change use the same sanitizer. The surface stays blank/neutral until the newly authenticated account's first accepted switch or explicit no-access lobby result; switch failure does not restore the old account's DOM. Reconnect remains unauthenticated until a fresh login succeeds. Login/cache/event/save wiring delegates into the bridge; tests use the same bridge/controller with dependency-free fakes. `beginSave` permits one pending save; reset, backend/account change, disconnect, logout, and socket replacement invalidate its token and reset the Save control through `onPendingChange`.

- [ ] **Step 6: Run focused client GREEN and visual-contract checks**

Run:

```bash
node --test --test-name-pattern='appearance|reduced motion|light theme|compact mode|preference events|semantic text colors|contrast|login clicked while disconnected|disconnect and account change|sanitized sessions reject' backend/test/client-smoke.test.js
node --test backend/test/client-smoke.test.js
node -e "const fs=require('fs'),vm=require('vm');const html=fs.readFileSync('chat.html','utf8');const scripts=[...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]).filter(s=>s.trim());scripts.forEach((s,i)=>new vm.Script(s,{filename:'inline-'+(i+1)+'.js'}));if(scripts.length!==1)throw new Error('expected one inline script');console.log('inline scripts: 1')"
```

Expected: all tests PASS and exactly one inline script compiles.

- [ ] **Step 7: Review and commit Task 3**

Review contrast tokens, no theme flash after a valid cache is loaded, cache account isolation, active-socket/version guards, settings focus, and touch targets. Commit:

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "feat: add synchronized appearance settings"
```

---

### Task 4: Shared Drag, Drop, Paste, Preview, and Compression

**Files:**
- Modify: `chat.html:180-235`
- Modify: `chat.html:580-615`
- Modify: `chat.html:623-1350`
- Modify: `chat.html:1350-1380`
- Modify: `chat.html:2180-2240`
- Modify: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: existing `sanitizeAttachment`, `compositionContextCoordinator`, `attachmentLoadEpoch`, `pendingAttachmentBase64`, `clearAttachment`, and Task 3 session-generation plus appearance/motion policy.
- Produces: `ChatClientHelpers.selectAttachmentCandidate(files)`, `readAttachmentHeaderDimensions(bytes, mimeType)`, `fitAttachmentDimensions(width, height)`, `createAttachmentIntakeCoordinator()`, `decodeAttachmentBytes(bytes, mimeType, adapters)`, `clipboardImageFile(items)`, `createAttachmentIntakeController(dependencies)`, and `bindAttachmentInputs(dependencies)`.
- Produces runtime: `intakeAttachment(file, source)` shared by picker, drop, and paste.

- [ ] **Step 1: Write failing attachment helper and runtime tests**

Add exact tests named:

```text
attachment candidate accepts only JPEG PNG and WebP at most ten MiB
attachment header parser rejects truncated deceptive and malformed JPEG PNG and WebP
attachment header parser rejects dimensions and pixels before browser decode
attachment intake rejects a decoder dimension mismatch before canvas allocation
attachment decoder revokes its object URL exactly once on every terminal path
attachment dimensions enforce positive bounded pixels and fit within eight hundred pixels
attachment intake permits one file and the newest intake supersedes older work
text paste remains native while focused image paste enters the shared pipeline
file picker drag drop and paste execute the same intake function
attachment processing invalidates on room switch socket replacement clear and send
same-object reconnect cannot complete or send an older attachment intake
failed decode canvas and output validation clear only the current intake
drop target and attachment status are accessible and motion aware
attachment errors redact hostile filenames clipboard data and decoder messages
multiple files report the one-attachment rule and select the first supported image
```

Instantiate the extracted production `createAttachmentIntakeController` with controlled ArrayBuffer-reader/Image/canvas/event-target doubles. Its dependencies include `getSessionContext`, `getCompositionContext`, `isCompositionEnabled`, `readArrayBuffer`, `decodeImageBytes`, `createCanvas`, `sanitizeAttachment`, `onProcessing`, `onAccepted`, `onCleared`, and `onError`. Test the production `decodeAttachmentBytes` separately with injected `BlobCtor`, `createObjectURL`, `revokeObjectURL`, and `imageFactory`; require exactly one revocation after successful load, decode error, controller invalidation during decode, and a thrown image callback, with no revocation of an unrelated URL. Instantiate `bindAttachmentInputs` with controlled file-input/drop-target/message-input EventTargets and the real controller intake callback; do not recreate listener logic in the test. The candidate test explicitly accepts size `10 * 1024 * 1024` and rejects `10 * 1024 * 1024 + 1`, while rejecting every unlisted MIME. Supply files named `PRIVATE_FILENAME_SENTINEL.png`, clipboard sentinel bytes, and thrown errors containing `DECODER_SECRET_SENTINEL`; require that no status, alert, log, or callback contains any sentinel and that the user sees only bounded enumerated errors such as `Could not process that image.` Supply multiple mixed files and require status `Only one image can be attached; using the first supported image.` while the first supported image alone reaches intake. Require the pre-decode header parser to run before the decode adapter in call-order assertions. Gate each async boundary independently and prove that an older completion cannot assign pending attachment data, preview state, status text, or send state after invalidation, including when the same socket object disconnects/reconnects with a newer generation.

- [ ] **Step 2: Run Task 4 RED**

Run:

```bash
node --test --test-name-pattern='attachment candidate|attachment header|attachment dimensions|attachment intake|attachment decoder|text paste|file picker drag drop|failed decode|drop target|attachment errors|multiple files' backend/test/client-smoke.test.js
```

Expected: FAIL because the shared selectors/coordinator/intake and drop/paste listeners are absent.

- [ ] **Step 3: Implement pure selection, bounds, and intake coordination**

Add helpers equivalent to:

```js
selectAttachmentCandidate(files) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const list = Array.from(files || []);
  const supported = list.filter(file => file && allowed.has(file.type) &&
    Number.isFinite(file.size) && file.size >= 0 && file.size <= 10 * 1024 * 1024);
  return { file: supported[0] || null, suppliedCount: list.length, supportedCount: supported.length };
},
fitAttachmentDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0 || width > 16384 || height > 16384 ||
      width * height > 40000000) return null;
  const scale = Math.min(1, 800 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)),
           height: Math.max(1, Math.round(height * scale)) };
}
```

The coordinator issues frozen tokens containing generation, socket identity, serverCode, and clientContextId. `isCurrent(token)` must check the latest generation, current socket reference, enabled composition, and exact composition context. `createAttachmentIntakeController` exposes `intake(file, source)`, `invalidate(reason)`, `clear()`, and `current()`. It owns validation and every async intake stage using this coordinator; the real browser wiring supplies adapters for FileReader, Image, and canvas. `bindAttachmentInputs` returns `unbind()` so duplicate setup or socket replacement cannot accumulate document listeners.

Implement `readAttachmentHeaderDimensions(bytes, mimeType)` over `Uint8Array`/`DataView` with no browser decoder:

- PNG: require the 8-byte PNG signature, an `IHDR` first chunk, and read big-endian width/height at bytes 16/20.
- JPEG: require SOI, scan bounded marker segments with validated lengths until an allowed SOF marker, reject scans that reach SOS/end without dimensions, and read big-endian SOF height/width.
- WebP: require `RIFF` and `WEBP`, validate chunk lengths, then parse `VP8X` 24-bit canvas dimensions, `VP8L` packed 14-bit dimensions, or `VP8 ` frame dimensions and key-frame signature.

Return null for truncated reads, zero dimensions, invalid segment/chunk lengths, unsupported subtypes, values above 16,384, or products above 40,000,000. Tests supply minimal valid headers for every supported subtype and mutations for truncation, false signatures, integer-boundary dimensions, and oversized pixel products.

- [ ] **Step 4: Extract and harden the shared runtime intake**

Replace the current file-input-only implementation with one `intakeAttachment(file, source)`. Set a processing state, read at most the accepted 10 MiB file into an ArrayBuffer, parse and bound its dimensions before calling the browser decoder, call the production `decodeAttachmentBytes`, verify decoded dimensions against the header (allowing only the width/height swap caused by JPEG orientation), and then allocate the bounded output canvas. `decodeAttachmentBytes` alone owns its short-lived Blob/object URL and calls the injected `revokeObjectURL` in `finally` exactly once. Validate again after `canvas.toDataURL('image/jpeg', 0.8)`. Require an exact `data:image/jpeg;base64,` prefix, require `ChatClientHelpers.sanitizeAttachment(output)` to return the identical output, and require the existing encoded-size bound before committing it. Add fake-canvas mutations returning PNG, GIF, WebP, malformed base64, and oversized JPEG outputs; every one must be rejected with zero pending/preview state.

All failure callbacks check token currency before cleanup. `clearAttachment` invalidates the intake coordinator. Existing switch/lobby/access/logout/socket replacement/send paths call the same invalidation boundary before or while clearing composition.

- [ ] **Step 5: Bind picker, file drag, and focused paste**

`bindAttachmentInputs` makes the file input call `intakeAttachment(selectedFile, 'picker')`.

The same binder makes the drop target listen for `dragenter`, `dragover`, `dragleave`, and `drop`; it calls `preventDefault()` only when `dataTransfer.types` contains `Files`. Nested enter/leave events use a depth counter so the highlight does not flicker. Drop chooses the first supported file and restores the target state in `finally`.

The message input paste listener inspects clipboard items. When no image item exists it returns without calling `preventDefault`. For a supported image it prevents default and calls `intakeAttachment(file, 'paste')`.

Add `role="status" aria-live="polite"` processing text, meaningful preview alt text, and a Remove attachment button with an accessible name and at least a 44px mobile hit area.

- [ ] **Step 6: Run focused and composition-race GREEN**

Run:

```bash
node --test --test-name-pattern='attachment|upload|composition context|room mutation' backend/test/client-smoke.test.js
node --test --test-name-pattern='attachment|chat message|composition' backend/test/message-actions.test.js backend/test/client-smoke.test.js
node --test backend/test/client-smoke.test.js
node --check backend/test/client-smoke.test.js
node -e "const fs=require('fs'),vm=require('vm');const html=fs.readFileSync('chat.html','utf8');const scripts=[...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]).filter(s=>s.trim());scripts.forEach((s,i)=>new vm.Script(s,{filename:'inline-'+(i+1)+'.js'}));if(scripts.length!==1)throw new Error('expected one inline script');console.log('inline scripts: 1')"
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 7: Review and commit Task 4**

Review output bounds, decompression limits, unsupported MIME behavior, text paste, one-file determinism, active socket/room guards, metadata stripping, and safe error text. Commit:

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "feat: improve image attachment intake"
```

---

### Task 5: Accessible Keyboard Shortcuts and Help

**Files:**
- Modify: `chat.html:330-620`
- Modify: `chat.html:623-1350`
- Modify: `chat.html:1450-1580`
- Modify: `chat.html:2110-2310`
- Modify: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: `openSettings('appearance')`, `requestServerSwitch`/`switchServer`, `cancelAction`, current modal/picker state, joined rooms, banned rooms, Task 3 authenticated session generation, and visible file input.
- Produces: `ChatClientHelpers.resolveKeyboardShortcut(eventContext)`, `nextAccessibleRoom(context)`, `escapeAction(context)`, `createEscapeLayerRegistry(dependencies)`, and `createShortcutController(dependencies)`.
- Produces runtime: one `createShortcutController(...).handleKeydown(event)` dispatcher and shortcut-help modal open/close lifecycle; controller setup returns `unbind()` for deterministic one-listener cleanup.

- [ ] **Step 1: Write failing shortcut resolver and connected runtime tests**

Add exact tests named:

```text
keyboard resolver maps the exact approved shortcuts on Windows and macOS
keyboard resolver ignores repeats IME protected dialogs password and unsafe editable targets
Escape performs exactly one highest-priority safe action
room keyboard traversal wraps and skips inaccessible entries
room keyboard traversal uses the serialized switch coordinator
appearance and upload shortcuts call existing visible UI actions
shortcut help is accessible and restores prior focus
visible shortcut help control opens the same accessible dialog
replaced sockets logged-out state and destructive dialogs reject shortcut effects
same-object reconnect disables shortcuts until a new login succeeds
```

Instantiate the extracted production `createEscapeLayerRegistry` and `createShortcutController` with dependency-injected modal elements, real owner-close callbacks, pending-state getters, action callbacks, room access/order getters, and session-context getters. Tests must consume the registry output; they may not reconstruct a hand-written layer array. Dispatch actual keydown objects through a controlled EventTarget harness, including `{ key: '?', shiftKey: true }`, Windows Ctrl variants, macOS Meta variants, repeats, IME, editable/password targets, auth/custom confirmation, and a replaced or generation-stale socket. Assert `defaultPrevented` only when the real controller accepts and executes an action. The registry test asserts every exact production modal ID maps to its specified owner and protection predicate. The visible-control test clicks `shortcut-help-btn`, requires the same help opener and prior-focus lifecycle as `?`, and requires a semantic accessible name plus a 44px mobile hit-target rule. The traversal tests include ordinary joined rooms, banned rooms, wrapping boundaries, duplicate codes, and a global administrator with an unjoined ghost room between joined targets. The production document listener must be a one-line delegation to this same controller.

- [ ] **Step 2: Run Task 5 RED**

Run:

```bash
node --test --test-name-pattern='keyboard resolver|Escape performs|room keyboard|appearance and upload shortcuts|shortcut help|replaced sockets|same-object reconnect' backend/test/client-smoke.test.js
```

Expected: FAIL for missing resolver, dispatcher, and help dialog.

- [ ] **Step 3: Implement pure shortcut resolution and room traversal**

Return named actions rather than callbacks:

```js
resolveKeyboardShortcut({ key, altKey, ctrlKey, metaKey, shiftKey,
                          repeat, isComposing, editable, password,
                          authenticated, protectedDialogOpen }) {
  if (repeat || isComposing) return null;
  if (key === 'Escape') return protectedDialogOpen ? null : 'escape';
  if (!authenticated || password) return null;
  if (!editable && altKey && !ctrlKey && !metaKey && !shiftKey && key === 'ArrowUp') return 'room_previous';
  if (!editable && altKey && !ctrlKey && !metaKey && !shiftKey && key === 'ArrowDown') return 'room_next';
  if ((ctrlKey || metaKey) && !altKey && !shiftKey && key === ',') return 'appearance';
  if ((ctrlKey || metaKey) && !altKey && !shiftKey && key.toLowerCase() === 'u') return 'upload';
  if (!editable && !altKey && !ctrlKey && !metaKey && key === '?') return 'help';
  return null;
}
```

Normalize `event.key` carefully without treating Ctrl and Meta together as two actions. A real US-layout help key arrives as `key: '?'` with `shiftKey: true`; accept that exact shape while still rejecting Ctrl/Meta/Alt. `nextAccessibleRoom` consumes rendered room order but first filters candidates to `global` plus codes present in `myJoinedServers`; only then may it apply `isRoomRailAccessible`, remove duplicates, exclude the current inaccessible/banned room, wrap, and return a code or null. Add a global-admin fixture with visible unjoined ghost rooms and require traversal to skip them.

- [ ] **Step 4: Add semantic shortcut-help UI and Escape priority**

Create one dialog/modal with a heading, a definition list or table of the exact shortcuts, a visible Close button, `role="dialog"`, `aria-modal="true"`, and labelled title. Opening stores `document.activeElement`; closing returns focus if that element remains connected.

Add a visible `Keyboard Shortcuts` button with ID `shortcut-help-btn` in Settings/Appearance. Its click calls the same `openShortcutHelp` owner used by the `?` action; do not duplicate dialog construction.

Implement explicit Escape priority through `escapeAction(createEscapeLayerRegistry(dependencies))`, where each generated layer is `{ id, active, protected, close }` and `close` is the real owner cleanup function:

```text
reaction picker -> emoji picker -> shortcut help -> owned modal registry -> edit/reply/attachment
```

The owned modal registry explicitly covers:

```text
auth-modal: protected, never Escape-dismissed
custom-dialog-modal confirmation: protected, never Escape-dismissed
custom-dialog-modal ordinary alert: closeCustomAlert() resolves its Promise exactly once
settings-modal: closeSettings()
server-modal: closeServerModal()
history-modal: closeHistoryModal()
moderator-center-modal: closeModeratorCenter() unless a protected save/list mutation is pending
moderation-action-modal: closeModerationPrompt() unless moderationDialogCoordinator is pending
report-modal: closeReportPrompt() unless reportDialogCoordinator is pending
resolution-modal: closeResolutionPrompt() unless resolutionDialogCoordinator is pending
```

Refactor `customDialog` to retain explicit `{ kind: 'alert'|'confirmation', settled, resolve, priorFocus }` ownership. `closeCustomAlert()` acts only on an active alert, runs the same cleanup as its OK button, resolves true exactly once, and restores focus; confirmations remain protected. Create the three missing ordinary owner functions for Settings, Server, and History; each removes its active state and restores saved focus when connected. Existing inline close buttons call those owners. A protected active layer consumes no Escape and prevents fall-through to lower layers. One key event executes at most one close/cancel branch. Tests open and dismiss every registry entry, prove each cleanup coordinator/state reset, prove an alert Promise resolves once, and prove protected pending/auth/confirmation states remain intact with no fall-through.

- [ ] **Step 5: Wire the single document-level dispatcher**

Install exactly one `keydown` listener that delegates to `createShortcutController(...).handleKeydown(event)`. Resolve editable state from input, textarea, select, and contenteditable targets. The controller calls injected adapters backed by existing UI functions:

- Appearance: `openSettings('appearance')` and focus `appearance-theme`.
- Upload: click the visible-equivalent hidden file input only when composition is enabled.
- Room traversal: call `requestServerSwitch(targetCode)` or the existing serialized wrapper; never emit `switch_server` directly.
- Escape: call the exact priority controller.
- Help: open the help dialog.

Call `event.preventDefault()` only after a named action is accepted and executable.

- [ ] **Step 6: Run focused and complete client GREEN**

Run:

```bash
node --test --test-name-pattern='keyboard resolver|Escape performs|room keyboard|appearance and upload shortcuts|shortcut help|replaced sockets|same-object reconnect' backend/test/client-smoke.test.js
node --test backend/test/client-smoke.test.js
node -e "const fs=require('fs'),vm=require('vm');const html=fs.readFileSync('chat.html','utf8');const scripts=[...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]).filter(s=>s.trim());scripts.forEach((s,i)=>new vm.Script(s,{filename:'inline-'+(i+1)+'.js'}));if(scripts.length!==1)throw new Error('expected one inline script');console.log('inline scripts: 1')"
node -e "const fs=require('fs');const html=fs.readFileSync('chat.html','utf8').replace(/<script(?:\\s[^>]*)?>[\\s\\S]*?<\\/script>/gi,'');const ids=[...html.matchAll(/\\bid=\"([^\"]+)\"/g)].map(m=>m[1]);const dup=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];if(dup.length)throw new Error('duplicate ids: '+dup.join(','));console.log('unique static IDs:',ids.length)"
```

Expected: client tests PASS and the static ID check reports no duplicates.

- [ ] **Step 7: Review and commit Task 5**

Review browser shortcut conflicts, editable/IME behavior, safe Escape semantics, switch serialization, focus restoration, touch equivalence, and one-listener installation. Commit:

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "feat: add accessible chat shortcuts"
```

---

### Task 6: Cross-Feature Policy Matrix and Release Gate

**Files:**
- Modify: `backend/test/preferences.test.js`
- Modify: `backend/test/client-smoke.test.js`
- Modify only if a real product gap is reproduced: `backend/server.js`, `chat.html`

**Interfaces:**
- Consumes all Tasks 1-5 production interfaces.
- Produces no new user feature; it proves complete integration, race, privacy, accessibility, and release contracts.

- [ ] **Step 1: Add an executable backend preference policy matrix**

Create a table-driven real-handler test covering:

```text
authentication: unauthenticated | authenticated | terminally quarantined
payload: valid | missing key | extra key | invalid enum | invalid version
version relation: exact legacy zero | exact current | stale lower | future higher
session topology: one socket | two same-account sockets | different-account observer
write outcome: success | CAS loser | database rejection
```

For every row assert exact acknowledgement keys, write count, event recipients, event-before-ack ordering, version, safe preference keys, and zero unknown/sentinel disclosure. Use a reduced pairwise set plus explicit concurrency rows rather than a meaningless full Cartesian product; name the test `complete appearance preference policy matrix uses registered handlers`.

- [ ] **Step 2: Add executable client cross-feature races**

Add exact tests named:

```text
complete usability race matrix preserves the newest account room socket and preference context
appearance changes during image processing cannot revive a stale attachment
shortcut room switch during image processing invalidates the old upload
reduced motion applies to attachment drop appearance and shortcut dialogs
light compact large-text state keeps composer controls present enabled and semantically labelled
```

The race matrix must drive the extracted production session, dispatch guard, sanitizer, appearance, attachment, and shortcut controllers, not hand-written substitutes. Include old socket -> new socket; same socket object/id A -> disconnect -> login clicked before id B reconnect -> the auth token is created only for connected generation B -> fresh login succeeds; an unauthenticated provisional account-A cache -> failed account-B login -> Dark defaults -> successful account-A login -> authoritative account-A restoration; Alice private-room sentinels -> disconnect/account change -> Bob login -> delayed initial switch -> failed switch -> no-access lobby with zero Alice DOM/cache/member/role/typing/dialog leakage throughout; post-Bob old authenticated chat/member events plus delayed switch/edit-history/deleted-message success and error callbacks with zero DOM/modal/alert/cache/audio/navigation/status mutation; room-A upload -> shortcut switch room B; and preference event-before-ack/ack-before-event orders. Repeat the temporal boundary for same-object reconnect and socket replacement. The large-text test proves DOM/control state and exact CSS contracts only; rendered reachability and contrast remain manual-browser checks.

- [ ] **Step 3: Run the matrix and capture any genuine RED**

Run:

```bash
node --test --test-name-pattern='complete appearance preference policy|complete usability race|appearance changes during image|shortcut room switch|reduced motion applies|light compact large-text' backend/test/preferences.test.js backend/test/client-smoke.test.js
```

Expected: PASS if Tasks 1-5 are complete. If a test fails, invoke systematic debugging, prove the root cause, add the smallest production fix under TDD, and rerun the owner suite before continuing.

- [ ] **Step 4: Run the full automated release gate**

Run from repository root:

```bash
npm test --prefix backend
node --check backend/server.js
node --check backend/test/preferences.test.js
node --check backend/test/client-smoke.test.js
node -e "const fs=require('fs'),vm=require('vm');const html=fs.readFileSync('chat.html','utf8');const scripts=[...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]).filter(s=>s.trim());scripts.forEach((s,i)=>new vm.Script(s,{filename:'inline-'+(i+1)+'.js'}));if(scripts.length!==1)throw new Error('expected one inline script');console.log('inline scripts: 1')"
node -e "const fs=require('fs');const html=fs.readFileSync('chat.html','utf8').replace(/<script(?:\\s[^>]*)?>[\\s\\S]*?<\\/script>/gi,'');const ids=[...html.matchAll(/\\bid=\"([^\"]+)\"/g)].map(m=>m[1]);const dup=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];if(dup.length)throw new Error('duplicate ids: '+dup.join(','));console.log('unique static IDs:',ids.length)"
node -e "const fs=require('fs');const html=fs.readFileSync('chat.html','utf8');if(!/<title>Chat v1\\.3\\.2<\\/title>/.test(html))throw new Error('wrong title');console.log('title: Chat v1.3.2')"
node -e "const fs=require('fs');const paths=['backend/server.js','chat.html','backend/test/preferences.test.js','backend/test/client-smoke.test.js'];const pattern=/(gho_|github_pat_|mongodb\\+srv:\\/\\/[^'\"\\s]+:[^'\"\\s]+@|sk-[A-Za-z0-9]{20,})/;for(const path of paths){if(fs.existsSync(path)&&pattern.test(fs.readFileSync(path,'utf8')))throw new Error('credential-like value in '+path)}console.log('credential scan: clean')"
git diff --check
git status --short
```

Expected: all tests/checks PASS. Status contains only intended task files plus the user's pre-existing untracked root package files.

- [ ] **Step 5: Perform independent whole-branch review**

Request a read-only reviewer to inspect the complete feature-base-to-HEAD diff against the approved design and plan. The reviewer must prioritize:

- preference CAS and account-lock ordering;
- safe auth/event/ack allowlists;
- cache account isolation and version ordering;
- light-theme contrast/token completeness;
- upload decoded-memory and output bounds;
- stale room/socket/intake invalidation;
- keyboard authorization, modal priority, and focus behavior;
- absence of removed room-experience features;
- no package/dependency changes.

Resolve every reproducible Critical or Important finding with a focused RED/GREEN fix and one coherent fix commit. Re-run the full release gate after the final fix.

- [ ] **Step 6: Record the manual-browser limitation honestly**

If no browser engine is available, state that Chromium/Firefox/Safari drag/drop, clipboard, 200% zoom, Light contrast, mobile file selection, and IME behavior were not manually verified. Do not label static helper tests as a browser pass.

- [ ] **Step 7: Commit final test/fix scope**

If Task 6 changes only tests:

```bash
git add -- backend/test/preferences.test.js backend/test/client-smoke.test.js
git commit -m "test: cover complete usability policy"
```

If a reviewed production fix is required, stage only its exact owner files and use:

```bash
git commit -m "fix: close usability integration gaps"
```

- [ ] **Step 8: Publish normally to GitHub**

After verification and review:

```bash
git push origin HEAD:deploy-chat
git ls-remote --heads origin deploy-chat
git rev-parse HEAD
```

Require the two SHAs to match exactly. Do not force-push, do not stage the root package files, and do not create a second runtime frontend/backend file.
