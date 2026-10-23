const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const TRANSCRIPT_URL = 'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false';
const NEXT_URL = 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WEB_VERSION = '2.20250312.04.00';

const CLIENTS = [
  {
    name: 'android',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'en', gl: 'US' } },
  },
  {
    name: 'ios',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: { client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US' } },
  },
];


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const videoId = String(req.query.v || '').trim();
  if (!/^[\w-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "That doesn't look like a YouTube video ID." });
  }
  const want = { lang: String(req.query.lang || ''), kind: String(req.query.kind || '') };

  const attempts = [];
  let title = '';

  async function fetchTitle() {
    if (title) return;
    try {
      const oe = await getJson(
        `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`
      );
      title = oe.title || '';
    } catch {}
  }

  // Strategy 0: Supadata API — dedicated transcript service that handles YouTube bot-detection.
  // Requires SUPADATA_API_KEY env var. One-time free setup at supadata.ai removes all maintenance.
  if (process.env.SUPADATA_API_KEY) {
    const sd = { via: 'supadata' };
    attempts.push(sd);
    try {
      const params = new URLSearchParams({ videoId, ...(want.lang ? { lang: want.lang } : {}) });
      const data = await getJson(
        `https://api.supadata.ai/v1/youtube/transcript?${params}`,
        { 'x-api-key': process.env.SUPADATA_API_KEY }
      );
      if (data.content?.length) {
        sd.status = 'OK';
        await fetchTitle();
        const segments = data.content.map(s => ({ start: (s.offset || 0) / 1000, text: clean(s.text || '') })).filter(s => s.text);
        const tracks = (data.availableLangs || []).map(l => ({ lang: l, kind: '', label: l }));
        return res.status(200).json({ title, via: 'supadata', tracks, active: { lang: data.lang || want.lang, kind: '' }, segments });
      }
      sd.reason = 'no content returned';
    } catch (e) {
      sd.error = e.message;
    }
  }

  // Strategies below all hit YouTube directly and are blocked by cloud IP bot-detection.
  // They are kept as fallbacks but will fail on Vercel without SUPADATA_API_KEY.

  async function callGetTranscript(params, clientVersion, visitorData) {
    const headers = { 'User-Agent': BROWSER_UA, 'Origin': 'https://www.youtube.com', 'Referer': `https://www.youtube.com/watch?v=${videoId}` };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    const context = { client: { clientName: 'WEB', clientVersion: clientVersion || WEB_VERSION, hl: 'en', gl: 'US', ...(visitorData ? { visitorData } : {}) } };
    const data = await postJson(TRANSCRIPT_URL, { context, params }, headers);
    return parsePanel(data);
  }

  const nextAttempt = { via: 'via-next' };
  attempts.push(nextAttempt);
  try {
    const nextData = await postJson(NEXT_URL, { context: { client: { clientName: 'WEB', clientVersion: WEB_VERSION, hl: 'en', gl: 'US' } }, videoId }, { 'User-Agent': BROWSER_UA, 'Origin': 'https://www.youtube.com' });
    const visitorData = nextData?.responseContext?.visitorData || '';
    const ep = findAll(nextData, 'getTranscriptEndpoint').find(e => e?.params);
    if (!ep) {
      nextAttempt.reason = 'no transcript endpoint in /next response';
    } else {
      nextAttempt.status = 'OK';
      const segs = await callGetTranscript(ep.params, WEB_VERSION, visitorData);
      if (segs.length) {
        await fetchTitle();
        return res.status(200).json({ title, via: 'via-next', tracks: [], active: null, segments: segs });
      }
      nextAttempt.reason = 'transcript came back empty';
    }
  } catch (e) {
    nextAttempt.error = e.message;
  }

  for (const c of CLIENTS) {
    const attempt = { via: c.name };
    attempts.push(attempt);
    try {
      const pr = await postJson(PLAYER_URL, { context: c.context, videoId }, { 'User-Agent': c.ua });
      title = title || pr.videoDetails?.title || '';
      attempt.status = pr.playabilityStatus?.status || 'none';
      attempt.reason = pr.playabilityStatus?.reason || '';
      const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      attempt.tracks = tracks.length;
      if (!tracks.length) continue;

      const track = pickTrack(tracks, want);
      const segments = parseCaptionFile(await getText(captionUrl(track.baseUrl), { 'User-Agent': c.ua }));
      if (!segments.length) { attempt.reason = 'caption file came back empty'; continue; }

      return res.status(200).json({
        title,
        via: c.name,
        tracks: tracks.map(t => ({ lang: t.languageCode, kind: t.kind || '', label: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode })),
        active: { lang: track.languageCode, kind: track.kind || '' },
        segments,
      });
    } catch (e) {
      attempt.error = e.message;
    }
  }

  // Strategy 6: watch page HTML → ytInitialData transcript params → get_transcript
  const panel = { via: 'transcript-panel' };
  attempts.push(panel);
  try {
    const html = await getText(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'SOCS=CAI; CONSENT=YES+1',
    });
    const pr = extractJson(html, 'ytInitialPlayerResponse');
    title = title || pr?.videoDetails?.title || '';
    panel.status = pr?.playabilityStatus?.status || 'none';
    panel.reason = pr?.playabilityStatus?.reason || '';
    const params = findAll(extractJson(html, 'ytInitialData'), 'getTranscriptEndpoint').find(e => e?.params)?.params;
    if (!params) {
      panel.reason ||= 'no transcript panel on the page';
    } else {
      const clientVersion = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] || WEB_VERSION;
      const visitorData = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1] || '';
      const segs = await callGetTranscript(params, clientVersion, visitorData);
      if (segs.length) {
        return res.status(200).json({ title, via: 'transcript-panel', tracks: [], active: null, segments: segs });
      }
      panel.reason = 'transcript panel came back empty';
    }
  } catch (e) {
    panel.error = e.message;
  }

  await fetchTitle();
  const blocked = attempts.some(a => a.status === 'LOGIN_REQUIRED' || /bot|sign in/i.test(a.reason || ''));
  const playable = attempts.some(a => a.status === 'OK');
  const noKey = !process.env.SUPADATA_API_KEY;
  let error;
  if (blocked || noKey) error = "YouTube blocks requests from cloud servers. Add a free Supadata API key to fix this permanently — see the setup guide below.";
  else if (playable) error = 'This video has no captions or transcript.';
  else error = "YouTube didn't return the video. " + (attempts.find(a => a.reason)?.reason || attempts.find(a => a.error)?.error || '');

  return res.status(blocked ? 503 : playable ? 404 : 502).json({ error, blocked, needsSetup: blocked || noKey, title, attempts });
}

async function postJson(url, body, headers) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, ...headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getText(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export function captionUrl(baseUrl) {
  return baseUrl.replace(/&fmt=[^&]*/g, '') + '&fmt=json3';
}

export function pickTrack(tracks, want = {}) {
  return (
    (want.lang && tracks.find(t => t.languageCode === want.lang && (t.kind || '') === want.kind)) ||
    (want.lang && tracks.find(t => t.languageCode === want.lang)) ||
    tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode?.startsWith('en')) ||
    tracks.find(t => t.kind !== 'asr') ||
    tracks[0]
  );
}

export function parseCaptionFile(text) {
  text = (text || '').trim();
  if (!text) return [];
  if (text[0] === '{') {
    return (JSON.parse(text).events || [])
      .filter(e => e.segs)
      .map(e => ({ start: (e.tStartMs || 0) / 1000, text: clean(e.segs.map(s => s.utf8 || '').join('')) }))
      .filter(s => s.text);
  }
  const out = [];
  const re = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(text))) {
    const start = /\bstart="([\d.]+)"/.exec(m[2]);
    const t = /\bt="(\d+)"/.exec(m[2]);
    const seg = { start: start ? parseFloat(start[1]) : t ? parseInt(t[1], 10) / 1000 : 0, text: clean(decode(m[3].replace(/<[^>]+>/g, ''))) };
    if (seg.text) out.push(seg);
  }
  return out;
}

export function parsePanel(data) {
  return findAll(data, 'transcriptSegmentRenderer')
    .map(r => ({
      start: parseInt(r.startMs || '0', 10) / 1000,
      text: clean(r.snippet?.runs ? r.snippet.runs.map(x => x.text || '').join('') : r.snippet?.simpleText || ''),
    }))
    .filter(s => s.text);
}

export function extractJson(src, name) {
  const m = new RegExp(name + '\\s*=\\s*\\{').exec(src);
  if (!m) return null;
  const startIdx = m.index + m[0].length - 1;
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(src.slice(startIdx, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export function findAll(node, key, out = []) {
  if (node && typeof node === 'object') {
    if (!Array.isArray(node) && key in node) out.push(node[key]);
    for (const k in node) findAll(node[k], key, out);
  }
  return out;
}

function clean(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function decode(s) {
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return s;
}
