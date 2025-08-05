import fetch from 'node-fetch';

const HOSTNAME = '5giptv.me:8880';
const USERNAME = 'rajeshji';
const PASSWORD = '11223344';
const USER_AGENT = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

export default async function handler(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const match = pathname.match(/^\/(.+?)\.(ts|m3u8)$/i);

  if (!match) {
    return res.status(400).json({ error: true, message: "ID Not Provided or Invalid Format" });
  }

  const [, id, ext] = match;
  const streamUrl = `http://${HOSTNAME}/live/${USERNAME}/${PASSWORD}/${id}.${ext}`;

  try {
    const response = await fetch(streamUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Host': HOSTNAME,
        'Connection': 'Keep-Alive',
        'Accept-Encoding': 'identity'
      },
      redirect: ext === 'm3u8' ? 'manual' : 'follow'
    });

    if (!response.ok && ext === 'ts') {
      return res.status(502).send("❌ Error fetching TS stream.");
    }

    if (ext === 'ts') {
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Content-Disposition", `inline; filename="${HOSTNAME}-${id}.ts"`);
      response.body.pipe(res);
    } else if (ext === 'm3u8') {
      let text = await response.text();

      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const redirectedUrl = response.headers.get('location');
        const redirectedRes = await fetch(redirectedUrl);

        if (!redirectedRes.ok) {
          return res.redirect("https://tg-aadi.vercel.app/intro.m3u8");
        }

        const redirectedText = await redirectedRes.text();
        const host = new URL(redirectedUrl).host;

        const proxiedBody = redirectedText.replace(/(\/(?:hlsr|hls|live)\/[^#\s"]+)/ig, (match) => {
          return `http://${host}${match}`;
        });

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        return res.send(proxiedBody);
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.send(text);
    }

  } catch (err) {
    res.status(500).send("❌ Server Error: " + err.toString());
  }
}
