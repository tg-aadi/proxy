// ========== ⚙ CONFIGURATION ==========
const hostname = '5giptv.me:8880';
const username = 'rajeshji';
const password = '11223344';
const userAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
// ======================================

export default async function handler(req, res) {
  const { query } = req;
  let id = query.tv || ''; // Accept ?tv=ID or /api/stream?tv=xxx.ts

  if (!id) {
    // Try to parse from URL path
    const urlPath = req.url || '';
    const matches = urlPath.match(/\/([^\/\?]+)\.(ts|m3u8)/);
    if (matches) id = matches[1];
  }

  const type = req.url.includes('.m3u8') ? 'm3u8' : 'ts';

  if (!id) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: true, message: 'ID Not Provided' });
    return;
  }

  const baseUrl = `http://${hostname}/live/${username}/${password}/${id}`;

  if (type === 'ts') {
    const tsUrl = `${baseUrl}.ts`;

    try {
      const response = await fetch(tsUrl, {
        headers: {
          'User-Agent': userAgent,
          'Icy-MetaData': '1',
          'Accept-Encoding': 'identity',
          'Host': hostname,
          'Connection': 'Keep-Alive',
        }
      });

      if (!response.ok) {
        res.status(502).send(`❌ Fetch error: ${response.statusText}`);
        return;
      }

      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Content-Disposition', `inline; filename="${hostname}-${id}.ts"`);

      const reader = response.body.getReader();
      const encoder = new TextEncoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }

      res.end();
    } catch (err) {
      res.status(502).send(`❌ Error: ${err.message}`);
    }
    return;
  }

  if (type === 'm3u8') {
    const m3u8Url = `${baseUrl}.m3u8`;

    try {
      const mainResp = await fetch(m3u8Url, {
        headers: {
          'User-Agent': userAgent,
          'Host': hostname,
          'Connection': 'Keep-Alive',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        redirect: 'manual'
      });

      // Follow redirect manually if needed
      if (mainResp.status >= 300 && mainResp.status < 400 && mainResp.headers.get('location')) {
        const redirectedUrl = mainResp.headers.get('location');
        const newResp = await fetch(redirectedUrl, { redirect: 'follow' });
        if (!newResp.ok) {
          res.writeHead(302, { Location: 'https://tg-aadi.vercel.app/intro.m3u8' }).end();
          return;
        }

        const redirectedBody = await newResp.text();
        const rewritten = redirectedBody.replace(/(\/(?:hlsr|hls|live)\/[^#\s"]+)/gi, match => {
          const parsed = new URL(redirectedUrl);
          return `http://${parsed.host}${match}`;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.status(200).send(rewritten);
        return;
      }

      // If no redirect
      const body = await mainResp.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.status(200).send(body);
    } catch (err) {
      res.writeHead(302, { Location: 'https://tg-aadi.vercel.app/intro.m3u8' }).end();
    }
  }
}
