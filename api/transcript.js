export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const videoId = (req.query.v || '').trim();
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid or missing video ID' });
  }

  try {
    // Fetch the YouTube watch page — gets us pre-signed caption URLs
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!pageRes.ok) {
      return res.status(502).json({ error: `YouTube returned HTTP ${pageRes.status}` });
    }

    const html = await pageRes.text();

    // Extract ytInitialPlayerResponse JSON
    const marker = 'ytInitialPlayerResponse';
    let idx = html.indexOf(marker);
    if (idx === -1) return res.status(502).json({ error: 'Could not parse YouTube page' });
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
      return res.status(404).json({ error: 'No captions found — captions may be disabled on this video.' });
    }

    const trackId = req.query.track ? parseInt(req.query.track, 10) : -1;
    const active =
      (trackId >= 0 && captionTracks[trackId]) ||
      captionTracks.find(t => t.languageCode?.startsWith('en') && !t.kind) ||
      captionTracks.find(t => t.languageCode?.startsWith('en')) ||
      captionTracks[0];

    // Fetch the actual transcript from the signed URL
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
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
