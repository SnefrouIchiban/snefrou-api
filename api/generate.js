export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, nb } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
  }

  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Missing Spotify server credentials' });
  }

  const wantedCount = Number(nb) || 15;

  const systemPrompt = `Tu es un curator musical extrêmement fiable, prudent et précis.

Ta priorité absolue est l'existence réelle et vérifiable des morceaux.

RÈGLES IMPÉRATIVES :
- propose un peu plus que nécessaire pour permettre validation et filtrage
- vise ${Math.max(wantedCount + 8, wantedCount + 5)} titres
- n'invente jamais de titre
- n'invente jamais d'artiste
- n'invente jamais de couple titre / artiste
- si tu as le moindre doute sur l'existence exacte d'un morceau, ne le propose pas
- mieux vaut un morceau connu mais exact qu'une rareté douteuse
- aucun hors-sujet
- réponds uniquement avec du JSON valide

Format exact :
{"playlist_title":"...","tracks":[{"title":"...","artist":"..."}]}`;

  const userPrompt = `Demande utilisateur :
${prompt}

Je veux avant tout des morceaux réels, exacts et trouvables sur Spotify.
Si tu hésites, choisis le morceau le plus sûr.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const raw = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error('ANTHROPIC ERROR', raw);
      return res.status(500).json({
        error: raw?.error?.message || 'Anthropic request failed',
        details: raw
      });
    }

    const text = raw.content?.find(block => block.type === 'text')?.text || '';
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON PARSE ERROR', cleaned);
      return res.status(500).json({ error: 'Invalid JSON returned by model' });
    }

    if (!parsed.playlist_title || !Array.isArray(parsed.tracks)) {
      return res.status(500).json({ error: 'Model returned invalid structure' });
    }

    const spotifyToken = await getSpotifyAccessToken(
      process.env.SPOTIFY_CLIENT_ID,
      process.env.SPOTIFY_CLIENT_SECRET
    );

    const deduped = dedupeTracks(parsed.tracks);
    const validated = [];

    for (const track of deduped) {
      if (validated.length >= wantedCount) break;

      const match = await resolveSpotifyTrack(spotifyToken, track.title, track.artist);
      if (match) {
        validated.push(match);
      }
    }

    if (!validated.length) {
      return res.status(200).json({
        playlist_title: parsed.playlist_title,
        tracks: []
      });
    }

    return res.status(200).json({
      playlist_title: parsed.playlist_title,
      tracks: validated.slice(0, wantedCount)
    });
  } catch (err) {
    console.error('SERVER ERROR', err);
    return res.status(500).json({
      error: err.message || 'Server error'
    });
  }
}

async function getSpotifyAccessToken(clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials'
    })
  });

  const data = await res.json();

  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Spotify token error');
  }

  return data.access_token;
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeTracks(tracks) {
  const seen = new Set();
  const out = [];

  for (const t of tracks || []) {
    if (!t || !t.title || !t.artist) continue;
    const key = normalize(`${t.title}|||${t.artist}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: String(t.title).trim(),
      artist: String(t.artist).trim()
    });
  }

  return out;
}

function msToDuration(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function pickBestSpotifyTrack(items, wantedTitle, wantedArtist) {
  if (!items?.length) return null;

  const nt = normalize(wantedTitle);
  const na = normalize(wantedArtist);

  let best = null;
  let bestScore = -Infinity;

  for (const item of items) {
    const itemTitle = normalize(item.name);
    const artistNames = (item.artists || []).map(a => normalize(a.name));
    const joinedArtists = artistNames.join(' ');

    const titleExact = itemTitle === nt;
    const titleClose = itemTitle.includes(nt) || nt.includes(itemTitle);

    const artistExact = artistNames.some(a => a === na);
    const artistClose = artistNames.some(a => a.includes(na) || na.includes(a));

    if (!artistExact && !artistClose) continue;

    let score = 0;

    if (titleExact) score += 100;
    else if (titleClose) score += 40;
    else score -= 100;

    if (artistExact) score += 200;
    else if (artistClose) score += 120;

    const full = `${itemTitle} ${joinedArtists}`;
    if (full.includes('karaoke')) score -= 200;
    if (full.includes('tribute')) score -= 200;
    if (full.includes('cover')) score -= 120;
    if (full.includes('remix')) score -= 60;
    if (full.includes('live')) score -= 30;

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}

async function resolveSpotifyTrack(token, title, artist) {
  const query = encodeURIComponent(`track:${title} artist:${artist}`);

  const res = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=5`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const data = await res.json();

  if (!res.ok) {
    return null;
  }

  const items = data.tracks?.items || [];
  const winner = pickBestSpotifyTrack(items, title, artist);

  if (!winner) return null;

  return {
    title: winner.name,
    artist: winner.artists?.map(a => a.name).join(', ') || artist,
    duration: msToDuration(winner.duration_ms),
    uri: winner.uri,
    spotify_url: winner.external_urls?.spotify || null
  };
}
