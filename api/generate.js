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
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const requestedNb = parseInt(body.nb, 10);
    const count = Number.isFinite(requestedNb)
      ? Math.max(5, Math.min(30, requestedNb))
      : 15;

    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
    }

    const systemPrompt = [
      'Tu es un expert musical spécialisé dans la création de playlists réellement exploitables sur Spotify.',
      `Génère exactement ${count} morceaux.`,
      'Règles impératives :',
      '- ne renvoie que des morceaux réellement connus et trouvables sur Spotify',
      '- n’inclus jamais d’albums',
      '- n’inclus jamais de compilations',
      '- n’inclus jamais de titres vagues ou ambigus',
      '- évite les live, remaster, deluxe, bonus track, alternate take, edit, version obscure',
      '- utilise le titre standard le plus courant',
      '- utilise l’artiste principal le plus connu sur Spotify',
      '- préfère des titres canoniques, simples à rechercher',
      '- si un morceau est ambigu, choisis un autre morceau',
      'Réponds UNIQUEMENT avec un objet JSON valide.',
      'Pas de markdown. Pas de backticks. Pas de phrase avant ou après.',
      'Format obligatoire :',
      '{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}'
    ].join('\n');

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        temperature: 0.4,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    const rawResponseText = await anthropicResponse.text();
    console.log('ANTHROPIC STATUS =', anthropicResponse.status);
    console.log('ANTHROPIC RAW =', rawResponseText);

    let data;
    try {
      data = JSON.parse(rawResponseText);
    } catch {
      return res.status(502).json({
        error: 'Anthropic returned non-JSON response',
        raw: rawResponseText
      });
    }

    if (!anthropicResponse.ok) {
      return res.status(anthropicResponse.status).json({
        error: 'Anthropic request failed',
        details: data
      });
    }

    const textBlock = data.content?.find(block => block.type === 'text');
    const text = textBlock?.text?.trim();

    if (!text) {
      return res.status(502).json({
        error: 'Anthropic returned no text content',
        details: data
      });
    }

    let parsed;
    try {
      const cleaned = text.replace(/```json|```/gi, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({
        error: 'Invalid JSON returned by Anthropic',
        raw: text
      });
    }

    if (!parsed || typeof parsed !== 'object') {
      return res.status(502).json({
        error: 'Invalid JSON structure',
        raw: parsed
      });
    }

    const playlistTitle =
      typeof parsed.playlist_title === 'string' && parsed.playlist_title.trim()
        ? parsed.playlist_title.trim()
        : 'Ma playlist';

    const rawTracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];

    const cleanedTracks = rawTracks
      .map(track => {
        const title = typeof track?.title === 'string' ? track.title.trim() : '';
        const artist = typeof track?.artist === 'string' ? track.artist.trim() : '';
        const duration = typeof track?.duration === 'string' ? track.duration.trim() : '';

        return { title, artist, duration };
      })
      .filter(track => track.title && track.artist)
      .filter(track => !looksLikeAlbum(track.title))
      .slice(0, count);

    if (cleanedTracks.length === 0) {
      return res.status(502).json({
        error: 'No valid tracks returned by Anthropic',
        raw: parsed
      });
    }

    return res.status(200).json({
      playlist_title: playlistTitle,
      tracks: cleanedTracks
    });
  } catch (e) {
    console.error('API /generate ERROR =', e);
    return res.status(500).json({
      error: e.message || 'Internal Server Error'
    });
  }
}

function looksLikeAlbum(title) {
  const t = String(title || '').toLowerCase();
  const badPatterns = [
    'greatest hits',
    'best of',
    'collection',
    'anthology',
    'complete recordings',
    'deluxe edition'
  ];
  return badPatterns.some(pattern => t.includes(pattern));
}
