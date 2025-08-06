// pages/api/proxy.js (for Next.js on Vercel)
export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': req.headers['user-agent'] || '',
        'Accept-Encoding': 'identity',
        // Pass other headers as needed
      },
      redirect: 'follow'
    });
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    response.body.pipe(res);
  } catch (error) {
    res.status(502).json({ error: `Proxy error: ${error.message}` });
  }
}
