const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');
const crypto = require('crypto');

// Initialize Express app
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration
const config = {
  urlVarName: 'q',
  flagsVarName: 'hl',
  maxFileSize: 1024 * 1024 * 4, // 4MB limit
  allowHotlinking: false,
  uponHotlink: 1, // 1: error, 2: 404, other: redirect
};

const flags = {
  includeForm: true,
  removeScripts: true,
  acceptCookies: true,
  showImages: true,
  showReferer: true,
  base64Encode: true,
  stripMeta: true,
  stripTitle: false,
  sessionCookies: true,
};

const proxifyTypes = {
  'text/html': true,
  'application/xml+xhtml': true,
  'application/xhtml+xml': true,
  'text/css': true,
};

// Utility Functions
const generateUUID = () => crypto.randomUUID();

function encodeUrl(inputUrl) {
  if (flags.base64Encode) {
    return encodeURIComponent(Buffer.from(inputUrl).toString('base64'));
  }
  return encodeURIComponent(inputUrl);
}

function decodeUrl(encodedUrl) {
  try {
    if (flags.base64Encode) {
      return Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString();
    }
    return decodeURIComponent(encodedUrl);
  } catch (e) {
    throw new Error('Invalid URL encoding');
  }
}

function parseUrl(inputUrl) {
  try {
    const parsed = new URL(inputUrl.startsWith('http') ? inputUrl : `http://${inputUrl}`);
    const pathParts = parsed.pathname.split('/').filter(p => p && p !== '.' && p !== '..');
    return {
      scheme: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      portExt: parsed.port ? `:${parsed.port}` : '',
      path: `/${pathParts.join('/')}${parsed.search || ''}`,
      query: parsed.search ? parsed.search.slice(1) : '',
      file: pathParts[pathParts.length - 1] || '',
      dir: `/${pathParts.slice(0, -1).join('/')}`,
      base: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${pathParts.slice(0, -1).join('/')}`,
      prevDir: pathParts.length > 1 ? `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${pathParts.slice(0, -1).join('/')}/` : `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/`,
    };
  } catch (e) {
    throw new Error('Invalid URL format');
  }
}

function completeUrl(inputUrl, base, proxify = true) {
  if (!inputUrl) return '';
  const fragment = inputUrl.includes('#') ? inputUrl.slice(inputUrl.indexOf('#')) : '';
  inputUrl = inputUrl.split('#')[0];
  if (!inputUrl.startsWith('http') && !inputUrl.startsWith('mailto:')) {
    if (inputUrl.startsWith('//')) {
      inputUrl = `${base.scheme}:${inputUrl}`;
    } else if (inputUrl.startsWith('/')) {
      inputUrl = `${base.scheme}://${base.host}${base.portExt}${inputUrl}`;
    } else if (inputUrl.startsWith('?')) {
      inputUrl = `${base.base}/${base.file}${inputUrl}`;
    } else {
      inputUrl = `${base.base}/${inputUrl}`;
    }
  }
  if (inputUrl.startsWith('mailto:')) return inputUrl;
  return proxify ? `/api/proxy?${config.urlVarName}=${encodeUrl(inputUrl)}${fragment}` : inputUrl;
}

function proxifyCss(css, base) {
  try {
    css = css.replace(/url\s*\(\s*([^)]*)\s*\)/gi, (match, p1) => {
      const url = p1.replace(/['"]/g, '').trim();
      return `url(${completeUrl(url, base)})`;
    });
    css = css.replace(/@import\s*(?:url\()?\s*['"]?([^'")]+)['"]?\s*(?:\))?\s*;/gi, (match, p1) => {
      return `@import "${completeUrl(p1, base)}";`;
    });
    return css;
  } catch (e) {
    console.error('CSS proxification error:', e.message);
    return css; // Return original CSS on error
  }
}

function proxifyHtml(html, base, urlParts) {
  try {
    const $ = cheerio.load(html, { decodeEntities: false });
    
    if (flags.stripTitle) $('title').remove();
    if (flags.removeScripts) {
      $('script').remove();
      $('[on*]').removeAttr();
      $('noscript').contents().unwrap();
    }
    if (!flags.showImages) $('img, image').remove();
    if (flags.stripMeta) $('meta').remove();

    const tags = {
      a: ['href'],
      img: ['src', 'longdesc'],
      form: ['action'],
      base: ['href'],
      // Simplified tag list for brevity
    };

    for (const [tag, attrs] of Object.entries(tags)) {
      $(tag).each((i, elem) => {
        const $elem = $(elem);
        attrs.forEach(attr => {
          const value = $elem.attr(attr);
          if (value) {
            if (tag === 'base') {
              base = parseUrl(completeUrl(value, base, false)) || base;
              $elem.attr(attr, completeUrl(value, base));
            } else if (tag === 'form' && attr === 'action') {
              if (!value) {
                $elem.attr('action', urlParts.path);
              } else if (!$elem.attr('method') || $elem.attr('method').toLowerCase() === 'get') {
                $elem.append(`<input type="hidden" name="${config.urlVarName}" value="${encodeUrl(completeUrl(value, base, false))}">`);
                $elem.attr('action', '');
              } else {
                $elem.attr(attr,alentUrl(value, base));
              }
            } else {
              $elem.attr(attr, completeUrl(value, base));
            }
          }
        });
      });
    }

    if (flags.includeForm) {
      const formHtml = `
        <form method="POST">
          <input type="text" name="${config.urlVarName}" placeholder="Enter URL">
          <button type="submit">Go</button>
        </form>
      `;
      $('body').prepend(formHtml);
    }

    return $.html();
  } catch (e) {
    console.error('HTML proxification error:', e.message);
    throw new Error('Failed to process HTML content');
  }
}

// Main Proxy Handler
app.all('/', async (req, res) => {
  try {
    // Handle URL submission
    if (req.method === 'POST' && req.body[config.urlVarName]) {
      const targetUrl = encodeUrl(req.body[config.urlVarName]);
      return res.redirect(`/?${config.urlVarName}=${targetUrl}`);
    }

    // Check for target URL
    const targetUrl = req.query[config.urlVarName];
    if (!targetUrl) {
      return res.status(200).send(`
        <form method="POST">
          <input type="text" name="${config.urlVarName}" placeholder="Enter URL">
          <button type="submit">Go</button>
        </form>
      `);
    }

    // Decode and parse URL
    let decodedUrl;
    try {
      decodedUrl = decodeUrl(targetUrl);
    } catch (e) {
      return res.status(400).send('Invalid URL encoding');
    }

    const urlParts = parseUrl(decodedUrl);
    if (!urlParts) {
      return res.status(400).send('Invalid URL format');
    }

    // Hotlinking check
    if (!config.allowHotlinking && req.get('referer')) {
      const referer = new URL(req.get('referer'), `http://${req.get('host')}`);
      const host = req.get('host');
      if (!referer.hostname.includes(host)) {
        if (config.uponHotlink === 1) {
          return res.status(403).send('Hotlinking not allowed');
        } else if (config.uponHotlink === 2) {
          return res.status(404).send('Not Found');
        } else {
          return res.redirect(config.uponHotlink);
        }
      }
    }

    // Fetch target URL
    let response;
    try {
      response = await axios({
        method: req.method,
        url: `${urlParts.scheme}://${urlParts.host}${urlParts.portExt}${urlParts.path}`,
        headers: {
          'User-Agent': req.get('user-agent') || 'Mozilla/5.0',
          'Accept': req.get('accept') || '*/*',
          ...(flags.showReferer && req.get('referer') ? { Referer: decodeUrl(req.get('referer').match(/q=([^&]+)/)?.[1] || '') } : {}),
          ...(flags.acceptCookies && req.get('cookie') ? { Cookie: req.get('cookie') } : {}),
        },
        data: req.method === 'POST' ? req.body : undefined,
        responseType: 'arraybuffer',
        timeout: 8000, // 8s timeout to stay within Vercel limits
        maxContentLength: config.maxFileSize,
        maxRedirects: 0,
      });
    } catch (err) {
      if (err.response?.status === 301 || err.response?.status === 302) {
        const location = err.response.headers.location;
        res.set('Location', completeUrl(location, urlParts));
        return res.status(err.response.status).send();
      }
      console.error('Axios error:', err.message, err.response?.status, err.response?.statusText);
      return res.status(500).send(`Error fetching URL: ${err.message}`);
    }

    // Process response headers
    const headers = response.headers;
    let contentType = headers['content-type']?.split(';')[0] || 'text/html';
    const contentDisposition = headers['content-disposition'] || (contentType === 'application/octet-stream' ? 'attachment' : 'inline') + `; filename="${urlParts.file}"`;

    // Set cookies
    if (flags.acceptCookies && headers['set-cookie']) {
      res.set('Set-Cookie', headers['set-cookie'].map(cookie => {
        const match = cookie.match(/([^=;,\s]*)\s*=?\s*([^;]*)/);
        if (match) {
          const [, name, value] = match;
          return `${name}=${value}; Path=/; Domain=${req.get('host')}${flags.sessionCookies ? '' : '; Max-Age=2419200'}`;
        }
        return cookie;
      }));
    }

    // Handle non-proxified content
    if (!proxifyTypes[contentType]) {
      res.set({
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition,
        ...(headers['content-length'] ? { 'Content-Length': headers['content-length'] } : {}),
      });
      return res.send(response.data);
    }

    // Convert response data to string
    let body;
    try {
      body = Buffer.from(response.data).toString('utf8');
    } catch (e) {
      console.error('Response conversion error:', e.message);
      return res.status(500).send('Error processing response data');
    }

    // Proxify content
    try {
      if (contentType === 'text/css') {
        body = proxifyCss(body, urlParts);
      } else {
        body = proxifyHtml(body, urlParts, urlParts);
      }
    } catch (e) {
      console.error('Content proxification error:', e.message);
      return res.status(500).send(`Error processing content: ${e.message}`);
    }

    // Send response
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition,
      'Content-Length': Buffer.byteLength(body),
    });
    res.send(body);
  } catch (err) {
    console.error('General error:', err.message);
    res.status(500).send(`Error fetching URL: ${err.message}`);
  }
});

// Export for Vercel
module.exports = app;
