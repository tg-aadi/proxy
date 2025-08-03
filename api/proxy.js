const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const url = require('url');
const path = require('path');

const app = express();
app.use(express.raw({ type: '*/*' }));

// Define PROXY_PREFIX based on server configuration
const getProxyPrefix = (req) => {
  const protocol = req.protocol;
  const host = req.get('host');
  const scriptPath = 'api/proxy.js'; // Adjusted for Vercel API route
  return `${protocol}://${host}/${scriptPath}/`;
};

// Validate URL
const isValidUrl = (string) => {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
};

// Convert relative URLs to absolute URLs
function rel2abs(rel, base) {
  if (!rel) rel = '.';
  if (/^([a-zA-Z]+:)|(^\/\/)/.test(rel)) return rel;
  if (rel.startsWith('#') || rel.startsWith('?')) return base + rel;

  const parsedBase = new URL(base);
  let { protocol, hostname, port, pathname } = parsedBase;

  pathname = pathname.replace(/\/[^\/]*$/, '') || '/';
  if (rel.startsWith('/')) pathname = '';

  port = port && port !== '80' ? `:${port}` : '';
  let auth = '';
  if (parsedBase.username) {
    auth = parsedBase.username;
    if (parsedBase.password) auth += `:${parsedBase.password}`;
    auth += '@';
  }

  let abs = `${auth}${hostname}${pathname}${port}/${rel}`;
  while (abs.match(/\/\.?\//) || abs.match(/\/(?!\.\.)[^\/]+\/\.\.\//)) {
    abs = abs.replace(/\/\.?\//g, '/').replace(/\/(?!\.\.)[^\/]+\/\.\.\//g, '/');
  }

  return `${protocol}//${abs}`;
}

// Proxify CSS url() references
function proxifyCSS(css, baseURL, proxyPrefix) {
  return css.replace(/url\((.*?)\)/gi, (match, url) => {
    url = url.trim().replace(/^['"]|['"]$/g, '');
    if (url.startsWith('data:')) return `url(${url})`;
    return `url(${proxyPrefix}${rel2abs(url, baseURL)})`;
  });
}

// Make HTTP request with timeout
async function makeRequest(targetUrl, req) {
  if (!isValidUrl(targetUrl)) {
    throw new Error('Invalid URL');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];
  delete headers['accept-encoding'];
  const userAgent = req.get('user-agent') || 'Mozilla/5.0 (compatible; NodeProxy)';
  headers['user-agent'] = userAgent;

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['POST', 'PUT'].includes(req.method) ? req.body : undefined,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const responseHeaders = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    const body = await response.text();
    if (Buffer.byteLength(body) > 4.5 * 1024 * 1024) {
      throw new Error('Response body exceeds 4.5 MB limit');
    }
    return {
      headers: responseHeaders,
      body,
      responseInfo: {
        content_type: response.headers.get('content-type') || '',
        status: response.status,
      },
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw new Error(`Fetch failed: ${error.message}`);
  }
}

// Main proxy route
app.all('/*', async (req, res) => {
  try {
    let targetUrl = req.url.slice(1);
    const proxyPrefix = getProxyPrefix(req);

    // Handle empty URL
    if (!targetUrl) {
      return res.send(`
        <html>
          <head>
            <script src="https://code.jquery.com/jquery-2.1.3.min.js"></script>
            <title>Test Widget</title>
          </head>
          <body>
            <form id="proxyForm" action="${proxyPrefix}google.ru">
              <input id="site" type="text" style="visibility: hidden;" />
              <input id="but1" type="submit" value="" style="visibility: hidden;" />
            </form>
            <script>
              $(document).ready(() => $('#but1').click());
            </script>
          </body>
        </html>
      `);
    }

    // Normalize URL
    if (targetUrl.startsWith('//')) targetUrl = `http:${targetUrl}`;
    if (!/^.*:\/\//.test(targetUrl)) targetUrl = `http://${targetUrl}`;

    // Make request
    const response = await makeRequest(targetUrl, req);
    let { headers, body, responseInfo } = response;

    // Append widget code
    const addWidget = `
      <link rel='stylesheet' href='http://cdn.rocketcallback.com/style/tracker_css/static.css'>
      <link rel='stylesheet' href='http://cdn.rocketcallback.com/style/tracker_css/user_css/b859tfSadN.css'>
      <script type='text/javascript'>var widget_code='b859tfSadN';</script>
      <script type='text/javascript' src='http://cdn.rocketcallback.com/loader.js' charset='UTF-8'></script>
    `;
    body += addWidget;

    // Filter headers
    const headerBlacklist = /^content-length|^transfer-encoding|^content-encoding.*gzip/i;
    Object.keys(headers).forEach((key) => {
      if (!headerBlacklist.test(key)) {
        res.set(key, headers[key]);
      }
    });

    const contentType = responseInfo.content_type;

    // Handle HTML content
    if (contentType.includes('text/html')) {
      const $ = cheerio.load(body);
      $('form').each((i, form) => {
        let action = $(form).attr('action') || targetUrl;
        action = rel2abs(action, targetUrl);
        $(form).attr('action', `${proxyPrefix}${action}`);
      });
      $('style').each((i, style) => {
        $(style).text(proxifyCSS($(style).text(), targetUrl, proxyPrefix));
      });
      $('[style]').each((i, element) => {
        const style = $(element).attr('style');
        $(element).attr('style', proxifyCSS(style, targetUrl, proxyPrefix));
      });
      ['href', 'src'].forEach((attr) => {
        $(`[${attr}]`).each((i, element) => {
          let attrContent = $(element).attr(attr);
          if (attr === 'href' && (attrContent.startsWith('javascript:') || attrContent.startsWith('mailto:'))) return;
          attrContent = rel2abs(attrContent, targetUrl);
          $(element).attr(attr, `${proxyPrefix}${attrContent}`);
        });
      });
      const script = `<script type="text/javascript">
        (function() {
          if (window.XMLHttpRequest) {
            function parseURI(url) {
              const m = String(url).replace(/^\\s+|\\s+$/g, '').match(/^([^:/?#]+:)?(\/\/(?:[^:@]*(?::[^:@]*)?@)?(([^:/?#]*)(?::(\\d*))?))?([^?#]*)(\\?[^#]*)?(#[\\s\\S]*)?/);
              return m ? {
                href: m[0] || '',
                protocol: m[1] || '',
                authority: m[2] || '',
                host: m[3] || '',
                hostname: m[4] || '',
                port: m[5] || '',
                pathname: m[6] || '',
                search: m[7] || '',
                hash: m[8] || ''
              } : null;
            }
            function rel2abs(base, href) {
              function removeDotSegments(input) {
                const output = [];
                input.replace(/^(\\.\\.?(\\/|$))+/,'')
                  .replace(/\\/(\\.(\\/|$))+/g, '/')
                  .replace(/\\/\\.\\.$/, '/../')
                  .replace(/\\/?[^\/]*/g, p => p === '/..' ? output.pop() : output.push(p));
                return output.join('').replace(/^\\//, input.charAt(0) === '/' ? '/' : '');
              }
              href = parseURI(href || '');
              base = parseURI(base || '');
              return !href || !base ? null : (href.protocol || base.protocol) +
                (href.protocol || href.authority ? href.authority : base.authority) +
                removeDotSegments(href.protocol || href.authority || href.pathname.charAt(0) === '/' ? href.pathname : (href.pathname ? ((base.authority && !base.pathname ? '/' : '') + base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1) + href.pathname) : base.pathname)) +
                (href.protocol || href.authority || href.pathname ? href.search : (href.search || base.search)) +
                href.hash;
            }
            const proxied = window.XMLHttpRequest.prototype.open;
            window.XMLHttpRequest.prototype.open = function() {
              if (arguments[1] !== null && arguments[1] !== undefined) {
                let url = arguments[1];
                url = rel2abs('${targetUrl}', url);
                url = '${proxyPrefix}' + url;
                arguments[1] = url;
              }
              return proxied.apply(this, [].slice.call(arguments));
            };
          }
        })();
      </script>`;
      $('head, body').first().prepend(script);
      body = $.html();
      res.send(`<!-- Proxified page constructed by NodeProxy -->\n${body}`);
    } else if (contentType.includes('text/css')) {
      res.send(proxifyCSS(body, targetUrl, proxyPrefix));
    } else {
      res.set('Content-Length', Buffer.byteLength(body));
      res.send(body);
    }
  } catch (error) {
    console.error('Function Error:', error.stack);
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Export for Vercel
module.exports = app;
