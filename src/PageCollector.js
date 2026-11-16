const BaseCollector = require('#radar/collectors/BaseCollector');

const PAGE_EXTRACT_SCRIPT = `(() => {
    const title = document.title || '';
    const lang = document.documentElement ? document.documentElement.getAttribute('lang') || '' : '';

    const meta = {};
    const metaTags = document.querySelectorAll('meta[name], meta[property]');
    for (const el of metaTags) {
        const key = el.getAttribute('name') || el.getAttribute('property');
        const value = el.getAttribute('content');
        if (key && value !== null && !meta[key]) {
            meta[key] = value;
        }
    }

    let canonicalUrl = null;
    const canonicalEl = document.querySelector('link[rel="canonical"][href]');
    if (canonicalEl) {
        try {
            canonicalUrl = new URL(canonicalEl.getAttribute('href'), document.baseURI).href;
        } catch {
            canonicalUrl = null;
        }
    }

    const headings = [];
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        const text = (h.innerText || h.textContent || '').trim();
        if (text) {
            headings.push({
                level: Number(h.tagName.slice(1)),
                text: text.slice(0, 500),
            });
        }
    }

    const links = [];
    const seenLinkKeys = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
        const rawHref = a.getAttribute('href') || '';
        let resolvedHref = '';
        try {
            resolvedHref = new URL(rawHref, document.baseURI).href;
        } catch {
            continue;
        }
        const text = (a.innerText || a.textContent || '').trim().slice(0, 300);
        const rel = (a.getAttribute('rel') || '').trim();
        const target = (a.getAttribute('target') || '').trim();
        const key = resolvedHref + '\\0' + text;
        if (!seenLinkKeys.has(key)) {
            seenLinkKeys.add(key);
            links.push({
                href: resolvedHref,
                text,
                rel: rel || undefined,
                target: target || undefined,
            });
        }
    }

    const forms = [];
    for (const form of document.querySelectorAll('form')) {
        let action = '';
        try {
            action = new URL(form.getAttribute('action') || '', document.baseURI).href;
        } catch {
            action = form.getAttribute('action') || '';
        }
        const inputs = [];
        for (const input of form.querySelectorAll('input, select, textarea, button')) {
            inputs.push({
                tag: input.tagName.toLowerCase(),
                type: input.getAttribute('type') || undefined,
                name: input.getAttribute('name') || undefined,
            });
        }
        forms.push({
            action,
            method: (form.getAttribute('method') || 'GET').toUpperCase(),
            inputs,
        });
    }

    const scripts = [];
    for (const s of document.querySelectorAll('script[src]')) {
        try {
            scripts.push(new URL(s.getAttribute('src'), document.baseURI).href);
        } catch {
            // ignore invalid script URL
        }
    }

    const iframes = [];
    for (const f of document.querySelectorAll('iframe[src]')) {
        try {
            iframes.push(new URL(f.getAttribute('src'), document.baseURI).href);
        } catch {
            // ignore invalid iframe URL
        }
    }

    const images = [];
    for (const img of document.querySelectorAll('img[src]')) {
        try {
            images.push({
                src: new URL(img.getAttribute('src'), document.baseURI).href,
                alt: (img.getAttribute('alt') || '').trim().slice(0, 200),
            });
        } catch {
            // ignore invalid image URL
        }
    }

    const bodyText = ((document.body && document.body.innerText) || '').trim();
    const MAX_TEXT = 100000;

    return {
        url: location.href,
        title,
        lang: lang || undefined,
        canonicalUrl,
        meta,
        headings,
        text: bodyText.slice(0, MAX_TEXT),
        textLength: bodyText.length,
        links,
        forms,
        scripts,
        iframes,
        images,
    };
})()`;

class PageCollector extends BaseCollector {
    id() {
        return 'page';
    }

    /**
     * @param {import('#radar/collectors/BaseCollector').CollectorInitOptions} options
     */
    init({ log }) {
        this._log = log;
        /** @type {import('puppeteer-core').CDPSession | null} */
        this._mainSession = null;
        this._mainTargetId = null;
        this._frames = new Map();
    }

    /**
     * @param {import('puppeteer-core').CDPSession} session
     * @param {import('devtools-protocol/types/protocol').Protocol.Target.TargetInfo} targetInfo
     */
    async addTarget(session, targetInfo) {
        if (targetInfo.type === 'page' && !this._mainSession) {
            this._mainSession = session;
            this._mainTargetId = targetInfo.targetId;
            await session.send('Page.enable');
            await session.send('Runtime.enable');
        }
    }

    /**
     * @returns {Promise<PageData | null>}
     */
    async getData() {
        if (!this._mainSession) {
            return null;
        }

        try {
            const evalResult = await this._mainSession.send('Runtime.evaluate', {
                expression: PAGE_EXTRACT_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            });

            if (evalResult.exceptionDetails) {
                this._log(`PageCollector evaluation exception: ${evalResult.exceptionDetails.text}`);
                return null;
            }

            return evalResult.result.value || null;
        } catch (e) {
            this._log(`PageCollector failed: ${e && e.message ? e.message : e}`);
            return null;
        }
    }
}

module.exports = PageCollector;

/**
 * @typedef PageLink
 * @property {string} href
 * @property {string} text
 * @property {string=} rel
 * @property {string=} target
 */

/**
 * @typedef PageData
 * @property {string} url
 * @property {string} title
 * @property {string=} lang
 * @property {string | null} canonicalUrl
 * @property {Object<string, string>} meta
 * @property {Array<{level: number, text: string}>} headings
 * @property {string} text
 * @property {number} textLength
 * @property {PageLink[]} links
 * @property {Array<{action: string, method: string, inputs: Array<{tag: string, type?: string, name?: string}>}>} forms
 * @property {string[]} scripts
 * @property {string[]} iframes
 * @property {Array<{src: string, alt: string}>} images
 */
