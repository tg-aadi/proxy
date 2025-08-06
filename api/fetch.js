export default async function handler(req, res) {
  const { id } = req.query;
  const urlPath = req.url;
  const extension = urlPath.endsWith(".m3u8") ? "m3u8" : "ts";

  if (!id || id === "") {
    return res.status(400).json({ error: true, message: "ID Not Provided" });
  }

  const hostname = '5giptv.me:8880';
  const username = 'rajeshji';
  const password = '11223344';
  const user_agent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

  const streamUrl = `http://${hostname}/live/${username}/${password}/${id}.${extension}`;

  try {
    const response = await fetch(streamUrl, {
      headers: {
        "User-Agent": user_agent,
        "Host": hostname,
        "Connection": "Keep-Alive",
        "Referer": "http://localhost/",
        "Origin": "http://localhost/",
        "Accept-Encoding": "identity"
      }
    });

    if (!response.ok) {
      return res.status(502).send("❌ Failed to fetch from IPTV server");
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Type",
      extension === "ts" ? "video/mp2t" : "application/vnd.apple.mpegurl"
    );

    const buffer = await response.arrayBuffer();
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("❌ Internal Proxy Error");
  }
}
