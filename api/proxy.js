export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    res.statusCode = 400;
    res.end("❌ Invalid or missing 'url' parameter.");
    return;
  }

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        "User-Agent": "Vercel-Proxy-Node"
      },
      body: req.method === "POST" ? req.body : undefined,
      redirect: "follow"
    });

    // Forward status code
    res.statusCode = response.status;

    // Forward headers (skip ones that cause issues)
    for (const [key, value] of response.headers.entries()) {
      if (!["transfer-encoding", "content-encoding"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    // Stream data (Node-style)
    const reader = response.body.getReader();

    res.setHeader("Transfer-Encoding", "chunked");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }

    res.end();

  } catch (err) {
    console.error("Proxy fetch failed:", err);
    res.statusCode = 502;
    res.end("❌ Proxy failed to fetch URL.");
  }
}
