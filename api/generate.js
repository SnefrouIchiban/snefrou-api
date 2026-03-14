// api/generate.js

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
const MUSICBRAINZ_USER_AGENT = 'OctopusGarden/1.0 (https://snefrou-api.vercel.app)';

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

    const playlistTitle = buildPlaylistTitleFromPrompt(prompt);

    const validatedPool = [];
    const seenKeys = new Set();

    // Version allégée pour Vercel
    const targetValidatedPoolSize = Math.max(count + 8, 18);

    for (let pass = 1; pass <= 2; pass += 1) {
      if (validatedPool.length >= targetValidatedPoolSize) break;

      const remainingPool = targetValidatedPoolSize - validatedPool.length;
      const candidateTarget = pass === 1
        ? Math.max(remainingPool * 2, 18)
        : Math.max(remainingPool, 10);

      const candidates = await generateCandidateTracksWithRetry({
        prompt,
        requestedCount: count,
        candidateTarget,
        pass,
        alreadyValidated: validatedPool,
        alreadyRejectedOrSeen: [...seenKeys]
      });

      for (const candidate of candidates) {
        if (validatedPool.length >= targetValidatedPoolSize) break;

        const originalKey = buildPairKey(candidate.title, candidate.artist);
        if (!originalKey || seenKeys.has(originalKey)) continue;
        seenKeys.add(originalKey);

        const validation = await validateTrackAgainstMusicBrainz(candidate.title, candidate.artist);

        // pause légère seulement
        await sleep(120);

        if (!validation.ok) continue;

        const validatedTrack = {
          title: validation.title,
          artist: validation.artist,
          duration: candidate.duration || ''
        };

        const validatedKey = buildPairKey(validatedTrack.title, validatedTrack.artist);
        if (!validatedKey) continue;

        if (validatedPool.some(t => buildPairKey(t.title, t.artist) === validatedKey)) {
          continue;
        }

        validatedPool.push(validatedTrack);
      }
    }

    if (validatedPool.length === 0) {
      return res.status(502).json({
        error: 'No validated tracks could be produced'
      });
    }

    const rankedTracks = await rankValidatedTracks({
      prompt,
      validatedTracks: validatedPool,
      count
    });

    const finalTracks = applyRanking({
      validatedTracks: validatedPool,
      rankedTracks,
      count
    });

    if (finalTracks.length === 0) {
      return res.status(502).json({
        error: 'Ranking produced no usable tracks'
      });
    }

    return res.status(200).json({
      playlist_title: playlistTitle,
      tracks: finalTracks,
      ...(finalTracks.length < count
        ? { warning: `Seulement ${finalTracks.length} titres validés sur ${count} demandés.` }
        : {})
    });
  } catch (e) {
    console.error('API /generate ERROR =', e);
    return res.status(500).json({
      error: e.message || 'Internal Server Error'
    });
  }
}

async function generateCandidateTracksWithRetry(args, maxAttempts = 2) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await generateCandidateTracks(args);
    } catch (e) {
      lastError = e;
      console.error(`generateCandidateTracks attempt ${attempt} failed:`, e.message);
      await sleep(250);
    }
  }

  throw lastError;
}

async function generateCandidateTracks({
  prompt,
  requestedCount,
  candidateTarget,
  pass,
  alreadyValidated,
  alreadyRejectedOrSeen
}) {
  const validatedLines = alreadyValidated
    .map(track => `${track.title} — ${track.artist}`)
    .slice(0, 30);

  const seenLines = alreadyRejectedOrSeen
    .slice(0, 50)
    .map(key => key.replace('__', ' — '));

  const systemPrompt = [
    'Tu es un programmateur musical de très haut niveau, obsessionnel, cultivé, précis et anti-consensuel.',
    `L’utilisateur veut une playlist finale de ${requestedCount} morceaux.`,
    `Tu dois proposer exactement ${candidateTarget} couples titre/artiste candidats.`,
    'Ta mission n’est pas de proposer les morceaux les plus connus.',
    'Ta mission est de proposer les morceaux les plus justes, les plus inspirés et les moins évidents possible.',
    '',
    'Règles impératives :',
    '- ne renvoie que des morceaux réels',
    '- n’invente jamais de titre',
    '- n’invente jamais d’artiste',
    '- ne renvoie jamais d’albums',
    '- évite les live, remaster, deluxe, edit, bonus track, alternate take, versions obscures',
    '- évite les intitulés de compilations ou de releases',
    '- colle au plus près du ton, de l’époque, du style, de la géographie, de la couleur culturelle et émotionnelle du prompt',
    '- évite les propositions génériques, paresseuses ou grand public',
    '- évite autant que possible les tubes mondiaux, les titres les plus streamés, les morceaux signature ultra-connus et les recommandations trop prévisibles',
    '- préfère des morceaux excellents mais légèrement moins évidents',
    '- privilégie les deep cuts, perles cachées, morceaux d’album, titres cultes moins exposés, raretés accessibles, faces moins attendues d’artistes connus',
    '- n’utilise un immense tube que s’il est vraiment indispensable à la logique du prompt',
    '- si le prompt s’y prête, va chercher des artistes secondaires, des scènes locales, des titres moins canonisés',
    '- cherche la diversité, mais sans sacrifier la fidélité au prompt',
    '- si tu as un doute sérieux sur l’existence exacte d’un morceau, exclue-le',
    '',
    'Important :',
    '- la playlist doit donner l’impression d’avoir été faite par quelqu’un qui connaît vraiment la musique, pas par un algorithme paresseux',
    '- mieux vaut un morceau très juste et moins connu qu’un tube attendu',
    '- évite de sortir immédiatement les artistes les plus évidents du genre, de l’époque ou de l’ambiance',
    '',
    'Titres déjà validés :',
    validatedLines.length ? validatedLines.join(' | ') : 'aucun',
    'Titres déjà vus ou refusés :',
    seenLines.length ? seenLines.join(' | ') : 'aucun',
    '',
    'Réponds UNIQUEMENT avec un objet JSON valide.',
    'Ta réponse doit commencer par { et finir par } sans aucun texte avant ou après.',
    'Pas de markdown. Pas de backticks.',
    'Format obligatoire :',
    '{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}'
  ].join('\n');

  const userPrompt = pass === 1
    ? [
        `Passe ${pass}. Demande utilisateur : ${prompt}`,
        `Je veux exactement ${candidateTarget} candidats très proches de cette demande.`,
        'Interdiction de proposer les morceaux les plus connus, les titres signature ou les tubes mondiaux les plus évidents.',
        'Cherche des choix fins, crédibles, surprenants, cultivés, mais parfaitement cohérents avec la demande.',
        'Évite de me redonner des morceaux déjà vus.'
      ].join('\n')
    : [
        `Passe ${pass}. Demande utilisateur : ${prompt}`,
        `Je veux exactement ${candidateTarget} candidats très proches de cette demande.`,
        'Tu peux légèrement réouvrir le champ, mais évite toujours les suggestions paresseuses, trop attendues ou trop mainstream.',
        'Cherche des choix éditoriaux solides, élégants et moins prévisibles.',
        'Évite de me redonner des morceaux déjà vus.'
      ].join('\n');

  const data = await callAnthropicJson({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2600,
    temperature: 0.68,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt
      }
    ],
    errorPrefix: 'Anthropic candidate generation failed'
  });

  const textBlock = data.content?.find(block => block.type === 'text');
  const text = textBlock?.text?.trim();

  if (!text) {
    throw new Error('Anthropic returned no text content');
  }

  let parsed;
  try {
    parsed = safeParseAnthropicJson(text);
  } catch {
    console.error('CANDIDATE RAW TEXT =', text);
    throw new Error('Invalid JSON returned by Anthropic during candidate generation');
  }

  const rawTracks = Array.isArray(parsed?.tracks) ? parsed.tracks : [];

  return rawTracks
    .map(track => ({
      title: typeof track?.title === 'string' ? track.title.trim() : '',
      artist: typeof track?.artist === 'string' ? track.artist.trim() : '',
      duration: typeof track?.duration === 'string' ? track.duration.trim() : ''
    }))
    .filter(track => track.title && track.artist)
    .filter(track => !looksLikeAlbum(track.title))
    .filter(track => !looksLikeReleaseNoise(track.title))
    .filter(track => !looksLikeGarbage(track.title, track.artist));
}

async function rankValidatedTracks({ prompt, validatedTracks, count }) {
  const limitedPool = validatedTracks.slice(0, 40);

  const systemPrompt = [
    'Tu es un programmateur musical de très haut niveau.',
    'Tu dois sélectionner les meilleurs morceaux parmi une liste de morceaux déjà validés.',
    'Tous les morceaux proposés existent réellement.',
    'Ta mission est de composer une sélection finale brillante, cohérente, surprenante et peu évidente.',
    '',
    'Priorités :',
    '- coller au plus près du prompt utilisateur',
    '- éviter les tubes évidents ET les choix canonisés',
    '- éviter les morceaux que quelqu’un de simplement cultivé proposerait spontanément',
    '- privilégier les morceaux qui donnent l’impression d’une écoute réelle des albums',
    '- privilégier des choix témoignant d’une connaissance intime des scènes musicales',
    '- éviter les morceaux les plus cités dans les playlists éditoriales classiques',
    '- éviter les redondances esthétiques',
    '- éviter plusieurs morceaux qui remplissent exactement la même fonction',
    '- la sélection doit refléter une vision esthétique implicite et subjective',
    '- faire une vraie sélection de curateur exigeant, pas une liste algorithmique',
    '- éviter de surreprésenter un même artiste',
    '',
    `Tu dois choisir exactement ${Math.min(count, limitedPool.length)} morceaux.`,
    '',
    'Réponds UNIQUEMENT avec un objet JSON valide.',
    'Ta réponse doit commencer par { et finir par } sans aucun texte avant ou après.',
    'Pas de markdown. Pas de backticks.',
    'Format obligatoire :',
    '{"tracks":[{"title":"...","artist":"..."}]}'
  ].join('\n');

  const userPrompt = [
    `Demande utilisateur : ${prompt}`,
    `Choisis exactement ${Math.min(count, limitedPool.length)} morceaux parmi cette liste validée :`,
    ...limitedPool.map(track => `- ${track.title} — ${track.artist}`)
  ].join('\n');

  const data = await callAnthropicJson({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1400,
    temperature: 0.55,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt
      }
    ],
    errorPrefix: 'Anthropic ranking failed'
  });

  const textBlock = data.content?.find(block => block.type === 'text');
  const text = textBlock?.text?.trim();

  if (!text) {
    throw new Error('Anthropic returned no ranking text');
  }

  let parsed;
  try {
    parsed = safeParseAnthropicJson(text);
  } catch {
    console.error('RANKING RAW TEXT =', text);
    throw new Error('Invalid JSON returned by Anthropic during ranking');
  }

  const ranked = Array.isArray(parsed?.tracks) ? parsed.tracks : [];

  return ranked
    .map(track => ({
      title: typeof track?.title === 'string' ? track.title.trim() : '',
      artist: typeof track?.artist === 'string' ? track.artist.trim() : ''
    }))
    .filter(track => track.title && track.artist);
}

function applyRanking({ validatedTracks, rankedTracks, count }) {
  const validatedMap = new Map();

  for (const track of validatedTracks) {
    validatedMap.set(buildPairKey(track.title, track.artist), track);
  }

  const selected = [];
  const seen = new Set();

  for (const ranked of rankedTracks) {
    const key = buildPairKey(ranked.title, ranked.artist);
    if (!key || seen.has(key)) continue;

    const realTrack = validatedMap.get(key);
    if (!realTrack) continue;
    if (!canAcceptArtistOnce(selected, realTrack.artist)) continue;

    selected.push(realTrack);
    seen.add(key);

    if (selected.length >= count) break;
  }

  if (selected.length < count) {
    for (const track of validatedTracks) {
      const key = buildPairKey(track.title, track.artist);
      if (!key || seen.has(key)) continue;
      if (!canAcceptArtistOnce(selected, track.artist)) continue;

      selected.push(track);
      seen.add(key);

      if (selected.length >= count) break;
    }
  }

  return selected.slice(0, count);
}

function canAcceptArtistOnce(currentTracks, artistName) {
  const normalizedArtist = normalize(artistName);
  return !currentTracks.some(track => normalize(track.artist) === normalizedArtist);
}

async function validateTrackAgainstMusicBrainz(inputTitle, inputArtist) {
  const exactQuery = `recording:"${escapeLucene(inputTitle)}" AND artist:"${escapeLucene(inputArtist)}"`;
  const looseQuery = `"${escapeLucene(inputTitle)}" AND "${escapeLucene(inputArtist)}"`;

  const exactResults = await searchMusicBrainzRecordings(exactQuery, 4);
  const looseResults = exactResults.length ? [] : await searchMusicBrainzRecordings(looseQuery, 6);

  const candidates = [...exactResults, ...looseResults];

  let best = null;
  let bestScore = -Infinity;

  for (const rec of candidates) {
    const recTitle = typeof rec?.title === 'string' ? rec.title.trim() : '';
    const recArtist = extractArtistCredit(rec);

    if (!recTitle || !recArtist) continue;
    if (looksLikeReleaseNoise(recTitle)) continue;
    if (looksLikeGarbage(recTitle, recArtist)) continue;

    const score = scoreMusicBrainzMatch(inputTitle, inputArtist, recTitle, recArtist);

    if (score > bestScore) {
      bestScore = score;
      best = {
        title: recTitle,
        artist: recArtist,
        score
      };
    }
  }

  if (!best) {
    return { ok: false };
  }

  if (best.score >= 180) {
    return {
      ok: true,
      title: best.title,
      artist: best.artist
    };
  }

  if (best.score >= 145) {
    return {
      ok: true,
      title: best.title,
      artist: best.artist
    };
  }

  return { ok: false };
}

async function searchMusicBrainzRecordings(query, limit) {
  const url =
    `${MUSICBRAINZ_BASE}/recording` +
    `?query=${encodeURIComponent(query)}` +
    `&limit=${limit}` +
    `&fmt=json`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': MUSICBRAINZ_USER_AGENT,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data?.recordings) ? data.recordings : [];
}

async function callAnthropicJson({
  model,
  max_tokens,
  temperature,
  system,
  messages,
  errorPrefix
}) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens,
      temperature,
      system,
      messages
    })
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`${errorPrefix}: non-JSON response`);
  }

  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${rawText}`);
  }

  return data;
}

function safeParseAnthropicJson(text) {
  const cleaned = stripCodeFences(text);

  try {
    return JSON.parse(cleaned);
  } catch {}

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const possibleJson = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(possibleJson);
    } catch {}
  }

  throw new Error('Could not parse JSON from Anthropic response');
}

function extractArtistCredit(recording) {
  const artistCredit = Array.isArray(recording?.['artist-credit'])
    ? recording['artist-credit']
    : [];

  const parts = artistCredit
    .map(part => {
      if (typeof part?.name === 'string') return part.name.trim();
      if (typeof part === 'string') return part.trim();
      return '';
    })
    .filter(Boolean);

  return parts.join(' ');
}

function scoreMusicBrainzMatch(inputTitle, inputArtist, foundTitle, foundArtist) {
  let score = 0;

  const t1 = normalize(inputTitle);
  const a1 = normalize(inputArtist);
  const t2 = normalize(foundTitle);
  const a2 = normalize(foundArtist);

  if (t1 === t2) score += 115;
  else if (t2.includes(t1) || t1.includes(t2)) score += 75;

  if (a1 === a2) score += 115;
  else if (a2.includes(a1) || a1.includes(a2)) score += 75;

  if (looksLikeReleaseNoise(foundTitle)) score -= 60;
  if (hasManyVersionTokens(foundTitle)) score -= 25;

  return score;
}

function buildPairKey(title, artist) {
  const t = normalize(title);
  const a = normalize(artist);
  if (!t || !a) return '';
  return `${t}__${a}`;
}

function normalize(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeLucene(str) {
  return String(str || '').replace(/([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
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

function looksLikeReleaseNoise(value) {
  const t = normalize(value);
  const badPatterns = [
    'live',
    'remaster',
    'remastered',
    'deluxe',
    'bonus track',
    'alternate take',
    'radio edit',
    'extended mix',
    'instrumental version',
    'karaoke',
    'original soundtrack',
    'motion picture soundtrack'
  ];
  return badPatterns.some(pattern => t.includes(pattern));
}

function hasManyVersionTokens(value) {
  const t = normalize(value);
  const tokens = ['live', 'edit', 'mix', 'version', 'remaster', 'take'];
  let count = 0;
  for (const token of tokens) {
    if (t.includes(token)) count += 1;
  }
  return count >= 2;
}

function looksLikeGarbage(title, artist) {
  const combined = `${normalize(title)} ${normalize(artist)}`;
  const banned = [
    'various artists',
    'unknown artist',
    'tracklist',
    'disc 1',
    'disc 2',
    'side a',
    'side b'
  ];
  return banned.some(pattern => combined.includes(pattern));
}

function buildPlaylistTitleFromPrompt(prompt) {
  const clean = String(prompt || '').trim();
  if (!clean) return 'Ma playlist';
  return clean.length > 80 ? clean.slice(0, 80).trim() : clean;
}

function stripCodeFences(text) {
  return String(text || '').replace(/```json|```/gi, '').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
