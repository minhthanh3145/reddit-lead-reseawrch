# Reddit Lead Research (Manual Review)

A Chrome extension that discovers public Reddit posts worth manually reviewing as sales-research leads for your niche. It scans the subreddits you configure, scores posts against your keywords and intent signals, and shows a ranked list — with an optional AI re-ranking pass using your own API key.

**Read-only by design.** The extension only fetches public subreddit listings. It never logs in, comments, DMs, votes, or posts on your behalf. Review each thread manually and follow every subreddit's rules.

## Installation

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this folder.
5. Pin the extension icon for quick access.

## Quick start

1. Click the extension icon and open **Settings** (or right-click the icon → Options).
2. Fill in your **niche, product, and ideal customer**, then review the subreddit and keyword lists. Sensible starter values are pre-filled; edit anything.
3. Click **Save settings**.
4. Open the popup and click **Scan Reddit**. After a few seconds you'll see ranked result cards.
5. Click **Open on Reddit** on any card to review the thread yourself.

Results are saved automatically — when you reopen the popup later, your last scan loads instantly with a "Showing saved results from …" note. Click **Scan Reddit** again to refresh, or **Clear** to discard them.

## How it works

### 1. Fetching (`background.js`)

When you click **Scan Reddit**, the popup sends a message to the background service worker, which fetches each configured subreddit's public *top* listing JSON (`https://www.reddit.com/r/<sub>/top.json`) for your chosen freshness window. Requests are throttled (1.2 s between subreddits) to stay polite, time out after 12 s, and duplicate posts are de-duplicated across subreddits.

### 2. Lexical scoring

Each post's title + body is matched against your configured lists:

| Signal | Default weight |
|---|---|
| Main keywords | ×2 |
| Problem phrases | ×3 (×5 when prioritizing complaints) |
| Buying-intent phrases | ×4 (×6 when prioritizing recommendations) |
| Competitor mentions | ×3 (×5 when prioritizing competitors) |
| Built-in intent regex patterns (e.g. "any recommendations", "alternative to", "struggling with") | ×2 |

Bonuses: up to **+3** for recency within the freshness window and up to **+2** for comment activity. Posts matching any **negative keyword** are skipped entirely; posts with no content match at all are excluded. Results are sorted by score, and each card explains *why* it matched (matched terms + detected intent).

### 3. Optional AI re-ranking

If you configure a provider (Anthropic or OpenAI) and paste your own API key in Settings, a second pass sends the top N lexical candidates (default 12, max 25) to the LLM. It returns a structured JSON score per post:

- **relevance** (0–10) — blended into the ranking as `score + relevance × 3`
- **intent** — recommendation / complaint / competitor / none
- **reason** — a one-sentence explanation, shown on the card

If the AI call fails (bad key, rate limit, timeout), the keyword results are still shown with an explanatory status message. Leave the provider on **None** to keep the extension purely keyword-based.

### 4. Storage & privacy

Everything lives in `chrome.storage.local` on your machine:

- **`config`** — your settings, including the optional LLM API key. The key is only ever sent directly to the provider you chose (api.anthropic.com or api.openai.com).
- **`lastScan`** — the most recent results + timestamp, so the popup restores them on reopen.

No analytics, no external servers, no data leaves your browser except the Reddit fetches and (if enabled) your own LLM API calls.

## Popup actions

| Button | What it does |
|---|---|
| **Scan Reddit** | Runs a fresh scan and replaces the saved results |
| **Clear** | Clears the list and deletes the saved results |
| **Export JSON** | Downloads the current results as `reddit-leads-<date>.json` |
| **Settings** | Opens the options page |

## Settings reference

| Setting | Notes |
|---|---|
| Niche / product / ideal customer | Used as context for the AI re-ranking prompt |
| Subreddits | One per line, without `r/` (pasted URLs are cleaned automatically) |
| Main keywords / problem phrases / buying-intent phrases / competitors | One per line; matched case-insensitively against title + body |
| Negative keywords | Any match skips the post entirely |
| Freshness window | 24 h / 7 d / 30 d / 12 months (maps to Reddit's `top` time filter) |
| Prioritize | Boosts complaints, recommendation-seekers, or competitor mentions |
| Max posts per subreddit | 1–100 (default 25) |
| AI provider / key / model | Optional; blank model uses the provider default (`claude-haiku-4-5` / `gpt-4o-mini`) |

**Generate starter keywords** on the options page derives keywords from your niche/product/ideal-customer text and merges them (de-duped) with your existing lists and the built-in defaults — useful after changing your niche. Review, edit, then Save.

## Project layout

```
manifest.json    Manifest V3 config (permissions: storage + reddit/anthropic/openai hosts)
background.js    Service worker: fetch, score, and optionally AI re-rank
defaults.js      Starter config, intent regex patterns, shared helpers
popup.html/js    Popup UI: scan, render cards, persist/restore results, export
options.html/js  Settings page
styles.css       Shared styles
icons/           Extension icons
```

## Troubleshooting

- **"Reddit rate-limited this request"** — Reddit throttles unauthenticated JSON requests. Wait a minute and scan again, or reduce the number of subreddits.
- **"Subreddit not found or private"** — check the spelling in Settings; private/banned subreddits can't be scanned.
- **"AI rejected the API key (401)"** — re-paste your key in Settings and make sure the provider matches the key.
- **No results** — widen the freshness window, add broader keywords, or trim your negative-keyword list.
