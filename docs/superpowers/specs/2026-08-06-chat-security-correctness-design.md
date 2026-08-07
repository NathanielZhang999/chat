# Chat Security and Correctness Design

**Goal:** Fix confirmed authorization, validation, credential, rendering, connection, and cross-room event bugs while preserving the application's intended chat workflows.

## Scope and constraints

- Keep `chat.html` as the only production frontend file. Its HTML, CSS, and browser JavaScript remain inline.
- Preserve the existing Socket.IO event names, acknowledgement shapes, MongoDB schemas, room roles, and visible workflows.
- Preserve the documented global-administrator ability to inspect rooms without joining them.
- Add focused backend helper and test files where isolation improves correctness.
- Use Node's built-in test runner and do not add production dependencies.
- Do not add persistent sessions, redesign authentication, or migrate legacy database records.
- Preserve the user's deletion of the three `Zone.Identifier` metadata files.

## Current architecture

The browser client in `chat.html` connects directly to the Socket.IO backend. Registration and login use acknowledgement callbacks. After login, the backend stores the authenticated identity and profile on the socket, joins the socket to the global room, and returns the user's available servers.

MongoDB stores users, chat servers, and messages. A user's `servers` array is the membership source of truth. A chat server's `moderators` array determines room moderators. Global administrators can inspect all existing servers and moderate every room. Switching rooms loads the newest 100 messages. Messages can contain formatted text, an image attachment, a trusted reply snapshot, reactions, edit history, and soft-deletion state.

## Confirmed defects

- Startup contains a hardcoded administrator password and overwrites that account's password on every successful database connection.
- Any authenticated socket can switch to a known private-room code, and message actions do not consistently verify access to the message's stored room.
- Leaving a server updates MongoDB but does not remove the socket from the Socket.IO room.
- A socket can log in again as a different user while retaining rooms joined by the previous identity.
- Missing acknowledgement callbacks and malformed event payloads can throw exceptions or leave requests unresolved.
- Client-supplied reply snapshots and internal `{{PING:...}}` tokens are trusted, allowing stored markup injection and mention spoofing.
- Server names, profile colors, avatar URLs, attachments, and reaction keys are insufficiently validated before persistence or rendering.
- Edited messages can be broadcast to the editor's current room instead of the message's stored room.
- Typing events omit the display name expected by the client.
- After a failed connection, changing the backend URL reuses the old Socket.IO connection and the login button can remain disabled.
- Several client render paths build HTML from stored values rather than assigning untrusted values as text or validated attributes.
- The client sets room state before a room switch is acknowledged, so rejected switches can leave the interface inconsistent.
- The success-message CSS variable is referenced but undefined.

## Design

### Backend validation and acknowledgement helpers

Add a dependency-free backend helper module with pure functions for:

- a no-op-safe acknowledgement wrapper;
- bounded string and password validation: usernames are 1–20 characters, display names and server names are 1–30 characters, message text is at most 2,000 characters, and passwords are 6–128 characters;
- server-code, server-name, username, and display-name normalization;
- six-digit hexadecimal color validation;
- HTTP(S) avatar URL validation with a 1,000-character maximum;
- raster-image data URL validation limited to JPEG, PNG, GIF, and WebP values no longer than 8,000,000 characters;
- reaction-key validation requiring an emoji-like value no longer than 64 UTF-16 code units and containing at least one Unicode extended pictograph;
- MongoDB identifier shape validation;
- neutralizing client-supplied internal ping tokens before resolving real mentions;
- membership decisions where global administrators may access any existing room and ordinary users must be members.

Every acknowledgement-based handler will normalize its callback before any early return. Every event will validate its payload before reading properties or calling string methods. Invalid payloads will return `Invalid input format.` when the event has an acknowledgement; fire-and-forget events will be ignored safely.

Profile fields, room names, reactions, and attachments will be rejected rather than silently storing unsafe values. Server codes will be either `global` or exactly six uppercase ASCII letters or digits.

### Authentication and room lifecycle

An already authenticated socket cannot log in again. This prevents a second identity from inheriting rooms joined by the first identity while preserving the normal login workflow.

`switch_server` will normalize the requested code, confirm that the server exists, and verify access before leaving the current room. Global administrators may switch to any existing room. Ordinary users may switch only to global or a room listed in `socket.joinedServers`. Rejected switches leave the socket and browser on the previous room.

`leave_server` will update membership, remove the socket from the Socket.IO room immediately, and remove any stale moderator assignment for that user. When leaving the active room, the backend will move the socket to global and update presence state. The frontend will follow the acknowledged room state rather than issuing a second private-room switch.

Posting and typing require access to the active room. Reactions, edits, deletion, edit-history reads, and deleted-message reads require access to the referenced message's actual room. Each event will emit to `msg.serverCode`, never merely `socket.serverCode`.

Role management will validate its action and target. Room-moderator promotion will require the target user to be a current member of that room. Existing global-administrator and system-owner protections remain unchanged.

### Trusted messages, replies, and mentions

Message text will be required to be a string before trimming. Literal client-supplied `{{PING:...}}` sequences will be converted back to ordinary visible text before the backend resolves authorized mentions. Only tokens generated by the backend during that request will produce mention styling or notification sounds.

When a message contains `replyTo.id`, the backend will validate the identifier, load the referenced message, verify access and same-room membership, and derive a snapshot containing the stored display name and at most 100 characters of stored text. It will never persist client-supplied reply display names or text. Invalid reply references will be ignored so the main message can still be delivered.

Attachments will be limited to the raster-image formats and size above, which are compatible with the existing upload compressor. Reaction keys will follow the stated emoji rule, preventing arbitrary object keys and unbounded reaction payload growth. Edit history will retain only the 20 most recent previous versions so a message cannot grow without limit.

### Administrator seeding and startup

Startup will always ensure the global server exists. It will create the `NYZhang1` owner account only when `ADMIN_PASSWORD` is configured and no matching account exists. Existing credentials will never be overwritten. The password will not appear in source control or logs.

Database connection and seeding failures will be logged with operation context. Socket handlers will keep user-facing error messages concise while logging unexpected server-side failures rather than swallowing them silently.

### Single-file frontend corrections

All browser changes remain inside `chat.html`:

- Add the missing `--success` color variable.
- Use DOM node creation and `textContent` for server names, display names, deleted-message labels, reply authors, and other stored values.
- Assign only backend-validated colors and HTTP(S) avatar URLs to style and image properties.
- Preserve formatted chat text through the existing escaped formatter, while preventing untrusted reply and profile fields from entering `innerHTML` templates.
- Validate the backend URL with the browser `URL` API. If the URL changes, disconnect the old socket, create a new connection, and register handlers once.
- Re-enable authentication controls on connection failure and guard acknowledgement responses before reading them.
- Commit `currentServerCode`, header state, and server-button state only after `switch_server` succeeds; restore the previous state on rejection.
- Render typing indicators from the display name supplied by the corrected server event, falling back to the username.
- Keep all existing inline styles, controls, slash commands, image compression, emoji selection, and visible administrator workflows.

## Error handling

Authorization failures use `Permission denied.` Invalid payloads use `Invalid input format.` Operation-specific database failures retain the existing user-facing wording where possible. Fire-and-forget events remain compatible and fail closed without crashing the process. Unexpected backend errors are logged with the event name but without passwords or message contents.

The frontend will surface acknowledgement errors through its existing modal and will not mutate local room state on a failed operation. Connection failures restore the login controls so the user can correct the backend URL without reloading the page.

## Testing and verification

Use `node:test` for dependency-free regression tests of callback safety, normalization, profile and attachment validation, reaction validation, mention neutralization, room-access decisions, and bounded history behavior. Each production change begins with a focused test that fails for the confirmed defect.

Backend integration points will be verified with a static event audit showing that every room-sensitive handler calls the centralized access rule and emits to the stored room. Frontend regressions will use a small Node smoke harness that loads the real inline script with minimal browser stubs; no second production frontend file or browser dependency is required.

Final verification includes:

- the complete built-in test suite;
- syntax checks for `backend/server.js`, the helper, the tests, and the inline client script;
- a client smoke test for URL replacement, connection-error recovery, safe rendering helpers, and rejected room switches;
- a scan for hardcoded credentials and unsafe untrusted interpolation paths;
- a clean review of the final diff, excluding the user's pre-existing `Zone.Identifier` deletions.

## Out of scope

- Persistent login tokens and automatic reauthentication after Socket.IO reconnects.
- A frontend split, build system, framework migration, or visual redesign.
- Schema migrations for previously stored unsafe values.
- Distributed rate limiting across multiple backend processes.
- Deployment configuration beyond documenting the required `MONGO_URI` and optional `ADMIN_PASSWORD` environment variables.
