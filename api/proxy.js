const axios = require('axios');
const { JSDOM } = require('jsdom');

// Define PROXY_PREFIX based on Vercel environment
const PROXY_PREFIX = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/proxy/` : 'http://localhost:3000/api/proxy/';

// Enhanced URL validation
function isValidUrl(url) {
  try {
    // Ensure URL has a valid scheme and hostname
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname;
  } catch {
    return false;
  }
}

// Convert relative URLs to absolute
function rel2abs(rel, base) {
  if (!rel) return base;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(rel) || rel.startsWith('//')) return rel;
  if (rel.startsWith('#') || rel.startsWith('?')) return base + rel;

  const baseUrl = new URL(base);
  let path = baseUrl.pathname.replace(/\/[^/]*$/, '') || '/';
  if (rel.startsWith('/')) path = '';

  const port = baseUrl.port && baseUrl.port !== '80' ? `:${baseUrl.port}` : '';
  const auth = baseUrl.username ? `${baseUrl.username}${baseUrl.password ? ':' + baseUrl.password : ''}@` : '';

  let abs = `${auth}${baseUrl.host}${path}${port}/${rel}`;
  while (abs.match(/\/\.?\//) || abs.match(/\/(?!\.\.)[^/]+\/\.\.\//)) {
    abs = abs.replace(/\/\.?\//g, '/').replace(/\/(?!\.\.)[^/]+\/\.\.\//g, '/');
  }

  return `${baseUrl.protocol}//${abs}`;
}

// Proxify CSS url() references
function proxifyCSS(css, baseURL) {
  return css.replace(/url\((.*?)\)/gi, (match, url) => {
    url = url.trim().replace(/^['"]|['"]$/g, '');
    if (url.startsWith('data:')) return `url(${url})`;
    return `url(${PROXY_PREFIX}${rel2abs(url, baseURL)})`;
  });
}

// Make HTTP request with improved error handling
async function makeRequest(url, req) {
  if (!isValidUrl(url)) {
    return { status: 400, data: 'Invalid URL provided. Please use a valid HTTP or HTTPS URL.' };
  }

  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];
  delete headers['accept-encoding'];

  headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (compatible; nrird.xyz/proxy)';
  headers['accept-encoding'] = 'gzip, deflate';

  try {
    const response = await axios({
      url,
      method: req.method,
      headers,
      data: req.method !== 'GET' ? req.body : undefined,
      params: req.method === 'GET' ? req.query : undefined,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      timeout: 30000, // 30-second timeout
    });

    return {
      status: response.status,
      headers: response.headers,
      data: response.data.toString('utf8'),
      contentType: response.headers['content-type'] || '',
    };
  } catch (error) {
    let message = 'Request failed';
    if (error.code === 'ENOTFOUND') {
      message = `DNS resolution failed for ${url}. Please check the URL and try again.`;
    } else if (error.code === 'ECONNABORTED') {
      message = `Request to ${url} timed out.`;
    } else {
      message = `Request error: ${error.message}`;
    }
    return { status: 500, data: message };
  }
}

// Log requests
function recordLog(url, ip) {
  const date = new Date().toISOString();
  console.log(`${date},${ip},${encodeURIComponent(url)}`);
}

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Extract URL from query or path
  let url = req.query.url || req.url.replace(/^\/api\/proxy\//, '');
  if (!url) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Web Proxy</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          *,::after,::before{box-sizing:border-box}
          body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;font-size:1rem;font-weight:400;line-height:1.5;color:#212529;background-color:#fff;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
          form{display:flex;flex-direction:column;gap:1ch;padding:12px;max-width:600px;margin:0 auto;}
          input[type="text"]{padding:8px;border:1px solid #ccc;border-radius:4px;}
          input[type="submit"]{width:fit-content;padding:8px 16px;background-color:#0d6efd;color:white;border:none;border-radius:4px;cursor:pointer;}
          input[type="submit"]:hover{background-color:#024dbc;}
          .error{color:red;margin-top:8px;}
        </style>
      </head>
      <body>
        <form onsubmit="const url = document.getElementById('site').value; if (/^https?:\\/\\//.test(url)) { window.location.href='/api/proxy/' + encodeURIComponent(url); } else { document.getElementById('error').textContent = 'Please enter a valid HTTP or HTTPS URL'; } return false;">
          <div>Enter the full URL to proxify:</div>
          <input type="text" id="site" placeholder="https://www.example.com" required pattern="https?://.+"/>
          <input type="submit" value="Proxify"/>
          <div id="error" class="error"></div>
        </form>
      </body>
      </html>
    `);
  }

  // Normalize URL
  url = url.trim();
  if (url.startsWith('//')) url = `http:${url}`;
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  if (!isValidUrl(url)) {
    res.status(400).send('Invalid URL format. Please use a valid HTTP or HTTPS URL.');
    return;
  }

  recordLog(url, req.headers['x-forwarded-for'] || req.socket.remoteAddress);

  const response = await makeRequest(url, req);
  if (response.status !== 200) {
    res.status(response.status).send(response.data);
    return;
  }

  // Proxy response headers
  Object.entries(response.headers).forEach(([key, value]) => {
    if (!['content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });

  const contentType = response.contentType.toLowerCase();
  if (contentType.includes('text/html')) {
    const dom = new JSDOM(response.data, { contentType: 'text/html; charset=utf-8' });
    const document = dom.window.document;

    // Rewrite form actions
    document.querySelectorAll('form').forEach(form => {
      let action = form.getAttribute('action') || url;
      action = rel2abs(action, url);
      form.setAttribute('action', `${PROXY_PREFIX}${action}`);
    });

    // Proxify <style> tags
    document.querySelectorAll('style').forEach(style => {
      style.textContent = proxifyCSS(style.textContent, url);
    });

    // Proxify style attributes
    document.querySelectorAll('[style]').forEach(element => {
      element.setAttribute('style', proxifyCSS(element.getAttribute('style'), url));
    });

    // Proxify href and src attributes
    ['href', 'src'].forEach(attr => {
      document.querySelectorAll(`[${attr}]`).forEach(element => {
        const attrContent = element.getAttribute(attr);
        if (attr === 'href' && (attrContent.startsWith('javascript:') || attrContent.startsWith('mailto:'))) return;
        element.setAttribute(attr, `${PROXY_PREFIX}${rel2abs(attrContent, url)}`);
      });
    });

    // Inject JavaScript for AJAX requests
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.textContent = `
      (function() {
        if (window.XMLHttpRequest) {
          function parseURI(url) {
            var m = String(url).replace(/^\\s+|\\s+$/g, "").match(/^([^:/?#]+:)?(\\/\\/(?:[^:@]*(?::[^:@]*)?@)?(([^:/?#]*)(?::(\\d*))?))?([^?#]*)(\\?[^#]*)?(#[\\s\\S]*)?/);
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
              input.replace(/^(\\.\\.?(\\/|$))+/g, "")
                .replace(/\\/(\\.(\\/|$))+/g, "/")
                .replace(/\\/\\.\\.$/, "/../")
                .replace(/\\/?[^\/]*/g, function(p) {
                  if (p === "/..") output.pop();
                  else output.push(p);
                });
              return output.join("").replace(/^\\/+/, input.charAt(0) === "/" ? "/" : "");
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
            if (arguments[1]) {
              var url = rel2abs('${url}', arguments[1]);
              arguments[1] = '${PROXY_PREFIX}' + url;
            }
            return proxied.apply(this, [].slice.call(arguments));
          };
        }
      })();
    `;
    (document.head || document.body)?.prepend(script);

    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.status(200).send(`<!-- Proxified page constructed by https://dev.nrird.com/web-proxy/ -->\n${dom.serialize()}`);
  } else if (contentType.includes('text/css')) {
    res.setHeader('Content-Type', 'text/css; charset=UTF-8');
    res.status(200).send(proxifyCSS(response.data, url));
  } else {
    res.setHeader('Content-Length', Buffer.byteLength(response.data));
    res.status(200).send(response.data);
  }
};
