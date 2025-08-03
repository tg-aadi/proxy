export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    return res.status(400).send("❌ Invalid or missing 'url' parameter.");
  }

  try {
    const targetResponse = await fetch(url, {
      method: req.method,
      headers: {
        // Optional: Add minimal headers; avoid passing user's headers
        "User-Agent": "Mozilla/5.0 (Vercel Proxy)",
      },
      body: req.method === "POST" ? req.body : undefined,
      redirect: "follow",
    });

    // Forward status
    res.status(targetResponse.status);

    // Copy response headers except those that may break things
    for (let [key, value] of targetResponse.headers.entries()) {
      if (
        !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(
          key.toLowerCase()
        )
      ) {
        res.setHeader(key, value);
      }
    }

    // Stream body
    const data = await targetResponse.arrayBuffer();
    res.end(Buffer.from(data));
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(502).send("❌ Error fetching target URL.");
  }
}
