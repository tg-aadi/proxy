const axios = require('axios');
const cheerio = require('cheerio');
const css = require('css');
const url = require('url');
const dns = require('dns').promises;
const { networkInterfaces } = require('os');

// Configuration
const whitelistPatterns = [];
const blacklistPatterns = [];
const forceCORS = false;
const disallowLocal = true;
const anonymize = true;
const startURL = '';
const landingExampleURL = 'https://example.net';

// Helper function to generate hostname regex pattern
function getHostnamePattern(hostname) {
    const escapedHostname = hostname.replace(/\./g, '\\.');
    return new RegExp(`^https?://([a-z0-9-]+\\.)*${escapedHostname}`, 'i');
}

// Validate URL against whitelist, blacklist, and local restrictions
async function isValidURL(inputUrl) {
    function passesWhitelist(inputUrl) {
        if (whitelistPatterns.length === 0) return true;
        return whitelistPatterns.some(pattern => pattern.test(inputUrl));
    }

    function passesBlacklist(inputUrl) {
        return !blacklistPatterns.some(pattern => pattern.test(inputUrl));
    }

    async function isLocal(inputUrl) {
        const parsed = new URL(inputUrl);
        const host = parsed.hostname;
        let ips = [];
        if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host) || /^[\da-fA-F:]+$/.test(host)) {
            ips = [host];
        } else {
            try {
                const records = await dns.resolve(host);
                ips = records;
                const records6 = await dns.resolve6(host).catch(() => []);
                ips = [...ips, ...records6];
            } catch (e) {
                return false;
            }
        }
        return ips.some(ip => {
            const bytes = ip.includes(':') ? ip.split(':').map(x => parseInt(x, 16)) : ip.split('.').map(Number);
            if (ip.includes(':')) {
                return (
                    (bytes[0] === 0xFD00 || bytes[0] === 0xFC00) || // Unique Local
                    (bytes[0] === 0xFE80) // Link-Local
                );
            }
            return (
                (bytes[0] === 10) || // Private
                (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
                (bytes[0] === 192 && bytes[1] === 168) ||
                (bytes[0] === 169 && bytes[1] === 254) // Link-Local
            );
        });
    }

    return passesWhitelist(inputUrl) && passesBlacklist(inputUrl) && (disallowLocal ? !(await isLocal(inputUrl)) : true);
}

// Convert relative URLs to absolute
function rel2abs(rel, base) {
    if (!rel) rel = '.';
    if (url.parse(rel).protocol || rel.startsWith('//')) return rel;
    if (rel[0] === '#' || rel[0] === '?') return base + rel;
    const parsedBase = url.parse(base);
    let path = parsedBase.pathname || '/';
    path = path.replace(/\/[^\/]*$/, '');
    if (rel[0] === '/') path = '';
    const port = parsedBase.port && parsedBase.port != '80' ? `:${parsedBase.port}` : '';
    const auth = parsedBase.auth ? `${parsedBase.auth}@` : '';
    let abs = `${auth}${parsedBase.host}${port}${path}/${rel}`;
    while (abs.match(/\/\.?\//) || abs.match(/\/(?!\.\.)[^\/]+\/\.\.\//)) {
        abs = abs.replace(/\/\.?\//g, '/').replace(/\/(?!\.\.)[^\/]+\/\.\.\//g, '/');
    }
    return `${parsedBase.protocol}//${abs}`;
}

// Proxify CSS url() references
function proxifyCSS(cssText, baseURL, proxyPrefix) {
    const ast = css.parse(cssText);
    function proxifyURL(urlStr) {
        urlStr = urlStr.replace(/^['"]|['"]$/g, '');
        if (urlStr.startsWith('data:')) return urlStr;
        return `${proxyPrefix}${rel2abs(urlStr, baseURL)}`;
    }
    ast.stylesheet.rules.forEach(rule => {
        if (rule.type === 'rule' || rule.type === 'font-face') {
            rule.declarations.forEach(decl => {
                if (decl.property === 'background' || decl.property === 'background-image' || decl.property.includes('src')) {
                    decl.value = decl.value.replace(/url\((.*?)\)/g, (match, urlStr) => `url(${proxifyURL(urlStr)})`);
                }
            });
        } else if (rule.type === 'import') {
            rule.import = rule.import.replace(/^['"]|['"]$/g, '');
            rule.import = `"${proxifyURL(rule.import)}"`;
        }
    });
    return css.stringify(ast);
}

// Proxify srcset attributes
function proxifySrcset(srcset, baseURL, proxyPrefix) {
    const sources = srcset.split(',').map(s => s.trim());
    const proxifiedSources = sources.map(source => {
        const components = source.split(' ').map(s => s.trim());
        if (components[0]) {
            components[0] = `${proxyPrefix}${rel2abs(components[0], baseURL)}`;
        }
        return components.join(' ');
    });
    return proxifiedSources.join(', ');
}

// Main handler
module.exports = async (req, res) => {
    // Define PROXY_PREFIX
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['host'];
    const proxyPrefix = `${protocol}://${host}/api/miniproxy?url=`;

    // Handle URL extraction
    let targetURL = '';
    if (req.method === 'POST' && req.body && req.body.miniProxyFormAction) {
        targetURL = req.body.miniProxyFormAction;
    } else if (req.query.url) {
        targetURL = req.query.url;
    } else {
        targetURL = req.url.replace(/^\/api\/miniproxy\?url=/, '');
    }

    if (!targetURL) {
        if (!startURL) {
            res.setHeader('Content-Type', 'text/html; charset=UTF-8');
            return res.end(`
                <html>
                    <head><title>miniProxy</title></head>
                    <body>
                        <h1>Welcome to miniProxy!</h1>
                        Invoke like: <a href="${proxyPrefix}${landingExampleURL}">${proxyPrefix}${landingExampleURL}</a><br /><br />
                        Or enter a URL:<br /><br />
                        <form onsubmit="if (document.getElementById('site').value) { window.location.href='${proxyPrefix}' + document.getElementById('site').value; return false; } else { window.location.href='${proxyPrefix}${landingExampleURL}'; return false; }" autocomplete="off">
                            <input id="site" type="text" size="50" /><input type="submit" value="Proxy It!" />
                        </form>
                    </body>
                </html>
            `);
        } else {
            targetURL = startURL;
        }
    }

    if (targetURL.includes(':/') && !targetURL.includes('://')) {
        targetURL = targetURL.replace(':/', '://');
    }

    const parsedURL = url.parse(targetURL);
    if (!parsedURL.protocol) {
        targetURL = targetURL.startsWith('//') ? `http:${targetURL}` : `http://${targetURL}`;
    } else if (!/^https?$/i.test(parsedURL.protocol.replace(':', ''))) {
        res.status(400).json({ error: 'Only http[s] URLs are supported.' });
        return;
    }

    if (!(await isValidURL(targetURL))) {
        res.status(403).json({ error: 'The requested URL was disallowed.' });
        return;
    }

    // Make HTTP request
    const headers = { ...req.headers };
    delete headers['accept-encoding'];
    delete headers['content-length'];
    delete headers['host'];
    delete headers['origin'];
    if (!anonymize) {
        headers['x-forwarded-for'] = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    }
    if (headers['origin']) {
        const parsed = url.parse(targetURL);
        headers['origin'] = `${parsed.protocol}//${parsed.host}`;
    }
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (compatible; miniProxy)';

    try {
        const response = await axios({
            method: req.method,
            url: targetURL,
            headers,
            data: req.method === 'POST' || req.method === 'PUT' ? req.body : undefined,
            maxRedirects: 5,
            responseType: 'arraybuffer',
        });

        // Forward headers
        const headerBlacklist = /^(content-length|transfer-encoding|content-encoding.*gzip)/i;
        Object.entries(response.headers).forEach(([key, value]) => {
            if (!headerBlacklist.test(key)) {
                res.setHeader(key, value);
            }
        });
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');

        if (forceCORS) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            if (req.method === 'OPTIONS') {
                if (req.headers['access-control-request-method']) {
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                }
                if (req.headers['access-control-request-headers']) {
                    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
                }
                return res.status(200).end();
            }
        }

        const contentType = response.headers['content-type'] || '';
        const responseBody = response.data.toString('utf8');

        if (contentType.includes('text/html')) {
            const $ = cheerio.load(responseBody);

            // Rewrite forms
            $('form').each((i, form) => {
                const action = $(form).attr('action') || targetURL;
                $(form).attr('action', proxyPrefix.replace(/\?url=$/, ''));
                $(form).append(`<input type="hidden" name="miniProxyFormAction" value="${action}">`);
            });

            // Rewrite meta refresh tags
            $('meta[http-equiv="refresh"]').each((i, meta) => {
                const content = $(meta).attr('content');
                if (content) {
                    const splitContent = content.split('=');
                    if (splitContent[1]) {
                        $(meta).attr('content', `${splitContent[0]}=${proxyPrefix}${rel2abs(splitContent[1], targetURL)}`);
                    }
                }
            });

            // Proxify style tags
            $('style').each((i, style) => {
                $(style).text(proxifyCSS($(style).text(), targetURL, proxyPrefix));
            });

            // Proxify style attributes
            $('[style]').each((i, el) => {
                $(el).attr('style', proxifyCSS($(el).attr('style'), targetURL, proxyPrefix));
            });

            // Proxify srcset attributes
            $('img[srcset]').each((i, img) => {
                $(img).attr('srcset', proxifySrcset($(img).attr('srcset'), targetURL, proxyPrefix));
            });

            // Proxify href and src attributes
            ['href', 'src'].forEach(attr => {
                $(`[${attr}]`).each((i, el) => {
                    const attrContent = $(el).attr(attr);
                    if (attr === 'href' && /^(about|javascript|magnet|mailto):|#/i.test(attrContent)) return;
                    if (attr === 'src' && /^data:/i.test(attrContent)) return;
                    $(el).attr(attr, `${proxyPrefix}${rel2abs(attrContent, targetURL)}`);
                });
            });

            // Inject AJAX proxy script
            const script = `
                <script>
                    (function() {
                        if (window.XMLHttpRequest) {
                            function parseURI(url) {
                                var m = String(url).replace(/^\\s+|\\s+$/g, "").match(/^([^:\\/?#]+:)?(\\/\\/(?:[^:@]*(?::[^:@]*)?@)?(([^:\\/?#]*)(?::(\\d*))?))?([^?#]*)(\\?[^#]*)?(#[\\s\\S]*)?/);
                                return (m ? {
                                    href: m[0] || "",
                                    protocol: m[1] || "",
                                    authority: m[2] || "",
                                    host: m[3] || "",
                                    hostname: m[4] || "",
                                    port: m[5] || "",
                                    pathname: m[6] || "",
                                    search: m[7] || "",
                                    hash: m[8] || ""
                                } : null);
                            }
                            function rel2abs(base, href) {
                                function removeDotSegments(input) {
                                    var output = [];
                                    input.replace(/^(\\.\.?(?:\\/|$))+/, "")
                                        .replace(/\\/(\\.(\\/|$))+/g, "/")
                                        .replace(/\\/\\.\\.$/, "/../")
                                        .replace(/\\/?[^\/]*/g, function(p) {
                                            if (p === "/..") output.pop();
                                            else output.push(p);
                                        });
                                    return output.join("").replace(/^\\//, input.charAt(0) === "/" ? "/" : "");
                                }
                                href = parseURI(href || "");
                                base = parseURI(base || "");
                                return !href || !base ? null : (href.protocol || base.protocol) +
                                    (href.protocol || href.authority ? href.authority : base.authority) +
                                    removeDotSegments(href.protocol || href.authority || href.pathname.charAt(0) === "/" ? href.pathname : (href.pathname ? ((base.authority && !base.pathname ? "/" : "") + base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1) + href.pathname) : base.pathname)) +
                                    (href.protocol || href.authority || href.pathname ? href.search : (href.search || base.search)) +
                                    href.hash;
                            }
                            var proxied = window.XMLHttpRequest.prototype.open;
                            window.XMLHttpRequest.prototype.open = function() {
                                if (arguments[1] !== null && arguments[1] !== undefined) {
                                    var url = arguments[1];
                                    url = rel2abs("${targetURL}", url);
                                    if (url.indexOf("${proxyPrefix}") === -1) {
                                        url = "${proxyPrefix}" + url;
                                    }
                                    arguments[1] = url;
                                }
                                return proxied.apply(this, [].slice.call(arguments));
                            };
                        }
                    })();
                </script>
            `;
            if ($('head').length) {
                $('head').prepend(script);
            } else if ($('body').length) {
                $('body').prepend(script);
            }

            res.setHeader('Content-Type', 'text/html; charset=UTF-8');
            return res.end(`<!-- Proxified page constructed by miniProxy -->\n${$.html()}`);
        } else if (contentType.includes('text/css')) {
            res.setHeader('Content-Type', 'text/css; charset=UTF-8');
            return res.end(proxifyCSS(responseBody, targetURL, proxyPrefix));
        } else {
            res.setHeader('Content-Length', Buffer.byteLength(response.data));
            return res.end(response.data);
        }
    } catch (error) {
        res.status(500).json({ error: `Request failed: ${error.message}` });
    }
};
