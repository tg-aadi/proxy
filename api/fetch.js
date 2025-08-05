// / on Vercel
export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: true, message: "Missing URL" });
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; MAG200) AppleWebKit/533.3 (KHTML, like Gecko)",
      }
    });
    const text = await response.text();
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: true, message: e.message });
  }
}
