const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');

const app = express();
app.use(express.raw({ type: '*/*' }));

const PROXY_PREFIX = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/proxy/` : 'http://localhost:3000/api/proxy/';

function getAllHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('x-') || key === 'host' || key === 'content-length' || key === 'accept-encoding') continue;
    headers[key] = value;
  }
  return headers;
}

async function makeRequest(url, req) {
  console.log('Making request to:', url);
  const headers = getAllHeaders(req);
  headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (compatible; nrird.xyz/proxy)';
  headers['accept-encoding'] = 'gzip, deflate, br';

  const options = {
    method: req.method,
    headers,
    redirect: 'follow',
  };

  if (req.method === 'POST' || req.method === 'PUT') {
    options.body = req.body;
  }

  try {
    const response = await fetch(url, options);
    const headersArray = [];
    response.headers.forEach((value, name) => {
      if (name !== 'content-length' && name !== 'transfer-encoding') {
        headersArray.push({ name, value });
      }
    });
    const body = await response.text();
    return {
      headers: headersArray,
      body,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
    };
  } catch (error) {
    console.error('Request error:', error.message);
    return { error: error.message };
  }
}

function rel2abs(rel, base) {
  if (!rel) rel = '.';
  if (/^[a-zA-Z][a-zA-Z0-9+-.]*:/.test(rel) || rel.startsWith('//')) return rel;
  if (rel.startsWith('#') || rel.startsWith('?')) return base + rel;
  
  const baseUrl = new URL(base);
  let path = baseUrl.pathname.replace(/\/[^/]*$/, '') || '/';
  if (rel.startsWith('/')) path = '';
  
  const port = baseUrl.port && baseUrl.port !== '80' ? `:${baseUrl.port}` : '';
  let auth = '';
  if (baseUrl.username) {
    auth = baseUrl.username;
    if (baseUrl.password) auth += `:${baseUrl.password}`;
    auth += '@';
  }
  
  let abs = `${auth}${baseUrl.host}${path}${port}/${rel}`;
  while (abs.match(/\/\.?\//) || abs.match(/\/(?!\.\.)[^/]+\/\.\.\//)) {
    abs = abs.replace(/\/\.?\//g, '/').replace(/\/(?!\.\.)[^/]+\/\.\.\//g, '/');
  }
  return `${baseUrl.protocol}//${abs}`;
}

function proxifyCSS(css, baseURL) {
  return css.replace(/url\((.*?)\)/gi, (match, url) => {
    url = url.trim().replace(/^['"]|['"]$/g, '');
    if (url.startsWith('data:')) return `url(${url})`;
    return `url(${PROXY_PREFIX}${rel2abs(url, baseURL)})`;
  });
}

function recordLog(url, req) {
  const userIp = req.headers['x-forwarded-for'] || req.ip;
  const rdate = new Date().toLocaleDateString('en-GB').replace(/\//g, '-');
  console.log(`${rdate},${userIp},${url}`);
}

app.get('/:url*', async (req, res) => {
  let url = req.params.url + (req.params[0] || '');
  if (!url) {
    console.error('No URL provided');
    return res.status(400).send('No URL provided');
  }

  try {
    url = decodeURIComponent(url);
  } catch (e) {
    console.error('Invalid URL encoding:', e.message);
    return res.status(400).send('Invalid URL encoding');
  }

  if (url.startsWith('//')) url = 'http:' + url;
  if (!url.match(/^.*:\/\//)) url = 'http://' + url;

  try {
    new URL(url);
  } catch (e) {
    console.error('Invalid URL format:', url);
    return res.status(400).send('Invalid URL format');
  }

  // recordLog(url, req);

  const response = await makeRequest(url, req);
  if (response.error) {
    return res.status(500).send(`Error: ${response.error}`);
  }

  response.headers.forEach(({ name, value }) => res.set(name, value));

  if (response.contentType.includes('text/html')) {
    const dom = new JSDOM(response.body);
    const document = dom.window.document;

    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
      const action = form.getAttribute('action') || url;
      form.setAttribute('action', PROXY_PREFIX + rel2abs(action, url));
    });

    const styles = document.querySelectorAll('style');
    styles.forEach(style => {
      style.textContent = proxifyCSS(style.textContent, url);
    });

    const elementsWithStyle = document.querySelectorAll('[style]');
    elementsWithStyle.forEach(element => {
      element.setAttribute('style', proxifyCSS(element.getAttribute('style'), url));
    });

    const proxifyAttributes = ['href', 'src'];
    proxifyAttributes.forEach(attr => {
      document.querySelectorAll(`[${attr}]`).forEach(element => {
        const attrContent = element.getAttribute(attr);
        if (attr === 'href' && (attrContent.startsWith('javascript:') || attrContent.startsWith('mailto:'))) return;
        element.setAttribute(attr, PROXY_PREFIX + rel2abs(attrContent, url));
      });
    });

    const head = document.querySelector('head') || document.querySelector('body');
    if (head) {
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.textContent = `
        (function() {
          if (window.XMLHttpRequest) {
            function parseURI(url) {
              var m = String(url).replace(/^\\s+|\\s+$/g, '').match(/^([^:/?#]+:)?(\\/\\/(?:[^:@]*(?::[^:@]*)?@)?(([^:/?#]*)(?::(\\d*))?))?([^?#]*)(\\?[^#]*)?(#[\\s\\S]*)?/);
              return (m ? {
                href: m[0] || '',
                protocol: m[1] || '',
                authority: m[2] || '',
                host: m[3] || '',
                hostname: m[4] || '',
                port: m[5] || '',
                pathname: m[6] || '',
                search: m[7] || '',
                hash: m[8] || ''
              } : null);
            }
            function rel2abs(base, href) {
              function removeDotSegments(input) {
                var output = [];
                input.replace(/^(\\.\\.?(\\/|$))+/, '')
                  .replace(/\\/(\\.(\\/|$))+/g, '/')
                  .replace(/\\/\\.\\.$/, '/..')
                  .replace(/\\/?[^/]+/g, function(p) {
                    if (p === '/..') output.pop();
                    else output.push(p);
                  });
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
            var proxied = window.XMLHttpRequest.prototype.open;
            window.XMLHttpRequest.prototype.open = function() {
              if (arguments[1] !== null && arguments[1] !== undefined) {
                var url = arguments[1];
                url = rel2abs('${url}', url);
                url = '${PROXY_PREFIX}' + url;
                arguments[1] = url;
              }
              return proxied.apply(this, [].slice.call(arguments));
            };
          }
        })();
      `;
      head.insertBefore(script, head.firstChild);
    }

    res.send(`<!-- Proxified page constructed by Node.js proxy -->\n${dom.serialize()}`);
  } else if (response.contentType.includes('text/css')) {
    res.send(proxifyCSS(response.body, url));
  } else {
    res.set('Content-Length', Buffer.byteLength(response.body));
    res.send(response.body);
  }
});

module.exports = app;
