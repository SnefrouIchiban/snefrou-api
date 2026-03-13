export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { prompt, nb, constraints = [] } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const wantedCount = Number(nb) || 15;

  // 🔴 on génère PLUS pour compenser les hallucinations
  const generationCount = Math.max(wantedCount * 2, 25);

  const systemPrompt = `
Tu es un curator musical extrêmement fiable, prudent et précis.

Ta priorité absolue est l'existence réelle et vérifiable des morceaux.

RÈGLES IMPÉRATIVES :

- génère EXACTEMENT ${generationCount} titres
- chaque morceau doit exister réellement et être trouvable sur Spotify
- n'invente jamais de titre
- n'invente jamais d'artiste
- n'invente jamais de couple titre / artiste
- si tu as le moindre doute sur l'existence exacte d'un morceau → NE LE PROPOSE PAS
- mieux vaut un morceau plus connu mais réel qu'une rareté douteuse
- les couples titre / artiste doivent être PARFAITEMENT exacts
- aucun hors-genre
- aucun mélange stylistique absurde
- aucun morceau moderne si l'époque demandée est ancienne
- privilégie les titres dont tu es très sûr

${constraints.length ? constraints.map(c => `- ${c}`).join('\n') : ''}

Tu dois aussi inventer un titre de playlist court, élégant et crédible.

Réponds UNIQUEMENT avec un objet JSON valide :

{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}
`;

  const userPrompt = `
Demande utilisateur :
${prompt}

Exigence supplémentaire :
Je veux avant tout des morceaux réels, exacts et trouvables sur Spotify.
Si tu hésites entre rare et sûr → choisis sûr.
Aucune invention.
Aucune approximation.
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
        max_tokens: 4000,
        temperature: 0.3,   // 🔴 moins de créativité = moins d’hallucinations
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const raw = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error("ANTHROPIC ERROR", raw);
      return res.status(500).json({
        error: 'Anthropic request failed',
        details: raw
      });
    }

    const text = raw.content?.find(b => b.type === 'text')?.text || '';

    // 🔴 nettoyage JSON
    let cleaned = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON PARSE ERROR", cleaned);
      return res.status(500).json({
        error: 'Invalid JSON returned by model'
      });
    }

    if (!parsed.tracks || !Array.isArray(parsed.tracks)) {
      return res.status(500).json({
        error: 'Model returned invalid structure'
      });
    }

    // 🔴 on coupe à la demande réelle
    parsed.tracks = parsed.tracks.slice(0, generationCount);

    return res.status(200).json(parsed);

  } catch (err) {

    console.error("SERVER ERROR", err);

    return res.status(500).json({
      error: err.message
    });
  }
}
