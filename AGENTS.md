# AGENTS.md

berg profiles a website by crawling it like a browser: what the site *says* (content, structure, links — "above the
line") and what it *does* (requests, cookies, JS API calls — "below the line"). This file covers (1) how the code works
and (2) what the output looks like and how an agent should assess it.

---

## 1. How the code works

### Layout

| Path | Role |
|---|---|
| `src/berg.js` | CLI entry point (`bin: berg`). Parses args, runs the BFS crawl, builds per-page reports, writes `site.json`. |
| `src/PageCollector.js` | berg's own collector. Snapshots DOM content and links from the main frame. |
| `src/urlUtils.js` | `normalizeUrl`, `isSameSite`, `createPageFilename`. |
| `test/berg.test.js` | Unit checks plus an end-to-end crawl against a local HTTP server (`npm test`). |
| `radar/` | Git submodule: [tracker-radar-collector](https://github.com/duckduckgo/tracker-radar-collector). Provides the crawler, browser launcher, and the behavior collectors. Don't edit it in place; bump the submodule instead (see README). |
| `data/` | Conventional output location (gitignored). |

Radar modules are imported through the subpath alias `#radar/*` → `./radar/*.js` (see `package.json` `imports`).
radar's dependencies live in `radar/node_modules` (installed by `postinstall`), not hoisted, because some radar
collectors resolve files via hardcoded `../node_modules/...` paths.

### Crawl flow (`crawlSite` in `src/berg.js`)

1. **Setup.** Creates `<output>/` and `<output>/pages/`, then calls radar's `downloadChrome` (first run downloads
   Chromium into `radar/chromium/`).
2. **Queue.** Breadth-first. The queue starts with the normalized seed URL. `discovered` dedupes enqueueing and
   `visited` dedupes crawling. The crawl stops when the queue is empty or `visited.size` reaches `--budget`.
3. **Per page (`crawlSingleUrl`).**
   - Builds a **fresh set of collector instances** (`createCollectors`) so no state leaks between pages.
   - Calls radar's `crawl(url, {...})`. berg passes no `browserConnection`, so **radar launches a new Chrome with a new
     temporary profile for every page** and deletes it afterwards. Every page is a cold, first-visit load with no
     cookies, storage or cache carried over from earlier pages.
   - radar loads the page (up to `--max-load-time`, default 30s), waits `--extra-time` (default 2.5s), then calls
     each collector's `getData()`. Anything the page loads after that window is not captured.
   - The `notABot` script is injected into every frame unless `--no-anti-bot` is set. It masks common automation tells
     such as `navigator.webdriver`, `Notification.permission`, `chrome.runtime` and the empty `plugins` list.
   - If the page redirected to another same-site URL, that final URL is marked as discovered so it won't be crawled again.
   - `buildPageReport` turns radar's raw `CollectResult` into the per-page JSON (described below).
   - Each same-site link not yet discovered is pushed onto the queue, and each unique `from → to` pair is recorded as a graph edge.
   - Writes `pages/NNNN_<slug>_<sha1-8>.json`. If screenshots are enabled, also writes a `.jpg` beside it and puts
     its relative path in the JSON in place of the base64 data.
   - Errors are caught per page and recorded with `status: "error"`. One failed page doesn't stop the crawl.
4. **Concurrency.** With `-c > 1`, the seed is crawled alone first so the queue has entries, then N workers pull from
   the shared queue. Page indices follow the order in which pages were dequeued.
5. **Summary.** Writes `site.json` with run metadata, a per-page index, and the internal link graph.

### URL semantics (`src/urlUtils.js`)

- `normalizeUrl` accepts only http(s) URLs and strips the `#fragment`. Query strings are **kept**, so
  `/feeds?chain=a` and `/feeds?chain=b` are different pages. On sites with filter or facet URLs this can use up the
  budget (see "Budget skew" below).
- `isSameSite` requires an **exact hostname match** (case-insensitive). The scheme can differ (`http`/`https` both
  count), but `www.example.com` and `example.com` are treated as different sites, and subdomains are not followed.
  Seed with the hostname the site actually serves from.
- `createPageFilename` produces `<4-digit index>_<host+path slug, ≤60 chars>_<sha1(url) first 8 hex>.json`.

### Collectors

Selected with `-d` (comma-separated). Defaults: `page,requests,apis,cookies,targets`.

| ID | Source | Captures |
|---|---|---|
| `page` | `src/PageCollector.js` | Runs one `Runtime.evaluate` in the main frame **after** load + extra time: title, `lang`, canonical, `<meta name/property>` (the first value wins for duplicate keys), headings h1–h6 (text ≤500 chars), every `a[href]` (resolved, deduped by href+text), forms with their input tag/type/name, `script[src]`, `iframe[src]`, `img[src]` with alt, and `body.innerText` (cut off at 100,000 chars; `textLength` holds the untruncated length). Main frame only; content inside iframes is not included. |
| `requests` | radar `RequestCollector` | Every network request: url, method, resource type, status, size, remote IP, initiators, timing, body hash, and **response headers filtered to a safelist** (`etag`, `set-cookie`, `cache-control`, `expires`, `pragma`, `p3p`, `timing-allow-origin`, `access-control-allow-origin`, `accept-ch`). |
| `apis` | radar `APICallCollector` | Instrumented JS API calls. `callStats` maps script URL → `{ "API description": count }`. `savedCalls` holds selected calls with their arguments (for example, `Document.cookie setter` values). |
| `cookies` | radar `CookieCollector` | The cookie jar at the end of the page load: name, domain, path, `expires` (ms epoch, after Chrome's 400-day cap), `session`, `sameSite`. |
| `targets` | radar `TargetCollector` | CDP targets (page, workers, iframes) created during the load. |
| `cookiepopups` | radar `CookiePopupsCollector` | Cookie banner / CMP detection. Off by default. |
| `screenshots` | radar `ScreenshotCollector` | Page screenshot written as a `.jpg`. Off by default. |
| `trace` | radar `TraceCollector` | Chrome performance trace. Off by default and large. |

To add a collector: subclass `#radar/collectors/BaseCollector` (implement `id()`, optionally `init`, `addTarget`,
`getData`), register it in `COLLECTOR_CLASSES`, and if it needs a dedicated section in the report, add it in
`buildPageReport`.

### CLI

```
berg --site <url> -o <dir> [-b 100] [-d page,requests,apis,cookies,targets] [-c 1]
     [--max-load-time 30000] [--extra-time 2500] [--no-anti-bot] [--only-3p] [-v]
```

`--only-3p` passes `filterOutFirstParty` to radar, which drops first-party requests and API calls from the output.
That makes the request data smaller but no longer complete. Collector IDs are validated before the browser launches.

### Dev

- Node ≥ 24.14.1 (`.nvmrc`). `npm install` also installs radar's dependencies.
- `npm test` runs an end-to-end crawl against a local server (sets `TRC_UNSAFE_DISABLE_SANDBOX=1`).
- `npm run lint` / `npm run format`: Prettier on `src/` and `test/` (`.prettierrc`).

---

## 2. Output and how to assess it

### Output layout

A run such as

```sh
node src/berg.js --site https://<host> -b <budget> -o <out>/
```

writes:

```
<out>/
├── site.json               # run summary + page index + link graph
├── pages/                  # one report per crawled page: 0001_… → NNNN_…
│   └── NNNN_<slug>_<hash>.jpg   # only with the screenshots collector
└── <host>.md               # the assessment, written afterwards by an agent (not by berg)
```

Output is large. With the default collectors, a 100-page crawl of a tracker-heavy site produces a `site.json` close to
1 MB (mostly graph edges), and the request and API data make each page file much bigger than its text content.

### `site.json`

```jsonc
{
  "seedUrl": "https://<host>/",
  "siteHost": "<host>",
  "budget": 100,
  "pagesCrawled": 100, "pagesSucceeded": 100, "pagesFailed": 0,
  "collectors": ["page","requests","apis","cookies","targets"],
  "startedAt": "<ISO>", "finishedAt": "<ISO>", "durationMs": 0,
  "pages": [
    { "index": 1, "url": "…", "finalUrl": "…", "file": "pages/0001_<slug>_<hash>.json",
      "title": "…", "internalLinksFound": 0, "status": "ok" }   // status: ok | timeout | error (+ "error" msg)
  ],
  "graph": { "edges": [ { "from": "<crawled url>", "to": "<same-site url>" } ] }
}
```

Edges point to every same-site link that was found, including targets never crawled because the budget ran out. A
`to` URL that isn't in `pages[]` therefore marks the unexplored frontier, not a broken link. A page's crawl depth is
its shortest path from the seed in this graph. Sitewide navigation links appear on nearly every page, so they inflate
inbound-link counts.

### `pages/NNNN_*.json`

```jsonc
{
  "initialUrl", "finalUrl", "timeout", "testStarted", "testFinished",
  "content": {            // from PageCollector — "above the line"
    "title", "lang", "canonicalUrl", "meta", "headings": [{level,text}],
    "text", "textLength", "forms", "images": [{src,alt}]
  },
  "relationships": {
    "internalLinks": [],  // normalized, deduped, same-site
    "externalLinks": [],  // normalized, deduped, other hosts
    "scripts": [], "iframes": [],
    "targets": [],
    "thirdPartyDomains": [] // hostnames of requests whose host ≠ seed host
  },
  "behaviors": {          // "below the line"
    "requests": [], "cookies": [], "apis": { "callStats": {}, "savedCalls": [] },
    "cookiepopups"        // only if that collector ran
  },
  "data": { … }           // raw radar collector output, keyed by collector id
}
```

`content`, `relationships` and `behaviors` are views built from `data`. When aggregating, use one or the other, not
both, or every value will be counted twice. `thirdPartyDomains` uses an exact hostname comparison, so the site's own
CDN and other subdomains (e.g. `cdn.<host>`) appear there as "third-party". Classify them yourself.

### How the output is meant to be assessed

The output is raw evidence. The intended consumer is an agent (or a person) who reads it and writes a **site profile**
in Markdown, saved next to the data as `<out>/<host>.md`. The profile should describe what the site says, what it
does, and where those two disagree, with every claim backed by numbers or artifacts from the crawl.

#### Process

1. **Read `site.json` first** to get the run metadata, status counts, and page list. Don't load all of `pages/` into
   context. Write small scripts (`node -e`, `jq`) that aggregate across `pages/*.json` and print only the numbers you
   need.
2. **Compute rather than estimate.** Every number in the profile should come from a script over the data: page counts
   per path family, median/p90 text length, requests and bytes per page, distinct third-party hosts × number of pages
   they appear on, distinct cookie (name, domain) pairs and their lifetimes and SameSite values, API call totals per
   API and per calling script.
3. **Get the stack and identifiers from the evidence:** framework from script paths (e.g. `/_next/…` for Next.js),
   hosting from `remoteIPAddress`, CMS from asset hosts, and tag/container IDs (GTM, GA4, ad pixels) and vendor script
   versions from request URLs.
4. **Find the headline.** Look for where the site's stated posture and its observed behavior disagree. A typical
   example: the privacy policy promises consent-based tracking, but ad pixels and session replay fire on first load
   with no CMP traffic. Support each claim with specific evidence: beacon parameters that indicate a first visit,
   `set-cookie` values, `savedCalls` arguments, and quotes from `content.text`.
5. **Check before you flag.** Rule out benign explanations before calling something tracking or fingerprinting. For
   example, first-party `CanvasRenderingContext2D.measureText` calls are usually font metrics. Canvas fingerprinting
   needs pixel reads (`getImageData`/`toDataURL`), so check for those before calling it fingerprinting.
6. **State the caveats.** Spell out what this dataset cannot show (see the limitations below) so readers don't
   over-read an absence.

#### Profile structure

Start with a header block: the run command, start/end timestamps and duration, succeeded/failed/timeout counts, and
the collectors that ran (and which were not enabled). Then:

1. **What the site is.** Purpose, stack, main claims and CTAs, and the one thing that stands out.
2. **Crawl shape.** Page counts by path family, depth, how the budget was spent, link graph facts (edges, orphans,
   nav inflation), and text volume distribution.
3. **Content & structure quality.** `lang`, robots, canonicals, h1 count, heading hierarchy, forms, iframes, images
   and missing `alt` (separate tracking-pixel `<img>` beacons from real images). Use a signal → finding table plus the
   few findings worth flagging.
4. **Behavior.** The core of the profile:
   - 4.1 Third-party inventory (host | pages | role), CMP presence or absence
   - 4.2 Cookies: distinct pairs by party, lifetimes (requested vs persisted), SameSite, session vs persistent
   - 4.3 The headline finding the data supports (e.g. consent-gating)
   - 4.4 JS API access and fingerprinting surface (API | calls | primary caller)
   - 4.5 Detection surface: what bot checks ran against the crawler and whether `notABot` held up
5. **Performance.** Requests and transfer size per page (median/mean/min/max), totals, status code breakdown (e.g.
   204s and 302s often come from tracking beacons and cookie syncs), and what is driving the weight.
6. **Caveats on this dataset.**
7. **Summary.** Two or three paragraphs covering content, behavior and cost.

Style: use tables for inventories and **bold** for the findings a reviewer should act on. Give concrete numbers and
name specific URLs and identifiers. Use cautious wording for inferences ("most likely", "worth confirming").

#### Known limitations to keep in mind (and cite in caveats)

- **Each page is a fresh browser profile.** Because radar launches a new Chrome per page, cookies don't build up across
  the crawl. Cookies and tracker activity on any page are what a first-time visitor to *that URL* triggers. This makes
  per-page consent findings stronger, since every page is a first visit. It also means berg cannot observe
  multi-page session behavior. Don't describe the crawl as one accumulating session.
- **Security headers are not captured.** CSP, HSTS, XFO, Referrer-Policy and similar headers are removed by the
  `RequestCollector` safelist. Don't report header posture unless radar is configured with a wider `saveHeaders`.
- **One snapshot per page.** The DOM and cookies are read once, after load + `--extra-time`. Content fetched later
  (pages that render as near-empty shells, for example) and anything that requires interaction (consent clicks,
  logins, scrolling, lazy loading) is not captured. Don't read a thin snapshot as a thin page.
- **Cookie `expires` is the value after Chrome's 400-day cap.** For the lifetime the site intended, read the
  `Document.cookie setter` arguments in `apis.savedCalls` or the `set-cookie` response headers.
- **Without `cookiepopups` or `screenshots`, "no banner" is an inference** from the absence of CMP traffic and
  CMP-related text in the DOM.
- **Budget skew.** BFS with query strings kept can spend most of the budget on templated or faceted URLs. Report how
  the budget was spent, and recommend a larger `-b` or a different seed when the sample isn't representative.
- **`notABot` is on by default.** API counts include the probes it answered. Fingerprinting and bot-check results
  describe a browser that is hiding its automation, not a plain headless one.
