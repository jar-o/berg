#!/usr/bin/env node

/**
 * @fileoverview Site crawler built on tracker-radar-collector's crawler and Collector architecture.
 * Starts from a seed URL (--site), follows links that remain on the same site up to a page budget (-b),
 * runs collectors on every page to capture content, relationships, and behaviors, and writes JSON output (-o).
 *
 * Usage:
 *   npx berg --site https://example.com -b 100 -o data/
 */

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const crawl = require('#radar/crawler');
const RequestCollector = require('#radar/collectors/RequestCollector');
const APICallCollector = require('#radar/collectors/APICallCollector');
const CookieCollector = require('#radar/collectors/CookieCollector');
const TargetCollector = require('#radar/collectors/TargetCollector');
const CookiePopupsCollector = require('#radar/collectors/CookiePopupsCollector');
const ScreenshotCollector = require('#radar/collectors/ScreenshotCollector');
const TraceCollector = require('#radar/collectors/TraceCollector');
const { downloadChrome } = require('#radar/helpers/chromiumDownload');
const notABot = require('#radar/helpers/notABot');
const PageCollector = require('./PageCollector');
const { normalizeUrl, isSameSite, createPageFilename } = require('./urlUtils');

/**
 * Map of collector IDs to collector constructors.
 * Includes the repository's built-in behavior/relationship collectors plus PageCollector for DOM content & links.
 */
const COLLECTOR_CLASSES = {
    page: PageCollector,
    requests: RequestCollector,
    apis: APICallCollector,
    cookies: CookieCollector,
    targets: TargetCollector,
    cookiepopups: CookiePopupsCollector,
    screenshots: ScreenshotCollector,
    trace: TraceCollector,
};

const DEFAULT_COLLECTORS = ['page', 'requests', 'apis', 'cookies', 'targets'];

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 */
function parseArgs(argv) {
    program
        .name('berg')
        .description('Site crawler using tracker-radar-collector collectors for content, relationships, and behaviors')
        .requiredOption('-s, --site <url>', 'seed URL to start crawling from')
        .option('-b, --budget <number>', 'maximum number of pages to crawl', '100')
        .requiredOption('-o, --output <path>', 'output directory for JSON files')
        .option(
            '-d, --data-collectors <list>',
            `comma-separated collectors (${Object.keys(COLLECTOR_CLASSES).join(', ')})`,
            DEFAULT_COLLECTORS.join(','),
        )
        .option('-c, --concurrency <number>', 'number of concurrent page crawls', '1')
        .option('--max-load-time <ms>', 'max page load time in ms', '30000')
        .option('--extra-time <ms>', 'extra execution time after load in ms', '2500')
        .option('--no-anti-bot', 'disable anti-bot script injection')
        .option('--only-3p', 'filter requests/APIs to third-party only')
        .option('-v, --verbose', 'verbose crawler logs to stderr')
        .parse(argv);

    return program.opts();
}

/**
 * Instantiate fresh Collector objects for a single page crawl.
 * Matches crawlerConductor's pattern of instantiating a new collector per crawl so state does not leak across pages.
 *
 * @param {string[]} collectorIds
 * @returns {import('#radar/collectors/BaseCollector')[]}
 */
function createCollectors(collectorIds) {
    return collectorIds.map((id) => {
        const CollectorClass = COLLECTOR_CLASSES[id];
        if (!CollectorClass) {
            throw new Error(`Unknown collector "${id}". Valid options: ${Object.keys(COLLECTOR_CLASSES).join(', ')}`);
        }
        return new CollectorClass();
    });
}

/**
 * Build structured content, relationships, and behaviors summary alongside raw collector outputs.
 *
 * @param {import('#radar/crawler').CollectResult} result
 * @param {URL} seedUrl
 */
function buildPageReport(result, seedUrl) {
    const rawData = /** @type {import('#radar/helpers/collectorsList').CollectorData & { page?: import('./PageCollector').PageData }} */ (
        result.data
    );
    const pageData = rawData.page || null;
    const requests = /** @type {import('#radar/collectors/RequestCollector').RequestData[]} */ (result.data.requests || []);
    const targets = /** @type {import('#radar/collectors/TargetCollector').TargetData[]} */ (result.data.targets || []);
    const cookies = /** @type {import('#radar/collectors/CookieCollector').CookieData[]} */ (result.data.cookies || []);
    const apis = /** @type {import('#radar/collectors/APICallCollector').APICallReport | null} */ (result.data.apis || null);

    const internalLinks = [];
    const externalLinks = [];
    if (pageData && Array.isArray(pageData.links)) {
        const seenInternal = new Set();
        const seenExternal = new Set();
        for (const link of pageData.links) {
            const normalized = normalizeUrl(link.href);
            if (!normalized) {
                continue;
            }
            if (isSameSite(seedUrl, normalized)) {
                if (!seenInternal.has(normalized)) {
                    seenInternal.add(normalized);
                    internalLinks.push(normalized);
                }
            } else if (!seenExternal.has(normalized)) {
                seenExternal.add(normalized);
                externalLinks.push(normalized);
            }
        }
    }

    const thirdPartyDomains = new Set();
    for (const req of requests) {
        try {
            const reqUrl = new URL(req.url);
            if (!isSameSite(seedUrl, reqUrl.href)) {
                thirdPartyDomains.add(reqUrl.hostname);
            }
        } catch {
            // ignore non-URL requests
        }
    }

    return {
        initialUrl: result.initialUrl,
        finalUrl: result.finalUrl,
        timeout: result.timeout,
        testStarted: result.testStarted,
        testFinished: result.testFinished,
        content: pageData
            ? {
                  title: pageData.title,
                  lang: pageData.lang,
                  canonicalUrl: pageData.canonicalUrl,
                  meta: pageData.meta,
                  headings: pageData.headings,
                  text: pageData.text,
                  textLength: pageData.textLength,
                  forms: pageData.forms,
                  images: pageData.images,
                  html: pageData.html,
              }
            : null,
        relationships: {
            internalLinks,
            externalLinks,
            scripts: pageData ? pageData.scripts : [],
            iframes: pageData ? pageData.iframes : [],
            targets,
            thirdPartyDomains: Array.from(thirdPartyDomains),
        },
        behaviors: {
            requests,
            cookies,
            apis,
            cookiepopups: result.data.cookiepopups || undefined,
        },
        data: result.data,
    };
}

/**
 * Crawl a site starting from seedUrl, following same-site links via BFS up to budget pages.
 *
 * @param {Object} config
 * @param {URL} config.seedUrl
 * @param {number} config.budget
 * @param {string} config.outputDir
 * @param {string[]} config.collectorIds
 * @param {number} config.concurrency
 * @param {number} config.maxLoadTimeMs
 * @param {number} config.extraExecutionTimeMs
 * @param {boolean} config.antiBot
 * @param {boolean} config.filterOutFirstParty
 * @param {boolean} config.verbose
 */
async function crawlSite({
    seedUrl,
    budget,
    outputDir,
    collectorIds,
    concurrency,
    maxLoadTimeMs,
    extraExecutionTimeMs,
    antiBot,
    filterOutFirstParty,
    verbose,
}) {
    const startTime = Date.now();
    const log = (...msg) => process.stderr.write(`${msg.join(' ')}\n`);

    fs.mkdirSync(outputDir, { recursive: true });
    const pagesDir = path.join(outputDir, 'pages');
    fs.mkdirSync(pagesDir, { recursive: true });

    const executablePath = await downloadChrome(log);

    const normalizedSeed = normalizeUrl(seedUrl.href);
    /** @type {string[]} */
    const queue = [normalizedSeed];
    /** @type {Set<string>} */
    const discovered = new Set([normalizedSeed]);
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {Array<{index: number, url: string, finalUrl: string, file: string, title: string, internalLinksFound: number, status: string, error?: string}>} */
    const sitePages = [];
    /** @type {Array<{from: string, to: string}>} */
    const siteEdges = [];
    /** @type {Set<string>} */
    const seenEdges = new Set();

    let completedCount = 0;

    /**
     * @param {string} targetUrlStr
     * @param {number} pageIndex
     */
    async function crawlSingleUrl(targetUrlStr, pageIndex) {
        const targetUrl = new URL(targetUrlStr);
        log(`[${pageIndex}/${budget}] Crawling ${targetUrlStr} (queued: ${queue.length})`);
        const pageLog = verbose ? (...msg) => log(`  [${pageIndex}]`, ...msg) : () => {};

        try {
            const collectors = createCollectors(collectorIds);
            const result = await crawl(targetUrl, {
                log: pageLog,
                collectors,
                executablePath,
                maxLoadTimeMs,
                extraExecutionTimeMs,
                filterOutFirstParty,
                runInEveryFrame: antiBot ? notABot : undefined,
                collectorFlags: {
                    enableAsyncStacktraces: true,
                    shortTimeouts: false,
                },
            });

            // Track finalUrl as discovered if a redirect landed on another same-site URL
            const normalizedFinal = normalizeUrl(result.finalUrl);
            if (normalizedFinal && isSameSite(seedUrl, normalizedFinal)) {
                discovered.add(normalizedFinal);
            }

            if (result.data.screenshots && typeof result.data.screenshots === 'string') {
                const screenshotName = createPageFilename(pageIndex, targetUrl).replace(/\.json$/, '.jpg');
                const screenshotPath = path.join(pagesDir, screenshotName);
                fs.writeFileSync(screenshotPath, Buffer.from(result.data.screenshots, 'base64'));
                result.data.screenshots = path.relative(outputDir, screenshotPath);
            }

            const pageData = /** @type {any} */ (result.data).page;
            if (pageData && typeof pageData.html === 'string') {
                const htmlName = createPageFilename(pageIndex, targetUrl).replace(/\.json$/, '.html');
                const htmlPath = path.join(pagesDir, htmlName);
                fs.writeFileSync(htmlPath, pageData.html, 'utf8');
                pageData.html = {
                    file: path.relative(outputDir, htmlPath),
                    bytes: Buffer.byteLength(pageData.html, 'utf8'),
                    originalBytes: pageData.htmlOriginalBytes,
                };
                delete pageData.htmlOriginalBytes;
            }

            const report = buildPageReport(result, seedUrl);

            for (const linkUrl of report.relationships.internalLinks) {
                const edgeKey = `${targetUrlStr}\0${linkUrl}`;
                if (!seenEdges.has(edgeKey)) {
                    seenEdges.add(edgeKey);
                    siteEdges.push({ from: targetUrlStr, to: linkUrl });
                }
                if (!discovered.has(linkUrl)) {
                    discovered.add(linkUrl);
                    queue.push(linkUrl);
                }
            }

            const filename = createPageFilename(pageIndex, targetUrl);
            const filePath = path.join(pagesDir, filename);
            fs.writeFileSync(filePath, JSON.stringify(report, null, 2));

            completedCount++;
            sitePages.push({
                index: pageIndex,
                url: targetUrlStr,
                finalUrl: result.finalUrl,
                file: path.relative(outputDir, filePath),
                title: report.content ? report.content.title : '',
                internalLinksFound: report.relationships.internalLinks.length,
                status: result.timeout ? 'timeout' : 'ok',
            });
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            log(`  [${pageIndex}] Failed ${targetUrlStr}: ${message}`);
            sitePages.push({
                index: pageIndex,
                url: targetUrlStr,
                finalUrl: targetUrlStr,
                file: '',
                title: '',
                internalLinksFound: 0,
                status: 'error',
                error: message,
            });
        }
    }

    async function processNextUrl() {
        while (queue.length > 0 && visited.size < budget) {
            const nextUrlStr = queue.shift();
            if (!nextUrlStr || visited.has(nextUrlStr)) {
                continue;
            }
            visited.add(nextUrlStr);
            const pageIndex = visited.size;
            await crawlSingleUrl(nextUrlStr, pageIndex);
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, budget));
    if (workerCount === 1) {
        await processNextUrl();
    } else {
        // Crawl the seed URL first so the link queue is populated before parallel workers start
        const firstUrl = queue.shift();
        if (firstUrl) {
            visited.add(firstUrl);
            await crawlSingleUrl(firstUrl, 1);
        }

        const workers = [];
        for (let i = 0; i < workerCount; i++) {
            workers.push(processNextUrl());
        }
        await Promise.all(workers);
    }

    const endTime = Date.now();
    const summary = {
        seedUrl: seedUrl.href,
        siteHost: seedUrl.hostname,
        budget,
        pagesCrawled: visited.size,
        pagesSucceeded: completedCount,
        pagesFailed: sitePages.filter((p) => p.status === 'error').length,
        collectors: collectorIds,
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date(endTime).toISOString(),
        durationMs: endTime - startTime,
        pages: sitePages.sort((a, b) => a.index - b.index),
        graph: {
            edges: siteEdges,
        },
    };

    fs.writeFileSync(path.join(outputDir, 'site.json'), JSON.stringify(summary, null, 2));
    log(
        `Done. Crawled ${visited.size} page(s) (${completedCount} succeeded) in ${((endTime - startTime) / 1000).toFixed(1)}s. Output: ${outputDir}`,
    );

    return summary;
}

if (require.main === module) {
    const opts = parseArgs(process.argv);

    let seedUrl;
    try {
        seedUrl = new URL(opts.site);
    } catch {
        process.stderr.write(`Invalid --site URL: ${opts.site}\n`);
        process.exit(1);
    }

    if (seedUrl.protocol !== 'http:' && seedUrl.protocol !== 'https:') {
        process.stderr.write(`--site URL must use http or https: ${opts.site}\n`);
        process.exit(1);
    }

    const budget = Number(opts.budget);
    if (!Number.isInteger(budget) || budget < 1) {
        process.stderr.write(`Invalid --budget (-b) value: ${opts.budget}. Must be a positive integer.\n`);
        process.exit(1);
    }

    const collectorIds = opts.dataCollectors
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    // Validate collector IDs up front before launching browser
    createCollectors(collectorIds);

    crawlSite({
        seedUrl,
        budget,
        outputDir: path.resolve(opts.output),
        collectorIds,
        concurrency: Number(opts.concurrency) || 1,
        maxLoadTimeMs: Number(opts.maxLoadTime) || 30000,
        extraExecutionTimeMs: Number(opts.extraTime) || 2500,
        antiBot: opts.antiBot !== false,
        filterOutFirstParty: Boolean(opts.only3p),
        verbose: Boolean(opts.verbose),
    }).catch((err) => {
        process.stderr.write(`Site crawl failed: ${err && err.stack ? err.stack : err}\n`);
        process.exit(1);
    });
}

module.exports = {
    crawlSite,
    buildPageReport,
    createCollectors,
    COLLECTOR_CLASSES,
    DEFAULT_COLLECTORS,
};
