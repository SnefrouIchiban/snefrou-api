// api/generate.js

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'Snefrou/1.0 ( playlist validation ; contact: hello@example.com )';

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

    const collected = [];
    const seenPairs = new Set();
    const seenTitles = new Set();

    let pass = 0;
    const maxPasses = 4;

    while (collected.length < count && pass < maxPasses) {
      pass += 1;

      const missing = count - collected.length;
      const candidateTarget = Math.max(missing * 4, 20);

      const exclusionList = collected
        .map(track => `${track.title} — ${track.artist}`)
        .join(' | ');

      const candidates = await generateCandidates({
        prompt,
        requestedCount: count,
        candidateTarget,
        exclusionList,
        pass
      });

      for (const candidate of candidates) {
        if (collected.length >= count) break;

        const pairKey = normalize(candidate.title) + '__' + normalize(candidate.artist);
        const titleKey = normalize(candidate.title);

        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const validated = await validateTrackWithMusicBrainz(candidate.title, candidate.artist);

        await sleep(220);

        if (!validated) continue;

        const dedupeTitleArtist = normalize(validated.title) + '__' + normalize(validated.artist);
        if (collected.some(t => normalize(t.title) + '__' + normalize(t.artist) === dedupeTitleArtist)) {
          continue;
        }

        if (seenTitles.has(titleKey) && !sameLooseArtistFamily(collected, validated)) {
          continue;
        }

        seenTitles.add(titleKey);
        collected.push(validated);
      }
    }

    if (collected.length === 0) {
      return res.status(502).json({
        error: 'No validated tracks could be produced'
      });
    }

    if (collected.length < count) {
      return res.status(200).json({
        playlist_title: buildFallbackTitle(prompt),
        tracks: collected,
        warning: `Only ${collected.length} validated tracks found out of ${count} requested.`
      });
    }

    return res.status(200).json({
      playlist_title: buildFallbackTitle(prompt),
      tracks: collected.slice(0, count)
    });
  } catch (e) {
    console.error('API /generate ERROR =', e);
    return res.status(500).json({
      error: e.message || 'Internal Server Error'
    });
  }
}

async function generateCandidates({ prompt, requestedCount, candidateTarget, exclusionList, pass }) {
  const systemPrompt = [
    'Tu es un expert musical extrêmement prudent.',
    `L’utilisateur veut une playlist finale de ${requestedCount} morceaux validés.`,
    `Tu dois proposer exactement ${candidateTarget} couples titre/artiste candidats.`,
    'Règles impératives :',
    '- ne renvoie que des morceaux réellement célèbres ou clairement catalogués',
    '- n’invente jamais de titre',
    '- n’invente jamais d’artiste',
    '- ne renvoie jamais d’albums',
    '- évite les live, remaster, deluxe, bonus track, alternate take, version obscure, edit',
    '- évite les deep cuts, raretés, faces B peu connues',
    '- privilégie les titres canoniques, simples, massivement reconnaissables',
    '- si tu as un doute sur l’existence précise du morceau, tu dois l’exclure',
    '- ne renvoie pas deux fois le même morceau',
    '- ne renvoie pas les exclusions suivantes si elles existent : ' + (exclusionList || 'aucune'),
    'Réponds UNIQUEMENT avec un objet JSON valide.',
    'Format obligatoire :',
    '{"playlist_title":"...","tracks":[{"title":"...","artist":"..."}]}'
  ].join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            `Passe ${pass}. Demande utilisateur : ${prompt}\n` +
            `Je veux ${candidateTarget} candidats ultra sûrs.`
        }
      ]
    })
  });

  const raw = await response.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Anthropic returned non-JSON response');
  }

  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${raw}`);
  }

  const textBlock = data.content?.find(block => block.type === 'text');
  const text = textBlock?.text?.trim();

  if (!text) {
    throw new Error('Anthropic returned no text content');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/gi, '').trim());
  } catch {
    throw new Error('Invalid JSON returned by Anthropic');
  }

  const rawTracks = Array.isArray(parsed?.tracks) ? parsed.tracks : [];

  return rawTracks
    .map(track => ({
      title: typeof track?.title === 'string' ? track.title.trim() : '',
      artist: typeof track?.artist === 'string' ? track.artist.trim() : ''
    }))
    .filter(track => track.title && track.artist)
    .filter(track => !looksLikeAlbum(track.title))
    .filter(track => !looksLikeVersionNoise(track.title));
}

async function validateTrackWithMusicBrainz(title, artist) {
  const query = `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(artist)}"`;
  const url = `${MUSICBRAINZ_BASE}/recording?query=${encodeURIComponent(query)}&limit=5&fmt=json`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const recordings = Array.isArray(data?.recordings) ? data.recordings : [];

  let best = null;
  let bestScore = -Infinity;

  for (const rec of recordings) {
    const recTitle = typeof rec?.title === 'string' ? rec.title.trim() : '';
    const artistCredit = Array.isArray(rec?.['artist-credit']) ? rec['artist-credit'] : [];
    const recArtist = artistCredit
      .map(part => typeof part?.name === 'string' ? part.name.trim() : '')
      .filter(Boolean)
      .join(' & ');

    if (!recTitle || !recArtist) continue;

    if (looksLikeVersionNoise(recTitle)) continue;

    const score = scoreCandidate(title, artist, recTitle, recArtist);

    if (score > bestScore) {
      bestScore = score;
      best = {
        title: recTitle,
        artist: recArtist
      };
    }
  }

  if (!best || bestScore < 160) {
    return null;
  }

  return best;
}

function scoreCandidate(inputTitle, inputArtist, foundTitle, foundArtist) {
  let score = 0;

  const t1 = normalize(inputTitle);
  const a1 = normalize(inputArtist);
  const t2 = normalize(foundTitle);
  const a2 = normalize(foundArtist);

  if (t1 === t2) score += 120;
  else if (t2.includes(t1) || t1.includes(t2)) score += 70;

  if (a1 === a2) score += 120;
  else if (a2.includes(a1) || a1.includes(a2)) score += 70;

  if (looksLikeVersionNoise(foundTitle)) score -= 80;

  return score;
}

function sameLooseArtistFamily(collected, validated) {
  const targetArtist = normalize(validated.artist);
  return collected.some(track => normalize(track.artist) === targetArtist);
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

function looksLikeVersionNoise(title) {
  const t = normalize(title);
  const badPatterns = [
    'live',
    'remaster',
    'remastered',
    'deluxe',
    'bonus track',
    'alternate take',
    'edit',
    'radio edit',
    'extended mix',
    'version'
  ];
  return badPatterns.some(pattern => t.includes(pattern));
}

function buildFallbackTitle(prompt) {
  const clean = String(prompt || '').trim();
  if (!clean) return 'Ma playlist';
  return clean.length > 80 ? clean.slice(0, 80).trim() : clean;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
