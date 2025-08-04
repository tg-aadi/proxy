export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    return res.status(400).send("❌ Invalid or missing 'url' parameter.");
  }

  try {
    const fetchResponse = await fetch(url, {
      method: req.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Vercel Streaming Proxy)"
      },
      body: req.method === "POST" ? req.body : undefined,
      redirect: "follow"
    });

    res.status(fetchResponse.status);

    // Forward all relevant headers except transfer-encoding
    fetchResponse.headers.forEach((value, key) => {
      if (!["transfer-encoding", "content-encoding"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // Stream the response
    if (fetchResponse.body) {
      const reader = fetchResponse.body.getReader();

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        }
      });

      return new Response(stream, {
        status: fetchResponse.status,
        headers: fetchResponse.headers
      }).body.pipeTo(res);
    } else {
      res.end();
    }

  } catch (error) {
    console.error("Proxy error:", error);
    res.status(502).send("❌ Proxy failed to load the resource.");
  }
}

