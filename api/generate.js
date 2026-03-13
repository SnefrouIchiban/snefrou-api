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

  try {
    const { prompt, nb } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
    }

    const wantedCount = Number(nb) || 15;

    const systemPrompt = `Tu es un curator musical extrêmement fiable, prudent et précis.

Ta priorité absolue est de proposer de vrais morceaux plausibles, connus ou vérifiables.

RÈGLES IMPÉRATIVES :
- génère exactement ${wantedCount} titres
- n'invente jamais de titre
- n'invente jamais d'artiste
- n'invente jamais de couple titre / artiste
- si tu hésites, choisis le morceau le plus sûr
- réponds uniquement avec du JSON valide

Format exact :
{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}`;

    const userPrompt = `Demande utilisateur :
${prompt}

Je veux avant tout des morceaux réels, exacts et crédibles.`;

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

    const rawText = await anthropicRes.text();

    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }

    if (!anthropicRes.ok) {
      return res.status(anthropicRes.status === 429 ? 429 : 500).json({
        error:
          data?.error?.message ||
          rawText ||
          'Anthropic request failed'
      });
    }

    if (!data) {
      return res.status(500).json({
        error: 'Anthropic returned non-JSON response'
      });
    }

    const text = data.content?.find(block => block.type === 'text')?.text || '';

    if (!text) {
      return res.status(500).json({
        error: 'Anthropic returned no text content'
      });
    }

    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({
        error: 'Invalid JSON returned by model',
        raw: cleaned
      });
    }

    if (!parsed.playlist_title || !Array.isArray(parsed.tracks)) {
      return res.status(500).json({
        error: 'Model returned invalid structure'
      });
    }

    const tracks = dedupeTracks(parsed.tracks)
      .slice(0, wantedCount)
      .map(t => ({
        title: t.title,
        artist: t.artist,
        duration: t.duration || '',
        uri: null,
        spotify_url: null
      }));

    return res.status(200).json({
      playlist_title: parsed.playlist_title,
      tracks
    });
  } catch (err) {
    console.error('API /generate ERROR =', err);
    return res.status(500).json({
      error: err?.message || 'Internal Server Error'
    });
  }
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

    const title = String(t.title).trim();
    const artist = String(t.artist).trim();
    const duration = String(t.duration || '').trim();
    const key = normalize(`${title}|||${artist}`);

    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ title, artist, duration });
  }

  return out;
}
