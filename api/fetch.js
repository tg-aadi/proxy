export default async function handler(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: true, message: "Missing 'url' parameter" });
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Referer': targetUrl,
        'Origin': new URL(targetUrl).origin,
      }
    });

    const contentType = response.headers.get("content-type") || 'application/octet-stream';
    const body = await response.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(Buffer.from(body));
  } catch (e) {
    res.status(500).json({ error: true, message: e.message });
  }
}
