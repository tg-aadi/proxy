// /

import axios from 'axios';

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: true, message: 'URL is required' });
  }

  try {
    // Optional: use proxy if required (IP matching)
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'Referer': url,
      },
      timeout: 10000,
      // Add this if using proxy
       proxy: {
        host: '31.42.185.100',
        port: 31210,
        //auth: { username: 'user', password: 'pass' }
      // }
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.status(200).send(response.data);
  } catch (error) {
    return res.status(500).json({
      error: true,
      message: 'Failed to fetch .m3u8',
      details: error.message,
    });
  }
}
