const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const url = require('url');
const path = require('path');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse raw POST/PUT data
app.use(express.raw({ type: '*/*' }));

// Define PROXY_PREFIX based on server configuration
const getProxyPrefix = (req) => {
  const protocol = req.protocol;
  const host = req.get('host');
  const scriptPath = path.basename(__filename);
  return `${protocol}://${host}/${scriptPath}/`;
};

// Convert relative URLs to absolute URLs
function rel2abs(rel, base) {
  if (!rel) rel = '.';
  if (/^([a-zA-Z]+:)|(^\/\/)/.test(rel)) return rel; // Already absolute or protocol-relative
  if (rel.startsWith('#') || rel.startsWith('?')) return base + rel; // Queries or anchors

  const parsedBase = new URL(base);
  let { protocol, hostname, port, pathname } = parsedBase;

  // Remove non-directory element from path
  pathname = pathname.replace(/\/[^\/]*$/, '') || '/';
  if (rel.startsWith('/')) pathname = ''; // Destroy path if relative URL points to root

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
    url = url.trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
    if (url.startsWith('data:')) return `url(${url})`; // Skip data URLs
    return `url(${proxyPrefix}${rel2abs(url, baseURL)})`;
  });
}

// Make HTTP request using node-fetch
async function makeRequest(targetUrl, req) {
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];
  delete headers['accept-encoding'];

  const userAgent = req.get('user-agent') || 'Mozilla/5.0 (compatible; NodeProxy)';
  headers['user-agent'] = userAgent;

  const options = {
    method: req.method,
    headers,
    redirect: 'follow',
  };

  if (req.method === 'POST' || req.method === 'PUT') {
    options.body = req.body;
  }

  try {
    const response = await fetch(targetUrl, options);
    const responseHeaders = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });

    const body = await response.text();
    return {
      headers: responseHeaders,
      body,
      responseInfo: {
        content_type: response.headers.get('content-type') || '',
        status: response.status,
      },
    };
  } catch (error) {
    throw new Error(`Request failed: ${error.message}`);
  }
}

// Main proxy route
app.all('/*', async (req, res) => {
  let targetUrl = req.url.slice(1); // Remove leading slash
  const proxyPrefix = getProxyPrefix(req);

  // Handle empty URL case
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

  try {
    // Make the request
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
      const dom = new JSDOM(body);
      const { document } = dom.window;

      // Rewrite form actions
      document.querySelectorAll('form').forEach((form) => {
        let action = form.getAttribute('action') || targetUrl;
        action = rel2abs(action, targetUrl);
        form.setAttribute('action', `${proxyPrefix}${action}`);
      });

      // Proxify CSS in <style> tags
      document.querySelectorAll('style').forEach((style) => {
        style.textContent = proxifyCSS(style.textContent, targetUrl, proxyPrefix);
      });

      // Proxify style attributes
      document.querySelectorAll('[style]').forEach((element) => {
        const style = element.getAttribute('style');
        element.setAttribute('style', proxifyCSS(style, targetUrl, proxyPrefix));
      });

      // Proxify href and src attributes
      ['href', 'src'].forEach((attr) => {
        document.querySelectorAll(`[${attr}]`).forEach((element) => {
          let attrContent = element.getAttribute(attr);
          if (attr === 'href' && (attrContent.startsWith('javascript:') || attrContent.startsWith('mailto:'))) return;
          attrContent = rel2abs(attrContent, targetUrl);
          element.setAttribute(attr, `${proxyPrefix}${attrContent}`);
        });
      });

      // Inject AJAX proxy script
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.textContent = `
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
      `;
      const prependElem = document.head || document.body;
      if (prependElem) prependElem.insertBefore(script, prependElem.firstChild);

      res.send(`<!-- Proxified page constructed by NodeProxy -->\n${dom.serialize()}`);
    } else if (contentType.includes('text/css')) {
      // Handle CSS content
      res.send(proxifyCSS(body, targetUrl, proxyPrefix));
    } else {
      // Serve other content types (images, JS, etc.)
      res.set('Content-Length', Buffer.byteLength(body));
      res.send(body);
    }
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`);
});
