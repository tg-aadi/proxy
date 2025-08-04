// api/proxy.js

import http from 'http';
import https from 'https';
import { URL } from 'url';

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || !url.startsWith('http')) {
    res.status(400).send('❌ Missing or invalid "url" parameter');
    return;
  }

  try {
    const targetUrl = new URL(url);
    const client = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = client.request(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
      },
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    req.pipe(proxyReq);

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.status(502).send('❌ Proxy failed');
    });
  } catch (e) {
    console.error('URL parse error:', e.message);
    res.status(500).send('❌ Internal Server Error');
  }
}
