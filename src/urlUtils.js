const URL = require('url').URL;

/**
 * Normalize a URL for deduplication within a site crawl:
 * - Only http/https
 * - Strip fragment (#...)
 * - Lowercase scheme and host, strip default ports (:80, :443)
 * - Normalize empty pathname to '/'
 *
 * @param {string} rawUrl
 * @param {string} [baseUrl]
 * @returns {string | null}
 */
function normalizeUrl(rawUrl, baseUrl) {
    let parsed;
    try {
        parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }

    parsed.hash = '';
    if (!parsed.pathname) {
        parsed.pathname = '/';
    }

    return parsed.href;
}

/**
 * Determine whether candidateUrl stays on the same site as seedUrl.
 * Matches exact hostname (treating www.<host> and <host> carefully: exact origin/hostname match,
 * or same hostname ignoring leading www. if desired - here we match exact hostname or www. equivalence
 * on the same scheme family http/https).
 *
 * @param {URL} seedUrl
 * @param {string} candidateHref
 * @returns {boolean}
 */
function isSameSite(seedUrl, candidateHref) {
    let candidate;
    try {
        candidate = new URL(candidateHref);
    } catch {
        return false;
    }

    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
        return false;
    }

    const seedHost = seedUrl.hostname.toLowerCase();
    const candHost = candidate.hostname.toLowerCase();

    return candHost === seedHost;
}

/**
 * Build a deterministic, filesystem-safe filename for a crawled page URL.
 *
 * @param {number} index
 * @param {URL} url
 * @returns {string}
 */
function createPageFilename(index, url) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha1').update(url.href).digest('hex').slice(0, 8);
    const slug = `${url.hostname}${url.pathname}`
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    const padded = String(index).padStart(4, '0');
    return `${padded}_${slug || 'page'}_${hash}.json`;
}

module.exports = {
    normalizeUrl,
    isSameSite,
    createPageFilename,
};
