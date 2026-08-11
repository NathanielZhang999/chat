# Chat Usability Bundle Design

Date: 2026-08-11

Status: Approved for implementation planning

## Objective

Add three focused usability improvements without restoring the removed room-experience bundle:

1. Drag-and-drop and clipboard-paste image intake through the existing preview and compression workflow.
2. A conservative, accessible set of global keyboard shortcuts.
3. Account-synchronized appearance preferences with a safe local startup cache.

The deployed runtime remains exactly `backend/server.js` and `chat.html`. No dependency or package-file changes are required. The browser title remains exactly `Chat v1.3.2`.

## Explicit Non-Goals

This bundle must not restore or introduce:

- room descriptions, rules, or room-info editing;
- pinned messages;
- unread or mention badges;
- per-room notification settings;
- user blocking;
- message search or pagination;
- customizable keyboard mappings;
- multiple attachments per message;
- new attachment storage services;
- new runtime files or third-party dependencies.

## Architecture

The upload and keyboard features are client-only extensions in `chat.html`. Appearance preferences use one small allowlisted object on the existing User document in `backend/server.js`, with a versioned socket protocol for cross-device synchronization.

The server is authoritative after authentication. The browser may use a per-backend-account local cache only to apply a previously accepted appearance quickly and reduce theme flashing. A cache value never grants authority and cannot override a newer server version.

Client authentication is connection-generation scoped. Choosing a backend/account and applying its provisional appearance cache is not an authenticated action. The authoritative login-attempt token is created only when the login request is actually emitted on a connected socket generation. A login clicked while disconnected is queued as an unauthenticated candidate and receives its token after the reconnecting socket becomes connected, so connection establishment cannot make a valid login acknowledgement appear stale.

Disconnect, logout, socket replacement, or account change immediately enters a sanitized unauthenticated state: room history, online-member content, selected-room/server caches, roles, typing state, composition state, attachments, and room-scoped dialogs are cleared before authentication is shown. A later login keeps the room surface blank or in the neutral lobby until that account's initial room/lobby result is accepted. A delayed or failed initial room switch must never reveal the prior account's private content.

Sanitization is also a temporal boundary. Every UI-mutating authenticated socket listener is bound to one exact active socket and authenticated connection generation, then unbound on disconnect/logout/replacement/account change. A fresh successful login installs a new binding. Every asynchronous acknowledgement captures that same session generation plus its relevant room/message context and must revalidate them before inspecting either success or error data. Sanitization resets the room-switch coordinator and all other pending request coordinators. An old event or delayed room-switch, edit-history, deleted-message, moderation, or other callback may not mutate DOM, dialogs, alerts, cache, audio, navigation, room state, or status text after the boundary.

## Appearance Preferences

### User-facing controls

The existing Settings modal gains an Appearance section with these exact settings:

| Setting | Allowed values | Default |
|---|---|---|
| Theme | `dark`, `light` | `dark` |
| Text size | `100`, `112.5`, `125` percent | `100` |
| Compact messages | `false`, `true` | `false` |
| Motion | `system`, `reduce` | `system` |

The labels should describe the values as Dark/Light, Normal/Large/Extra Large, Off/On, and Follow device/Reduce motion. There is no small-text option and no setting that forces animation when the operating system requests reduced motion.

### Persistence model

The User schema gains:

```text
preferences: {
  theme: "dark" | "light",
  textScale: 100 | 112.5 | 125,
  compactMessages: boolean,
  motion: "system" | "reduce"
}
preferencesVersion: non-negative safe integer
```

Legacy users with missing fields receive the exact defaults above. Stored `undefined` fields may be defaulted individually. Nulls, unknown enum values, wrong types, unsafe versions, and extra client-supplied keys are rejected by write normalization and safely normalized to defaults on read. The schema enforces a non-negative safe-integer version. Missing legacy versions are treated as version zero. A present malformed, negative, fractional, wrong-type, or maximum-safe version fails closed on update without being overwritten; the handler returns a generic unavailable response and a safe event-specific log so an operator can repair corrupted external data explicitly.

### Socket contract

Login and registration success payloads include the safe normalized `preferences` object and `preferencesVersion`.

The client saves through:

```text
update_preferences({ preferences, expectedVersion }, callback)
```

The backend:

1. requires an authenticated, non-quarantined session;
2. strictly normalizes the complete preferences object and expected version before writing;
3. takes the normalized account lock;
4. reloads the canonical user;
5. requires `expectedVersion` to equal the stored normalized version;
6. discovers the complete same-account live-session recipient set before committing;
7. performs one atomic versioned update;
8. publishes the accepted snapshot synchronously to every discovered live session for that normalized account;
9. acknowledges with the same safe snapshot before releasing the account lock.

A version mismatch returns a generic stale-settings response containing the current safe snapshot so the client can reconcile without blind retry. Recipient discovery or database failures before the commit do not publish or update the browser cache. After a durable commit, one recipient's synchronous emit failure is isolated and safely logged while publication continues to the remaining sessions; the initiating acknowledgement remains a truthful success for the committed snapshot. A missed session reconciles from the server on its next login or accepted update rather than receiving a false failure for an already-committed write.

The direct event is:

```text
preferences_updated({ preferences, preferencesVersion })
```

The client accepts only a safe normalized snapshot whose version is newer than its current accepted version. An equal version is idempotent. Older events and acknowledgements cannot change DOM, state, controls, or cache.

### Local cache and first paint

The cache key is scoped by normalized backend origin plus normalized username so identical usernames on two configurable backends cannot share appearance state. Before authentication, the page uses Dark defaults. Once both backend origin and username are known, a valid cached snapshot may apply immediately while login is pending. A failed login returns to Dark defaults. The successful login snapshot always reconciles it.

Cache parsing and storage errors are ignored. Only a server-accepted snapshot is written to the account cache.

### Rendering

Appearance is expressed through attributes on `<html>` and root CSS variables:

- `data-theme="dark|light"`
- `data-text-scale="100|112.5|125"`
- `data-density="comfortable|compact"`
- `data-motion="system|reduce"`

Dark mode preserves the existing visual identity while correcting semantic text tokens that do not meet normal-text contrast. Light mode replaces hard-coded surface, text, border, focus, overlay, hover, disabled, error, success, warning, and interactive colors with semantic variables so contrast remains coherent across authentication, chat, context menus, emoji pickers, settings, and moderator surfaces. Ordinary, muted, primary/link, error, success, warning, disabled, badge, and button foreground tokens target at least 4.5:1 against every intended surface; non-text focus and boundary indicators target at least 3:1. Foreground status colors and filled status surfaces use separate tokens when one color cannot satisfy both roles.

Text scaling changes the root font scale. Compact mode reduces message/avatar spacing only; it does not shrink configured text size or interactive targets. Touch targets remain at least 44 CSS pixels where practical on mobile.

The effective reduced-motion policy is true when the saved preference is `reduce` or when it is `system` and `prefers-reduced-motion: reduce` matches. Both CSS animations and JavaScript scroll/motion helpers consume the same effective policy.

## Image Intake, Preview, and Compression

### Input methods

One shared `intakeAttachment(file, source)` pipeline handles:

- the existing hidden file picker;
- a file dropped over the composer/chat drop target;
- an image clipboard item pasted while the message input is focused.

Text-only clipboard paste is never prevented or modified. Drag navigation is prevented only when the drag contains files. Multiple supplied files deterministically select the first supported image and report that only one attachment is allowed.

### Validation and transformation

Accepted input MIME types are exactly:

- `image/jpeg`
- `image/png`
- `image/webp`

SVG, GIF, HEIC, generic `image/*` values, empty types, and non-images are rejected. The original file must be at most 10 MiB.

Before invoking a browser image decoder or allocating a canvas, a bounded binary-header parser reads dimensions from the JPEG, PNG, or WebP byte stream and enforces the format signature, structural bounds, dimensions, and pixel count. After decode, the browser-reported dimensions are checked again against the header and the same bounds. The chosen conservative decoded-image bounds are:

- width and height must each be positive and no greater than 16,384 pixels;
- total decoded pixels must not exceed 40,000,000.

The longest output edge is at most 800 pixels. Canvas re-encoding strips source metadata. Output is JPEG at quality 0.8, preserving the application's existing behavior. The produced data URL must pass the existing attachment sanitizer and server-size contract before becoming pending state. Truncated, deceptive, structurally malformed, dimensionless, or header/decode-mismatched images fail before publication.

### State and race behavior

Only one attachment may be pending. Each intake captures:

- an incremented attachment epoch;
- the active socket identity;
- the active connection/authentication generation;
- the exact composition `{serverCode, clientContextId}`.

Every asynchronous boundary—file read, image decode, canvas creation, and encoding—must verify the attachment epoch, socket reference, connection/authentication generation, and composition context. A newer intake, clear action, accepted send, room switch, lobby transition, access revocation, disconnect, reconnect, logout, or socket replacement invalidates older work. Socket.IO may reconnect through the same JavaScript socket object, so reference identity alone is insufficient. Disconnect immediately marks the session unauthenticated, disables composition, invalidates pending privileged/client operations, and requires a successful login on the new connection before upload or shortcut actions resume.

While processing, the preview region displays an accessible status and the send action cannot publish the incomplete attachment. On success it displays the compressed preview and a clearly labeled Remove attachment button. On failure it clears only the failed intake if it is still current and shows a generic safe error without file contents or metadata.

The drop target uses a visible focus-like state and `aria-live` status. It must not cover or trap the interface on mobile browsers that do not support desktop drag/drop.

## Keyboard Shortcuts

### Shortcut map

| Shortcut | Action |
|---|---|
| `Escape` | Close the highest-priority dismissible picker/dialog; otherwise cancel active edit, reply, or attachment |
| `Alt + ArrowUp` | Switch to the previous accessible joined room |
| `Alt + ArrowDown` | Switch to the next accessible joined room |
| `Ctrl/Cmd + ,` | Open Settings directly to Appearance |
| `Ctrl/Cmd + U` | Open the existing image file picker |
| `?` | Open keyboard-shortcut help when the user is not typing |

### Dispatcher rules

One document-level dispatcher resolves keys into named UI actions and calls existing client functions. It never emits room or message socket events directly.

The dispatcher ignores:

- `event.isComposing` and IME composition;
- repeated keydown events;
- unauthenticated, disconnected, generation-stale, or replaced-socket state where the action needs an active session;
- inaccessible or disabled room entries;
- editable targets for shortcuts that would alter typed input;
- password fields for every global shortcut except a deliberately safe Escape close;
- destructive confirmations and authentication dialogs that must not be dismissed.

Escape uses an explicit priority order: reaction picker, emoji picker, shortcut help, non-destructive ordinary modal, edit/reply/attachment composition. It performs at most one action per key press.

Room traversal uses the visible ordering filtered explicitly to Global plus codes present in the user's joined-membership list. It then skips inaccessible/banned entries, wraps at both ends, and routes the selection through the existing serialized room-switch coordinator. A global administrator's unjoined ghost-visible rooms are never keyboard traversal targets. All shortcut actions retain equivalent visible pointer/touch controls.

The shortcut-help dialog lists the exact active bindings and is keyboard accessible. Settings/Appearance includes a visible `Keyboard Shortcuts` button with a semantic accessible name and mobile touch target; it opens the same owned dialog as `?`. Opening it stores the prior focus; closing it restores focus when the element is still connected. Escape dismissal is implemented through an explicit layer registry whose entries own their close functions. Authentication and custom confirmation dialogs are protected. A non-confirmation custom alert is dismissible only through an owner close function that resolves its Promise exactly once and restores focus. Settings, server join/create, history, moderator center, moderation, report, and resolution layers are dismissed only through their real owner cleanup function and only while no protected operation is pending; raw class removal may not strand dialog promises or coordinator state.

## Error Handling and Privacy

- Preference handlers log only event names and safe account/version metadata, never appearance cache contents beyond the allowlisted enum/number/boolean fields.
- Preference discovery/database failures before commit publish nothing; post-commit recipient failures are isolated while the committed success remains truthful.
- Image errors never log or transmit file names, clipboard contents, original data URLs, EXIF metadata, or decoded pixels.
- Multiple supplied files select the first supported image and report the one-attachment rule without exposing any supplied file name or clipboard content.
- Unsupported and oversized images are rejected before publication.
- Stale image callbacks cannot mutate a newer room or socket.
- Keyboard dispatch never bypasses existing UI authorization or room-switch coordination.
- Appearance data is presentation-only and cannot influence backend authorization.

## Test Strategy

Implementation follows test-driven development. Production changes occur only after focused regressions fail for the intended missing behavior.

### Backend tests

- strict preference defaults and validation, including legacy missing fields and malformed stored values;
- login and registration safe payloads;
- authenticated update authorization and exact allowlist;
- expected-version compare-and-swap and version increment;
- missing-version migration plus fail-closed handling for malformed, negative, fractional, wrong-type, and maximum-safe stored versions;
- concurrent device winner/loser ordering;
- all-session publication before acknowledgement;
- pre-commit recipient-discovery failure and isolated post-commit recipient emit failure;
- stale event/idempotent equal event/newer event behavior contract;
- database failure produces no event/cache-authoritative success;
- existing profile, authentication, moderation, and account-lock regressions remain green.

### Client executable tests

- appearance normalization, defaulting, backend-origin-plus-account cache scoping, corrupt-cache handling, and exact version acceptance;
- server snapshot overriding stale local cache;
- Dark/Light tokens, all text sizes, compact density, and effective motion behavior;
- complete settings render/save payload and stale acknowledgement rejection;
- picker/drop/paste use the same attachment pipeline;
- text paste remains unchanged;
- exact MIME, input size, pre-decode binary-header dimension/pixel validation, post-decode agreement, resize, output sanitizer, and one-file rules;
- latest-intake-wins across room, socket, clear, send, and failure races;
- same-object disconnect/reconnect generation invalidates uploads, saves, and shortcuts until fresh authentication;
- disconnected login attempts create their authoritative token only when emitted on the connected generation;
- disconnect/account change clears prior room/member/role/typing/dialog state, and delayed or failed initial switching cannot expose the prior account's content;
- every authenticated socket listener and acknowledgement is generation/context guarded, so old events and delayed history/detail callbacks have zero effects after sanitization;
- visible and accessible processing/preview/drop states;
- every keyboard mapping plus modifier variants;
- editable fields, password fields, IME, repeats, modal priority, inaccessible rooms, and replaced sockets;
- room traversal wraps and uses the existing coordinator;
- shortcut help restores focus;
- existing upload context, motion, room switch, and security tests remain green.

### Release verification

- full backend test suite;
- syntax checks for `backend/server.js`, the client tests, and the inline `chat.html` script;
- static HTML ID uniqueness;
- exact browser title `Chat v1.3.2`;
- no dependency or package-file changes;
- credential scan and diff hygiene;
- commit scope limited to `backend/server.js`, `chat.html`, and relevant existing test files;
- manual browser matrix when a browser is available: Chromium, Firefox, and Safari; desktop drag/drop; clipboard image/text; mobile file selection; transparent PNG behavior; malformed and large-dimension images; Dark/Light contrast; 200% zoom; keyboard focus/IME; and reduced motion.

## Delivery

The work will be divided into independently reviewed TDD tasks:

1. backend preference schema/protocol/synchronization;
2. client appearance rendering/cache/settings;
3. shared attachment intake plus drag/drop/paste;
4. keyboard dispatcher/help UI;
5. cross-feature race, accessibility, and release verification.

Each task receives focused RED/GREEN evidence, an independent review, and a scoped commit. After the final whole-branch review, the completed series will be pushed normally to the existing `deploy-chat` branch without force.
