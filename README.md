# FrostFeed

**Browse archived Reddit user profiles natively inside Reddit's UI.**

FrostFeed is a lightweight, zero-dependency Chrome/Edge (Manifest V3) extension that adds an **Archive** tab directly to Reddit user profiles. Powered by the public [Arctic Shift](https://arctic-shift.photon-reddit.com) archive, it lets you read archived posts and comments in a native Reddit-style feed — without leaving the page or touching Reddit's API.

> **Disclaimer:** FrostFeed is an independent, unofficial project and is not affiliated with or endorsed by Reddit, Inc. or Arctic Shift.

---

## Features

- **Native Reddit UI** — Matches Reddit's current (`shreddit`) light and dark themes automatically, plus `old.reddit.com` support.
- **Synced Profile Tabs** — Uses Reddit's own **Overview**, **Posts**, and **Comments** tabs to drive the archive feed:
  - **Overview**: Posts and comments interleaved chronologically via dual-cursor stream merging.
  - **Posts**: Submissions only.
  - **Comments**: Comments only.
- **Rich Media & Flairs** — Renders images (with blurred backdrops), interactive gallery carousels, videos, crossposts, external link previews, NSFW/Spoiler blur overlays, subreddit icons, and custom flair emojis.
- **Feed Controls** — Reddit-style **Sort** (`New` / `Old`) and **View** (`Card` / `Compact`) dropdowns, infinite scroll with skeleton loaders, and one-click permalink **Share** buttons.
- **Fast & Lightweight** — Vanilla JS/CSS with zero third-party dependencies, 5-minute response caching, batched subreddit icon lookups, and automatic retry on transient rate limits.
- **Privacy-First** — Never calls `reddit.com`'s API and never reads or transmits your Reddit session/cookies. The only external host contacted is `arctic-shift.photon-reddit.com`.

---

## Installation (Load Unpacked)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/xarv0/FrostFeed.git
   ```
2. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. Visit any Reddit user profile (`reddit.com/u/<username>`) and click the **Archive** tab.

---

## How It Works

| File | Responsibility |
| --- | --- |
| `manifest.json` | Manifest V3 configuration (`host_permissions` scoped only to `arctic-shift.photon-reddit.com`). |
| `background.js` | Service worker handling all Arctic Shift API requests, 5-minute caching, batched subreddit icon lookups, and retries. |
| `content.js` | Profile route detection, tab injection, dual-stream pagination, markdown rendering, and native card UI. |
| `content.css` | Theme-aware styling mirroring Reddit's CSS tokens in light and dark mode. |
| `popup.html` | Toolbar popup with quick status/usage info. |

### API Endpoints Used

```text
GET https://arctic-shift.photon-reddit.com/api/posts/search
GET https://arctic-shift.photon-reddit.com/api/comments/search
GET https://arctic-shift.photon-reddit.com/api/users/search
GET https://arctic-shift.photon-reddit.com/api/subreddits/ids
```

---

## Notes & Limitations

- Archived data reflects what was public when Arctic Shift crawled it; very recent posts/comments or brand-new accounts may not appear yet.
- Vote counts represent scores at crawl time, not live scores.
- Deleted or removed content recorded as `[deleted]` / `[removed]` in the archive is shown as-is.
- Arctic Shift is a free community service — heavy scrolling may occasionally hit rate limits, in which case a **Retry** button is shown.

---

## License

This project is licensed under the [MIT License](LICENSE).
