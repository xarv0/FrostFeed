/* Reddit Archive View — service worker
 *
 * All network access to the Arctic Shift API happens here so the content
 * script never has to care about CORS or the page's CSP.
 */

const BASE = "https://arctic-shift.photon-reddit.com/api";
const TTL = 5 * 60 * 1000; // cache successful responses for 5 minutes
const PAGE_SIZE = 100; // hard server maximum

const cache = new Map(); // key -> { at, data }
const inflight = new Map(); // key -> Promise

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (cache.size > 400) {
    // crude bound, drop the oldest entries
    const keys = [...cache.keys()].slice(0, 100);
    for (const k of keys) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), data });
}

async function request(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      credentials: "omit",
    });
  } catch (err) {
    if (attempt < 2) {
      await sleep(800 * (attempt + 1));
      return request(url, attempt + 1);
    }
    throw new Error("Network error reaching arctic-shift.photon-reddit.com");
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 2) {
      await sleep(1200 * (attempt + 1));
      return request(url, attempt + 1);
    }
    throw new Error(
      res.status === 429
        ? "The archive is rate limiting requests. Try again in a moment."
        : `Archive server returned ${res.status}.`
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || body?.detail || "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Archive server returned ${res.status}.`);
  }

  const json = await res.json();
  if (json && json.error) {
    throw new Error(json.error.message || json.error.type || "Archive error");
  }
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pageLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return PAGE_SIZE;
  return Math.min(Math.max(n, 1), PAGE_SIZE);
}

function buildSearch(kind, { author, before, after, sort, limit }) {
  const params = new URLSearchParams();
  params.set("author", author);
  params.set("limit", String(pageLimit(limit)));
  params.set("sort", sort === "asc" ? "asc" : "desc");
  if (before) params.set("before", String(before));
  if (after) params.set("after", String(after));
  return `${BASE}/${kind}/search?${params.toString()}`;
}

async function search(kind, opts) {
  const limit = pageLimit(opts && opts.limit);
  const url = buildSearch(kind, opts);
  const key = url;

  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const json = await request(url);
    const data = Array.isArray(json.data) ? json.data : [];
    const result = {
      items: data.map((x) => (kind === "comments" ? shapeComment(x) : shapePost(x))),
      // A full page means there may be more behind the cursor.
      hasMore: data.length >= limit,
      nextCursor:
        data.length > 0
          ? opts.sort === "asc"
            ? data[data.length - 1].created_utc
            : data[data.length - 1].created_utc
          : null,
    };
    cacheSet(key, result);
    return result;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

function unescapeUrl(u) {
  if (!u || typeof u !== "string") return null;
  return u.replace(/&amp;/g, "&");
}

function extractPreview(p) {
  const img = p.preview?.images?.[0];
  if (!img) return null;
  const resolutions = Array.isArray(img.resolutions) ? img.resolutions : [];
  // Prefer a crisp feed-sized resolution (~640-1080px wide) to avoid huge raw downloads.
  const pick =
    resolutions.find((r) => r.width >= 640 && r.width <= 1200) ||
    resolutions[resolutions.length - 1] ||
    img.source;
  return unescapeUrl(pick?.url || img.source?.url);
}

function extractGallery(p) {
  if (!p.is_gallery || !p.gallery_data?.items || !p.media_metadata) return null;
  const out = [];
  for (const item of p.gallery_data.items) {
    const meta = p.media_metadata[item.media_id];
    if (!meta || meta.status === "failed") continue;
    const previews = Array.isArray(meta.p) ? meta.p : [];
    const pick =
      previews.find((r) => r.x >= 640 && r.x <= 1200) ||
      previews[previews.length - 1] ||
      meta.s;
    const url = unescapeUrl(pick?.u || meta.s?.u || meta.s?.gif);
    if (url) out.push({ url, caption: item.caption || null });
  }
  return out.length ? out : null;
}

function extractThumbnail(t) {
  if (!t || typeof t !== "string") return null;
  if (!/^https?:\/\//i.test(t)) return null;
  return unescapeUrl(t);
}

function shapeFlairRichtext(rt) {
  if (!Array.isArray(rt) || !rt.length) return null;
  const out = [];
  for (const part of rt) {
    if (!part || typeof part !== "object") continue;
    if (part.e === "emoji" && typeof part.u === "string" && /^https?:\/\//i.test(part.u)) {
      out.push({ e: "emoji", a: part.a || "", u: unescapeUrl(part.u) });
    } else if (part.e === "text" && typeof part.t === "string" && part.t.length) {
      out.push({ e: "text", t: part.t });
    }
  }
  return out.length ? out : null;
}

function shapeComment(c) {
  return {
    kind: "comment",
    id: c.id,
    author: c.author,
    body: c.body,
    created: c.created_utc,
    subreddit: c.subreddit,
    subredditId: c.subreddit_id || null,
    permalink: c.permalink,
    score: c.score,
    distinguished: c.distinguished || null,
    authorFlair: c.author_flair_text || null,
    authorFlairRich: shapeFlairRichtext(c.author_flair_richtext),
    authorFlairBg: c.author_flair_background_color || null,
    authorFlairColor: c.author_flair_text_color || null,
    isSubmitter: !!c.is_submitter,
    parentId: c.parent_id || null,
    edited: !!c.edited,
    stickied: !!c.stickied,
    locked: !!c.locked,
    archived: !!c.archived,
    subredditPrefixed: c.subreddit_name_prefixed || null,
    linkId: c.link_id || null,
    linkTitle: c.link_title || null,
    linkPermalink: c.link_permalink || null,
    linkAuthor: c.link_author || null,
    removed:
      c.body === "[deleted]" || c.body === "[removed]" || c.body === "[ Removed by Reddit ]",
  };
}

function shapePost(p) {
  const rv = p.secure_media?.reddit_video || p.media?.reddit_video || null;
  const xp = Array.isArray(p.crosspost_parent_list) && p.crosspost_parent_list[0];
  return {
    kind: "post",
    id: p.id,
    author: p.author,
    title: p.title,
    body: p.selftext || "",
    url: p.is_self ? null : p.url,
    created: p.created_utc,
    subreddit: p.subreddit,
    subredditId: p.subreddit_id || null,
    permalink: p.permalink,
    score: p.score,
    numComments: p.num_comments,
    over18: !!p.over_18,
    spoiler: !!p.spoiler,
    stickied: !!(p.stickied || p.pinned),
    locked: !!p.locked,
    archived: !!p.archived,
    edited: !!p.edited,
    isSelf: !!p.is_self,
    isVideo: !!p.is_video,
    isGallery: !!p.is_gallery,
    postHint: p.post_hint || null,
    thumbnail: extractThumbnail(p.thumbnail),
    previewUrl: extractPreview(p),
    videoUrl: rv?.fallback_url ? unescapeUrl(rv.fallback_url) : null,
    videoDuration: typeof rv?.duration === "number" ? rv.duration : null,
    gallery: extractGallery(p),
    crosspost: xp
      ? {
          subreddit: xp.subreddit,
          author: xp.author,
          title: xp.title,
          created: xp.created_utc,
          score: xp.score,
          numComments: xp.num_comments,
          permalink: xp.permalink,
          over18: !!xp.over_18,
        }
      : null,
    distinguished: p.distinguished || null,
    subredditType: p.subreddit_type || null,
    subredditPrefixed: p.subreddit_name_prefixed || null,
    flair: p.link_flair_text || null,
    flairRich: shapeFlairRichtext(p.link_flair_richtext),
    flairColor: p.link_flair_background_color || null,
    flairTextColor: p.link_flair_text_color || null,
    domain: p.domain || null,
    removed: p.selftext === "[removed]" || p.selftext === "[deleted]",
  };
}

async function userStats(author) {
  const url = `${BASE}/users/search?author=${encodeURIComponent(author)}`;
  const cached = cacheGet(url);
  if (cached) return cached;

  const json = await request(url);
  const row = Array.isArray(json.data) ? json.data[0] : null;
  if (!row) return null;

  const m = row._meta || {};
  const result = {
    author: row.author,
    id: row.id,
    posts: m.num_posts ?? null,
    comments: m.num_comments ?? null,
    postKarma: m.post_karma ?? null,
    commentKarma: m.comment_karma ?? null,
    totalKarma: m.total_karma ?? null,
    firstPost: m.earliest_post_at ?? null,
    firstComment: m.earliest_comment_at ?? null,
    lastPost: m.last_post_at ?? null,
    lastComment: m.last_comment_at ?? null,
  };
  cacheSet(url, result);
  return result;
}

const subCache = new Map(); // stripped id -> { icon, color }

function validHexColor(c) {
  return typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : null;
}

async function fetchSubreddits(rawIds) {
  if (!Array.isArray(rawIds) || !rawIds.length) return {};

  const out = {};
  const missing = [];
  const seen = new Set();

  for (const raw of rawIds) {
    if (typeof raw !== "string") continue;
    const clean = raw.replace(/^t5_/i, "").trim().toLowerCase();
    if (!clean || !/^[a-z0-9]+$/.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    const key = "t5_" + clean;
    if (subCache.has(clean)) {
      out[key] = subCache.get(clean);
    } else {
      missing.push(clean);
    }
  }

  // Batch uncached subreddit IDs in chunks of 50.
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const url = `${BASE}/subreddits/ids?ids=${chunk.join(",")}`;
    try {
      const json = await request(url);
      const rows = Array.isArray(json.data) ? json.data : [];
      const found = new Set();
      for (const r of rows) {
        const id = String(r.id || "").replace(/^t5_/i, "").toLowerCase();
        if (!id) continue;
        found.add(id);
        const commIcon = /^https?:\/\//i.test(r.community_icon || "")
          ? unescapeUrl(r.community_icon)
          : null;
        const stdIcon = /^https?:\/\//i.test(r.icon_img || "")
          ? unescapeUrl(r.icon_img)
          : null;
        const icon = commIcon || stdIcon;
        const fallback = commIcon && stdIcon && commIcon !== stdIcon ? stdIcon : null;
        const color = validHexColor(r.primary_color) || validHexColor(r.key_color) || null;
        const entry = { icon, fallback, color };
        subCache.set(id, entry);
        out["t5_" + id] = entry;
      }
      // Cache misses too so deleted/private subs are not re-requested.
      for (const id of chunk) {
        if (!found.has(id)) {
          const empty = { icon: null, fallback: null, color: null };
          subCache.set(id, empty);
          out["t5_" + id] = empty;
        }
      }
    } catch {
      /* icons are optional — never fail the feed */
    }
  }

  if (subCache.size > 2000) {
    const drop = [...subCache.keys()].slice(0, 500);
    for (const k of drop) subCache.delete(k);
  }

  return out;
}

function handle(msg) {
  switch (msg && msg.type) {
    case "search":
      return search(msg.kind === "comments" ? "comments" : "posts", {
        author: msg.author,
        before: msg.before || null,
        after: msg.after || null,
        sort: msg.sort || "desc",
        limit: msg.limit,
      });
    case "stats":
      return userStats(msg.author);
    case "subreddits":
      return fetchSubreddits(msg.ids);
    case "ping":
      return { pong: true };
    default:
      throw new Error(`Unknown message type: ${msg && msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  Promise.resolve()
    .then(() => handle(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the message channel open for the async response
});
