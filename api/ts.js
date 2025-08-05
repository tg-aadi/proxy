import fetch from 'node-fetch';

export default async function handler(req, res) {
  const id = req.query.id;

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).send("❌ Invalid or missing ID");
  }

  const targetUrl = `http://uglivetv.uk/live/Timothy1/Timothy2/${id}.ts`;

  try {
    const originRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
        "Accept-Encoding": "identity",
        "Icy-MetaData": "1",
        "Connection": "Keep-Alive"
      },
      redirect: "follow"
    });

    if (!originRes.ok) {
      return res.status(502).send(`❌ Origin error: ${originRes.status}`);
    }

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");

    originRes.body.pipe(res);
  } catch (err) {
    res.status(500).send("❌ Proxy error: " + err.message);
  }
}

