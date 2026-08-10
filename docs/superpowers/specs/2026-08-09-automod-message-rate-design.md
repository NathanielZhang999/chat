# AutoMod Message-Rate Protection Design

## Goal

Add a configurable, room-scoped rolling message-rate limit to AutoMod and rename the browser tab to `Chat v1.3.2`.

## Scope

This change extends the existing AutoMod settings with two required integers:

- `messageLimit`: number of new messages permitted in a rolling window, from 1 through 20.
- `messageWindowSeconds`: rolling-window duration, from 1 through 60 seconds.

The default is 5 messages per 5 seconds. The settings are stored independently for Global Chat and every private room. Existing rooms whose stored AutoMod object lacks the new fields receive these defaults without requiring a database migration.

The browser document title changes from `Pro Global Chat` to `Chat v1.3.2`. The visible application name and other branding do not change.

All production work remains in the existing three-file architecture. This feature requires changes only to `backend/server.js` and `chat.html`; no runtime dependency is added.

## Alternatives Considered

### Rolling limit — selected

Allow a configurable number of messages during a configurable rolling interval. This permits short, natural bursts while still enforcing a clear average rate. The moderator can choose a strict 1-message/1-second policy or a more conversational policy such as 5 messages/5 seconds.

### Fixed cooldown

Store one configurable minimum delay between accepted messages. This has a simpler tracker and UI, but normal consecutive short messages feel unnecessarily frustrating and it cannot express a controlled burst.

### Token bucket

Configure a refill rate and burst capacity. This is flexible and smooth at scale but introduces settings and behavior that are harder for moderators to understand and unnecessary for the current single-process Render deployment.

## Configuration and Authorization

The existing **Moderator Center → AutoMod** panel gains two numeric inputs:

- **Message limit (1–20)**
- **Window seconds (1–60)**

The existing AutoMod save request and response include both values. A save is valid only when the complete settings object passes all existing keyword, mention, and repeat validation plus the new bounds.

The existing authority rules remain unchanged:

- Global Admins can configure AutoMod for Global Chat and every private room.
- A current Room Moderator can configure AutoMod only for that exact private room.
- A banned or stale moderator cannot read or update the settings.

The moderation audit entry for an AutoMod settings change records the two numeric values but never records configured keywords.

## Enforcement Semantics

The rolling limit applies to every authenticated account, including Room Moderators and Global Admins.

The key is the normalized account username plus exact room code. Consequently:

- Different rooms have independent limits.
- Different accounts have independent limits.
- Multiple sockets or browser tabs for the same account and room share one limit.
- Reconnecting to the same running backend does not reset the limit.
- A Render cold start or redeploy resets in-memory rate history, matching the existing bounded AutoMod tracker and approved single-process deployment model.

A new valid text message or attachment-only message counts as one attempt. Edits, reactions, typing events, reports, and moderation actions do not count.

For each account-room key, the server removes timestamps at least `messageWindowSeconds` old, then:

1. If fewer than `messageLimit` accepted timestamps remain, it records the current timestamp and continues through the existing AutoMod and persistence flow.
2. Otherwise it rejects the message without adding a timestamp. Rejected attempts therefore do not extend the waiting period.
3. A timestamp exactly on the window boundary is expired and no longer counts.

Rate enforcement occurs before message persistence and broadcast. A rejected message is never saved, replied to, ping-resolved, or sent to the room. The existing hard-coded 500-millisecond, per-socket throttle is removed so users face only the configured room policy.

## Tracker and Resource Bounds

Extend the existing process-global AutoMod tracker with a separate rolling timestamp list for new-message attempts. The tracker remains bounded to 10,000 normalized account-room keys and deterministically evicts its oldest key when necessary.

Each key stores no more than `messageLimit` accepted timestamps. Pruning removes expired timestamps and empty keys. No message text, attachments, IP addresses, passwords, or tokens are stored in rate state.

Because the current production deployment is one Node process on Render, an in-memory shared tracker provides consistent behavior across sockets without a new service. Horizontal multi-instance deployment would require a shared Redis or database-backed limiter and is outside this scope.

## User Feedback and Audit

When the message limit is exceeded:

- The sender receives the existing room-scoped `message_blocked` event with the generic content-policy presentation.
- The client shows the existing **Message blocked** notice.
- The raw text or attachment is never included in the event, application log, or audit entry.
- The audit action remains `automod_block`, with metadata rule `message_rate` and a content digest where existing audit behavior requires it.

To prevent a spammer from turning blocked attempts into excessive database writes, only the first rate-limit rejection for an account-room key during the active rolling window creates an audit entry. Later rejected attempts in that window still receive the client notice but do not create another audit entry. Once the account can send again, a later rate-limit episode may create a new audit entry.

Unexpected tracker or audit errors are logged without message content. Tracker validation fails closed: malformed stored rate settings do not permit unbounded publishing. Legacy missing fields alone are not malformed and receive the 5/5 defaults.

## Client Behavior

The two new inputs appear alongside the existing mention, repeat, and repeat-window controls. Loading the AutoMod panel renders persisted or legacy-default values. Saving normalizes all numeric inputs to integers and rejects values outside their displayed ranges before sending a socket request.

The existing request coordinator continues to prevent stale AutoMod responses from overwriting a newer room or save. The Save button and inline success/error behavior remain unchanged.

The document `<title>` is exactly `Chat v1.3.2`.

## Test Strategy

Development follows strict RED/GREEN testing against production helpers and registered Socket.IO handlers.

Backend coverage includes:

- normalization of new bounds and 5/5 legacy defaults;
- persistence, fetch, authorization, and audit metadata for the new settings;
- first five sends accepted and the sixth blocked for the default 5/5 policy;
- strict 1/1 configuration;
- exact rolling-boundary expiry;
- blocked attempts not extending the wait;
- shared state across same-account sockets and reconnects;
- isolation across accounts and rooms;
- enforcement for Room Moderators and Global Admins;
- attachment-only messages counting while edits do not;
- no persistence, reply lookup, ping resolution, broadcast, or content leakage on rejection;
- one audit entry per active rate-limit episode;
- bounded 10,000-key storage and per-key timestamp bounds;
- removal of the old 500-millisecond per-socket throttle.

Client coverage includes:

- exact labels, numeric ranges, and default rendering;
- normalization and complete save payloads;
- invalid value rejection;
- stale-response and pending-save behavior remaining correct;
- generic room-scoped blocked-message presentation;
- exact browser title `Chat v1.3.2`.

The full existing backend and client regression suites must pass before completion.
