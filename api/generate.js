function buildConstraints(options = {}) {
  const constraints = [];

  if (options.fameLevel === 'mix') {
    constraints.push('mélange des morceaux connus et des morceaux moins connus');
  }
  if (options.fameLevel === 'underground') {
    constraints.push('privilégie des morceaux peu connus et évite les choix trop évidents');
  }
  if (options.fameLevel === 'deep') {
    constraints.push('privilégie des deep cuts, raretés, faces B, morceaux moins exposés');
  }
  if (options.fameLevel === 'no-hits') {
    constraints.push('évite les tubes, les hits et les morceaux les plus célèbres');
  }

  if (options.selectionMode === 'tracks') {
    constraints.push('ne propose que des morceaux individuels, pas des albums entiers');
  }
  if (options.selectionMode === 'albums') {
    constraints.push('propose des morceaux représentatifs d’albums cohérents ; ne réponds pas avec des noms d’albums seuls car le format de sortie doit rester composé de tracks');
  }
  if (options.selectionMode === 'mixed') {
    constraints.push('tu peux alterner grands morceaux et titres plus album-oriented, mais la sortie doit rester une liste de tracks');
  }

  if (options.vocalMode === 'instrumental') {
    constraints.push('privilégie strictement les morceaux instrumentaux');
  }
  if (options.vocalMode === 'vocal') {
    constraints.push('les morceaux chantés sont autorisés');
  }

  if (options.strictness === 'high') {
    constraints.push('reste très cohérent avec le genre, l’époque, le pays, la scène, les textures et l’ambiance demandés');
  }
  if (options.strictness === 'very-high') {
    constraints.push('tolérance zéro pour les hors-sujet : aucun morceau ne doit sortir du périmètre stylistique demandé');
  }

  if (options.includeArtists) {
    constraints.push(`inclure si pertinent certains artistes explicitement demandés : ${options.includeArtists}`);
  }

  if (options.excludeArtists) {
    constraints.push(`exclure strictement tout ce qui se rapporte à : ${options.excludeArtists}`);
  }

  if (options.decades) {
    constraints.push(`respecter prioritairement les décennies suivantes : ${options.decades}`);
  }

  if (options.countries) {
    constraints.push(`privilégier les pays, scènes ou origines suivantes : ${options.countries}`);
  }

  return constraints;
}

function cleanJsonText(text) {
  return text.replace(/```json|```/g, '').trim();
}

function normalizeTrack(track) {
  return {
    title: String(track.title || '').trim(),
    artist: String(track.artist || '').trim(),
    duration: String(track.duration || '').trim()
  };
}

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
    const { prompt, nb, options = {} } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
    }

    const wantedCount = Number(nb) || 15;
    const constraints = buildConstraints(options);

    const systemPrompt = `Tu es un curator musical haut de gamme, érudit, subtil, précis et discipliné.

Ta mission est de créer une playlist Spotify réellement désirable, crédible et cohérente avec la demande de l'utilisateur.

Règles impératives :
- génère exactement ${wantedCount} titres
- chaque morceau doit être réel, crédible et trouvable sur Spotify
- donne la priorité absolue à l’exactitude des artistes et des titres
- ne propose jamais un morceau hors du périmètre stylistique demandé
- si l'utilisateur demande un genre, une époque, un pays, une scène, une texture, une ambiance ou un type d'orchestration précis, chaque morceau doit appartenir clairement à cet univers
- si un morceau est douteux, anachronique, trop éloigné, ou stylistiquement incohérent, il doit être exclu
- évite les choix paresseux, ultra-génériques ou arbitraires
- évite les doublons d'artistes sauf nécessité absolue
- cherche de la personnalité, de la cohérence, de la surprise maîtrisée et du goût
- si l'utilisateur demande un univers pointu, ne le pollue pas avec des titres mainstream ou d'un autre genre
- n’invente ni artistes ni morceaux
- si tu n’es pas sûr d’un couple titre / artiste, choisis un autre morceau plus certain

Contraintes supplémentaires :
${constraints.length ? constraints.map(c => `- ${c}`).join('\n') : '- aucune contrainte supplémentaire'}

Tu dois aussi inventer un titre de playlist court, élégant, crédible et mémorable.

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni backticks, au format exact :
{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}`;

    const userPrompt = `Demande utilisateur :
${prompt}

Exigence supplémentaire :
Je veux une playlist avec une identité forte, une vraie cohérence stylistique, et sans hors-sujet.
Les couples titre / artiste doivent être exacts.
Si un morceau ne correspond pas clairement à la demande, tu dois l'exclure.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2200,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
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
      parsed = JSON.parse(cleanJsonText(text));
    } catch {
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

    let tracks = parsed.tracks
      .map(normalizeTrack)
      .filter(t => t.title && t.artist)
      .slice(0, wantedCount);

    if (tracks.length === 0) {
      return res.status(500).json({
        error: 'No usable tracks returned',
        raw: parsed
      });
    }

    const validationPrompt = `Demande initiale :
${prompt}

Contraintes :
${constraints.length ? constraints.join('\n') : 'aucune contrainte supplémentaire'}

Playlist proposée :
${JSON.stringify({ playlist_title: parsed.playlist_title, tracks }, null, 2)}

Tâche :
- vérifie la cohérence stylistique de chaque morceau
- vérifie l’exactitude de chaque couple titre / artiste
- supprime tout morceau hors-sujet, anachronique, arbitraire, ou dont le couple titre / artiste semble douteux ou inventé
- remplace les morceaux supprimés par d'autres morceaux plus pertinents afin d'obtenir exactement ${wantedCount} titres
- conserve un niveau élevé de cohérence et de goût
- évite les hors-sujet grossiers
- réponds UNIQUEMENT avec le même format JSON valide`;

    const validationRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2200,
        messages: [
          { role: 'user', content: validationPrompt }
        ]
      })
    });

    const validationData = await validationRes.json();
    console.log('VALIDATION STATUS =', validationRes.status);
    console.log('VALIDATION DATA =', JSON.stringify(validationData));

    if (validationRes.ok) {
      const validationText = validationData.content?.find(block => block.type === 'text')?.text?.trim();
      if (validationText) {
        try {
          const validated = JSON.parse(cleanJsonText(validationText));
          if (validated.playlist_title && Array.isArray(validated.tracks)) {
            tracks = validated.tracks
              .map(normalizeTrack)
              .filter(t => t.title && t.artist)
              .slice(0, wantedCount);

            if (tracks.length > 0) {
              parsed.playlist_title = validated.playlist_title;
            }
          }
        } catch (e) {
          console.log('Validation JSON parse skipped:', e.message);
        }
      }
    }

    return res.status(200).json({
      playlist_title: parsed.playlist_title,
      tracks
    });
  } catch (e) {
    console.error('API /generate ERROR =', e);
    return res.status(500).json({ error: e.message || 'Internal Server Error' });
  }
}
