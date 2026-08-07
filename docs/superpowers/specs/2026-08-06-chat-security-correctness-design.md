# Chat Security and Correctness Design

**Goal:** Fix confirmed authorization, data-validation, credential-seeding, and cross-room event bugs without changing the main `chat.html` client or its intended chat behavior.

## Scope and constraints

- Preserve `chat.html` unchanged as the main chat client.
- Preserve the existing Socket.IO event names, callback shapes, MongoDB schemas, room roles, and visible workflows.
- Modify `backend/server.js` only where needed to apply the fixes.
- Add focused backend helper and test files so security rules are independently testable.
- Do not add dependencies; use Node's built-in test runner.
- Do not redesign authentication or add persistent sessions in this change.

## Current architecture

The browser client connects directly to the configured Socket.IO backend. Registration and login use acknowledgement callbacks. After login, the backend stores the authenticated identity and profile on the socket, joins the socket to the global room, and returns the user's available servers.

MongoDB stores users, chat servers, and messages. A user's `servers` array is the membership source of truth. A chat server's `moderators` array determines room moderators. Global administrators can see all servers and have moderation privileges everywhere. Switching rooms loads the newest 100 messages. Messages can contain formatted text, an image attachment, reply context, reactions, edit history, and soft-deletion state.

## Design

### Centralized input and authorization helpers

Add a small dependency-free helper module that provides:

- a safe acknowledgement wrapper that is callable even when the client omitted its callback;
- strict string normalization for server codes and names;
- strict profile color and HTTP(S) avatar URL validation;
- membership checks where global administrators may inspect any existing room, while ordinary users must have the room code in their `joinedServers` list;
- message-room access checks using the same rule;
- bounded emoji validation for reactions.

Every relevant Socket.IO handler will normalize its callback and validate its payload before accessing properties or calling string methods.

### Room access enforcement

`switch_server` will first verify that the target server exists and that the socket may access it. An unauthorized request will return an acknowledgement error without leaving the current room.

Posting requires access to the socket's active room. Reactions, edits, deletion, edit-history reads, and deleted-message reads require access to the message's actual room. Events are emitted to `msg.serverCode`; this corrects the existing edit path that can broadcast an update to the editor's current room instead.

Leaving a server immediately removes the socket from that Socket.IO room. If it was the active room, the socket moves to global on the backend rather than depending on the browser to issue a second request.

### Trusted reply context

The backend will stop persisting arbitrary client-supplied reply display names and text. When a payload contains `replyTo.id`, it will load that referenced message, require it to belong to the active room, and derive a bounded reply snapshot from the stored message. Invalid references will be ignored rather than causing message delivery to fail.

This preserves the current reply UI while removing the stored-HTML injection path and preventing cross-room reply references.

### Stored-data validation

Server names will be normalized to the same conservative character set already used by display names. Profile colors must be six-digit hexadecimal values, and avatar URLs must use HTTP or HTTPS. Display names remain restricted to letters, numbers, spaces, underscores, and dashes; the reserved system-owner name remains unavailable during profile updates as it already is during registration.

Registration will enforce display-name uniqueness consistently, including when the requested display name equals the new username.

### Administrator seeding

Startup will continue ensuring the global server exists. It will no longer contain or reapply a hardcoded administrator password. The system administrator will be created only when `ADMIN_PASSWORD` is configured and the account does not already exist. Existing administrator credentials will never be overwritten during startup.

### Error handling

Handlers will return their existing user-facing error messages where possible. Authorization failures will use `Permission denied.` and invalid payloads will use `Invalid input format.`. Database errors will continue to return operation-specific errors. Fire-and-forget message actions will remain fire-and-forget so the client protocol does not change.

## Testing

Use `node:test` for dependency-free unit tests of normalization, profile validation, callback safety, and access-control decisions. For each confirmed defect, first add a regression test that fails against the missing helper behavior, then integrate the helper into `server.js` and run the test again.

Verification will include:

- the complete built-in test suite;
- Node syntax checks for the server, helper, and unchanged inline client script;
- a static event audit confirming each room-sensitive handler calls the centralized access check and emits to the message's stored room;
- confirmation that `chat.html` has no diff (the workspace has no usable Git history, so this will be checked by preserving the file throughout the edits and comparing a pre-change checksum).

## Out of scope

- Persistent login/session tokens and automatic reauthentication after Socket.IO reconnects.
- UI redesign or client-side refactoring.
- Schema migrations for legacy unsafe profile or server-name values.
- Deployment configuration beyond documenting `MONGO_URI` and `ADMIN_PASSWORD` expectations in the backend package metadata or a new README.
