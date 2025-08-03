const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');
const querystring = require('querystring');

// Configuration
const CONFIG = {
  whitelistPatterns: [], // Add regex patterns for allowed URLs, e.g., [/^https?:\/\/([a-z0-9-]+\.)*example\.net/i]
  blacklistPatterns: [], // Add regex patterns for blocked URLs
  forceCORS: false,
  disallowLocal: true,
  anonymize: true,
  startURL: '',
  landingExampleURL: 'https://example.net'
};

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Helper function to validate URLs
function isValidURL(requestUrl) {
  // Whitelist check
  const passesWhitelist = CONFIG.whitelistPatterns.length === 0 || 
    CONFIG.whitelistPatterns.some(pattern => pattern.test(requestUrl));

  // Blacklist check
  const passesBlacklist = !CONFIG.blacklistPatterns.some(pattern => pattern.test(requestUrl));

  // Local network check
  const isLocal = (url) => {
    try {
      const { hostname } = new URL(url);
      if (!hostname) return false;
      
      // Simple IP check (Node.js doesn't have direct DNS resolution like PHP's dns_get_record)
      const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
      if (ipRegex.test(hostname)) {
        // Check for private/reserved IP ranges
        const privateRanges = [
          /^10\./,
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
          /^192\.168\./,
          /^127\./
        ];
        return privateRanges.some(range => range.test(hostname));
      }
      return false;
    } catch {
      return false;
    }
  };

  return passesWhitelist && passesBlacklist && (!CONFIG.disallowLocal || !isLocal(requestUrl));
}

// Helper function to convert relative URLs to absolute
function rel2abs(rel, base) {
  try {
    if (!rel) return base;
    if (/^(?:[a-z]+:)?\/\//i.test(rel) || rel.startsWith('data:')) return rel;
    if (rel.startsWith('#') || rel.startsWith('?')) return base + rel;
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

// Proxify CSS url() references
function proxifyCSS(css, baseURL) {
  return css.replace(/url\((.*?)\)/gi, (match, p1) => {
    let url = p1.trim().replace(/^['"]|['"]$/g, '');
    if (url.startsWith('data:')) return match;
    return `url("${process.env.VERCEL_URL || 'https://your-vercel-app.vercel.app'}/api/proxy?url=${encodeURIComponent(rel2abs(url, baseURL))}")`;
  });
}

// Proxify srcset attributes
function proxifySrcset(srcset, baseURL) {
  const sources = srcset.split(',').map(s => s.trim());
  const proxifiedSources = sources.map(source => {
    const [url, ...rest] = source.split(' ').map(s => s.trim());
    if (!url) return source;
    return `${process.env.VERCEL_URL || 'https://your-vercel-app.vercel.app'}/api/proxy?url=${encodeURIComponent(rel2abs(url, baseURL))} ${rest.join(' ')}`;
  });
  return proxifiedSources.join(', ');
}

// Main proxy handler
app.all('/proxy', async (req, res) => {
  let targetURL;

  // Handle form submissions and query parameters
  if (req.method === 'POST' && req.body.miniProxyFormAction) {
    targetURL = req.body.miniProxyFormAction;
  } else {
    const queryParams = { ...req.query };
    if (queryParams.miniProxyFormAction) {
      targetURL = queryParams.miniProxyFormAction;
      delete queryParams.miniProxyFormAction;
      targetURL += Object.keys(queryParams).length ? `?${querystring.stringify(queryParams)}` : '';
    } else {
      targetURL = req.query.url || CONFIG.startURL;
    }
  }

  // Show landing page if no URL is provided
  if (!targetURL) {
    res.send(`
      <html>
        <head><title>Node.js Proxy</title></head>
        <body>
          <h1>Welcome to Node.js Proxy!</h1>
          <p>Enter a URL to proxy:</p>
          <form action="/api/proxy" method="POST">
            <input type="text" name="miniProxyFormAction" size="50" />
            <input type="submit" value="Proxy It!" />
          </form>
        </body>
      </html>
    `);
    return;
  }

  // Normalize URL
  if (!/^https?:\/\//i.test(targetURL)) {
    targetURL = `http://${targetURL}`;
  }

  if (!isValidURL(targetURL)) {
    res.status(403).send('Error: The requested URL was disallowed by the server administrator.');
    return;
  }

  try {
    // Make the request
    const headers = {
      'User-Agent': req.get('User-Agent') || 'Mozilla/5.0 (compatible; NodeProxy)',
      ...Object.fromEntries(
        Object.entries(req.headers).filter(([key]) => !['host', 'content-length', 'accept-encoding'].includes(key.toLowerCase()))
      )
    };

    if (!CONFIG.anonymize) {
      headers['X-Forwarded-For'] = req.ip;
    }

    const response = await axios({
      method: req.method,
      url: targetURL,
      headers,
      data: req.method === 'POST' ? req.body : undefined,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true
    });

    // Set response headers
    const blacklistedHeaders = /^(content-length|transfer-encoding|content-encoding.*gzip)/i;
    Object.entries(response.headers).forEach(([key, value]) => {
      if (!blacklistedHeaders.test(key)) {
        res.set(key, value);
      }
    });

    res.set('X-Robots-Tag', 'noindex, nofollow');

    if (CONFIG.forceCORS) {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true'
      });
      if (req.method === 'OPTIONS') {
        if (req.get('Access-Control-Request-Method')) {
          res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        }
        if (req.get('Access-Control-Request-Headers')) {
          res.set('Access-Control-Allow-Headers', req.get('Access-Control-Request-Headers'));
        }
        return res.status(200).end();
      }
    }

    // Handle different content types
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.data.toString('utf-8'));

      // Rewrite forms
      $('form').each((i, form) => {
        const action = $(form).attr('action') || targetURL;
        $(form).attr('action', '/api/proxy');
        $(form).append(`<input type="hidden" name="miniProxyFormAction" value="${rel2abs(action, targetURL)}">`);
      });

      // Rewrite meta refresh tags
      $('meta[http-equiv="refresh"]').each((i, meta) => {
        const content = $(meta).attr('content');
        if (content) {
          const [time, urlPart] = content.split('=');
          if (urlPart) {
            $(meta).attr('content', `${time}=${(process.env.VERCEL_URL || 'https://your-vercel-app.vercel.app')}/api/proxy?url=${encodeURIComponent(rel2abs(urlPart, targetURL))}`);
          }
        }
      });

      // Proxify style tags and attributes
      $('style').each((i, style) => {
        $(style).text(proxifyCSS($(style).text(), targetURL));
      });
      $('[style]').each((i, elem) => {
        $(elem).attr('style', proxifyCSS($(elem).attr('style'), targetURL));
      });

      // Proxify img srcset
      $('img[srcset]').each((i, img) => {
        $(img).attr('srcset', proxifySrcset($(img).attr('srcset'), targetURL));
      });

      // Proxify href and src attributes
      ['href', 'src'].forEach(attr => {
        $(`[${attr}]`).each((i, elem) => {
          const attrValue = $(elem).attr(attr);
          if (attr === 'href' && /^(about|javascript|magnet|mailto):|#/i.test(attrValue)) return;
          if (attr === 'src' && /^data:/i.test(attrValue)) return;
          $(elem).attr(attr, `${(process.env.VERCEL_URL || 'https://your-vercel-app.vercel.app')}/api/proxy?url=${encodeURIComponent(rel2abs(attrValue, targetURL))}`);
        });
      });

      // Add AJAX proxy script
      const proxyScript = `
        <script>
          (function() {
            if (window.XMLHttpRequest) {
              function parseURI(url) {
                var m = String(url).replace(/^\\s+|\\s+$/g, "").match(/^([^:\\/?#]+:)?(\\/\\/(?:[^:@]*(?::[^:@]*)?@)?(([^:\\/?#]*)(?::(\\d*))?))?([^\?#]*)(\\?[^#]*)?(#[\\s\\S]*)?/);
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
                  input.replace(/^(\\.\\.?(\\/|$))+/, "")
                    .replace(/\\/(\\.(?:\\/|$))+/g, "/")
                    .replace(/\\/\\.\\.$/, "/../")
                    .replace(/\\/?[^\\/]*/g, function(p) {
                      if (p === "/..") output.pop();
                      else output.push(p);
                    });
                  return output.join("").replace(/^\\/\\//, input.charAt(0) === "/" ? "/" : "");
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
                  if (!url.includes("${(process.env.VERCEL_URL || 'https://your-vercel-app.vercel.app')}/api/proxy")) {
                    url = "${(process.env.VERCEL_URL || 'https://your-vercel-app.vercel.app')}/api/proxy?url=" + encodeURIComponent(url);
                  }
                  arguments[1] = url;
                }
                return proxied.apply(this, [].slice.call(arguments));
              };
            }
          })();
        </script>
      `;
      $('head, body').first().prepend(proxyScript);

      res.send($.html());
    } else if (contentType.includes('text/css')) {
      res.send(proxifyCSS(response.data.toString('utf-8'), targetURL));
    } else {
      res.set('Content-Length', response.data.length);
      res.send(response.data);
    }
  } catch (error) {
    res.status(500).send(`Error fetching URL: ${error.message}`);
  }
});

module.exports = app;
