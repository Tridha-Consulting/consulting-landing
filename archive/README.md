# Archive of the GoHighLevel/Synamate build (captured 2026-10-24)

Source of truth for the rebuild. Synamate subscription had lapsed at capture time.

| File | What |
|---|---|
| consulting-live.html | Landing page, server-rendered by GHL. The page body is one custom-code block (design tokens, all sections, CSS). |
| apply-live.html | /apply — GHL booking page (c-calendar element). Copy is fetched client-side and is NOT in this file. At capture it rendered a blank white page for 30s+ — the "white screen" users saw. |
| survey-live.html | The opt-in survey widget (`W5K6iUb4sMSdsXIYaDgQ`) as GHL still served it on 2026-10-26. Its "Privacy Policy" link pointed at `https://www.example.com`; its thank-you text was "Thank you for taking the time to complete this survey." |
| tridha-home.html | tridha.net homepage, for design-system reference. |
| hero-poster.png | Hero video poster frame. |
| live-*.jpg | Screenshots at capture time. |

Hero video: original is a 725 MB mp4 on GHL CDN
(`assets.cdn.filesafe.space/1FowXVL8XpvYf6Al5vH0/media/6a608341d56e9e5c145c20c3.mp4`). The owner supplied the same file (identical size) from Google Drive as "Sarthak tripahi V2.mp4": 854x480, 60 fps, 12:13.5, 7.6 Mbps. It is kept locally as `archive/hero-video-original.mp4`, gitignored. `assets/hero.mp4` is a re-encode of it: x264 CRF 24 preset slow, 60 fps kept, AAC 128k, faststart; 46 MB; SSIM 0.983 vs the original over the first 60s.

## Old lead flow
Every CTA (`href="#"`) opened a GHL popup with Synamate survey `W5K6iUb4sMSdsXIYaDgQ`:

1. Full Name — text, required
2. Email — email, required (+ "Privacy Policy" note on the slide)
3. Phone — required (intl-tel-input with country flags)
4. UTM Campaign — hidden, from `?utm_campaign`
5. UTM Medium — hidden, from `?utm_medium`

On submit → redirect to `https://consulting.tridha.net/apply` (calendar booking).

Tracking on the landing page: X (Twitter) pixel only — `uwt.js` with `twq('config','re613')` (consulting-live.html line 671). No Meta, Google or LinkedIn tags.
