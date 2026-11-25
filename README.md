# consulting.tridha.net

Static landing page plus one Vercel serverless function that appends leads to a Google Sheet. It replaces the old GoHighLevel build, whose subscription lapsed. `archive/` holds what was captured from that build and is read-only reference.

- `index.html`, `css/site.css`: the page, ported verbatim from the GHL custom-code block.
- `css/form.css`, `js/form.js`: the lead modal (all 12 questions on one scrolling form, never navigates; the calendar or thank-you replaces the card in place). A submit with no answer in 20 seconds is aborted and shown like a network failure (the generic error with `FALLBACK_CONTACT`, every answer kept). Answers in progress are kept in `sessionStorage` (`trd-lead-draft-v1`, so only for that tab) to survive a reload, and dropped once the lead is saved; the honeypot and the Turnstile token are never stored.
- `js/config.js`: all owner-editable settings (thank-you text, fallback contact, consent notice, Cal.com link, ad IDs, Turnstile key).
- `js/track.js`: ad tags, loaded after `window.load` and only when their ID is set.
- `js/booking.js`, `book.html`: the Cal.com inline booking embed, used by the modal and by `/book` (see Cal.com booking).
- `api/cal-webhook.ts`: Cal.com booking webhook that updates the lead's row (see "Cal.com webhook"). `lib/cal-booking.ts` (parse + row matching, pure), `lib/cal-sheet.ts` + `lib/sheets-client.ts` (Sheets I/O shared with the lead sink).
- `api/calendar-notify.ts`, `api/calendar-cron.ts`: flag a booker who declines the Google invite (see "Google Calendar declines"). `lib/calendar-sync.ts` (decision + Status write), `lib/calendar-client.ts` (read-only Calendar API), `lib/calendar-env.ts`.
- `lib/alert.ts`: the failure-alert email, sent from the failure paths of the API endpoints (see "Failure alerts"). `scripts/test-alert.ts` sends one test alert.
- `robots.txt`, `sitemap.xml`, `llms.txt`: what crawlers may fetch, the one page to index, and a summary for language models (see "Search and AI visibility").
- `lib/channel.ts` (`classifyChannel`, pure: which marketing channel a lead came from), `lib/event-log.ts` (best-effort audit rows on the Events tab).
- `api/lead-email.ts`: corrects the email of a lead whose domain has no mail server (see "Email check"). `lib/email-domain.ts` (the MX lookup), `lib/email-sheet.ts` (the guarded Sheet update), `lib/fix-token.ts` (the correction credential), `lib/http.ts` (request helpers shared by the two lead endpoints).
- `api/lead.ts`: the endpoint. `lib/schema.ts` (zod, single source of truth, including the answer option lists), `lib/columns.ts` (sheet layout), `lib/sinks/` (where leads go), `lib/lead-dedupe.ts` + `lib/lead-lookup.ts` (one row per submission, see "Duplicate submissions"), `lib/env.ts` (fails loudly on missing env).

## Local development

```
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run dev         # vercel dev: serves the page and /api/lead
```

`vercel dev` needs `vercel login` and a linked project (`vercel link`). Put the env vars below in `.env.local`. Without a Sheet configured `/api/lead` returns 500 and logs `LEAD_SINK_MISCONFIGURED`, by design. For a visual-only check, `npx serve .` works (the form will fail on submit, because `/api/lead` does not exist there).

## Environment variables (Vercel project settings)

| Var | Required | Notes |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | yes | `client_email` from the JSON key |
| `GOOGLE_PRIVATE_KEY` | yes | `private_key` from the JSON key. Literal `\n` is fine |
| `SHEET_ID` | yes | the long id in the sheet URL |
| `SHEET_TAB` | no | defaults to `Leads` |
| `EVENTS_TAB` | no | defaults to `Events`; the audit-log tab, see "Events tab" |
| `TURNSTILE_SECRET_KEY` | no | set together with `TURNSTILE_SITE_KEY` in `js/config.js` |
| `CAL_WEBHOOK_SECRET` | for `/api/cal-webhook` | the secret typed into the Cal.com webhook; without it the endpoint returns 500 |
| `ALERT_SMTP_PASS` | no | the Zoho app password of the alert mailbox; setting it turns failure alerts on, see "Failure alerts". Unset: alerts are off and the site works as before |
| `ALERT_SMTP_USER` | no | the mailbox that sends the alerts; defaults to `consulting@tridha.net` |
| `ALERT_TO` | no | who receives them, comma-separated; defaults to `ALERT_SMTP_USER` |
| `ALERT_SMTP_HOST` | no | defaults to `smtp.zoho.in` (port 465, implicit TLS); `smtp.zoho.com` for an account on the .com data centre |
| `CALENDAR_ID`, `CALENDAR_CHANNEL_TOKEN`, `CRON_SECRET` | for the calendar sync | see "Google Calendar declines". `CRON_SECRET` also keys the `fixToken` of the email correction (see "Email check") |

### Lead rate limit

`/api/lead` accepts 5 submissions per client IP per 10 minutes (sliding window) and then answers `429 { "error": "rate_limited" }` with a `Retry-After` header; the dropped lead is logged in full as `LEAD_RATE_LIMITED`. The check runs after the honeypot and before the Turnstile call. It is kept in each serverless instance's memory (`lib/rate-limit.ts`), so it stops a burst from one source but is not a global quota across instances; Turnstile is the bot defence. A request with no client IP is not limited. `vercel dev` sets `x-real-ip` to the loopback address, so the limit applies locally too; set `LEAD_RATE_LIMIT=1000` in `.env.local` to lift it.

| Var | Required | Notes |
|---|---|---|
| `LEAD_RATE_LIMIT` | no | submissions per IP per window; defaults to `5`. A non-positive or non-integer value is ignored |
| `LEAD_RATE_WINDOW_SEC` | no | window length in seconds; defaults to `600`. A non-positive or non-integer value is ignored |

### Duplicate submissions

The form aborts a `/api/lead` request that has not answered within 20 seconds, but the request can still finish on the server and save the lead; the visitor's retry must not add a second row. So the browser proposes the Lead ID, and the server stores one submission once (`lib/lead-dedupe.ts`, `lib/lead-lookup.ts`):

- **The id.** `js/form.js` makes a random UUID v4 (`crypto.randomUUID`, else built from `crypto.getRandomValues`) and sends it as `leadId` with the first attempt and every retry of the same answers. It is kept in `sessionStorage` (`trd-lead-id-v1`) with a hash of the 12 answers as sent (the phone as normalised), never the answers themselves, so a reload of the tab keeps it. A change to any answer as sent makes a new id: changed answers are a new submission with a row of their own, and only the latest answers keep their id. A saved lead drops the id along with the draft. A browser with neither crypto call sends no id, and the server makes one as before.
- **The server.** `/api/lead` takes `leadId` only when it is a lowercase UUID v4; anything else is ignored and the server makes the id. Every attempt still passes the honeypot, the rate limit (a retry counts), Turnstile (the form resets the widget after a failure, so a retry carries a fresh token) and validation. A request is the same submission as an earlier one when it carries the same id and the same Email (ignoring case) and Phone. Then:
  1. On the same serverless instance, a retry that arrives while the first attempt is still running waits for it and gets its answer, success or failure; one that arrives within 15 minutes of a success gets that answer without reading the Sheet. Logged as `LEAD_RETRY_JOINED` (id and status). A failed attempt is forgotten as soon as it answers, so the next retry writes again.
  2. Otherwise the server reads the Lead ID column (that one column, beside the MX lookup, under a 4 second deadline) and on a match that one row. A match by the same submitter is answered from the row and nothing is appended or added to the Events tab (`LEAD_RETRY_REPLAYED`, id and row number).
  The answer is the one the first attempt gave, `{ ok, leadId, emailOk }` and the same `fixToken` while the row's Email Check is `No mail server`, so the email step and the Cal embed get the stored lead's id. `track.lead()` (the X lead conversion included) fires on the one success the browser sees, so once per lead.
- **An id held by someone else.** When the row or the running attempt with that id has a different Email or Phone, the request is never answered from it: the lead is stored under a fresh server id (`LEAD_ID_CONFLICT`, ids and row only). Knowing a lead id is not enough to read back that lead's answer or its fix token. A row whose Email or Phone was edited by hand, or corrected through `/api/lead-email`, no longer matches a late retry of the original answers, which is then stored as a new row.
- **A failed check.** If the lookup fails or times out, or the row found moved before it was read (the sheet was sorted in between), the lead is appended anyway (`LEAD_DEDUPE_CHECK_FAILED`, id and error only): a possible duplicate costs less than a lost lead.
- **The race that remains.** The wait in step 1 is per instance. A retry that reaches a *different* instance while the first attempt is still running there, before it has appended its row, finds nothing in the Sheet and appends a second row. Both rows carry the same Lead ID; the Cal.com webhook, the email correction and this lookup all use the upper one, so delete the lower one by hand. A retry usually lands seconds later on the same warm instance, but nothing guarantees it; closing this needs a store shared by all instances (or a lock in the Sheet), which the site does not have.

## Google Sheet setup

1. Create a Google Cloud project at console.cloud.google.com (any name).
2. In that project, open APIs & Services, Library, search "Google Sheets API", click Enable.
3. IAM & Admin, Service Accounts, Create service account (e.g. `lead-writer`). No roles needed.
4. Open the service account, Keys, Add key, Create new key, JSON. A file downloads. Keep it private and do not commit it.
5. Create the Google Sheet. Rename the first tab to `Leads` (or set `SHEET_TAB`). Click Share and add the service account email (`client_email` in the JSON) as Editor.
6. Paste the header row into cell A1. Print it with `npm run sheet-headers`, which prints two labelled tab-separated lines, one for the Leads tab and one for the Events tab (step 9). Paste the Leads line, which fills A1 to AP1 across cells (42 columns). `Channel`, `twclid`, `gbraid` and `wbraid` follow `Last Event At` (see "Channel"). To move an existing sheet to this layout, follow "Rollout order". `Call Outcome`, `Qualified`, `Setter Notes` and `Deal Value (₹)` are the team's (see "Team columns"). The last two, `Email Check` and `Cancellation Reason`, are written by code (see "Email check" and "Cal.com webhook"). The nine answer columns from `Designation` to `Decision Maker` are filled from the site form when the lead is saved. The booking columns (`Call Time (IST)`, `Booked At (IST)`, `Booking Details`, `Booking UID`, `Last Event At`) are filled by the Cal.com webhook and stay blank on a fresh lead. The order must match `lib/columns.ts`; that file generates both. While the sheet holds only a header row it can be replaced with the new one outright. Once it holds data rows, columns are only ever appended at the end: reordering would misalign the existing rows. The Cal.com webhook and the calendar sync refuse to write unless the first 42 header cells match exactly; cells after AP are not checked (see "Trailing columns").
7. In Vercel, Project, Settings, Environment Variables, add `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `SHEET_ID` for Production (and Preview if wanted). Redeploy.
8. Submit a test lead on the live page and confirm a row appears.
9. Optional, for the audit log (see "Events tab"): add a second tab named `Events` (or set `EVENTS_TAB`), and paste the Events line from `npm run sheet-headers` into its A1. The tab sits in the same spreadsheet and needs no extra sharing. Until it exists the log writes fail harmlessly (`EVENT_LOG_WRITE_FAILED`) and everything else works.

If a write fails, the function logs one JSON line `{"event":"LEAD_WRITE_FAILED", ...}` containing the full lead. Search Vercel logs for `LEAD_WRITE_FAILED` to recover it. `LEAD_WRITTEN` marks successes.

With Turnstile on, a rejected lead logs `LEAD_CAPTCHA_REJECTED` (Cloudflare `errorCodes` plus the full lead), and an unreachable Cloudflare logs `LEAD_CAPTCHA_UNAVAILABLE` with the lead. A rejection with `missing-input-response` and a `hint` usually means `TURNSTILE_SECRET_KEY` is set but `TURNSTILE_SITE_KEY` is empty in `js/config.js`.

## Cal.com webhook

`/api/cal-webhook` copies bookings onto the lead's row so the setter sees call time and answers next to the lead.

1. In Cal.com, Settings, Developer, Webhooks, New. Subscriber URL: `https://consulting.tridha.net/api/cal-webhook`.
2. Tick the triggers **Booking Created**, **Booking Rescheduled**, **Booking Cancelled** (others are acknowledged and ignored).
3. Set a Secret, and put the same value in Vercel as `CAL_WEBHOOK_SECRET`. Redeploy. Use the Ping test button: it should return 200 (to be confirmed on the live account; the ping payload is not described in Cal's docs, and any signed trigger we do not handle is acknowledged with 200).

Cal signs the raw body with HMAC-SHA256 in `x-cal-signature-256`; a missing or wrong signature is a 401 (`CAL_WEBHOOK_BAD_SIGNATURE`, body never logged). The row is found by `metadata.leadId` (the embed should pass the lead id), else by the stored Booking UID (`uid`, or `rescheduleUid` on a reschedule), else by the newest row with the attendee's email. With no match a row is appended with Lead ID `cal-<uid>`. Status becomes `Booked`, `Rescheduled` or `Cancelled`; a cancel keeps the call time. Booking-form answers, if the event type asks any, go to their own columns (see "Questions and sheet columns"). Booking Details is rewritten on every applied event, from that event's answers that have no column; it does not accumulate. The cancellation reason has its own column, `Cancellation Reason`: a cancel writes the reason (trimmed, blank when the lead gave none) and a created or rescheduled booking writes blank, so a re-book clears a stale reason; an ignored (stale) event writes nothing. A row appended from a booking gets the same value. Row 1 (the header) is never matched or written, whatever the booker puts in the booking form. `Last Event At` stores the envelope `createdAt` of the last event applied; an event strictly older than that is ignored (200 `{"ignored":"stale_event"}`, logged as `CAL_WEBHOOK_STALE`), so a late or replayed event cannot revert a newer state. Only a strict ISO-8601 datetime counts as a timestamp, and one more than 24 hours ahead of the server clock is ignored too (noted as `warn` in the sync log line); anything else, such as text typed into the cell, is treated as missing and the row is updated as normal. A cancellation applies only when its uid equals the row's Booking UID or the row has none; a cancel of an earlier booking (the lead rebooked) is ignored (200 `{"ignored":"stale_cancellation"}`, logged as `CAL_WEBHOOK_STALE`). The same event delivered twice one after the other leaves the sheet unchanged. Known limitations, both low: two simultaneous first deliveries for a brand-new booker with no lead row can both append a row (delete the duplicate by hand), and a cancellation delivered before the reschedule it belongs to is ignored, so that row ends `Rescheduled` instead of `Cancelled` (correct it by hand). Booking Details is capped at 45,000 characters (a Sheets cell holds 50,000).

`CAL_BOOKING_SYNCED` marks a success (uid, trigger, matchedBy, row, plus `warn` and `unmapped` when present; see "Questions and sheet columns"). If the Sheet is unreachable the function returns 502 so that a retry can recover the write if Cal retries (Cal's docs only describe retries for some events, so do not rely on it); the dependable recovery is the `CAL_WEBHOOK_WRITE_FAILED` log line, which carries the full payload. `CAL_WEBHOOK_MISCONFIGURED` means `CAL_WEBHOOK_SECRET` or a Sheet variable is missing, or the sheet's header row does not match `npm run sheet-headers` (the `error` field says which; payload logged); `CAL_WEBHOOK_BAD_PAYLOAD` is a signed body that is not a JSON object (logged with the raw body) or a booking without a uid, start time or attendee email (logged with the payload). `CAL_WEBHOOK_TOO_LARGE` is a body over 64 KB (413; byte size only, since it is unauthenticated).

## Google Calendar declines

Cal.com puts each booking on `consulting@` as a Google Calendar event and invites the booker, but it is never told when the booker answers the invite "No". The calendar sync reads those answers and sets the lead's Status to `Declined`, so the setter does not ring someone who has said they will not come.

- **What it does.** An event is tied to its row through its `iCalUID` (`<Cal booking uid>@Cal.com`), which equals the row's Booking UID. Only the booker's own response counts (the attendee whose email is the row's Email, compared ignoring case and spaces); a guest the setter added declining changes nothing. `Booked` or `Rescheduled` becomes `Declined` when the booker has declined; `Declined` goes back to `Booked` when they answer `accepted`, `tentative` or `needsAction` again. Any other Status (`New`, `Cancelled`) and any cancelled Google event is left alone. Only the Status cell is written, in one `values.batchUpdate`, and only after the header row is checked like the webhook does.
- **Rescheduled bookings.** Cal updates a rescheduled booking's Google event in place, so the event keeps the ORIGINAL booking uid while the webhook overwrites the row's Booking UID with the new one. When no row has the event's uid, the sync falls back to a row where a non-organizer attendee's email equals the row's Email, the event's start (formatted like the webhook does, `YYYY-MM-DD HH:mm:ss` IST) equals the row's `Call Time (IST)` exactly, and the Status is `Booked`, `Rescheduled` or `Declined`. A `Cancelled` or `New` row never matches this way. If several rows qualify, the newest wins. The usual booker and decision rules then apply to that row, and `CALENDAR_EVENT_MATCHED_BY_TIME` is logged.
- **Limits.** The booker is found by email. If they type a different email in Cal than the one on the form, no attendee matches the row's Email, so their decline cannot be applied; the sync logs `CALENDAR_BOOKER_NOT_FOUND` (uid only) for it. The sync also needs to see attendees: if the calendar is shared at free/busy only, Google returns events without them, and `CALENDAR_EVENTS_WITHOUT_ATTENDEES` is logged with a count.
- **Logs.** The sync emits `CALENDAR_STATUS_CHANGED` (uid, from, to), `CALENDAR_EVENT_UNMATCHED` (uid), `CALENDAR_EVENT_MATCHED_BY_TIME` (uid), `CALENDAR_BOOKER_NOT_FOUND` (uid) and `CALENDAR_EVENTS_WITHOUT_ATTENDEES` (count, hint, once per sync); these carry identifiers only, never a name or email. `/api/calendar-notify` emits `CALENDAR_NOTIFY_MISCONFIGURED`, `CALENDAR_NOTIFY_BAD_TOKEN` and `CALENDAR_NOTIFY_FAILED`. `/api/calendar-cron` emits `CALENDAR_CRON_MISCONFIGURED`, `CALENDAR_CRON_UNAUTHORIZED`, `CALENDAR_SWEEP_FAILED`, `CALENDAR_CHANNEL_RENEWED` (channelId, expiresAt) and `CALENDAR_WATCH_RENEW_FAILED`. The failure events carry the error message text.
- **Environment variables** (only these endpoints need them; the form and the Cal.com webhook work without). If a variable an endpoint needs is unset it answers 500 `server_misconfigured`; if it is set but the request's secret is missing or wrong it answers 401:

| Var | Notes |
|---|---|
| `CALENDAR_ID` | the calendar Cal.com books onto, e.g. the `consulting@` address; needed by both endpoints |
| `CALENDAR_CHANNEL_TOKEN` | a long random string; Google echoes it in `X-Goog-Channel-Token` on every push. Needed by both endpoints (the cron sends it when it opens a channel); `/api/calendar-notify` returns 401 when the header is missing or wrong |
| `CRON_SECRET` | a long random string; Vercel sends it as `Authorization: Bearer ...` to the cron. Also keys the fix token `/api/lead` issues for an email with no mail server (see Email Check), so rotating it invalidates tokens already handed out. Unset: `/api/calendar-cron` returns 500 (401 when the bearer is missing or wrong), `/api/lead` still saves every lead but cannot offer the email-fix step, and `/api/lead-email` returns 500 |

- **Calendar access.** Share that calendar with the service account email (the same one as the Sheet) with "See all event details", and enable the Google Calendar API in the same Google Cloud project. The sync asks only for the `calendar.readonly` scope.
- **How it runs.** `vercel.json` schedules `/api/calendar-cron` for 00:30 UTC (06:00 IST). Vercel runs Hobby crons once a day, at some point within the scheduled hour. It sweeps events from yesterday to 90 days ahead, then opens a new push channel with a 2-day lifetime pointing at `https://$VERCEL_PROJECT_PRODUCTION_URL/api/calendar-notify`. A channel is opened every day, so they overlap; channels are not stored or stopped, and duplicate notifications are harmless because the sync is idempotent. Google then posts to `/api/calendar-notify` whenever the calendar changes, and that re-reads the events updated in the last 48 hours, so a decline usually lands within a few minutes. The sweep and the channel renewal are independent: if one fails the other still runs and the cron answers 500.
- **Worst case.** If push delivery fails (a channel that did not open, or notifications that never arrive), a decline appears at the next daily sweep, up to about a day later. A decline on an event more than 90 days away is picked up once its date comes within the window.
- **Setup check.** After setting the three variables and deploying, call the cron once by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://consulting.tridha.net/api/calendar-cron`. It answers `{"ok":true,"swept":N,"changed":N,"channelExpiresAt":"..."}`.

## Failure alerts

Vercel's Hobby plan keeps function logs for about an hour, so a lead that fails to save at night would be gone from the logs by morning. When something below fails, the function also emails the team through the Zoho mailbox. Every failure is still logged exactly as before; the email is in addition, and the HTTP answer of the endpoint never changes. The mail is sent after the response, through `waitUntil` from `@vercel/functions` (`alertInBackground` in `lib/alert.ts`), so a slow mail server never delays a visitor or counts against the form's 20 second submit timeout.

- **What alerts.**
  - A lead that is not saved: `LEAD_WRITE_FAILED`, `LEAD_SINK_MISCONFIGURED` and `LEAD_CAPTCHA_UNAVAILABLE` (Cloudflare could not be reached, so the lead was dropped) from `/api/lead`. The mail carries every field of the lead, so it can be entered into the Sheet by hand. When only some sinks fail, one mail lists the failed ones.
  - `CAL_WEBHOOK_WRITE_FAILED` and `CAL_WEBHOOK_MISCONFIGURED` (the missing secret, the missing Sheet variables and a wrong header row), and `CAL_WEBHOOK_BAD_PAYLOAD` for a signed body only. The mail carries the trigger and the payload.
  - `LEAD_EMAIL_WRITE_FAILED` and `LEAD_EMAIL_MISCONFIGURED` (Sheet variables or header row) from `/api/lead-email`: a corrected address that was not written.
  - `CALENDAR_CRON_MISCONFIGURED`, `CALENDAR_SWEEP_FAILED` and `CALENDAR_WATCH_RENEW_FAILED` from the daily cron, and `CALENDAR_NOTIFY_MISCONFIGURED` from `/api/calendar-notify`. Without a renewed push channel, declines stop syncing within two days.
- **What deliberately does not.** Anything a stranger can trigger by sending requests: `LEAD_RATE_LIMITED`, a rejected captcha (a visitor the captcha turned away, not a lead lost), validation errors, `CAL_WEBHOOK_BAD_SIGNATURE`, `CAL_WEBHOOK_TOO_LARGE`, `CALENDAR_CRON_UNAUTHORIZED`, `CALENDAR_NOTIFY_BAD_TOKEN`, and the `/api/lead-email` token and `CRON_SECRET` checks. Also `LEAD_DEDUPE_CHECK_FAILED`, `LEAD_ID_CONFLICT`, `LEAD_FIX_TOKEN_UNAVAILABLE`, `CALENDAR_NOTIFY_FAILED` (Google retries and the daily sweep covers it) and `EVENT_LOG_WRITE_FAILED`: the lead or booking itself is safe. Some alerts can be reached without any credential. The three misconfiguration alerts that run before a secret is checked (`CAL_WEBHOOK_SECRET` missing, `CALENDAR_NOTIFY_MISCONFIGURED`, and the cron's) have one fixed throttle key, so they are bounded to one mail per ten minutes per server instance. `LEAD_SINK_MISCONFIGURED` and `LEAD_CAPTCHA_UNAVAILABLE` are reached by any well-formed lead, and the lead id in them is chosen by the sender, so a key cannot bound them: each is capped at 5 mails per ten minutes per instance, whoever sends. The fifth says that further alerts of that type are suppressed for ten minutes; the leads over the cap are still in the Vercel logs.
- **Throttle.** A server instance sends at most one mail per ten minutes for the same alert key. A lost lead is keyed by its lead id, so every distinct lead alerts; a Cal.com retry of the same booking and trigger, and a repeating misconfiguration, are suppressed. A send that fails or times out gives its slot back, so the next attempt (Cal.com's retry, for one) can still alert. The throttle lives in memory, so a new instance may mail again.
- **Mail.** Plain text, subject prefixed `[consulting.tridha.net]`, the time in IST, the error message and the details as JSON (cut at 60 KB). The whole send, loading the mail library included, gives up after 6 seconds (the connection is aborted, not left open), and a failed send is logged as `ALERT_SEND_FAILED` (nothing else changes). With no password set, `ALERT_NOT_CONFIGURED` is logged instead.
- **Create the app password.** Sign in to Zoho Accounts (accounts.zoho.in, or accounts.zoho.com on the .com data centre) as the mailbox owner, then Security, App Passwords, Generate New Password, name it `consulting.tridha.net alerts`. App passwords need two-factor authentication to be enabled on the account first. Copy the password once; it is not shown again. An account on the .com data centre sets `ALERT_SMTP_HOST=smtp.zoho.com`. If login fails on `smtp.zoho.in`, an organisation (custom-domain) account may need `smtppro.zoho.in` instead (`smtppro.zoho.com` on the .com data centre): set `ALERT_SMTP_HOST` to it.
- **Rollout.** In Vercel, Project, Settings, Environment Variables, add `ALERT_SMTP_PASS` (Production) and redeploy. The other three are only needed to change a default. Then check delivery with `ALERT_SMTP_PASS=<the app password> npx tsx scripts/test-alert.ts`, which sends one mail labelled as a test and prints only whether the server accepted it. Never commit the password.

## Hero video

The page works with only the poster. To add the video, put the file at `assets/hero.mp4`. The original is 725 MB; compress first:

```
ffmpeg -i original.mp4 -vf "scale=-2:'min(1080,ih)'" -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart assets/hero.mp4
```

The video tag uses `preload="none"`, so it costs nothing until played. Keep the compressed file small enough for your Vercel plan's deployment limits, or host it on Vercel Blob / R2 and change `src` in `index.html`.

## Ad IDs and tracking

Edit `js/config.js`: `META_PIXEL_ID`, `GA4_ID`, `GOOGLE_ADS_ID` + `GOOGLE_ADS_LEAD_LABEL`, `LINKEDIN_PARTNER_ID` + `LINKEDIN_CONVERSION_ID`, `X_PIXEL_ID` (the base pixel, set to `re613` as on the old page) and `X_LEAD_EVENT_ID` (a `tw-xxxxx-yyyyy` event id fired on a successful submit; empty fires nothing). Empty means the tag is never loaded. `track.lead()` fires once on a successful submit. To use Turnstile, set `TURNSTILE_SITE_KEY` there and `TURNSTILE_SECRET_KEY` in Vercel.

## Cal.com booking

After the lead is saved (the form's twelve answers are already in the Sheet), the visitor can book a call on a Cal.com calendar embedded on our own domain. Cal is only used to pick a time slot. It is driven by two settings in `js/config.js`:

- `CAL_LINK`: the Cal.com booking link as `<user>/<event>`, set to `'tridha-consulting/exploration-call'`. **Empty turns the booking state off:** the form ends with the thank-you text exactly as before, and `/book` says online booking is unavailable and gives `FALLBACK_CONTACT`.
- `CAL_ORIGIN`: where the embed is served from, default `'https://app.cal.com'`. For a self-hosted Cal, change this one line to its origin.

With `CAL_LINK` set, a successful submit (unless the email check below fails) turns the modal into the calendar ("Pick a time for your call"), prefilled with name, email, phone (from the form) and `metadata[leadId]` (the id `/api/lead` returned, so the booking can be matched to the Sheet row). The Cal script is fetched only at that moment, never on page load. If Cal has not rendered within 15 seconds, or its script fails, the card shows the thank-you text ("our team will call you") and an "Open the booking page" link to `https://cal.com/<CAL_LINK>` (or `<CAL_ORIGIN>/<CAL_LINK>` when self-hosted) with the same prefill. A booking replaces the embed with `BOOKED_TEXT` and calls `track.booked()`: Meta `Schedule`, GA4 `book_call`, and X only when `X_BOOKED_EVENT_ID` is set.

### Email check

Cal.com refuses a booking whose attendee email domain cannot receive mail (HTTP 400 `email_domain_cannot_receive_mail`), so the Cal embed would fail for a lead who typed `gmial.co`. The lead is saved regardless; the form asks for the fix before the calendar opens.

1. `/api/lead` looks up the MX records of the email's domain (`checkEmailDomain` in `lib/email-domain.ts`, Node's DNS resolver, 1.5 second query timeout, no retry, 2 second overall deadline) and writes the result to the `Email Check` column: `OK`, `No mail server` or `Unchecked`. `No mail server` means a definite answer: no such domain (`ENOTFOUND`), no MX records (`ENODATA` or an empty answer), or a null MX (RFC 7505). Any other outcome, a timeout or `SERVFAIL` included, is `Unchecked`, so our own DNS trouble never blocks a lead. A domain that has no MX but receives mail on an A record is reported `No mail server`: the lead can still skip the step. The response is `{ ok, leadId, emailOk }`, with `emailOk` false only for `No mail server`; `LEAD_WRITTEN` logs the `emailCheck`. An unreachable DNS resolver, or one that cannot even be created, is `Unchecked` too: the lookup never rejects, so it can never cost a lead its row. When `emailOk` is false the response also carries `fixToken`, the base64url HMAC-SHA256 of `lead-email:<leadId>` keyed by `CRON_SECRET` (the `lead-email:` prefix keeps it from being a valid signature for anything else). Without `CRON_SECRET` the lead is still saved, no token is issued (`LEAD_FIX_TOKEN_UNAVAILABLE` is logged) and the form goes straight to the thank-you text.
2. With `emailOk: false` the modal does not open Cal. It shows "We've saved your details. We couldn't find a mail server for `<domain>`, so your booking confirmation wouldn't reach you. Please check your email:" with the address prefilled, a "Continue to booking" button and a "Skip — just call me" link that shows the thank-you text. The typo hint of the main form runs on this input too.
3. Continue posts `{ leadId, email, fixToken }` to `POST /api/lead-email`. The token is verified in constant time before any DNS lookup or Sheet request: a missing, wrong or other-lead token answers 403 `{ "error": "forbidden" }`, and with `CRON_SECRET` unset the endpoint answers 500 `server_misconfigured` (logged as `LEAD_EMAIL_MISCONFIGURED`), so a random lead id cannot make it read the Sheet. It then checks the new address with the same rule as the form (`emailSchema` in `lib/schema.ts`; `leadId` must be a UUID; body cap 2 KiB; other methods get a JSON 405), looks the new domain up, and updates the same row. It writes only the `Email` and `Email Check` cells of that row (one `batchUpdate`, RAW), appends an `Email corrected` row to the Events tab, and answers `{ ok: true, leadId, emailOk }`. A still-bad address is written too (the latest attempt wins) and answers `emailOk: false`, so the step stays with an error; `emailOk: true` opens the calendar with the corrected address and the same `metadata[leadId]`.
4. A row is correctable only while its `Email Check` is `No mail server`. A retry of a correction that already landed (the answer was lost on the way back) is recognised: when the row's `Email Check` is `OK` or `Unchecked` and its `Email` equals the requested address (trimmed, case-insensitive) the answer is 200 `emailOk: true` and nothing is written. Any other row, including every row written before the column existed, answers 409 `{ "error": "not_correctable" }` and is never rewritten; the form then shows a short message and keeps "Skip". The lead id is matched exactly, never as part of a longer id. An unknown lead id answers 404 `not_found`. A Sheets failure answers 502 and logs `LEAD_EMAIL_WRITE_FAILED` with the lead id and the attempted address (the recovery path, like `LEAD_WRITE_FAILED`); a missing Sheet variable or a header row that does not match answers 500 and logs `LEAD_EMAIL_MISCONFIGURED`. A network or server error in the step shows the generic error with `FALLBACK_CONTACT`, and the visitor can retry or skip; a request that takes 15 seconds is aborted and shown the same way, and "Skip" works while a request is in flight (the request is aborted and the thank-you shows).

`/book` is the same embed on its own page, for a setter to send a personal link. Prefill comes from the query string:

```
https://consulting.tridha.net/book?name=Asha%20Rao&email=asha%40example.com&phone=%2B919876543210
```

`phone` is sent to Cal as `attendeePhoneNumber`, the key of Cal's default phone field. The form validates the number with `libphonenumber-js/max` on the server (`lib/schema.ts`), so an invalid number is flagged on our form rather than blocking Confirm in Cal; the browser applies the India rule (10 digits starting 6-9) and the server applies the same rule on top of libphonenumber (`+915876543210` is rejected on both sides). Both drop every leading trunk 0 from the national number before checking it (Italy, `+39`, keeps its zeros), so `+91009000000001` is stored as `+919000000001`. For other countries the browser relies on the server's field error. If the event type uses a differently named phone field, change `prefillParams` in `js/booking.js`.

The browser reads the number as people type it: spaces, dashes, dots and parentheses are ignored, and so are the invisible characters a number copied from a phone or a chat can carry (direction marks, zero-width spaces); any other character makes the number invalid. A number typed with `+` and a country code uses that code whatever the dropdown says (`+971 50 123 4567` with India selected posts `+971501234567`). With India selected it also takes the 10-digit mobile after a trunk 0 or after 91. For other countries it checks only the length (8 to 15 digits with a typed code) and leaves the rest to the server.

With India selected, only `+` and `0091` are international prefixes. `00` followed by an Indian mobile (10 digits starting 6-9) is that mobile with its trunk 0 typed twice, so it posts as `+91` and the 10 digits; `0091` and a mobile posts the same. Any other number starting `00` is refused in the browser ("Please enter a valid phone number."), so `00971501234567` with India selected is refused while `+971 50 123 4567` is posted. The zeros are read once the separators are dropped, so `0 0` counts too. Three or more zeros are all trunk zeros: they are dropped and the rest is checked as an Indian number. With another country selected, `00` is still the international prefix and its country code wins over the dropdown, as `+` does.

### Consent notice

Just above the form's Submit button the modal shows `CONSENT_TEXT` from `js/config.js`, a notice under the DPDP Act 2023: what the form collects (name, email, phone, the answers), what for (to contact the visitor about a consulting call and schedule it), that the booking step shares name, email, phone and company with Cal.com, that the X pixel sends X hashed copies of the name, email and phone when Submit is pressed (uwt.js does this on its own: its automatic button-click event reads the form), and how to withdraw consent or ask for deletion (by email; the address becomes a mailto link). Submitting the form is the consent; there is no tick-box. Submit is described by the notice (`aria-describedby`), so a screen reader reads it with the button. The wording is marked DRAFT in `js/config.js`. An empty `CONSENT_TEXT` shows no notice.

### Questions and sheet columns

All twelve questions are asked on the site form (`js/form.js`), on one page, every one required. `/api/lead` validates them against `lib/schema.ts` and writes each answer to its own sheet column, so it can be sorted and filtered:

| Form field (JSON key) | Sheet header | Type |
|---|---|---|
| Full Name (`fullName`) | Full Name | Text |
| Designation (`designation`) | Designation | Text, 1 to 120 characters |
| Phone (`phone`) | Phone | Country code + number; the server rejects numbers libphonenumber-js (max metadata) deems invalid, the same check Cal.com's booking step applies |
| Email (`email`) | Email | Email |
| Company Name (`company`) | Company | Text, 1 to 120 characters |
| Company Website (`website`) | Website | Text, 1 to 200 characters, not format-checked |
| What is your company's current annual revenue? (`revenue`) | Annual Revenue | Radio |
| To implement custom AI or scale your tech infrastructure, what is your approved investment budget for the next 3-6 months? (`budget`) | Budget (3-6 Months) | Radio |
| What is the biggest operational bottleneck currently slowing down your company's growth? (Select up to two) (`bottleneck`) | Bottleneck | Checkboxes, one or two |
| Do you have an in-house development/tech team? (`techTeam`) | Tech Team | Radio |
| If we identify a clear ROI path to automate your bottlenecks, how soon are you looking to initiate the project? (`timeline`) | Timeline | Radio |
| Are you the primary decision-maker for financial investments in your company? (`decisionMaker`) | Decision Maker | Radio |

The options of the radio and checkbox questions are the exported lists in `lib/schema.ts` (`REVENUE_OPTIONS`, `BUDGET_OPTIONS`, `BOTTLENECK_OPTIONS`, `TECH_TEAM_OPTIONS`, `TIMELINE_OPTIONS`, `DECISION_MAKER_OPTIONS`). The server rejects any other text. `js/form.js` keeps a copy (`OPTIONS`), and `tests/client-parity.test.ts` fails if the copy differs in a single character or in order. To change an option, edit `lib/schema.ts` first, then the copy in `js/form.js`. The cell holds the option text exactly; `Bottleneck` holds the ticked options joined with `; `, in the order of `BOTTLENECK_OPTIONS` (not the order they were ticked).

**Cal.com event type.** Cal only picks the time slot. In Cal.com, open the event type, Advanced, Booking questions: keep Name and Email, make Phone required, and add one hidden Short Text question with the identifier `company`, and switch every other question off. The embed prefills name, email, phone and company from the form, so the visitor is not asked twice, and the event name in calendar can use `{COMPANY}` (for example `Tridha × {COMPANY} · Exploration Call`). The webhook maps a `company` response to the Company column, which writes the same value the form already wrote.

**Optional fallback: answers asked in Cal.** If Cal booking questions are ever turned on, the webhook still copies their answers into the same columns, keyed by the question's Identifier (typed exactly; the identifier is what the webhook reads, not the question text):

| Identifier | Sheet header |
|---|---|
| `designation` | Designation |
| `company` | Company |
| `website` | Website |
| `revenue` | Annual Revenue |
| `budget` | Budget (3-6 Months) |
| `bottleneck` | Bottleneck |
| `tech_team` | Tech Team |
| `timeline` | Timeline |
| `decision_maker` | Decision Maker |

This matters mostly for a booking that arrives with no lead row (for example a setter sending a `/book` link): the row is then created from the booking alone, and any answers can only come from Cal. For a lead that already has site answers, a Cal answer replaces that cell only when it is non-empty. The mapping lives in `ANSWER_COLUMNS` in `lib/cal-booking.ts`. Cal's checkbox group joins its selections with `, ` and cannot cap them at two.

- A custom question whose identifier is not in the table (a typo such as `desgination`, or a new question) is not lost: it is written to `Booking Details` as `Label: value`, and its identifier is listed in the `unmapped` field of that booking's `CAL_BOOKING_SYNCED` log line. Cal's built-in fields (location, notes, guests, additional guests, reschedule reason, title, `what_is_this_meeting_about`) are never reported. An identifier is listed only when it carries a value; a blank optional question is not logged.
- A later event with an empty or missing answer (a cancel payload may carry no answers) never blanks an answer already in the sheet; only non-empty answers are written.
- `Booked At (IST)` is when the lead first booked: the webhook's `createdAt` on `BOOKING_CREATED` (the server clock if that is missing or unusable), shown in IST. It is written only while the cell is empty, so a replayed event, a reschedule, a cancel or a re-book after a cancel never moves it. It stays blank if that lead's `BOOKING_CREATED` was never applied (lost, or ignored as stale); fill it by hand. `Call Time (IST)` is still when the call is.
- Each answer cell is capped at 45,000 characters like `Booking Details`.
- Cal may write an identifier with hyphens where the table has underscores (`tech-team` for `tech_team`). The webhook treats `-` and `_` as the same, for the answer column, the Booking Details exclusion and the unmapped check. If both spellings carry a value, the underscore one is used.
- The webhook checks the live header row before every write. Its first 42 cells (A1:AP1, the Leads line of `npm run sheet-headers`) must match exactly, spaces around a cell ignored; cells after AP are not checked (see "Trailing columns"). If the tab is empty or the header differs within those 42 (an old 22-, 32- or 40-column header, a renamed, missing or reordered column, one inserted in the middle), nothing is written: the function logs `CAL_WEBHOOK_MISCONFIGURED` with the first differing column (headers only, never row data), the trigger and the full payload, and returns 500. Fix the header row; the payload in the log is the way to recover the booking.

### Channel, team columns and the Events tab

**Channel.** `Channel` is derived when the row is written, from the attribution columns, by `classifyChannel` in `lib/channel.ts` (pure, covered by `tests/channel.test.ts`). The first rule that matches wins:

| # | Rule | Channel |
|---|---|---|
| 1 | `utm_medium` matches GA4's paid rule `^(.*cp.*|ppc|retargeting|paid.*)$` (so `cpc`, `cpm`, `cpv`, `ppc`, `retargeting`, `paid`, `paid_social`, `paid_media`) or is `sponsored`, `display`, `ad`, `ads`, `pmax`, `paid_social`, `paidsocial` or `social_paid`; or `gclid`, `gbraid`, `wbraid`, `twclid` or `li_fat_id` is present: paid, platform by `gclid`, `gbraid`, `wbraid` or `utm_source` Google (see aliases below) | Google Ads |
| | then `twclid` or `utm_source` X | X Ads |
| | then `li_fat_id` or `utm_source` LinkedIn | LinkedIn Ads |
| | then `utm_source` Meta, or an `fbclid` beside the paid medium | Meta Ads |
| | none of those | Paid (other) |
| 2 | `utm_medium` is `email`, or `utm_source` is exactly `email`, `newsletter`, `mailchimp` or `zoho_campaigns` (a source that merely contains "mail", such as `dailymail` or `hotmail`, is not Email) | Email |
| 3 | `utm_medium` is `social` or `organic_social` | Organic Social |
| 4 | an `fbclid` with none of the above (Meta adds it to organic link clicks, so it is not paid) | Organic Social |
| 5 | `utm_source` is a social network (Meta, X, LinkedIn, `youtube`, `whatsapp`, `reddit`) and the medium is not paid | Organic Social |
| | `utm_source` is a search engine (`google`, `bing`, `duckduckgo`, `yahoo`, `yandex`, `ecosia`) and `utm_medium` is `organic` | Organic Search |
| 6 | referrer host (leading `www.` dropped): `mail.google.com`, `outlook.live.com`, `mail.yahoo.com`; `android-app://com.google.android.gm` | Email |
| | `googleadservices.com`, `googlesyndication.com`, `doubleclick.net` (subdomains included) | Google Ads |
| | search hosts only: `google.<tld>` (`google.com`, `google.co.in`; `mail.`, `docs.`, `news.` and other subdomains do not count), `bing.com`, `duckduckgo.com`, `search.yahoo.com`, `yandex.<tld>`, `ecosia.org`; `android-app://com.google.android.googlequicksearchbox` | Organic Search |
| | t.co, x.com, twitter.com, facebook, instagram, linkedin, lnkd.in, youtube, whatsapp, wa.me, reddit (subdomains such as `l.facebook.com` included); the Android apps `com.linkedin.android`, `com.twitter.android`, `com.instagram.android`, `com.facebook.katana`, `com.whatsapp` | Organic Social |
| | the site's own host, or the host of the landing URL: ignored | Direct |
| | any other http(s) host, including `docs.google.com`; any other `android-app://` package | Referral |
| 7 | nothing matched: any `utm_source` at all (tagged traffic is never Direct) | Referral |
| | nothing matched, no `utm_source`, and the referrer is empty or not an http(s) or android-app URL | Direct |

`utm_medium` and `utm_source` are matched after lower-casing and folding runs of spaces, hyphens and underscores into one underscore, so `Paid Social`, `paid-social` and `paid_social` are one value. `utm_source` aliases: `google`, `google_ads`, `googleads`, `adwords` are Google; `x`, `twitter` are X; `facebook`, `fb`, `instagram`, `ig`, `meta` are Meta; `linkedin`, `lnkd` are LinkedIn. When several paid signals disagree the order is Google, X, LinkedIn, Meta. `utm_source=google` without a paid medium or click id is not paid: with `utm_medium=organic` it is Organic Search, otherwise it falls through to the referrer rules. The channel is computed from exactly what the `UTM`, click-id, `Referrer` and `Landing URL` columns hold (`js/form.js` keeps the attribution in `sessionStorage` for the tab, and a link carrying a campaign or click id replaces what was stored). `twclid` is X's click id (the X Ads equivalent of `gclid`), and `gbraid` and `wbraid` are Google Ads' click ids for iOS traffic that cannot carry a `gclid` (app-to-web and web-to-app); `js/form.js` captures all three and `/api/lead` stores them, in the `twclid`, `gbraid` and `wbraid` columns right after `Channel`. Rows written before this layout was deployed have a blank Channel: it is computed only when a row is written and there is no backfill. A row created by a Cal booking with no lead has no attribution, so its Channel is `Direct`.

**Team columns.** `Call Outcome`, `Qualified`, `Setter Notes` and `Deal Value (₹)` are for the team to fill in by hand. The code writes them blank when it appends a row and never addresses them afterwards: not the Cal.com webhook, not the calendar sync (`tests/cal-webhook.test.ts` and `tests/calendar-sync.test.ts` pin this with filled cells). They are columns AK to AN and `MANUAL_HEADERS` in `lib/columns.ts` lists them. `Email Check` and `Cancellation Reason` (AO and AP) come after them only because columns are append-only; code writes those two, the team does not.

**Trailing columns.** A team member may add columns to the right of `Cancellation Reason` (AQ onwards). The header guard checks only the first 42 cells, and every read is `A:AP`, so extra columns are neither read nor written, and a booking or decline never shifts them. Anything inside A:AP that differs (a missing, renamed or reordered column, or a column inserted in the middle) still refuses the write. The append-only rule is unchanged: once the sheet holds data rows, new columns of ours go after `Cancellation Reason` and never in front of it, and a column inserted in the middle by hand would misalign every row the code writes.

**Rollout order (moving a live sheet to this layout).** The live Leads tab has the old 32-column header (A1:AF1) and holds data rows. Do these in this order, then deploy:

1. Confirm `AG1:AP1` on the live Leads tab are empty. The new header fills A1:AP1, so anything the team keeps there would be overwritten.
2. Paste the full new Leads header line (`npm run sheet-headers`, first line) into `Leads!A1`. Existing rows are untouched: their new cells are simply blank.
3. Create the Events tab (`Events`, or the name in `EVENTS_TAB`) and paste the Events header line into its A1.
4. Deploy.

Why this order: the new code's header guard refuses any header that is not the 42 columns, so deploying first makes every Cal.com booking and calendar sync fail with 500 (`CAL_WEBHOOK_MISCONFIGURED`) until the header is pasted. The old code reads only `A:AF`, so it never sees the extra header cells and its own header check still passes: step 2 can be done while the old code is still live. The Events tab goes in before the deploy because until it exists every audit row fails (`EVENT_LOG_WRITE_FAILED`) and is not retried. Rows written before the deploy have a blank `Channel` (and blank `twclid`, `gbraid`, `wbraid`); there is no backfill. A row a Cal booking creates with no lead behind it gets `Direct`, because it carries no attribution.

**Rollout order for Email Check and Cancellation Reason (a live sheet already on the 40-column layout).** Before deploying, make sure the tab's grid has at least 42 columns (a tab created with exactly 40 has no column AO; Sheets rejects every read or write of `A:AP` with "exceeds grid limits" until columns are inserted at the right edge), check that `AO1:AP1` are empty (a column the team keeps to the right of `Deal Value (₹)` would have to move to AQ first), then type `Email Check` into `AO1` and `Cancellation Reason` into `AP1` (or paste the full line from `npm run sheet-headers`). Existing rows are untouched: their two new cells are blank, and a blank `Email Check` is never open to correction by `/api/lead-email`. Deploying first makes every `/api/cal-webhook` call, calendar sync and email correction fail with 500 until the two headers are in, exactly as described above. Ranges become `A:AP`.

**Events tab.** An audit log with one row per event, appended (RAW, INSERT_ROWS) to the tab named by `EVENTS_TAB` (default `Events`). Header row: `At (IST)`, `Lead ID`, `Event`, `Status From`, `Status To`, `Call Time (IST)`, `Booking UID`, `Source`, `Detail` (`npm run sheet-headers` prints it).

| Event | Written by | Source | Filled columns |
|---|---|---|---|
| `Lead submitted` | `/api/lead`, after the lead is stored | `form` | Status To `New`, Detail = the Channel |
| `Email corrected` | `/api/lead-email`, after the row is updated | `form` | Detail = the new Email Check result (never the address) |
| `Booked`, `Rescheduled`, `Cancelled` | `/api/cal-webhook`, when it changes the row | `cal` | Status From (blank for a row the booking created), Status To, Call Time, Booking UID |
| `Declined in Google Calendar`, `Re-accepted in Google Calendar` | the calendar sync, when it changes a Status | `google-calendar` | Status From, Status To, Call Time, Booking UID |

An event the webhook ignores (stale event or cancellation, an unhandled trigger) writes no row, and neither does the same event delivered twice (the row already held those values). Logging is best-effort: it runs after the main write, and a failure never changes what the lead, webhook or sync returns. It is logged as `EVENT_LOG_WRITE_FAILED` (`eventName`, `leadId` when known, `error`; no names or emails), one line per event. The Events write is awaited but capped at 2 seconds (`EVENT_LOG_DEADLINE_MS` in `lib/event-log.ts`), so a stuck log write holds `/api/lead`, the webhook or the calendar sync back by at most 2 seconds instead of the 8 second deadline of the main Sheets calls. A failure that is an HTTP 4xx from Sheets (a missing Events tab is a 400) leaves the shared Sheets client alone; a timeout or network error discards it, like any other Sheets failure. A failed audit row is not retried: the Leads tab holds the current state, and the log line is the record of what was missed.

`/api/lead` accepts request bodies up to 32 KiB (`MAX_BODY_BYTES` in `api/lead.ts`): the largest valid lead is about 10 KB in ASCII and about 24.1 KB in worst-case non-Latin text.

## Search and AI visibility

What the site gives search engines and AI assistants, all of it static:

- **FAQ.** Section V of `index.html` (`#faq`) answers eight questions a buyer asks: what Tridha does, who it is for, how an engagement works, what the free call covers, how Tridha differs, where it is based, and two on the work Tridha has delivered, from the four case studies at https://tridha.net/insights/. Every statement in it comes from this page, `book.html` or tridha.net. It names no person, and no client beyond those this page already names and the three tridha.net names in text: HumSafer, Tata and HUL, on its mobility case. tridha.net describes its other clients without naming them, so this page does too; keep it that way when editing.
- **Structured data.** One `application/ld+json` block in `index.html`'s head holds an `@graph`: the Organization under `https://tridha.net/#org` (the `@id` tridha.net declares, so the two sites read as one entity), a ProfessionalService for this page (Mumbai and New Delhi, no street address because no source gives one), WebSite, WebPage, and a FAQPage that repeats the visible questions and answers word for word. `tests/seo.test.ts` fails when the FAQPage text and the visible FAQ differ, or when the WebPage name and description differ from `<title>` and the meta description, so edit both together. The CSP needs no hash for the block: a data block is never run (see `DATA_BLOCK_TYPES` in `tests/headers.test.ts`). Google shows FAQ rich results only for well-known government and health sites, so the FAQPage is for answer engines and other parsers, not a Google snippet.
- **robots.txt.** Every crawler may fetch everything except `/api/`. The search and AI crawlers the owner welcomed (Googlebot, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, CCBot) are also named, each in its own group. A crawler that finds a group naming it ignores `*`, so each named group repeats `Disallow: /api/`; a new group must too, and the test checks it.
- **Sitemap and /book.** `sitemap.xml` lists only the landing page, with a `<lastmod>`: change that date when the page's content changes. `/book` carries `noindex, follow` and stays out of the sitemap.
- **llms.txt.** A plain-text summary for language models, in the llmstxt.org shape (an H1, a one-line `>` summary, facts, then H2 sections of links), linking to this page and to tridha.net, with a "Selected work" section that retells the four tridha.net case studies in the FAQ's terms. `vercel.json` serves it as `text/plain; charset=utf-8`.

Owner steps, outside the code (no verification tag or key file is committed until the owner has the real value):

1. **Google Search Console.** Add a Domain property for `tridha.net`, which covers `consulting.tridha.net` and every other subdomain, and verify it with the TXT record Search Console shows, added in Cloudflare DNS for `tridha.net`. A URL-prefix property for `https://consulting.tridha.net/` also works and also verifies by DNS; its HTML-tag and file methods would need a commit. Then submit `https://consulting.tridha.net/sitemap.xml` under Sitemaps, and request indexing of `https://consulting.tridha.net/` with URL inspection.
2. **Bing Webmaster Tools.** Sign in and import the site from Google Search Console (it brings the verified property and its sitemaps), or add the site and verify it by DNS.
3. **IndexNow (optional).** Bing and other engines take a ping when a page changes. It needs a key file at the site root named after a key the owner generates; commit that file with the real key, then ping after each deploy. Cloudflare's Crawler Hints sends these pings only for proxied records, and the `consulting` record is DNS only (see "DNS cutover").
4. **After the deploy.** `curl -I` `/robots.txt`, `/sitemap.xml` and `/llms.txt` on the live domain (200, and `text/plain; charset=utf-8` for `llms.txt`), and run `https://consulting.tridha.net/` through Google's Rich Results Test and the Schema Markup Validator: the FAQPage should be detected, and the business may draw warnings for the missing street address and phone (no source gives an address, and this repo commits no phone numbers).

## DNS cutover

1. In Vercel, Project, Settings, Domains, add `consulting.tridha.net`.
2. In Cloudflare DNS for `tridha.net`, change the existing `consulting` record to the CNAME target Vercel shows (typically `cname.vercel-dns.com`).
3. Set the record to DNS only (grey cloud). Proxying breaks Vercel's certificate issuance.
4. Wait for Vercel to show the domain as valid, then load https://consulting.tridha.net and submit a test lead.

## Adding a CRM later (e.g. ClickUp)

Add `lib/sinks/clickup.ts` exporting a `LeadSink`, and append it to the list in `lib/sinks/index.ts`. A lead counts as written if at least one sink succeeds; failed sinks are logged with the full lead.
