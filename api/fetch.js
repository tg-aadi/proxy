// api/fetch.js
export default async function handler(req, res) {
  const url = req.query.url;

  if (!url) {
    return res.status(400).send('Missing URL');
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Referer': req.headers['referer'] || '',
      }
    });

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const body = await response.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(body));
  } catch (error) {
    res.status(500).send('Fetch failed: ' + error.message);
  }
}
