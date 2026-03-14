// api/generate.js

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

    const artistCount = Math.max(4, Math.min(10, Math.ceil(count / 3)));

    const systemPrompt = [
      'Tu es un expert musical spécialisé dans la préparation de playlists réellement exploitables sur Spotify.',
      `Tu dois proposer exactement ${artistCount} artistes.`,
      'Règles impératives :',
      '- ne renvoie que des artistes réels et connus de Spotify',
      '- n’invente jamais un artiste',
      '- ne renvoie jamais de morceaux',
      '- ne renvoie jamais d’albums',
      '- ne renvoie jamais de labels ou de genres seuls à la place d’un artiste',
      '- privilégie des artistes cohérents avec la demande de l’utilisateur',
      '- préfère des artistes suffisamment connus pour avoir des top tracks disponibles sur Spotify',
      '- mélange fidélité à la demande et accessibilité Spotify',
      'Réponds UNIQUEMENT avec un objet JSON valide.',
      'Pas de markdown. Pas de backticks. Pas de phrase avant ou après.',
      'Format obligatoire :',
      '{"playlist_title":"...","artists":["...","...","..."]}'
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
        max_tokens: 1800,
        temperature: 0.3,
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

    const playlistTitle =
      typeof parsed?.playlist_title === 'string' && parsed.playlist_title.trim()
        ? parsed.playlist_title.trim()
        : 'Ma playlist';

    const rawArtists = Array.isArray(parsed?.artists) ? parsed.artists : [];

    const cleanedArtists = [...new Set(
      rawArtists
        .map(artist => typeof artist === 'string' ? artist.trim() : '')
        .filter(Boolean)
        .filter(artist => !looksInvalidArtist(artist))
    )].slice(0, artistCount);

    if (cleanedArtists.length === 0) {
      return res.status(502).json({
        error: 'No valid artists returned by Anthropic',
        raw: parsed
      });
    }

    return res.status(200).json({
      playlist_title: playlistTitle,
      artists: cleanedArtists,
      requested_track_count: count
    });
  } catch (e) {
    console.error('API /generate ERROR =', e);
    return res.status(500).json({
      error: e.message || 'Internal Server Error'
    });
  }
}

function looksInvalidArtist(value) {
  const v = String(value || '').toLowerCase().trim();

  if (!v) return true;

  const banned = [
    'greatest hits',
    'best of',
    'various artists',
    'playlist',
    'soundtrack',
    'compilation',
    'anthology',
    'complete recordings',
    'deluxe edition'
  ];

  return banned.some(pattern => v.includes(pattern));
}
