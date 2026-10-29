# consulting.tridha.net

Static landing page plus one Vercel serverless function that appends leads to a Google Sheet. It replaces the old GoHighLevel build, whose subscription lapsed. `archive/` holds what was captured from that build and is read-only reference.

- `index.html`, `css/site.css`: the page, ported verbatim from the GHL custom-code block.
- `css/form.css`, `js/form.js`: the lead modal (all 12 questions on one scrolling form, never navigates; the calendar or thank-you replaces the card in place).
- `js/config.js`: all owner-editable settings (thank-you text, fallback contact, Cal.com link, ad IDs, Turnstile key).
- `js/track.js`: ad tags, loaded after `window.load` and only when their ID is set.
- `js/booking.js`, `book.html`: the Cal.com inline booking embed, used by the modal and by `/book` (see Cal.com booking).
- `api/cal-webhook.ts`: Cal.com booking webhook that updates the lead's row (see "Cal.com webhook"). `lib/cal-booking.ts` (parse + row matching, pure), `lib/cal-sheet.ts` + `lib/sheets-client.ts` (Sheets I/O shared with the lead sink).
- `api/lead.ts`: the endpoint. `lib/schema.ts` (zod, single source of truth, including the answer option lists), `lib/columns.ts` (sheet layout), `lib/sinks/` (where leads go), `lib/env.ts` (fails loudly on missing env).

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
| `TURNSTILE_SECRET_KEY` | no | set together with `TURNSTILE_SITE_KEY` in `js/config.js` |
| `CAL_WEBHOOK_SECRET` | for `/api/cal-webhook` | the secret typed into the Cal.com webhook; without it the endpoint returns 500 |

## Google Sheet setup

1. Create a Google Cloud project at console.cloud.google.com (any name).
2. In that project, open APIs & Services, Library, search "Google Sheets API", click Enable.
3. IAM & Admin, Service Accounts, Create service account (e.g. `lead-writer`). No roles needed.
4. Open the service account, Keys, Add key, Create new key, JSON. A file downloads. Keep it private and do not commit it.
5. Create the Google Sheet. Rename the first tab to `Leads` (or set `SHEET_TAB`). Click Share and add the service account email (`client_email` in the JSON) as Editor.
6. Paste the header row into cell A1. Print it with `npm run sheet-headers` and paste the tab-separated line, which fills A1 to AF1 across cells (32 columns). The nine answer columns from `Designation` to `Decision Maker` are filled from the site form when the lead is saved. The booking columns (`Call Time (IST)`, `Booked At (IST)`, `Booking Details`, `Booking UID`, `Last Event At`) are filled by the Cal.com webhook and stay blank on a fresh lead. The order must match `lib/columns.ts`; that file generates both. While the sheet holds only a header row it can be replaced with the new one outright. Once it holds data rows, columns are only ever appended at the end: reordering would misalign the existing rows. The Cal.com webhook refuses to write unless this header row matches exactly (see "Questions and sheet columns").
7. In Vercel, Project, Settings, Environment Variables, add `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `SHEET_ID` for Production (and Preview if wanted). Redeploy.
8. Submit a test lead on the live page and confirm a row appears.

If a write fails, the function logs one JSON line `{"event":"LEAD_WRITE_FAILED", ...}` containing the full lead. Search Vercel logs for `LEAD_WRITE_FAILED` to recover it. `LEAD_WRITTEN` marks successes.

With Turnstile on, a rejected lead logs `LEAD_CAPTCHA_REJECTED` (Cloudflare `errorCodes` plus the full lead), and an unreachable Cloudflare logs `LEAD_CAPTCHA_UNAVAILABLE` with the lead. A rejection with `missing-input-response` and a `hint` usually means `TURNSTILE_SECRET_KEY` is set but `TURNSTILE_SITE_KEY` is empty in `js/config.js`.

## Cal.com webhook

`/api/cal-webhook` copies bookings onto the lead's row so the setter sees call time and answers next to the lead.

1. In Cal.com, Settings, Developer, Webhooks, New. Subscriber URL: `https://consulting.tridha.net/api/cal-webhook`.
2. Tick the triggers **Booking Created**, **Booking Rescheduled**, **Booking Cancelled** (others are acknowledged and ignored).
3. Set a Secret, and put the same value in Vercel as `CAL_WEBHOOK_SECRET`. Redeploy. Use the Ping test button: it should return 200 (to be confirmed on the live account; the ping payload is not described in Cal's docs, and any signed trigger we do not handle is acknowledged with 200).

Cal signs the raw body with HMAC-SHA256 in `x-cal-signature-256`; a missing or wrong signature is a 401 (`CAL_WEBHOOK_BAD_SIGNATURE`, body never logged). The row is found by `metadata.leadId` (the embed should pass the lead id), else by the stored Booking UID (`uid`, or `rescheduleUid` on a reschedule), else by the newest row with the attendee's email. With no match a row is appended with Lead ID `cal-<uid>`. Status becomes `Booked`, `Rescheduled` or `Cancelled`; a cancel keeps the call time. Booking-form answers, if the event type asks any, go to their own columns (see "Questions and sheet columns"). Booking Details is rewritten on every applied event, from that event's answers that have no column plus, on a cancel, the cancellation reason; it does not accumulate, so a cancel that carries no such answers leaves it holding just the reason. Row 1 (the header) is never matched or written, whatever the booker puts in the booking form. `Last Event At` stores the envelope `createdAt` of the last event applied; an event strictly older than that is ignored (200 `{"ignored":"stale_event"}`, logged as `CAL_WEBHOOK_STALE`), so a late or replayed event cannot revert a newer state. Only a strict ISO-8601 datetime counts as a timestamp, and one more than 24 hours ahead of the server clock is ignored too (noted as `warn` in the sync log line); anything else, such as text typed into the cell, is treated as missing and the row is updated as normal. A cancellation applies only when its uid equals the row's Booking UID or the row has none; a cancel of an earlier booking (the lead rebooked) is ignored (200 `{"ignored":"stale_cancellation"}`, logged as `CAL_WEBHOOK_STALE`). The same event delivered twice one after the other leaves the sheet unchanged. Known limitations, both low: two simultaneous first deliveries for a brand-new booker with no lead row can both append a row (delete the duplicate by hand), and a cancellation delivered before the reschedule it belongs to is ignored, so that row ends `Rescheduled` instead of `Cancelled` (correct it by hand). Booking Details is capped at 45,000 characters (a Sheets cell holds 50,000).

`CAL_BOOKING_SYNCED` marks a success (uid, trigger, matchedBy, row, plus `warn` and `unmapped` when present; see "Questions and sheet columns"). If the Sheet is unreachable the function returns 502 so that a retry can recover the write if Cal retries (Cal's docs only describe retries for some events, so do not rely on it); the dependable recovery is the `CAL_WEBHOOK_WRITE_FAILED` log line, which carries the full payload. `CAL_WEBHOOK_MISCONFIGURED` means `CAL_WEBHOOK_SECRET` or a Sheet variable is missing, or the sheet's header row does not match `npm run sheet-headers` (the `error` field says which; payload logged); `CAL_WEBHOOK_BAD_PAYLOAD` is a signed body that is not a JSON object (logged with the raw body) or a booking without a uid, start time or attendee email (logged with the payload). `CAL_WEBHOOK_TOO_LARGE` is a body over 64 KB (413; byte size only, since it is unauthenticated).

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

With `CAL_LINK` set, a successful submit turns the modal into the calendar ("Pick a time for your call"), prefilled with name, email, phone (from the form) and `metadata[leadId]` (the id `/api/lead` returned, so the booking can be matched to the Sheet row). The Cal script is fetched only at that moment, never on page load. If Cal has not rendered within 15 seconds, or its script fails, the card shows the thank-you text ("our team will call you") and an "Open the booking page" link to `https://cal.com/<CAL_LINK>` (or `<CAL_ORIGIN>/<CAL_LINK>` when self-hosted) with the same prefill. A booking replaces the embed with `BOOKED_TEXT` and calls `track.booked()`: Meta `Schedule`, GA4 `book_call`, and X only when `X_BOOKED_EVENT_ID` is set.

`/book` is the same embed on its own page, for a setter to send a personal link. Prefill comes from the query string:

```
https://consulting.tridha.net/book?name=Asha%20Rao&email=asha%40example.com&phone=%2B919876543210
```

`phone` is sent to Cal as `attendeePhoneNumber`, the key of Cal's default phone field. The form validates the number with `libphonenumber-js/max` on the server (`lib/schema.ts`), so an invalid number is flagged on our form rather than blocking Confirm in Cal; the browser only applies a cheap India rule (10 digits starting 6-9) and otherwise relies on the server's field error. If the event type uses a differently named phone field, change `prefillParams` in `js/booking.js`.

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
- The webhook checks the live header row before every write. It must equal the output of `npm run sheet-headers` exactly (32 cells, A1:AF1, spaces around a cell ignored). If the tab is empty or the header differs (an old 22-column header, a renamed or missing column), nothing is written: the function logs `CAL_WEBHOOK_MISCONFIGURED` with the first differing column (headers only, never row data), the trigger and the full payload, and returns 500. Fix the header row; the payload in the log is the way to recover the booking.

`/api/lead` accepts request bodies up to 24 KiB (`MAX_BODY_BYTES` in `api/lead.ts`): the largest valid lead is about 8.5 KB in ASCII and about 19.6 KB in worst-case non-Latin text.

## DNS cutover

1. In Vercel, Project, Settings, Domains, add `consulting.tridha.net`.
2. In Cloudflare DNS for `tridha.net`, change the existing `consulting` record to the CNAME target Vercel shows (typically `cname.vercel-dns.com`).
3. Set the record to DNS only (grey cloud). Proxying breaks Vercel's certificate issuance.
4. Wait for Vercel to show the domain as valid, then load https://consulting.tridha.net and submit a test lead.

## Adding a CRM later (e.g. ClickUp)

Add `lib/sinks/clickup.ts` exporting a `LeadSink`, and append it to the list in `lib/sinks/index.ts`. A lead counts as written if at least one sink succeeds; failed sinks are logged with the full lead.
