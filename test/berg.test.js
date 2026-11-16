const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { normalizeUrl, isSameSite, createPageFilename } = require('../src/urlUtils');
const { buildPageReport, crawlSite, createCollectors } = require('../src/berg');
const PageCollector = require('../src/PageCollector');

async function testUrlUtils() {
    assert.strictEqual(normalizeUrl('https://example.com/path#section'), 'https://example.com/path');
    assert.strictEqual(normalizeUrl('/about?q=1#top', 'https://example.com/dir/page'), 'https://example.com/about?q=1');
    assert.strictEqual(normalizeUrl('mailto:user@example.com'), null);
    assert.strictEqual(normalizeUrl('javascript:void(0)'), null);

    const seed = new URL('https://example.com/');
    assert.strictEqual(isSameSite(seed, 'https://example.com/other'), true);
    assert.strictEqual(isSameSite(seed, 'http://example.com/other'), true);
    assert.strictEqual(isSameSite(seed, 'https://sub.example.com/'), false);
    assert.strictEqual(isSameSite(seed, 'https://other.org/'), false);

    const filename = createPageFilename(1, new URL('https://example.com/a/b'));
    assert(filename.startsWith('0001_example_com_a_b_'));
    assert(filename.endsWith('.json'));
}

async function testCreateCollectors() {
    const first = createCollectors(['page', 'requests', 'cookies', 'targets']);
    const second = createCollectors(['page', 'requests', 'cookies', 'targets']);
    assert.strictEqual(first.length, 4);
    assert(first[0] instanceof PageCollector);
    assert.notStrictEqual(first[0], second[0]);
    assert.throws(() => createCollectors(['unknown-collector']), /Unknown collector/);
}

async function testBuildPageReport() {
    const seed = new URL('https://example.com/');
    const report = buildPageReport(
        /** @type {any} */ ({
            initialUrl: 'https://example.com/',
            finalUrl: 'https://example.com/',
            timeout: false,
            testStarted: 1000,
            testFinished: 2000,
            data: {
                page: {
                    url: 'https://example.com/',
                    title: 'Example',
                    canonicalUrl: null,
                    meta: {},
                    headings: [{ level: 1, text: 'Hello' }],
                    text: 'Hello',
                    textLength: 5,
                    links: [
                        { href: 'https://example.com/about#frag', text: 'About' },
                        { href: 'https://example.com/about', text: 'About Again' },
                        { href: 'https://thirdparty.net/x', text: 'Ext' },
                    ],
                    forms: [],
                    scripts: ['https://cdn.thirdparty.net/app.js'],
                    iframes: [],
                    images: [],
                },
                requests: [
                    { url: 'https://example.com/', method: 'GET', type: 'Document' },
                    { url: 'https://cdn.thirdparty.net/app.js', method: 'GET', type: 'Script' },
                ],
                cookies: [{ name: 'sid', domain: 'example.com', path: '/', session: true }],
                targets: [{ type: 'page', url: 'https://example.com/' }],
                apis: { callStats: {}, savedCalls: [] },
            },
        }),
        seed,
    );

    assert.strictEqual(report.content.title, 'Example');
    assert.deepStrictEqual(report.relationships.internalLinks, ['https://example.com/about']);
    assert.deepStrictEqual(report.relationships.externalLinks, ['https://thirdparty.net/x']);
    assert.deepStrictEqual(report.relationships.thirdPartyDomains, ['cdn.thirdparty.net']);
    assert.strictEqual(report.behaviors.requests.length, 2);
    assert.strictEqual(report.behaviors.cookies.length, 1);
}

async function testCrawlSiteRespectsBudgetAndSiteBoundary() {
    const pages = {
        '/': '<html><head><title>Seed</title></head><body><a href="/p1">P1</a><a href="/p2">P2</a><a href="https://offsite.invalid/away">Away</a></body></html>',
        '/p1': '<html><head><title>Page 1</title></head><body><a href="/p3">P3</a><a href="/">Back</a></body></html>',
        '/p2': '<html><head><title>Page 2</title></head><body><p>Two</p></body></html>',
        '/p3': '<html><head><title>Page 3</title></head><body><p>Three</p></body></html>',
    };

    const server = http.createServer((req, res) => {
        const html = pages[req.url];
        if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'berg-unit-'));

    try {
        // Test exhausting all pages on site when budget > total pages
        const fullSummary = await crawlSite({
            seedUrl: new URL(`http://127.0.0.1:${port}/`),
            budget: 10,
            outputDir: outDir,
            collectorIds: ['page', 'requests', 'targets'],
            concurrency: 1,
            maxLoadTimeMs: 15000,
            extraExecutionTimeMs: 200,
            antiBot: false,
            filterOutFirstParty: false,
            verbose: false,
        });

        assert.strictEqual(fullSummary.pagesCrawled, 4);
        assert.strictEqual(fullSummary.pagesSucceeded, 4);
        assert(fs.existsSync(path.join(outDir, 'site.json')));

        // Test stopping at budget when budget < total pages
        const outDirBudget = fs.mkdtempSync(path.join(os.tmpdir(), 'berg-budget-'));
        try {
            const budgetSummary = await crawlSite({
                seedUrl: new URL(`http://127.0.0.1:${port}/`),
                budget: 2,
                outputDir: outDirBudget,
                collectorIds: ['page', 'requests', 'targets'],
                concurrency: 1,
                maxLoadTimeMs: 15000,
                extraExecutionTimeMs: 200,
                antiBot: false,
                filterOutFirstParty: false,
                verbose: false,
            });
            assert.strictEqual(budgetSummary.pagesCrawled, 2);
            assert.strictEqual(budgetSummary.pagesSucceeded, 2);
        } finally {
            fs.rmSync(outDirBudget, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
        server.close();
    }
}

async function main() {
    await testUrlUtils();
    await testCreateCollectors();
    await testBuildPageReport();
    await testCrawlSiteRespectsBudgetAndSiteBoundary();
    console.log('All berg tests passed!');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
