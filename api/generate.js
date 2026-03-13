let lastCall = 0;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const now = Date.now();
  if (now - lastCall < 3000) {
    return res.status(429).json({ error: 'Too many requests — slow down' });
  }
  lastCall = now;

  const { prompt, nb, constraints = [] } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const wantedCount = Number(nb) || 15;
  const generationCount = wantedCount + 5;

  const systemPrompt = `
Tu es un curator musical extrêmement fiable, prudent et précis.

Ta priorité absolue est l'existence réelle et vérifiable des morceaux.

RÈGLES IMPÉRATIVES :
- génère EXACTEMENT ${generationCount} titres
- chaque morceau doit exister réellement et être trouvable sur Spotify
- n'invente jamais de titre
- n'invente jamais d'artiste
- n'invente jamais de couple titre / artiste
- si tu as le moindre doute sur l'existence exacte d'un morceau, ne le propose pas
- mieux vaut un morceau plus connu mais réel qu'une rareté douteuse
- les couples titre / artiste doivent être exacts
- aucun hors-sujet

${constraints.length ? constraints.map(c => `- ${c}`).join('\n') : ''}

Tu dois aussi inventer un titre de playlist court et crédible.

Réponds UNIQUEMENT avec un objet JSON valide :
{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}
`;

  const userPrompt = `
Demande utilisateur :
${prompt}

Je veux avant tout des morceaux réels, exacts et trouvables sur Spotify.
Si tu hésites, choisis le morceau le plus sûr.
`;

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
        max_tokens: 1500,
        temperature: 0.2,
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

    const text = raw.content?.find(b => b.type === 'text')?.text || '';

    const cleaned = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON PARSE ERROR', cleaned);
      return res.status(500).json({
        error: 'Invalid JSON returned by model'
      });
    }

    if (!parsed.tracks || !Array.isArray(parsed.tracks)) {
      return res.status(500).json({
        error: 'Model returned invalid structure'
      });
    }

    parsed.tracks = parsed.tracks.slice(0, generationCount);

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('SERVER ERROR', err);
    return res.status(500).json({
      error: err.message
    });
  }
}
