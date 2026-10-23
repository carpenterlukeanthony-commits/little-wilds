const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20231121.08.00',
  hl: 'en',
  gl: 'US',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const videoId = (req.query.v || '').trim();
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid or missing video ID' });
  }

  try {
    // Use YouTube's Innertube API — works reliably server-side
    const playerRes = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          context: { client: INNERTUBE_CLIENT },
        }),
      }
    );

    if (!playerRes.ok) {
      return res.status(502).json({ error: `Innertube API returned HTTP ${playerRes.status}` });
    }

    const playerResponse = await playerRes.json();
    const captionTracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks?.length) {
      // Fallback: try scraping the watch page
      return await scrapeWatchPage(videoId, req, res);
    }

    return await sendTranscript(videoId, playerResponse, captionTracks, req, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function scrapeWatchPage(videoId, req, res) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!pageRes.ok) {
    return res.status(502).json({ error: `YouTube returned HTTP ${pageRes.status}` });
  }

  const html = await pageRes.text();
  const marker = 'ytInitialPlayerResponse';
  let idx = html.indexOf(marker);
  if (idx === -1) {
    return res.status(502).json({ error: 'Could not parse YouTube page — try again in a moment' });
  }
  idx = html.indexOf('{', idx);
  let depth = 0, i = idx;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { if (--depth === 0) break; }
  }
  const playerResponse = JSON.parse(html.slice(idx, i + 1));
  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks?.length) {
    return res.status(404).json({ error: 'No captions found — this video may have captions disabled.' });
  }

  return await sendTranscript(videoId, playerResponse, captionTracks, req, res);
}

async function sendTranscript(videoId, playerResponse, captionTracks, req, res) {
  const trackId = req.query.track != null ? parseInt(req.query.track, 10) : -1;
  const active =
    (trackId >= 0 && captionTracks[trackId]) ||
    captionTracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
    captionTracks.find(t => t.languageCode?.startsWith('en')) ||
    captionTracks[0];

  const transcriptRes = await fetch(active.baseUrl + '&fmt=json3');
  if (!transcriptRes.ok) {
    return res.status(502).json({ error: `Transcript fetch failed: HTTP ${transcriptRes.status}` });
  }
  const transcript = await transcriptRes.json();

  return res.status(200).json({
    title: playerResponse?.videoDetails?.title || '',
    tracks: captionTracks.map((t, i) => ({
      index: i,
      languageCode: t.languageCode,
      name: t.name?.simpleText || '',
      kind: t.kind || '',
    })),
    activeIndex: captionTracks.indexOf(active),
    events: transcript.events || [],
  });
}
