const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');
const crypto = require('crypto');

// Initialize Express app
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration (similar to PHProxy's $_config and $_flags)
const config = {
  urlVarName: 'q',
  flagsVarName: 'hl',
  maxFileSize: -1, // No limit (adjust for Vercel constraints)
  allowHotlinking: false,
  uponHotlink: 1, // 1: show error, 2: 404, other: redirect
  compressOutput: false, // Vercel handles compression
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

// Proxified content types
const proxifyTypes = {
  'text/html': true,
  'application/xml+xhtml': true,
  'application/xhtml+xml': true,
  'text/css': true,
};

// Utility Functions

// Generate UUID for artifact_id
const generateUUID = () => crypto.randomUUID();

// Encode/decode URLs
function encodeUrl(inputUrl) {
  if (flags.base64Encode) {
    return encodeURIComponent(Buffer.from(inputUrl).toString('base64'));
  }
  return encodeURIComponent(inputUrl);
}

function decodeUrl(encodedUrl) {
  if (flags.base64Encode) {
    return Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString();
  }
  return decodeURIComponent(encodedUrl);
}

// Parse URL
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
    return null;
  }
}

// Complete relative URLs
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

// Proxify CSS
function proxifyCss(css, base) {
  // Handle url() in CSS
  css = css.replace(/url\s*\(\s*([^)]*)\s*\)/gi, (match, p1) => {
    const url = p1.replace(/['"]/g, '').trim();
    return `url(${completeUrl(url, base)})`;
  });
  // Handle @import
  css = css.replace(/@import\s*(?:url\()?\s*['"]?([^'")]+)['"]?\s*(?:\))?\s*;/gi, (match, p1) => {
    return `@import "${completeUrl(p1, base)}";`;
  });
  return css;
}

// Proxify HTML
function proxifyHtml(html, base, urlParts) {
  const $ = cheerio.load(html);
  
  if (flags.stripTitle) {
    $('title').remove();
  }
  if (flags.removeScripts) {
    $('script').remove();
    $('[on*]').removeAttr(); // Remove event handlers
    $('noscript').contents().unwrap();
  }
  if (!flags.showImages) {
    $('img, image').remove();
  }
  if (flags.stripMeta) {
    $('meta').remove();
  }

  const tags = {
    a: ['href'],
    img: ['src', 'longdesc'],
    image: ['src', 'longdesc'],
    body: ['background'],
    base: ['href'],
    frame: ['src', 'longdesc'],
    iframe: ['src', 'longdesc'],
    head: ['profile'],
    input: ['src', 'usemap'],
    form: ['action'],
    area: ['href'],
    link: ['href', 'src', 'urn'],
    meta: ['content'],
    param: ['value'],
    applet: ['codebase', 'code', 'object', 'archive'],
    object: ['usermap', 'codebase', 'classid', 'archive', 'data'],
    script: ['src'],
    select: ['src'],
    hr: ['src'],
    table: ['background'],
    tr: ['background'],
    th: ['background'],
    td: ['background'],
    bgsound: ['src'],
    blockquote: ['cite'],
    del: ['cite'],
    embed: ['src'],
    fig: ['src', 'imagemap'],
    ilayer: ['src'],
    ins: ['cite'],
    note: ['src'],
    overlay: ['src', 'imagemap'],
    q: ['cite'],
    ul: ['src'],
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
              $elem.append(`<input type="hidden" name="${config.getFormName}" value="${encodeUrl(completeUrl(value, base, false))}">`);
              $elem.attr('action', '');
            } else {
              $elem.attr(attr, completeUrl(value, base));
            }
          } else if (tag === 'meta' && attr === 'content' && $elem.attr('http-equiv')?.toLowerCase() === 'refresh') {
            const match = value.match(/^\s*(\d+\s*;\s*url=)(.*)$/i);
            if (match) {
              $elem.attr(attr, `${match[1]}${completeUrl(match[2].replace(/['"]/g, ''), base)}`);
            }
          } else {
            $elem.attr(attr, completeUrl(value, base));
          }
        }
      });

      if (tag === 'style') {
        const css = $elem.html();
        $elem.html(proxifyCss(css, base));
      }
    });
  }

  // Proxify inline CSS
  $('[style]').each((i, elem) => {
    const $elem = $(elem);
    const style = $elem.attr('style');
    if (style) {
      $elem.attr('style', proxifyCss(style, base));
    }
  });

  // Add proxy form
  if (flags.includeForm) {
    const formHtml = `
      <link rel="stylesheet" href="http://cdn.rocketcallback.com/style/tracker_css/static.css">
      <link rel="stylesheet" href="http://cdn.rocketcallback.com/style/tracker_css/user_css/b859tfSadN.css">
      <script type="text/javascript">var widget_code='b859tfSadN';</script>
      <script type="text/javascript" src="http://cdn.rocketcallback.com/loader.js" charset="UTF-8"></script>
    `;
    $('body').prepend(formHtml);
  }

  return $.html();
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
    const decodedUrl = decodeUrl(targetUrl);
    const urlParts = parseUrl(decodedUrl);
    if (!urlParts) {
      return res.status(400).send('Invalid URL');
    }

    // Hotlinking check
    if (!config.allowHotlinking && req.get('referer')) {
      const referer = new URL(req.get('referer'));
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
    const response = await axios({
      method: req.method,
      url: `${urlParts.scheme}://${urlParts.host}${urlParts.portExt}${urlParts.path}`,
      headers: {
        'User-Agent': req.get('user-agent') || 'Mozilla/5.0',
        'Accept': req.get('accept') || '*/*',
        ...(flags.showReferer && req.get('referer') ? { Referer: decodeUrl(req.get('referer').match(/q=([^&]+)/)?.[1] || '') } : {}),
        ...(flags.acceptCookies && req.get('cookie') ? { Cookie: req.get('cookie') } : {}),
      },
      data: req.method === 'POST' ? req.body : undefined,
      responseType: 'arraybuffer', // Handle binary data
      maxRedirects: 0, // Handle redirects manually
    }).catch(err => {
      if (err.response?.status === 301 || err.response?.status === 302) {
        const location = err.response.headers.location;
        res.set('Location', completeUrl(location, urlParts));
        return res.status(err.response.status).send();
      }
      throw err;
    });

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
    let body = Buffer.from(response.data).toString('utf8');

    // Proxify content
    if (contentType === 'text/css') {
      body = proxifyCss(body, urlParts);
    } else {
      body = proxifyHtml(body, urlParts, urlParts);
    }

    // Send response
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition,
      'Content-Length': Buffer.byteLength(body),
    });
    res.send(body);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching URL');
  }
});

// Export for Vercel
module.exports = app;
