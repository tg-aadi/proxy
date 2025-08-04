const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');
const app = express();

// Middleware to parse form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Define PROXY_PREFIX based on the request
const getProxyPrefix = (req) => {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}/api/proxy/`;
};

// Convert relative URLs to absolute URLs
function rel2abs(rel, base) {
  if (!rel) rel = '.';
  if (rel.match(/^[^:\/?#]+:/) || rel.startsWith('//')) return rel; // Already absolute
  if (rel.startsWith('#') || rel.startsWith('?')) return base + rel; // Queries or anchors
  const parsedBase = new URL(base);
  let path = parsedBase.pathname.replace(/\/[^\/]*$/, '') || '/';
  if (rel.startsWith('/')) path = ''; // Root-relative URLs
  let abs = `${parsedBase.host}${path}/${rel}`;
  if (parsedBase.port && parsedBase.port !== '80' && parsedBase.port !== '443') {
    abs = `${parsedBase.host.split(':')[0]}:${parsedBase.port}${path}/${rel}`;
  }
  if (parsedBase.username) {
    const auth = parsedBase.password ? `${parsedBase.username}:${parsedBase.password}` : parsedBase.username;
    abs = `${auth}@${abs}`;
  }
  // Resolve ../ and ./
  while (abs.match(/\/\.\.?\/|\/\.\/|\.\//)) {
    abs = abs.replace(/\/\.\//g, '/').replace(/\/[^\/]+\/\.\.\//g, '/').replace(/^\.\//, '');
  }
  return `${parsedBase.protocol}//${abs}`;
}

// Proxify CSS url() references
function proxifyCSS(css, baseURL, proxyPrefix) {
  return css.replace(/url\((.*?)\)/gi, (match, url) => {
    url = url.trim().replace(/^['"]|['"]$/g, ''); // Remove quotes
    if (url.startsWith('data:')) return `url(${url})`;
    const absoluteURL = rel2abs(url, baseURL);
    return `url(${proxyPrefix}${absoluteURL})`;
  });
}

// Make HTTP request to the target URL
async function makeRequest(targetURL, req) {
  const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (compatible; proxy)';
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];
  delete headers['accept-encoding'];
  headers['user-agent'] = userAgent;

  try {
    const method = req.method.toLowerCase();
    const config = {
      method,
      url: targetURL,
      headers,
      maxRedirects: 5,
      responseType: 'arraybuffer', // Handle binary data
    };

    if (method === 'post') {
      config.data = req.body;
    } else if (method === 'put') {
      config.data = req.body;
    } else if (method === 'get' && Object.keys(req.query).length > 0) {
      const queryString = new URLSearchParams(req.query).toString();
      config.url = `${targetURL.split('?')[0]}?${queryString}`;
    }

    const response = await axios(config);
    const responseBody = response.data;
    const contentType = response.headers['content-type'] || '';

    return {
      headers: response.headers,
      body: responseBody,
      contentType,
      status: response.status,
    };
  } catch (error) {
    throw new Error(`Request failed: ${error.message}`);
  }
}

// Serve the proxy form
app.get('/', (req, res) => {
  const proxyPrefix = getProxyPrefix(req);
  res.set('Content-Type', 'text/html');
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8" />
    <title>Upload</title>
    <style>
        *,::after,::before{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji";font-size:1rem;font-weight:400;line-height:1.5;color:#212529;background-color:#fff;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}[tabindex="-1"]:focus:not(:focus-visible){outline:0!important}hr{margin:1rem 0;color:inherit;background-color:currentColor;border:0;opacity:.25}hr:not([size]){height:1px}h1,h2,h3,h4,h5,h6{margin-top:0;margin-bottom:.5rem;font-weight:500;line-height:1.2}h1{font-size:2.5rem}h2{font-size:2rem}h3{font-size:1.75rem}h4{font-size:1.5rem}h5{font-size:1.25rem}h6{font-size:1rem}p{margin-top:0;margin-bottom:1rem}abbr[data-original-title],abbr[title]{text-decoration:underline;-webkit-text-decoration:underline dotted;text-decoration:underline dotted;cursor:help;-webkit-text-decoration-skip-ink:none;text-decoration-skip-ink:none}address{margin-bottom:1rem;font-style:normal;line-height:inherit}ol,ul{padding-left:2rem}dl,ol,ul{margin-top:0;margin-bottom:1rem}ol ol,ol ul,ul ol,ul ul{margin-bottom:0}dt{font-weight:700}dd{margin-bottom:.5rem;margin-left:0}blockquote{margin:0 0 1rem}b,strong{font-weight:bolder}small{font-size:.875em}sub,sup{position:relative;font-size:.75em;line-height:0;vertical-align:baseline}sub{bottom:-.25em}sup{top:-.5em}a{color:#0d6efd;text-decoration:none}a:hover{color:#024dbc;text-decoration:underline}a:not([href]),a:not([href]):hover{color:inherit;text-decoration:none}code,kbd,pre,samp{font-family:SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:1em}pre{display:block;margin-top:0;margin-bottom:1rem;overflow:auto;font-size:.875em}pre code{font-size:inherit;color:inherit;word-break:normal}code{font-size:.875em;color:#d63384;word-wrap:break-word}a>code{color:inherit}kbd{padding:.2rem .4rem;font-size:.875em;color:#fff;background-color:#212529;border-radius:.2rem}kbd kbd{padding:0;font-size:1em;font-weight:700}figure{margin:0 0 1rem}img{vertical-align:middle}svg{overflow:hidden;vertical-align:middle}table{border-collapse:collapse}caption{padding-top:.5rem;padding-bottom:.5rem;color:#6c757d;text-align:left;caption-side:bottom}th{text-align:inherit}label{display:inline-block;margin-bottom:.5rem}button{border-radius:0}button:focus{outline:1px dotted;outline:5px auto -webkit-focus-ring-color}button,input,optgroup,select,textarea{margin:0;font-family:inherit;font-size:inherit;line-height:inherit}button,input{overflow:visible}button,select{text-transform:none}select{word-wrap:normal}[list]::-webkit-calendar-picker-indicator{display:none}[type=button],[type=reset],[type=submit],button{-webkit-appearance:button}[type=button]:not(:disabled),[type=reset]:not(:disabled),[type=submit]:not(:disabled),button:not(:disabled){cursor:pointer}::-moz-focus-inner{padding:0;border-style:none}input[type=date],input[type=datetime-local],input[type=month],input[type=time]{-webkit-appearance:textfield}textarea{overflow:auto;resize:vertical}fieldset{min-width:0;padding:0;margin:0;border:0}legend{float:left;width:100%;padding:0;margin-bottom:.5rem;font-size:1.5rem;line-height:inherit;color:inherit;white-space:normal}mark{padding:.2em;background-color:#fcf8e3}progress{vertical-align:baseline}::-webkit-datetime-edit{overflow:visible;line-height:0}[type=search]{outline-offset:-2px;-webkit-appearance:textfield}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-color-swatch-wrapper{padding:0}::-webkit-file-upload-button{font:inherit;-webkit-appearance:button}output{display:inline-block}summary{display:list-item;cursor:pointer}template{display:none}main{display:block}[hidden]{display:none!important}
        form { display: flex; flex-direction: column; gap: 1ch; padding: 12px; }
        input[type="submit"] { width: fit-content; }
    </style>
</head>
<body>
    <form onsubmit="window.location.href='${proxyPrefix}' + document.getElementById('site').value; return false;">
        <div>Enter the full URL to proxify:</div>
        <input type="text" id="site" placeholder="http://www.google.com" required/>
        <input type="submit" value="Proxify"/>
    </form>
</body>
</html>
  `);
});

// Handle proxy requests
app.all('/api/proxy/*', async (req, res) => {
  let targetURL = req.url.replace('/api/proxy/', '');
  if (!targetURL) {
    return res.redirect('/');
  }

  if (targetURL.startsWith('//')) targetURL = `http:${targetURL}`;
  if (!targetURL.match(/^.*:\/\//)) targetURL = `http://${targetURL}`;

  const proxyPrefix = getProxyPrefix(req);

  try {
    const response = await makeRequest(targetURL, req);
    const contentType = response.contentType;

    // Proxy headers
    Object.entries(response.headers).forEach(([key, value]) => {
      if (!['content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.set(key, value);
      }
    });

    if (contentType.includes('text/html')) {
      const $ = cheerio.load(response.body.toString('utf8'));

      // Rewrite form actions
      $('form').each((i, form) => {
        const action = $(form).attr('action') || targetURL;
        const absoluteAction = rel2abs(action, targetURL);
        $(form).attr('action', `${proxyPrefix}${absoluteAction}`);
      });

      // Proxify style tags
      $('style').each((i, style) => {
        const css = $(style).html();
        $(style).html(proxifyCSS(css, targetURL, proxyPrefix));
      });

      // Proxify style attributes
      $('[style]').each((i, elem) => {
        const style = $(elem).attr('style');
        $(elem).attr('style', proxifyCSS(style, targetURL, proxyPrefix));
      });

      // Proxify href and src attributes
      ['href', 'src'].forEach(attr => {
        $(`[${attr}]`).each((i, elem) => {
          const attrContent = $(elem).attr(attr);
          if (attr === 'href' && (attrContent.startsWith('javascript:') || attrContent.startsWith('mailto:'))) return;
          const absoluteURL = rel2abs(attrContent, targetURL);
          $(elem).attr(attr, `${proxyPrefix}${absoluteURL}`);
        });
      });

      // Inject script to handle AJAX requests
      const script = `
        <script>
        (function() {
          if (window.XMLHttpRequest) {
            function parseURI(url) {
              var m = String(url).replace(/^\\s+|\\s+$/g, '').match(/^([^:/?#]+:)?(\/\/(?:[^:@]*(?::[^:@]*)?@)?(([^:/?#]*)(?::(\\d*))?))?([^?#]*)(\\?[^#]*)?(#[\\s\\S]*)?/);
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
                input.replace(/^(\\.{1,2}(\\/|$))+/, '')
                  .replace(/\\/(\\.(\\/|$))+/g, '/')
                  .replace(/\\/\\.\\.$/, '/../')
                  .replace(/\\/?[^\\/]*/g, function(p) {
                    if (p === '/..') output.pop();
                    else output.push(p);
                  });
                return output.join('').replace(/^\\/$/, input.charAt(0) === '/' ? '/' : '');
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
                url = rel2abs('${targetURL}', url);
                url = '${proxyPrefix}' + url;
                arguments[1] = url;
              }
              return proxied.apply(this, [].slice.call(arguments));
            };
          }
        })();
        </script>
      `;
      $('head').length ? $('head').prepend(script) : $('body').prepend(script);

      res.set('Content-Type', 'text/html');
      res.send(`<!-- Proxified page constructed by Node.js proxy -->\n${$.html()}`);
    } else if (contentType.includes('text/css')) {
      const css = proxifyCSS(response.body.toString('utf8'), targetURL, proxyPrefix);
      res.set('Content-Type', 'text/css');
      res.send(css);
    } else {
      res.set('Content-Length', Buffer.byteLength(response.body));
      res.send(response.body);
    }
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

module.exports = app;
