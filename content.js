/* Reddit Archive View — content script
 *
 * Adds an "Archive" section to a Reddit profile that renders posts/comments
 * from the Arctic Shift archive. Works on both new Reddit (shreddit) and
 * old.reddit.com.
 *
 * Design notes
 * ------------
 * - Nothing here talks to reddit.com's API. Only the background worker
 *   touches the archive host.
 * - Archived content is always visibly labelled as archived. The point is to
 *   read history that Reddit no longer lists, not to pass it off as live.
 */

(() => {
  "use strict";

  if (window.__redditArchiveView) return;
  window.__redditArchiveView = true;

  const PANEL_ID = "asx-panel";
  const TAB_ID = "asx-tab";
  const TABROW_ID = "asx-tabrow";
  const ROOT_CLASS = "asx-root";

  const state = {
    user: null,
    open: false,
    view: "mixed", // mixed = overview (posts + comments interleaved)
    sort: "desc",
    density: storedDensity(), // "card" | "compact"
    items: [],
    seen: new Set(),
    streams: {},
    hasMore: true,
    loading: false,
    error: null,
    stats: null,
    statsRequested: false,
    fetched: false,
    loadedOnce: false,
  };

  function storedDensity() {
    try {
      return localStorage.getItem("asx:density") === "compact" ? "compact" : "card";
    } catch {
      return "card";
    }
  }

  function rememberDensity(val) {
    try {
      localStorage.setItem("asx:density", val);
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function num(n) {
    if (n === null || n === undefined) return "?";
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  const AGO_UNITS = [
    [31536000, "yr.", "year"],
    [2592000, "mo.", "month"],
    [86400, "d", "day"],
    [3600, "hr.", "hour"],
    [60, "min.", "minute"],
  ];

  function ago(ts, short) {
    if (!ts) return "";
    const s = Math.max(0, Date.now() / 1000 - ts);
    for (const [n, abbr, unit] of AGO_UNITS) {
      if (s < n) continue;
      const v = Math.floor(s / n);
      if (short) {
        return abbr === "d" ? `${v} day${v === 1 ? "" : "s"} ago` : `${v} ${abbr} ago`;
      }
      return `${v} ${unit}${v === 1 ? "" : "s"} ago`;
    }
    return "just now";
  }

  function fullDate(ts) {
    if (!ts) return "";
    try {
      return new Date(ts * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return new Date(ts * 1000).toString();
    }
  }

  function redditUrl(path) {
    if (!path) return "https://www.reddit.com";
    if (/^https?:\/\//i.test(path)) return path;
    return "https://www.reddit.com" + path;
  }

  function call(type, payload) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) reject(new Error("The archive request timed out."));
      }, 30000);

      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          done = true;
          clearTimeout(timer);
          if (chrome.runtime?.lastError) {
            reject(new Error("Extension reloaded — refresh the page."));
            return;
          }
          if (!res) reject(new Error("No response from the extension."));
          else if (!res.ok) reject(new Error(res.error || "Archive request failed."));
          else resolve(res.data);
        });
      } catch {
        done = true;
        clearTimeout(timer);
        reject(new Error("Extension context lost — refresh the page."));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Markdown (escaped first, then a fixed set of safe tags)
   * ------------------------------------------------------------------ */

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inline(s) {
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(
      /&gt;!([^!\n]{1,400})!&lt;/g,
      '<span class="asx-spoiler" tabindex="0" title="Click to reveal spoiler">$1</span>'
    );
    s = s.replace(
      /\[([^\]]{1,300})\]\((https?:\/\/[^\s)]{1,500}|\/[^\s)]{1,500})\)/g,
      (_m, t, u) =>
        `<a href="${u.startsWith("/") ? "https://www.reddit.com" + u : u}" target="_blank" rel="noopener noreferrer">${t}</a>`
    );
    s = s.replace(/\*\*([^*\n]{1,400})\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]{1,400})\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]{1,400})~~/g, "<del>$1</del>");
    s = s.replace(
      /(^|[\s(])(https?:\/\/[^\s<)"']{4,500})/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
    );
    s = s.replace(
      /(^|[\s(])\/?([ru]\/[A-Za-z0-9_-]{2,24})\b/g,
      '$1<a href="https://www.reddit.com/$2/" target="_blank" rel="noopener noreferrer">$2</a>'
    );
    return s;
  }

  function mdToHtml(src) {
    if (!src) return "";
    const text = esc(String(src).trim());
    if (!text) return "";
    const out = [];
    const lines = text.split(/\r?\n/);
    let list = null;
    let para = [];
    let quote = [];
    let inCode = false;
    let codeLines = [];

    const flushPara = () => {
      if (para.length) {
        out.push("<p>" + inline(para.join("<br>")) + "</p>");
        para = [];
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        out.push("<blockquote>" + inline(quote.join("<br>")) + "</blockquote>");
        quote = [];
      }
    };
    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");

      if (/^```/.test(line.trim())) {
        if (inCode) {
          out.push("<pre><code>" + codeLines.join("\n") + "</code></pre>");
          codeLines = [];
          inCode = false;
        } else {
          flushPara();
          flushQuote();
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeLines.push(raw);
        continue;
      }

      if (!line.trim()) {
        flushPara();
        flushQuote();
        closeList();
        continue;
      }

      let m;
      if ((m = line.match(/^&gt;\s?(.*)$/))) {
        flushPara();
        closeList();
        quote.push(m[1]);
        continue;
      }
      flushQuote();

      if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
        flushPara();
        closeList();
        out.push('<p class="asx-h">' + inline(m[1]) + "</p>");
        continue;
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (list !== "ul") {
          closeList();
          out.push("<ul>");
          list = "ul";
        }
        out.push("<li>" + inline(m[1]) + "</li>");
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push("<li>" + inline(m[1]) + "</li>");
        continue;
      }
      closeList();
      para.push(line);
    }

    if (inCode && codeLines.length) {
      out.push("<pre><code>" + codeLines.join("\n") + "</code></pre>");
    }
    flushPara();
    flushQuote();
    closeList();
    return out.join("");
  }

  /* ------------------------------------------------------------------ *
   * Route detection
   * ------------------------------------------------------------------ */

  function route() {
    const m = location.pathname.match(
      /^\/(?:user|u)\/([^/]+?)(?:\/(submitted|comments|saved|upvoted|downvoted|hidden|gilded))?\/?$/
    );
    if (!m) return null;
    const user = decodeURIComponent(m[1]);
    if (!user || /^(me|anonymous)$/i.test(user)) return null;
    return { user, section: m[2] || "overview" };
  }

  function isOldReddit() {
    return (
      location.hostname === "old.reddit.com" ||
      document.body.classList.contains("old-reddit") ||
      !!document.querySelector(".tabmenu") && !!document.querySelector("#siteTable")
    );
  }

  /* ------------------------------------------------------------------ *
   * Panel construction
   * ------------------------------------------------------------------ */

  function buildDropdown({ ariaLabel, title, header, items, getValue, onSelect, renderLabel }) {
    const wrap = el("div", { class: "asx-dd" });
    const btn = el("button", {
      class: "asx-dd-btn",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": ariaLabel,
      title: title || ariaLabel,
    });
    const labelSpan = el("span", { class: "asx-dd-label" });
    const chev = el("span", { class: "asx-dd-chev", html: ICON.chevron });
    btn.append(labelSpan, chev);

    const menu = el("div", { class: "asx-dd-menu", role: "menu", hidden: true });
    if (header) menu.append(el("div", { class: "asx-dd-head", text: header }));

    const optNodes = [];
    for (const item of items) {
      const opt = el(
        "button",
        {
          class: "asx-dd-item",
          type: "button",
          role: "menuitemradio",
          "data-val": item.value,
        },
        item.icon ? el("span", { class: "asx-dd-ico", html: item.icon }) : null,
        el("span", { text: item.label })
      );
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu();
        onSelect(item.value);
        sync();
      });
      optNodes.push(opt);
      menu.append(opt);
    }

    const sync = () => {
      const cur = getValue();
      renderLabel(labelSpan, cur);
      for (const opt of optNodes) {
        const active = opt.dataset.val === cur;
        opt.classList.toggle("is-active", active);
        opt.setAttribute("aria-checked", active ? "true" : "false");
      }
    };

    const closeMenu = () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      // Close any other open archive dropdowns first
      for (const other of document.querySelectorAll(`#${PANEL_ID} .asx-dd-menu`)) {
        other.hidden = true;
        other.previousElementSibling?.setAttribute("aria-expanded", "false");
      }
      menu.hidden = !willOpen;
      btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });

    sync();
    wrap.append(btn, menu);
    wrap.__sync = sync;
    return wrap;
  }

  function buildShell() {
    const root = el("div", {
      id: PANEL_ID,
      class: ROOT_CLASS + (state.density === "compact" ? " asx-compact" : ""),
    });

    const seg = el("div", { class: "asx-seg", role: "tablist" });
    for (const [value, label] of [
      ["mixed", "Overview"],
      ["posts", "Posts"],
      ["comments", "Comments"],
    ]) {
      const b = el("button", {
        class: "asx-seg-btn",
        type: "button",
        role: "tab",
        "data-view": value,
        text: label,
        "aria-selected": value === state.view ? "true" : "false",
      });
      b.addEventListener("click", () => setView(value));
      seg.append(b);
    }

    const sortDd = buildDropdown({
      ariaLabel: "Sort archived items",
      title: "Sort by",
      header: "Sort by",
      items: [
        { value: "desc", label: "New" },
        { value: "asc", label: "Old" },
      ],
      getValue: () => state.sort,
      renderLabel: (node, v) => {
        node.textContent = v === "asc" ? "Old" : "New";
      },
      onSelect: (val) => {
        if (state.sort === val) return;
        state.sort = val;
        resetData();
        loadPage(true);
      },
    });

    const viewDd = buildDropdown({
      ariaLabel: "Change post view",
      title: "Change post view",
      header: "View",
      items: [
        { value: "card", label: "Card", icon: ICON.viewCard },
        { value: "compact", label: "Compact", icon: ICON.viewCompact },
      ],
      getValue: () => state.density,
      renderLabel: (node, v) => {
        node.innerHTML = v === "compact" ? ICON.viewCompact : ICON.viewCard;
      },
      onSelect: (val) => {
        if (state.density === val) return;
        state.density = val;
        rememberDensity(val);
        root.classList.toggle("asx-compact", val === "compact");
      },
    });

    const badge = el(
      "span",
      {
        class: "asx-badge",
        title:
          "Archived data from arctic-shift.photon-reddit.com. Reddit itself does not serve these items for this profile.",
      },
      "Archive"
    );
    const stats = el("span", { class: "asx-stats", hidden: true });
    const meta = el("div", { class: "asx-bar-meta" }, stats, badge);

    const left = el("div", { class: "asx-bar-left" }, sortDd, viewDd, seg);
    const bar = el("div", { class: "asx-bar" }, left, meta);

    const list = el("div", { class: "asx-list" });
    const status = el("div", { class: "asx-status" });
    const sentinel = el("div", { class: "asx-sentinel" });

    const body = el("div", { class: "asx-body" }, list, status, sentinel);

    root.append(bar, body);

    // Close dropdown menus when clicking outside
    const onDocClick = () => {
      for (const m of root.querySelectorAll(".asx-dd-menu:not([hidden])")) {
        m.hidden = true;
        m.previousElementSibling?.setAttribute("aria-expanded", "false");
      }
    };
    document.addEventListener("click", onDocClick);
    root.__cleanup = () => document.removeEventListener("click", onDocClick);

    // Reveal inline markdown spoilers on click
    root.addEventListener("click", (e) => {
      const sp = e.target.closest?.(".asx-spoiler");
      if (sp) {
        e.stopPropagation();
        sp.classList.toggle("is-revealed");
      }
    });

    // Infinite scroll
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadPage(false);
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(sentinel);
    root.__io = io;

    return root;
  }

  function getPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) panel = buildShell();
    return panel;
  }

  function destroyPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    try {
      panel.__io?.disconnect();
      panel.__cleanup?.();
    } catch {
      /* ignore */
    }
    panel.remove();
  }

  function buildTab() {
    const a = el("a", {
      id: TAB_ID,
      class: "asx-tab",
      href: "#",
      role: "tab",
      "aria-selected": state.open ? "true" : "false",
      title: "Read this profile's archived posts and comments",
      html:
        '<svg viewBox="0 0 20 20" aria-hidden="true" width="16" height="16">' +
        '<path fill="currentColor" d="M3 7.5h14v-2.2c0-.7-.6-1.3-1.3-1.3H4.3c-.7 0-1.3.6-1.3 1.3v2.2Zm.6 1.5v6.2c0 .7.6 1.3 1.3 1.3h10.2c.7 0 1.3-.6 1.3-1.3V9h-2v3.2a.8.8 0 0 1-1.6 0V9H8.2v3.2a.8.8 0 0 1-1.6 0V9H3.6Z"/></svg>' +
        "<span>Archive</span>",
    });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.open) closeView();
      else openView();
    });
    return a;
  }

  function buildTabRow() {
    const row = el("div", { id: TABROW_ID, class: "asx-tabrow", role: "tablist" });
    row.append(buildTab());
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Open / close
   * ------------------------------------------------------------------ */

  function openView() {
    state.open = true;
    rememberOpen(state.user);

    // Enter on whichever section the profile is currently showing.
    const view = viewForSection(route()?.section) || "mixed";
    if (view !== state.view) {
      state.view = view;
      resetData();
    }
    syncSegUI();

    const tab = document.getElementById(TAB_ID);
    if (tab) {
      tab.classList.add("asx-tab--active");
      tab.setAttribute("aria-selected", "true");
    }
    mount();
    hydrate();
  }

  function closeView() {
    state.open = false;
    rememberOpen(null);
    const tab = document.getElementById(TAB_ID);
    if (tab) {
      tab.classList.remove("asx-tab--active");
      tab.setAttribute("aria-selected", "false");
    }
    destroyPanel();
    restoreFeed();
    const siteTable = document.getElementById("siteTable");
    if (siteTable) siteTable.style.display = "";
  }

  /* ------------------------------------------------------------------ *
   * Data loading
   *
   * "Overview" interleaves posts and comments the way a public profile does,
   * so each source keeps its own cursor and the two sorted streams are merged
   * on the fly. That stays correct even when someone has 10k comments and 12
   * posts, which a naive "fetch both, concat" would not.
   * ------------------------------------------------------------------ */

  const PAGE_SIZE = 100; // items rendered per lazy-load step
  const REFILL = 50; // items requested per source per refill

  function kindsForView(view) {
    if (view === "posts") return ["posts"];
    if (view === "comments") return ["comments"];
    return ["posts", "comments"];
  }

  function freshStreams(kinds) {
    const streams = {};
    for (const kind of kinds) {
      streams[kind] = { cursor: null, buffer: [], hasMore: true, loading: false, failed: false };
    }
    return streams;
  }

  function resetData() {
    state.items = [];
    state.seen = new Set();
    state.streams = freshStreams(kindsForView(state.view));
    state.hasMore = true;
    state.error = null;
    state.fetched = false;
    state.loadedOnce = false;
    const list = document.querySelector(`#${PANEL_ID} .asx-list`);
    if (list) list.textContent = "";
    const status = document.querySelector(`#${PANEL_ID} .asx-status`);
    if (status) {
      status.textContent = "";
      delete status.dataset.asxKey;
    }
  }

  function setView(view, { navigate = true } = {}) {
    if (state.view === view) return;

    // When the real tab strip is present we click Reddit's own tab so its
    // highlight, URL and history all stay consistent with what is displayed;
    // the route change then drives the reload.
    if (navigate) {
      const tab = profileTabFor(view);
      if (tab) {
        tab.click();
        return;
      }
    }

    state.view = view;
    syncSegUI();
    resetData();
    loadPage(true);
  }

  function syncSegUI() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    for (const b of panel.querySelectorAll(".asx-seg-btn")) {
      b.setAttribute("aria-selected", b.dataset.view === state.view ? "true" : "false");
    }
    panel.classList.toggle("asx-has-tabs", hasTabStrip());
  }

  function profileTabFor(view) {
    const id =
      view === "posts"
        ? "profile-tab-posts_tab"
        : view === "comments"
          ? "profile-tab-comments_tab"
          : "profile-tab-overview_tab";
    const tab = document.getElementById(id);
    return tab instanceof HTMLElement ? tab : null;
  }

  function hasTabStrip() {
    return !!document.querySelector("faceplate-tabgroup#profile-feed-tabgroup, ul.tabmenu");
  }

  async function refill(kind) {
    const stream = state.streams[kind];
    if (!stream || stream.loading || !stream.hasMore) return;

    stream.loading = true;
    try {
      const params = { kind, author: state.user, sort: state.sort, limit: REFILL };
      if (stream.cursor) {
        if (state.sort === "asc") params.after = stream.cursor;
        else params.before = stream.cursor;
      }
      const res = await call("search", params);
      if (!res || !Array.isArray(res.items)) throw new Error("Unexpected archive response.");
      stream.buffer.push(...res.items);
      if (res.items.length) stream.cursor = res.items[res.items.length - 1].created;
      stream.hasMore = !!res.hasMore && res.items.length > 0;
    } catch (err) {
      stream.failed = true;
      stream.hasMore = false;
      if (!state.error) state.error = String(err?.message || err);
    } finally {
      stream.loading = false;
    }
  }

  function takeNext() {
    let bestKind = null;
    let best = null;
    for (const kind of Object.keys(state.streams)) {
      const buffer = state.streams[kind].buffer;
      if (!buffer.length) continue;
      const head = buffer[0];
      if (
        !best ||
        (state.sort === "asc" ? head.created < best.created : head.created > best.created)
      ) {
        best = head;
        bestKind = kind;
      }
    }
    if (!best) return null;
    state.streams[bestKind].buffer.shift();
    return best;
  }

  async function loadPage(reset) {
    if (!state.user) return;
    if (state.loading) return;
    if (!reset && (!state.hasMore || state.loadedOnce === "done")) return;

    state.loading = true;
    state.error = null;
    if (reset) resetData();
    renderStatus();

    const kinds = Object.keys(state.streams);
    const list = document.querySelector(`#${PANEL_ID} .asx-list`);
    let emitted = 0;
    const batch = [];

    try {
      while (emitted < PAGE_SIZE) {
        // Top up any exhausted source.
        for (const kind of kinds) {
          if (!state.streams[kind].buffer.length && state.streams[kind].hasMore) {
            await refill(kind);
          }
        }

        const item = takeNext();
        if (!item) break;

        const key = item.kind + ":" + item.id;
        if (!state.seen.has(key)) {
          state.seen.add(key);
          state.items.push(item);
          batch.push(item);
          if (list) list.append(renderCard(item));
          emitted++;
        }
      }

      if (batch.length) hydrateSubIcons(batch);

      state.fetched = true;
      state.hasMore = kinds.some((k) => {
        const s = state.streams[k];
        return s.hasMore || s.buffer.length > 0;
      });
      // Nothing new came back but a source claimed more: stop rather than
      // spin on a cursor that is not advancing.
      if (emitted === 0) state.hasMore = false;
      if (!state.hasMore) state.loadedOnce = "done";
    } catch (err) {
      state.error = String(err?.message || err);
    } finally {
      state.loading = false;
      renderStatus();
    }

    autofill();
  }

  // If the sentinel is already on screen when a page finishes (short viewport,
  // tall window), the IntersectionObserver will not fire again on its own.
  function autofill() {
    if (!state.hasMore || state.loading || state.error) return;
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.offsetParent) return;
    const sentinel = panel.querySelector(".asx-sentinel");
    if (!sentinel) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top < (window.innerHeight || 0) + 700) {
      setTimeout(() => {
        if (state.hasMore && !state.loading) loadPage(false);
      }, 80);
    }
  }

  async function hydrate() {
    if (!state.user) return;
    loadStats();
    if (state.items.length === 0) loadPage(true);
    else renderAll();
  }

  function renderAll() {
    const list = document.querySelector(`#${PANEL_ID} .asx-list`);
    if (!list) return;
    list.textContent = "";
    for (const item of state.items) list.append(renderCard(item));
    if (state.items.length) hydrateSubIcons(state.items);
    renderStatus();
  }

  async function loadStats() {
    if (state.statsRequested) return;
    state.statsRequested = true;
    try {
      const s = await call("stats", { author: state.user });
      state.stats = s;
      renderStats();
    } catch {
      state.statsRequested = false;
      /* stats are optional — ignore failures */
    }
  }

  function renderStats() {
    const box = document.querySelector(`#${PANEL_ID} .asx-stats`);
    if (!box) return;
    const s = state.stats;
    if (!s) {
      box.hidden = true;
      return;
    }

    const bits = [];
    if (s.posts !== null) bits.push(`${num(s.posts)} posts`);
    if (s.comments !== null) bits.push(`${num(s.comments)} comments`);
    if (!bits.length) {
      box.hidden = true;
      return;
    }

    const detail = [...bits];
    if (s.totalKarma !== null) detail.push(`${num(s.totalKarma)} archived karma`);
    if (s.firstComment || s.firstPost) {
      const first = Math.min(
        ...[s.firstComment, s.firstPost].filter(Boolean).map(Number)
      );
      if (isFinite(first)) detail.push(`archived since ${new Date(first * 1000).getFullYear()}`);
    }

    const key = bits.join(" · ");
    if (box.dataset.asxKey === key) return;
    box.dataset.asxKey = key;

    box.textContent = key;
    box.title = "Archived totals: " + detail.join(" · ");
    box.hidden = false;
  }

  function renderEmpty() {
    return el(
      "div",
      { class: "asx-empty" },
      el("strong", { text: `u/${state.user} hasn't posted yet` }),
      el("span", {
        text: `No archived ${state.view === "mixed" ? "posts or comments" : state.view} found on Arctic Shift. The account may be brand new or have no public archived history.`,
      })
    );
  }

  function renderSkeletons(count = 4) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      frag.append(
        el(
          "div",
          { class: "asx-skel", "aria-hidden": "true" },
          el(
            "div",
            { class: "asx-skel-row" },
            el("span", { class: "asx-skel-av" }),
            el("span", { class: "asx-skel-line", style: "width: 110px" }),
            el("span", { class: "asx-skel-line", style: "width: 64px" })
          ),
          el("div", { class: "asx-skel-title", style: `width: ${55 + ((i * 17) % 32)}%` }),
          el("div", { class: "asx-skel-body", style: "width: 92%" }),
          el("div", { class: "asx-skel-body", style: `width: ${60 + ((i * 13) % 28)}%` }),
          el(
            "div",
            { class: "asx-skel-actions" },
            el("span", { class: "asx-skel-pill", style: "width: 72px" }),
            el("span", { class: "asx-skel-pill", style: "width: 56px" }),
            el("span", { class: "asx-skel-pill", style: "width: 68px" })
          )
        ),
        el("hr", { class: "asx-hr" })
      );
    }
    return frag;
  }

  function renderStatus() {
    const status = document.querySelector(`#${PANEL_ID} .asx-status`);
    if (!status) return;

    // Idempotent: this runs from the render loop, and rewriting identical
    // content would feed our own MutationObserver forever.
    const key = state.error
      ? "err:" + state.error
      : state.loading
        ? state.items.length === 0
          ? "loading-skel"
          : "loading-more"
        : state.fetched && state.items.length === 0
          ? "empty:" + state.view
          : state.loadedOnce === "done" && state.items.length > 0
            ? "end"
            : "idle:" + state.items.length;
    if (status.dataset.asxKey === key) return;
    status.dataset.asxKey = key;

    status.textContent = "";

    if (state.error) {
      const retry = el("button", { class: "asx-retry", type: "button", text: "Retry" });
      retry.addEventListener("click", () => loadPage(false));
      status.append(el("div", { class: "asx-error" }, el("span", { text: state.error }), retry));
      return;
    }

    if (state.loading) {
      if (state.items.length === 0) {
        status.append(renderSkeletons(4));
      } else {
        status.append(
          el("div", { class: "asx-loading" }, el("span", { class: "asx-spinner" }), "Loading more…")
        );
      }
      return;
    }

    if (state.fetched && state.items.length === 0) {
      status.append(renderEmpty());
      return;
    }

    if (state.loadedOnce === "done" && state.items.length > 0) {
      status.append(el("div", { class: "asx-end", text: "You've reached the end of the archive." }));
    }
  }

  /* ------------------------------------------------------------------ *
   * Card rendering
   * ------------------------------------------------------------------ */

  const ICON = {
    up: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M10 19c-.072 0-.145 0-.218-.006A4.1 4.1 0 0 1 6 14.816V11H2.862a1.751 1.751 0 0 1-1.234-2.993L9.41.28a.836.836 0 0 1 1.18 0l7.782 7.727A1.751 1.751 0 0 1 17.139 11H14v3.882a4.134 4.134 0 0 1-.854 2.592A3.99 3.99 0 0 1 10 19Zm0-17.193L2.685 9.071a.251.251 0 0 0 .177.429H7.5v5.316A2.63 2.63 0 0 0 9.864 17.5a2.441 2.441 0 0 0 1.856-.682A2.478 2.478 0 0 0 12.5 15V9.5h4.639a.25.25 0 0 0 .176-.429L10 1.807Z"/></svg>',
    down: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M10 1c.072 0 .145 0 .218.006A4.1 4.1 0 0 1 14 5.184V9h3.138a1.751 1.751 0 0 1 1.234 2.993L10.59 19.72a.836.836 0 0 1-1.18 0l-7.782-7.727A1.751 1.751 0 0 1 2.861 9H6V5.118a4.134 4.134 0 0 1 .854-2.592A3.99 3.99 0 0 1 10 1Zm0 17.193 7.315-7.264a.251.251 0 0 0-.177-.429H12.5V5.184A2.631 2.631 0 0 0 10.136 2.5a2.441 2.441 0 0 0-1.856.682A2.478 2.478 0 0 0 7.5 5v5.5H2.861a.251.251 0 0 0-.176.429L10 18.193Z"/></svg>',
    comment:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M10 19H1.871a.886.886 0 0 1-.798-.52.886.886 0 0 1 .158-.941L3.1 15.771A9 9 0 1 1 10 19Zm-6.549-1.5H10a7.5 7.5 0 1 0-5.323-2.219l.54.545L3.451 17.5Z"/></svg>',
    share:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9.2 11.5 3.2v3.4C6.2 6.8 2.4 10 2.2 16.2c2.3-3.2 5.4-4.4 9.3-4.4v3.4L18 9.2Z"/></svg>',
    external:
      '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4h5v5M16 4l-6.5 6.5"/><path d="M15 12.5V15c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V6c0-.6.4-1 1-1h2.5"/></svg>',
    shield:
      '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="currentColor"><path d="M10 1.6 3.8 3.9v5.3c0 3.7 2.6 6.9 6.2 8 3.6-1.1 6.2-4.3 6.2-8V3.9L10 1.6Z"/></svg>',
    pin: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M13.5 3.1a1 1 0 0 0-1.4 0L9.4 5.8 6.2 5a1 1 0 0 0-1 .26L4.1 6.4a.75.75 0 0 0 0 1.06l3.3 3.3-4.2 4.2a.75.75 0 0 0 1.06 1.06l4.2-4.2 3.3 3.3a.75.75 0 0 0 1.06 0l1.14-1.14a1 1 0 0 0 .26-.98l-.8-3.2 2.7-2.7a1 1 0 0 0 0-1.4l-2.62-2.6Z"/></svg>',
    lock: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M15.5 8.5h-1V6.2a4.5 4.5 0 0 0-9 0v2.3h-1A1.5 1.5 0 0 0 3 10v6.5A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V10a1.5 1.5 0 0 0-1.5-1.5Zm-8.5-2.3a3 3 0 0 1 6 0v2.3H7V6.2Z"/></svg>',
    archive:
      '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M3 7.5h14v-2.2c0-.7-.6-1.3-1.3-1.3H4.3c-.7 0-1.3.6-1.3 1.3v2.2Zm.6 1.5v6.2c0 .7.6 1.3 1.3 1.3h10.2c.7 0 1.3-.6 1.3-1.3V9h-2v3.2a.8.8 0 0 1-1.6 0V9H8.2v3.2a.8.8 0 0 1-1.6 0V9H3.6Z"/></svg>',
    chevron:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M10 13.125a.624.624 0 0 1-.442-.183l-5-5 .884-.884L10 11.616l4.558-4.558.884.884-5 5a.624.624 0 0 1-.442.183Z"/></svg>',
    viewCard:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M16.5 3h-13A1.5 1.5 0 0 0 2 4.5v4A1.5 1.5 0 0 0 3.5 10h13A1.5 1.5 0 0 0 18 8.5v-4A1.5 1.5 0 0 0 16.5 3Zm0 5.5h-13v-4h13v4Zm0 3.5h-13A1.5 1.5 0 0 0 2 13.5v2A1.5 1.5 0 0 0 3.5 17h13a1.5 1.5 0 0 0 1.5-1.5v-2a1.5 1.5 0 0 0-1.5-1.5Zm0 3.5h-13v-2h13v2Z"/></svg>',
    viewCompact:
      '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M2 4.5h16V6H2V4.5Zm0 4.75h16v1.5H2v-1.5ZM2 14h16v1.5H2V14Z"/></svg>',
    textPost:
      '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M4 4.5h12V6H4V4.5Zm0 3.5h12v1.5H4V8Zm0 3.5h9V13H4v-1.5Zm0 3.5h6v1.5H4V15Z"/></svg>',
    linkPost:
      '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M8.5 13.5a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1-1.06-1.06 1-1a2 2 0 1 0-2.83-2.83l-2 2a2 2 0 0 0 0 2.83L8.5 13.5Zm3-7a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1 1.06 1.06-1 1a2 2 0 1 0 2.83 2.83l2-2a2 2 0 0 0 0-2.83L11.5 6.5Z"/></svg>',
    videoPost:
      '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M6.5 4.8v10.4c0 .7.75 1.13 1.35.78l8.7-5.2a.9.9 0 0 0 0-1.56l-8.7-5.2a.9.9 0 0 0-1.35.78Z"/></svg>',
    prev: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12.5 15.4 7.1 10l5.4-5.4 1.06 1.06L9.22 10l4.34 4.34-1.06 1.06Z"/></svg>',
    next: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M7.5 4.6 12.9 10l-5.4 5.4-1.06-1.06L10.78 10 6.44 5.66 7.5 4.6Z"/></svg>',
  };

  // "r/subreddit" for community posts, "u/author" for profile posts.
  function whoLabel(subreddit, author) {
    if ((subreddit || "").startsWith("u_")) return "u/" + (author || subreddit.slice(2));
    return "r/" + (subreddit || "?");
  }

  function whoHref(subreddit, author, permalink) {
    if ((subreddit || "").startsWith("u_")) {
      return `https://www.reddit.com/user/${encodeURIComponent(author || subreddit.slice(2))}/`;
    }
    if (!subreddit) return redditUrl(permalink);
    return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/`;
  }

  const subIcons = new Map(); // t5_id -> { icon, color }
  const pendingSubIds = new Set();

  function applySubIcon(node, info) {
    if (!node || !info) return;
    if (info.color) node.style.background = info.color;
    if (!info.icon || node.querySelector(".asx-avatar-img")) return;
    const img = el("img", {
      class: "asx-avatar-img",
      src: info.icon,
      alt: "",
      loading: "lazy",
      referrerpolicy: "no-referrer",
    });
    img.addEventListener("error", () => {
      if (info.fallback && img.src !== info.fallback) {
        img.src = info.fallback;
      } else {
        img.remove();
      }
    });
    node.append(img);
  }

  function hydrateSubIcons(items) {
    const ids = [];
    for (const item of items) {
      const id = item.subredditId ? String(item.subredditId).toLowerCase() : null;
      if (!id || (item.subreddit || "").startsWith("u_")) continue;
      if (subIcons.has(id) || pendingSubIds.has(id)) continue;
      pendingSubIds.add(id);
      ids.push(id);
    }
    if (!ids.length) return;

    call("subreddits", { ids })
      .then((map) => {
        if (!map || typeof map !== "object") return;
        const panel = document.getElementById(PANEL_ID);
        for (const [id, info] of Object.entries(map)) {
          subIcons.set(id, info);
          if (!panel || (!info?.icon && !info?.color)) continue;
          const nodes = panel.querySelectorAll(`.asx-avatar[data-asx-subid="${CSS.escape(id)}"]`);
          for (const node of nodes) applySubIcon(node, info);
        }
      })
      .catch(() => {
        /* icons are optional */
      })
      .finally(() => {
        for (const id of ids) pendingSubIds.delete(id);
      });
  }

  // Starts with a colored r/ or initial badge immediately (zero blocking), then
  // swaps in the real subreddit icon once the background batch resolves.
  function avatarEl(label, href, subredditId) {
    const name = String(label || "?");
    const isUser = name.startsWith("u/");
    const clean = name.replace(/^[ru]\//, "");
    const ch = isUser ? clean.charAt(0).toUpperCase() || "U" : "r/";
    const subId = !isUser && subredditId ? String(subredditId).toLowerCase() : null;
    let hue = 0;
    for (let i = 0; i < clean.length; i++) hue = (hue * 31 + clean.charCodeAt(i)) % 360;
    const node = el(
      "a",
      {
        class: "asx-avatar" + (isUser ? " asx-avatar--user" : ""),
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        tabindex: "-1",
        "aria-hidden": "true",
        "data-asx-subid": subId,
        style: `background: hsl(${hue} 52% 42%)`,
      },
      el("span", { class: "asx-avatar-ch", text: ch })
    );
    if (subId && subIcons.has(subId)) {
      applySubIcon(node, subIcons.get(subId));
    }
    return node;
  }

  function distBadge(kind) {
    if (!kind) return null;
    const label = kind === "admin" ? "ADMIN" : kind === "moderator" ? "MOD" : kind.toUpperCase();
    return el(
      "span",
      { class: "asx-dist asx-dist--" + kind, title: "Distinguished when archived" },
      el("span", { class: "asx-dist-ico", html: ICON.shield }),
      el("span", { text: label })
    );
  }

  function flairEl(text, bg, textColor, richtext) {
    const hasRich = Array.isArray(richtext) && richtext.length > 0;
    if (!text && !hasRich) return null;
    const validBg = bg && /^#[0-9a-f]{3,8}$/i.test(bg.trim()) ? bg.trim() : null;
    const style = validBg
      ? `background:${validBg};color:${textColor === "light" ? "#ffffff" : "#0f1a1c"};border-color:transparent;`
      : null;
    const node = el("span", { class: "asx-flair", style });
    if (hasRich) {
      for (const part of richtext) {
        if (part.e === "emoji" && part.u) {
          const img = el("img", {
            class: "asx-flair-emoji",
            src: part.u,
            alt: part.a || "",
            title: part.a || "",
            loading: "lazy",
            referrerpolicy: "no-referrer",
          });
          img.addEventListener("error", () => {
            img.replaceWith(document.createTextNode(part.a || ""));
          });
          node.append(img);
        } else if (part.e === "text" && part.t) {
          const clean = part.t.trim();
          if (clean) node.append(document.createTextNode(clean));
        }
      }
      if (node.childNodes.length) return node;
    }
    if (!text) return null;
    node.textContent = text;
    return node;
  }

  function statusIcons(item) {
    const icons = [];
    if (item.stickied) {
      icons.push(el("span", { class: "asx-stat-ico asx-stat-ico--pin", title: "Pinned", html: ICON.pin }));
    }
    if (item.locked) {
      icons.push(el("span", { class: "asx-stat-ico asx-stat-ico--lock", title: "Locked", html: ICON.lock }));
    }
    if (item.archived) {
      icons.push(
        el("span", { class: "asx-stat-ico asx-stat-ico--arch", title: "Archived by Reddit", html: ICON.archive })
      );
    }
    return icons;
  }

  function timeEl(ts, short) {
    return el("time", {
      class: "asx-time",
      datetime: new Date(ts * 1000).toISOString(),
      title: fullDate(ts),
      text: ago(ts, short),
    });
  }

  function voteGroup(score, plain) {
    const neg = score < 0;
    return el(
      "span",
      {
        class: "asx-votes" + (plain ? " asx-votes--plain" : "") + (neg ? " is-neg" : ""),
        title: `${score.toLocaleString()} point${score === 1 ? "" : "s"} when archived`,
      },
      el("span", { class: "asx-vote-ico", html: ICON.up }),
      el("span", { class: "asx-votes-n", text: num(score) }),
      el("span", { class: "asx-vote-ico", html: ICON.down })
    );
  }

  function actionPill(href, label, icon, title) {
    return el(
      "a",
      {
        class: "asx-pill",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        title: title || label,
      },
      icon && el("span", { class: "asx-pill-ico", html: icon }),
      el("span", { class: "asx-pill-label", text: label })
    );
  }

  function sharePill(permalink) {
    const url = redditUrl(permalink);
    const label = el("span", { class: "asx-pill-label", text: "Share" });
    const btn = el(
      "button",
      {
        class: "asx-pill asx-pill--btn",
        type: "button",
        title: "Copy Reddit link",
      },
      el("span", { class: "asx-pill-ico", html: ICON.share }),
      label
    );
    let timer = null;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const done = () => {
        label.textContent = "Copied!";
        clearTimeout(timer);
        timer = setTimeout(() => {
          label.textContent = "Share";
        }, 1600);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(done, done);
      } else {
        done();
      }
    });
    return btn;
  }

  function makeCardClickable(card, href) {
    card.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const sel = window.getSelection?.();
      if (sel && sel.toString().length > 0) return;
      if (e.target.closest?.("a, button, video, input, select, .asx-spoiler, .asx-media-blur")) return;
      window.open(href, "_blank", "noopener,noreferrer");
    });
  }

  function isDirectImageUrl(url) {
    if (!url) return false;
    return /^https?:\/\/i\.redd\.it\//i.test(url) || /\.(?:jpe?g|png|gif|webp)(?:[?#].*)?$/i.test(url);
  }

  function formatDuration(sec) {
    if (typeof sec !== "number" || !isFinite(sec)) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  function wrapSensitiveMedia(box, p) {
    if (!p.over18 && !p.spoiler) return box;
    box.classList.add("asx-is-blurred");
    const label = p.over18 ? "View NSFW content" : "View spoiler";
    const overlay = el(
      "div",
      { class: "asx-media-blur" },
      el("button", { class: "asx-blur-btn", type: "button", text: label })
    );
    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      box.classList.remove("asx-is-blurred");
      overlay.remove();
    });
    box.append(overlay);
    return box;
  }

  function buildLinkCard(p) {
    let host = p.domain || "";
    try {
      host = p.domain || new URL(p.url).hostname.replace(/^www\./, "");
    } catch {
      /* ignore */
    }
    const thumb = p.thumbnail || p.previewUrl;
    if (thumb) {
      const img = el("img", {
        class: "asx-linkcard-img",
        src: thumb,
        alt: "",
        loading: "lazy",
        referrerpolicy: "no-referrer",
      });
      img.addEventListener("error", () => img.parentElement?.remove());
      return el(
        "a",
        {
          class: "asx-linkcard",
          href: p.url,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        el(
          "div",
          { class: "asx-linkcard-info" },
          el("span", { class: "asx-linkcard-host", text: host || "external link" }),
          el("span", { class: "asx-linkcard-url", text: p.url })
        ),
        el(
          "div",
          { class: "asx-linkcard-thumb" + (p.over18 || p.spoiler ? " asx-thumb-blur" : "") },
          img,
          el("span", { class: "asx-linkcard-badge", html: ICON.external })
        )
      );
    }
    return el(
      "a",
      { class: "asx-domain", href: p.url, target: "_blank", rel: "noopener noreferrer" },
      el("span", { text: host || "external link" }),
      el("span", { class: "asx-domain-ico", html: ICON.external })
    );
  }

  function buildPostMedia(p) {
    if (p.removed) return null;

    // 1. Crosspost card
    if (p.crosspost) {
      const xp = p.crosspost;
      const xpHref = redditUrl(xp.permalink);
      const xpLabel = whoLabel(xp.subreddit, xp.author);
      return el(
        "a",
        {
          class: "asx-xpost",
          href: xpHref,
          target: "_blank",
          rel: "noopener noreferrer",
        },
        el(
          "div",
          { class: "asx-xpost-head" },
          el("span", { class: "asx-xpost-sub", text: xpLabel }),
          el("span", { class: "asx-dot", text: "•" }),
          timeEl(xp.created, true)
        ),
        el("div", { class: "asx-xpost-title", text: xp.title || "(untitled)" }),
        el("div", {
          class: "asx-xpost-meta",
          text: `${num(xp.score)} upvotes · ${num(xp.numComments)} comments`,
        })
      );
    }

    // 2. Gallery carousel
    if (p.gallery && p.gallery.length > 0) {
      let idx = 0;
      const total = p.gallery.length;
      const frame = el("div", { class: "asx-media asx-gallery" });
      const img = el("img", {
        class: "asx-media-img",
        src: p.gallery[0].url,
        alt: p.title || "",
        loading: "lazy",
        referrerpolicy: "no-referrer",
      });
      const counter = el("span", { class: "asx-gal-count", text: `1 / ${total}` });
      const caption = el("div", {
        class: "asx-gal-cap",
        hidden: !p.gallery[0].caption,
        text: p.gallery[0].caption || "",
      });

      const prevBtn = el("button", {
        class: "asx-gal-btn asx-gal-prev",
        type: "button",
        "aria-label": "Previous image",
        html: ICON.prev,
        hidden: true,
      });
      const nextBtn = el("button", {
        class: "asx-gal-btn asx-gal-next",
        type: "button",
        "aria-label": "Next image",
        html: ICON.next,
        hidden: total <= 1,
      });

      const update = () => {
        const cur = p.gallery[idx];
        img.src = cur.url;
        counter.textContent = `${idx + 1} / ${total}`;
        prevBtn.hidden = idx === 0;
        nextBtn.hidden = idx === total - 1;
        caption.textContent = cur.caption || "";
        caption.hidden = !cur.caption;
      };

      prevBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (idx > 0) {
          idx--;
          update();
        }
      });
      nextBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (idx < total - 1) {
          idx++;
          update();
        }
      });

      frame.append(img, counter, prevBtn, nextBtn, caption);
      return wrapSensitiveMedia(frame, p);
    }

    // 3. Video
    if (p.isVideo && p.videoUrl) {
      const frame = el("div", { class: "asx-media asx-media--video" });
      const video = el("video", {
        class: "asx-media-vid",
        src: p.videoUrl,
        poster: p.previewUrl || p.thumbnail || null,
        controls: true,
        playsinline: true,
        preload: "metadata",
      });
      video.addEventListener("click", (e) => e.stopPropagation());
      frame.append(video);
      if (p.videoDuration) {
        frame.append(el("span", { class: "asx-vid-dur", text: formatDuration(p.videoDuration) }));
      }
      return wrapSensitiveMedia(frame, p);
    }

    // 4. Single image
    const imgSrc =
      p.postHint === "image" || isDirectImageUrl(p.url) ? p.previewUrl || p.url : null;
    if (imgSrc) {
      const frame = el("div", { class: "asx-media" });
      const bg = el("div", {
        class: "asx-media-bg",
        style: `background-image:url("${imgSrc.replace(/"/g, "%22")}")`,
      });
      const img = el("img", {
        class: "asx-media-img",
        src: imgSrc,
        alt: p.title || "",
        loading: "lazy",
        referrerpolicy: "no-referrer",
      });
      img.addEventListener("error", () => {
        if (p.url && img.src !== p.url) {
          img.src = p.url;
        } else {
          frame.replaceWith(buildLinkCard(p));
        }
      });
      frame.append(bg, img);
      return wrapSensitiveMedia(frame, p);
    }

    // 5. External link
    if (p.url && !p.isSelf) {
      return buildLinkCard(p);
    }

    return null;
  }

  function buildCompactThumb(p) {
    const thumbSrc =
      p.thumbnail ||
      p.previewUrl ||
      (p.gallery && p.gallery[0]?.url) ||
      (isDirectImageUrl(p.url) ? p.url : null);
    const box = el("div", {
      class: "asx-cthumb" + (p.over18 || p.spoiler ? " asx-thumb-blur" : ""),
    });
    if (thumbSrc && !p.removed) {
      const img = el("img", {
        src: thumbSrc,
        alt: "",
        loading: "lazy",
        referrerpolicy: "no-referrer",
      });
      img.addEventListener("error", () => {
        img.remove();
        box.innerHTML = p.isVideo ? ICON.videoPost : p.isSelf ? ICON.textPost : ICON.linkPost;
      });
      box.append(img);
    } else {
      box.innerHTML = p.isVideo ? ICON.videoPost : p.isSelf ? ICON.textPost : ICON.linkPost;
    }
    return box;
  }

  function renderCard(item) {
    if (item.kind === "comment") return renderComment(item);
    return renderPost(item);
  }

  function renderComment(c) {
    const card = el("article", { class: "asx-card asx-card--comment" });
    const inner = el("div", { class: "asx-inner" });
    const threadHref = redditUrl(c.permalink);

    const label = whoLabel(c.subreddit, c.author);
    const href = whoHref(c.subreddit, c.author, c.permalink);

    const line1 = el("div", { class: "asx-ctx-line" });
    line1.append(
      el("a", {
        class: "asx-ctx-name",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        text: label,
      })
    );
    if (c.linkTitle) {
      line1.append(
        el("span", { class: "asx-dot", text: "•" }),
        el("a", {
          class: "asx-ctx-title",
          href: redditUrl(c.linkPermalink || c.permalink),
          target: "_blank",
          rel: "noopener noreferrer",
          text: c.linkTitle,
          title: c.linkTitle,
        })
      );
    }

    const line2 = el("div", { class: "asx-ctx-line asx-ctx-sub" });
    line2.append(
      el("a", {
        class: "asx-ctx-author",
        href: `https://www.reddit.com/user/${encodeURIComponent(c.author || "")}/`,
        target: "_blank",
        rel: "noopener noreferrer",
        text: c.author || "?",
      })
    );
    if (c.isSubmitter) line2.append(el("span", { class: "asx-op", text: "OP" }));
    const badge = distBadge(c.distinguished);
    if (badge) line2.append(badge);
    const flair = flairEl(c.authorFlair, c.authorFlairBg, c.authorFlairColor, c.authorFlairRich);
    if (flair) line2.append(flair);
    const verb = c.parentId && c.parentId.startsWith("t1_") ? "replied" : "commented";
    line2.append(
      el("span", { class: "asx-verb", text: verb }),
      el("span", { class: "asx-dot", text: "•" }),
      timeEl(c.created, true)
    );
    if (c.edited) line2.append(el("span", { class: "asx-edited", text: "(edited)" }));
    for (const ico of statusIcons(c)) line2.append(ico);

    const ctx = el(
      "div",
      { class: "asx-ctx" },
      avatarEl(label, href, c.subredditId),
      el("div", { class: "asx-ctx-main" }, line1, line2)
    );

    const content = el("div", { class: "asx-md" });
    if (c.removed) {
      content.append(el("p", { class: "asx-removed", text: (c.body || "").trim() }));
    } else {
      content.innerHTML = mdToHtml(c.body);
    }

    const actions = el("div", { class: "asx-actions asx-actions--comment" });
    if (typeof c.score === "number") actions.append(voteGroup(c.score, true));
    actions.append(
      actionPill(threadHref, "View thread", ICON.comment, "Open this comment in its thread"),
      sharePill(c.permalink)
    );

    inner.append(ctx, content, actions);
    card.append(inner, el("hr", { class: "asx-hr" }));
    makeCardClickable(inner, threadHref);
    return card;
  }

  function renderPost(p) {
    const card = el("article", { class: "asx-card asx-card--post" });
    const inner = el("div", { class: "asx-inner" });
    const threadHref = redditUrl(p.permalink);

    const label = whoLabel(p.subreddit, p.author);
    const href = whoHref(p.subreddit, p.author, p.permalink);

    const credit = el("div", { class: "asx-credit" });
    credit.append(
      avatarEl(label, href, p.subredditId),
      el("a", {
        class: "asx-credit-name",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        text: label,
      })
    );
    const badge = distBadge(p.distinguished);
    if (badge) credit.append(badge);
    credit.append(el("span", { class: "asx-dot", text: "•" }), timeEl(p.created, true));
    if (p.edited) credit.append(el("span", { class: "asx-edited", text: "(edited)" }));
    for (const ico of statusIcons(p)) credit.append(ico);

    const title = el(
      "h3",
      { class: "asx-title" },
      el("a", {
        href: threadHref,
        target: "_blank",
        rel: "noopener noreferrer",
        text: p.title || "(untitled)",
      })
    );

    const tags = el("div", { class: "asx-tags" });
    if (p.over18) tags.append(el("span", { class: "asx-nsfw", text: "NSFW" }));
    if (p.spoiler) tags.append(el("span", { class: "asx-spoiler-tag", text: "SPOILER" }));
    const flair = flairEl(p.flair, p.flairColor, p.flairTextColor, p.flairRich);
    if (flair) tags.append(flair);

    const mainCol = el("div", { class: "asx-post-main" });
    mainCol.append(credit, title);
    if (tags.childNodes.length) mainCol.append(tags);

    const media = buildPostMedia(p);
    if (media) mainCol.append(media);

    if (p.body && !p.removed) {
      // Profile cards in Reddit show about six lines of body text and then an
      // ellipsis, so trim before converting rather than building a huge DOM.
      const LIMIT = 700;
      const cut = p.body.length > LIMIT;
      const raw = cut ? p.body.slice(0, LIMIT).replace(/\s+\S*$/, "") + "…" : p.body;
      const content = el("div", { class: "asx-md asx-clamp asx-post-body" });
      content.innerHTML = mdToHtml(raw);
      mainCol.append(content);
    } else if (p.body) {
      mainCol.append(
        el("div", { class: "asx-md asx-post-body" }, el("p", { class: "asx-removed", text: p.body.trim() }))
      );
    }

    const actions = el("div", { class: "asx-actions" });
    if (typeof p.score === "number") actions.append(voteGroup(p.score, false));
    if (typeof p.numComments === "number") {
      actions.append(actionPill(threadHref, num(p.numComments), ICON.comment, "Open comments"));
    }
    actions.append(sharePill(p.permalink));
    mainCol.append(actions);

    inner.append(buildCompactThumb(p), mainCol);
    card.append(inner, el("hr", { class: "asx-hr" }));
    makeCardClickable(inner, threadHref);
    return card;
  }

  /* ------------------------------------------------------------------ *
   * Mounting
   * ------------------------------------------------------------------ */

  function applyTheme(node) {
    node.classList.toggle("asx-dark", isDark());
  }

  function isDark() {
    const explicitDark =
      document.documentElement.classList.contains("theme-dark") ||
      document.body.classList.contains("theme-dark") ||
      document.body.classList.contains("res-nightmode");
    if (explicitDark) return true;
    if (
      document.documentElement.classList.contains("theme-light") ||
      document.body.classList.contains("theme-light")
    ) {
      return false;
    }
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/\d+/g);
      if (!m) return matchMedia("(prefers-color-scheme: dark)").matches;
      const [r, g, b] = m.map(Number);
      return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    } catch {
      return matchMedia("(prefers-color-scheme: dark)").matches;
    }
  }

  function mount() {
    const r = route();
    if (!r) return;
    if (isOldReddit()) mountOld();
    else mountNew();
  }

  function mountNew() {
    const main = document.querySelector("#main-content") || document.querySelector("main");
    if (!main) return;

    const tabgroup = document.querySelector("faceplate-tabgroup#profile-feed-tabgroup");

    // Reddit's tab strip is a shadow-DOM component with fixed named slots, so
    // a tab appended to it would never paint. Instead we put our own pill row
    // after it, pulled back up onto the same line so it reads as part of the
    // profile's section switcher.
    if (tabgroup) {
      // Sit the Archive pill directly beside Overview / Posts / Comments by
      // turning Reddit's tab wrapper into a row. The tabgroup itself is a
      // shadow-DOM component with fixed named slots, so appending into it
      // would never paint.
      const holder = tabgroup.parentElement;
      if (holder) holder.classList.add("asx-tabholder");
      let row = document.getElementById(TABROW_ID);
      if (!row) row = buildTabRow();
      if (row.previousElementSibling !== tabgroup) tabgroup.insertAdjacentElement("afterend", row);
      const tab = row.querySelector(`#${TAB_ID}`);
      if (tab) {
        applyTheme(tab);
        tab.classList.toggle("asx-tab--active", state.open);
      }
    }

    if (!state.open) {
      restoreFeed();
      destroyPanel();
      return;
    }

    // The "Feed options" row sits between the tabs and the panel and has no
    // meaning for archived content, so it is hidden while we are showing.
    const feed = document.querySelector("shreddit-feed");
    const host = (tabgroup && tabgroup.parentElement) || (feed && feed.parentElement) || main;

    let panel = getPanel();
    applyTheme(panel);

    // Put the panel directly under our tab row when we have one, so it reads
    // as the selected section of the profile rather than a stray block. The
    // tab wrapper has 4px side margins, so mount one level up to line the
    // panel up with the full-width feed column.
    const row = document.getElementById(TABROW_ID);
    if (row && row.parentElement && row.parentElement.parentElement) {
      const column = row.parentElement.parentElement;
      if (panel.parentElement !== column) {
        column.insertBefore(panel, row.parentElement.nextSibling);
      }
    } else if (panel.parentElement !== host) {
      if (feed && feed.parentElement === host) host.insertBefore(panel, feed);
      else host.append(panel);
    }

    if (feed) hideFeed(feed, panel);
    if (panel !== document.getElementById(PANEL_ID)) return;

    // Keep the two lists in sync with state after re-mounts.
    syncSegUI();
    if (state.open && !state.fetched && !state.loading && !state.error) hydrate();
    if (state.items.length && !panel.querySelector(".asx-card")) renderAll();
    renderStats();
    renderStatus();
  }

  let hiddenFeedParent = null;

  function hideFeed(feed, panel) {
    if (!feed) return;
    feed.style.display = "none";
    const parent = feed.parentElement;
    // The feed's wrapper also holds the "Feed options" control and the title
    // row; hiding the wrapper avoids leaving orphaned chrome above our panel.
    // Never hide a wrapper that also contains our own UI.
    if (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      !parent.contains(panel) &&
      !parent.contains(document.getElementById(TABROW_ID))
    ) {
      hiddenFeedParent = parent;
      parent.style.display = "none";
    }
  }

  function restoreFeed() {
    const feed = document.querySelector("shreddit-feed");
    if (feed) feed.style.display = "";
    if (hiddenFeedParent) {
      hiddenFeedParent.style.display = "";
      hiddenFeedParent = null;
    }
  }

  function mountOld() {
    // Tab strip
    let tab = document.getElementById(TAB_ID);
    if (!tab) {
      tab = buildTab();
      tab.classList.add("asx-tab--old");
      const menu = document.querySelector("ul.tabmenu");
      if (menu) {
        const li = el("li", {}, tab);
        li.id = "asx-tab-li";
        menu.append(li);
      }
    }
    applyTheme(tab);
    tab.classList.toggle("asx-tab--active", state.open);

    const siteTable = document.getElementById("siteTable");
    if (!state.open) {
      destroyPanel();
      if (siteTable) siteTable.style.display = "";
      return;
    }

    const host = (siteTable && siteTable.parentElement) || document.body;
    let panel = getPanel();
    applyTheme(panel);
    if (!panel.isConnected) {
      if (siteTable && siteTable.parentElement === host) host.insertBefore(panel, siteTable);
      else host.append(panel);
    }
    if (siteTable) siteTable.style.display = "none";

    syncSegUI();
    if (state.open && !state.fetched && !state.loading && !state.error) hydrate();
    if (state.items.length && !panel.querySelector(".asx-card")) renderAll();
    renderStats();
    renderStatus();
  }

  function teardown() {
    restoreFeed();
    destroyPanel();
    document.getElementById(TAB_ID)?.closest("li")?.remove();
    document.getElementById(TABROW_ID)?.remove();
    document.getElementById(TAB_ID)?.remove();
    const siteTable = document.getElementById("siteTable");
    if (siteTable) siteTable.style.display = "";
  }

  function resetForUser(user) {
    teardown();
    state.user = user;
    state.open = storedOpen() === user;
    state.view = viewForSection(route()?.section);
    state.items = [];
    state.seen = new Set();
    state.streams = freshStreams(kindsForView(state.view));
    state.hasMore = true;
    state.error = null;
    state.stats = null;
    state.statsRequested = false;
    state.fetched = false;
    state.loadedOnce = false;
    state.loading = false;
  }

  /* ------------------------------------------------------------------ *
   * Navigation + render loop
   * ------------------------------------------------------------------ */

  let lastPath = location.pathname;
  let scheduled = false;

  function viewForSection(section) {
    if (section === "submitted") return "posts";
    if (section === "comments") return "comments";
    if (!section || section === "overview") return "mixed";
    return null; // saved / upvoted / hidden — not something the archive mirrors
  }

  function storedOpen() {
    try {
      return sessionStorage.getItem("asx:open");
    } catch {
      return null;
    }
  }

  function rememberOpen(user) {
    try {
      if (user) sessionStorage.setItem("asx:open", user);
      else sessionStorage.removeItem("asx:open");
    } catch {
      /* storage can be blocked */
    }
  }

  function ensure() {
    scheduled = false;
    const pathChanged = lastPath !== location.pathname;
    lastPath = location.pathname;

    const r = route();
    if (!r) {
      if (state.user) {
        teardown();
        state.user = null;
      }
      return;
    }

    if (state.user !== r.user) resetForUser(r.user);

    // Navigating between Overview / Posts / Comments keeps the archive open
    // and follows the section, exactly like the profile's own tabs would.
    const view = viewForSection(r.section);
    if (view === null) {
      if (state.open) {
        state.open = false;
        rememberOpen(null);
      }
    } else if (pathChanged && state.open && view !== state.view) {
      state.view = view;
      resetData();
      syncSegUI();
      loadPage(true);
    }

    mount();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(ensure, 120);
  }

  function start() {
    ensure();

    // SPA navigation on new Reddit
    for (const method of ["pushState", "replaceState"]) {
      const orig = history[method];
      if (!orig || orig.__asxPatched) continue;
      const patched = function (...args) {
        const out = orig.apply(this, args);
        schedule();
        return out;
      };
      patched.__asxPatched = true;
      history[method] = patched;
    }
    window.addEventListener("popstate", schedule);

    // Re-render guard: Reddit re-renders its own tab strip and feed often,
    // which can drop our nodes. Only react to structural changes that matter,
    // then fall back to a cheap periodic check for anything missed.
    const interesting = (node) =>
      node.nodeType === 1 &&
      (node.id === PANEL_ID ||
        node.id === TAB_ID ||
        node.matches?.("shreddit-feed, faceplate-tabgroup, #siteTable, ul.tabmenu"));

    const mo = new MutationObserver((records) => {
      // Reddit re-renders constantly; only look at changes while we are on a
      // profile page so ordinary browsing costs nothing.
      if (!route()) return;
      for (const rec of records) {
        for (const node of rec.addedNodes) if (interesting(node)) return schedule();
        for (const node of rec.removedNodes) if (interesting(node)) return schedule();
        // Our panel is usually replaced as part of a bigger subtree swap.
        if (!document.getElementById(PANEL_ID) && state.open) return schedule();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    setInterval(ensure, 900);

    // Reddit's own profile tabs now drive the archive section instead of
    // closing it, so nothing is intercepted here on purpose.

    // Theme can change without us mutating the page.
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      const panel = document.getElementById(PANEL_ID);
      if (panel) applyTheme(panel);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
