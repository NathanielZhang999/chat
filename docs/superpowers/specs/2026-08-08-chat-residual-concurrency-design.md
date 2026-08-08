# Residual Chat Concurrency Design

## Goal

Close the four residual review findings without adding a production application file or introducing distributed infrastructure that the deployment cannot use.

The production application remains exactly:

- `chat.html`
- `backend/server.js`
- `backend/package.json`

Tests remain under `backend/test/`.

## Deployment assumption

The backend runs as one Node.js process on a Render Free web-service instance and uses MongoDB for durable data. Render Free does not support scaling the web service beyond one instance, so keyed in-process coordination is sufficient for the deployed topology. MongoDB remains authoritative for users, memberships, roles, rooms, and messages.

If the service later moves to multiple backend instances, the in-process locks in this design must be replaced with database-backed coordination before horizontal scaling is enabled.

## Root causes

### Account publication races

Room leave, administrator demotion, and profile update currently fetch a snapshot of live sockets before committing the authoritative MongoDB change. A login that overlaps that window can publish stale membership, role, or profile data after the operation finishes and is absent from the earlier socket snapshot.

### Room deletion race

Room deletion currently snapshots live sockets before it acquires the room mutation lock. `switch_server` performs its final transport transition outside that lock. A late switch can therefore enter the room after deletion's snapshot and avoid eviction.

### Frontend test boundary

The client tests call low-level decision helpers, but the helpers do not own the actual state and DOM mutation boundary. The wiring can regress while helper-only tests remain green.

## Design

### Keyed account transition locks

Split coordination into the existing global identity-allocation lock and a new keyed account lock interface:

```js
withAccountTransitionLock(username, operation)
```

Keys use the normalized lowercase username. Locks for different accounts may proceed independently. Every lock releases in `finally` and removes its idle tail entry.

The global identity-allocation lock continues to serialize case-insensitive username/display-name collision checks and writes across different accounts. The keyed account lock serializes publication and mutation for one account without blocking unrelated accounts.

The following operations share the keyed lock for the affected account:

- login state publication;
- room membership removal;
- global-administrator demotion;
- profile updates;
- profile updates, which also require the global identity-allocation lock while allocating a display name.

When both locks are required, code always acquires the global identity-allocation lock first and the keyed account lock second. No path acquires them in the opposite order.

Login may verify the password before entering the account lock. Inside the lock it re-fetches the user and revalidates the password-relevant identity record before publishing membership, role, profile, Socket.IO membership, or `onlineUsersMap` state. This prevents a login from publishing stale account state after a concurrent mutation.

Leave, demotion, and profile update commit MongoDB state while holding the affected account lock. After the write, they fetch a fresh live-socket list and reconcile every matching socket and every matching online-map entry before acknowledging. Cache updates occur synchronously before transport awaits. Transport eviction falls back to disconnecting a socket if leave/join operations fail.

### Room transition locking

`switch_server` may prepare history and room role outside the room lock. Its final existence/access recheck and transport transition run inside:

```js
withRoomMutationLock(serverCode, operation)
```

`delete_server` performs permission revalidation, live-socket preflight, primary deletion, cache invalidation, transport eviction, notification, and secondary cleanup inside the same room lock. Its authoritative socket snapshot is taken only after lock acquisition.

This ordering guarantees either:

- a switch commits first and deletion's later snapshot includes and evicts it; or
- deletion commits first and the switch's locked recheck sees an absent room and fails without joining.

No unlocked path may join a non-global room. `join_server` continues to use the same room lock for membership mutation.

### Test-owned frontend boundaries

Move connection-error recovery and rejected-switch handling into exported inline helpers that own their effects through injected state/DOM adapters.

The connection helper registers the listener and performs button/status mutation itself. The switch-result helper performs the error decision and is solely responsible for invoking either the error adapter or the success-state/DOM adapter; callers do not mutate room state outside that helper.

The Node VM smoke harness executes these exact production helpers and supplies minimal adapters. Tests assert actual state/DOM adapter calls rather than asserting an unrelated object remained unchanged.

## Error handling

- Account and room locks always release in `finally`.
- A database failure before an authoritative commit produces an error acknowledgement with no published state change.
- A secondary transport failure after a revocation commit cannot restore access; the affected socket is disconnected if it cannot be moved safely.
- Logging remains event-specific and metadata-only.
- No passwords, message contents, attachments, reply snapshots, or raw payloads are logged.

## Testing

Behavior tests use the real exported connection handler and controlled deferred promises.

Required regressions:

- a login paused before account publication cannot publish membership removed by a concurrent leave;
- a login paused before account publication cannot retain administrator ghost access after concurrent demotion;
- a login overlapping profile update publishes the final profile;
- a profile update reconciles a socket that becomes live during the write;
- deletion waiting for a room lock captures and evicts a socket that switches before deletion acquires the lock;
- a switch waiting for deletion fails its locked room recheck and remains outside the deleted room;
- account locks serialize only the same normalized username and release after rejection;
- the production connection-error helper mutates the provided auth controls only for the active socket/modal;
- the production switch-result helper never calls the success state/DOM adapter for an error acknowledgement.

Final verification includes the complete Node test suite, backend syntax, extracted inline-client syntax, credential scan, whitespace check, and an independent task review followed by a whole-branch review.

## Non-goals

- Multiple backend replicas or distributed locks.
- MongoDB schema changes or migrations.
- A new frontend file, backend helper file, dependency, framework, or build system.
- Redesigning authentication sessions or the visible chat workflow.
