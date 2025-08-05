export default async function handler(req, res) {
  const { url } = req.query;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: true, message: 'Invalid or missing URL' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)...'
      }
    });

    const content = await response.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.status(200).send(content);
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
}
