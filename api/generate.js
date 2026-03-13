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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `Tu es un curator musical haut de gamme, érudit, subtil et crédible.

Tu crées des playlists Spotify réellement désirables, pas des listes génériques.

Règles impératives :
- génère exactement ${nb || 15} titres
- chaque morceau doit être réel, crédible et trouvable sur Spotify
- évite les choix paresseux, trop évidents ou ultra-mainstream sauf s’ils sont artistiquement indispensables
- varie les artistes, les époques, les niveaux de notoriété et les textures sonores quand c’est pertinent
- évite les doublons d’artiste
- cherche un équilibre entre morceaux immédiatement séduisants, excellents choix moins attendus, et découvertes raffinées
- crée une playlist cohérente mais pas monotone
- privilégie le goût, la personnalité, la surprise et la profondeur curatoriale
- donne l’impression qu’un vrai expert passionné a composé la playlist

Crée aussi un titre de playlist court, élégant et mémorable.

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni backticks, au format exact :
{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}`,
        messages: [
          {
            role: 'user',
            content: `Demande utilisateur : ${prompt}

Je veux une playlist avec une vraie identité, de la variété, et des choix pas trop prévisibles.`
          }
        ]
      })
    });

    const data = await response.json();
    console.log('ANTHROPIC STATUS =', response.status);
    console.log('ANTHROPIC DATA =', JSON.stringify(data));

    if (!response.ok) {
      return res.status(500).json({
        error: 'Anthropic request failed',
        details: data
      });
    }

    const text = data.content?.find(block => block.type === 'text')?.text?.trim();

    if (!text) {
      return res.status(500).json({
        error: 'Anthropic returned no text content',
        details: data
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (parseError) {
      return res.status(500).json({
        error: 'Invalid JSON returned by Anthropic',
        raw: text
      });
    }

    if (!parsed.playlist_title || !Array.isArray(parsed.tracks)) {
      return res.status(500).json({
        error: 'JSON structure invalid',
        raw: parsed
      });
    }

    return res.status(200).json(parsed);
  } catch (e) {
    console.error('API /generate ERROR =', e);
    return res.status(500).json({ error: e.message || 'Internal Server Error' });
  }
}
