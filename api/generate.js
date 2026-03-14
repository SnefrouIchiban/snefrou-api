// api/generate.js

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
const MUSICBRAINZ_USER_AGENT = 'Snefrou/1.0 ( https://snefrou-api.vercel.app )';

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

    const accepted = [];
    const softValidatedPool = [];
    const seenPairKeys = new Set();
    const rejectedPairKeys = new Set();

    const maxPasses = 5;

    for (let pass = 1; pass <= maxPasses; pass += 1) {
      if (accepted.length >= count) break;

      const missing = count - accepted.length;
      const candidateTarget = computeCandidateTarget(missing, pass);

      const candidates = await generateCandidateTracks({
        prompt,
        requestedCount: count,
        candidateTarget,
        accepted,
        rejectedPairKeys,
        pass
      });

      for (const candidate of candidates) {
        if (accepted.length >= count) break;

        const pairKey = buildPairKey(candidate.title, candidate.artist);
        if (!pairKey) continue;
        if (seenPairKeys.has(pairKey) || rejectedPairKeys.has(pairKey)) continue;

        seenPairKeys.add(pairKey);

        const validation = await validateTrackAgainstMusicBrainz(candidate.title, candidate.artist);

        // MusicBrainz: on ralentit volontairement
        await sleep(1100);

        if (!validation.ok) {
          rejectedPairKeys.add(pairKey);
          continue;
        }

        const validatedTrack = {
          title: validation.title,
          artist: validation.artist,
          duration: candidate.duration || ''
        };

        const validatedKey = buildPairKey(validatedTrack.title, validatedTrack.artist);
        if (!validatedKey) continue;
        if (accepted.some(track => buildPairKey(track.title, track.artist) === validatedKey)) {
          continue;
        }
        if (softValidatedPool.some(track => buildPairKey(track.title, track.artist) === validatedKey)) {
          continue;
        }

        if (validation.tier === 'strict') {
          accepted.push(validatedTrack);
        } else {
          softValidatedPool.push(validatedTrack);
        }
      }
    }

    if (accepted.length < count && softValidatedPool.length > 0) {
      for (const track of softValidatedPool) {
        if (accepted.length >= count) break;
        const key = buildPairKey(track.title, track.artist);
        if (!accepted.some(t => buildPairKey(t.title, t.artist) === key)) {
          accepted.push(track);
        }
      }
    }

    if (accepted.length === 0) {
      return res.status(502).json({
        error: 'No validated tracks could be produced'
      });
    }

    if (accepted.length < count) {
      return res.status(200).json({
        playlist_title: playlistTitle,
        tracks: accepted,
        warning: `Seulement ${accepted.length} titres validés sur ${count} demandés.`
      });
    }

    return res.status(200).json({
      playlist_title: playlistTitle,
      tracks: accepted.slice(0, count)
    });
  } catch (e) {
    console.error('API /generate ERROR =', e);
    return res.status(500).json({
      error: e.message || 'Internal Server Error'
    });
  }
}

function computeCandidateTarget(missing, pass) {
  if (pass === 1) return Math.max(missing * 5, 24);
  if (pass === 2) return Math.max(missing * 5, 22);
  if (pass === 3) return Math.max(missing * 4, 18);
  if (pass === 4) return Math.max(missing * 4, 16);
  return Math.max(missing * 3, 14);
}

async function generateCandidateTracks({
  prompt,
  requestedCount,
  candidateTarget,
  accepted,
  rejectedPairKeys,
  pass
}) {
  const exclusionLines = accepted
    .map(track => `${track.title} — ${track.artist}`)
    .slice(0, 50);

  const rejectedExamples = [...rejectedPairKeys]
    .slice(0, 40)
    .map(key => key.replace('__', ' — '));

  const systemPrompt = [
    'Tu es un expert musical extrêmement précis.',
    `L’utilisateur veut une playlist finale de ${requestedCount} morceaux.`,
    `Tu dois proposer exactement ${candidateTarget} couples titre/artiste candidats.`,
    'Objectif prioritaire : coller au plus près de la demande de l’utilisateur.',
    'Objectif secondaire : éviter les erreurs factuelles évidentes.',
    'Règles impératives :',
    '- ne renvoie que des morceaux réels',
    '- n’invente jamais de titre',
    '- n’invente jamais d’artiste',
    '- ne renvoie jamais d’albums',
    '- évite les live, remaster, deluxe, edit, bonus track, alternate take, versions obscures',
    '- évite les compilations et intitulés de release',
    '- privilégie la fidélité stylistique, émotionnelle, historique et culturelle au prompt',
    '- n’hésite pas à choisir des morceaux moins mainstream si cela colle mieux au prompt, mais ils doivent rester réels',
    '- évite de répéter les mêmes standards trop génériques si le prompt suggère une couleur plus spécifique',
    '- si tu as un doute sérieux sur l’existence exacte d’un morceau, tu dois l’exclure',
    'Exclusions déjà retenues :',
    exclusionLines.length ? exclusionLines.join(' | ') : 'aucune',
    'Exclusions déjà rejetées :',
    rejectedExamples.length ? rejectedExamples.join(' | ') : 'aucune',
    'Réponds UNIQUEMENT avec un objet JSON valide.',
    'Pas de markdown. Pas de backticks.',
    'Format obligatoire :',
    '{"playlist_title":"...","tracks":[{"title":"...","artist":"...","duration":"3:45"}]}'
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
      max_tokens: 3200,
      temperature: 0.35,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            `Passe ${pass}. Demande utilisateur : ${prompt}\n` +
            `Je veux ${candidateTarget} candidats très proches de cette demande.`
        }
      ]
    })
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error('Anthropic returned non-JSON response');
  }

  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${rawText}`);
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
      artist: typeof track?.artist === 'string' ? track.artist.trim() : '',
      duration: typeof track?.duration === 'string' ? track.duration.trim() : ''
    }))
    .filter(track => track.title && track.artist)
    .filter(track => !looksLikeAlbum(track.title))
    .filter(track => !looksLikeReleaseNoise(track.title))
    .filter(track => !looksLikeGarbage(track.title, track.artist));
}

async function validateTrackAgainstMusicBrainz(inputTitle, inputArtist) {
  const exactQuery = `recording:"${escapeLucene(inputTitle)}" AND artist:"${escapeLucene(inputArtist)}"`;
  const looseQuery = `"${escapeLucene(inputTitle)}" AND "${escapeLucene(inputArtist)}"`;

  const exactResults = await searchMusicBrainzRecordings(exactQuery, 6);
  const looseResults = exactResults.length ? [] : await searchMusicBrainzRecordings(looseQuery, 8);

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

  if (best.score >= 195) {
    return {
      ok: true,
      tier: 'strict',
      title: best.title,
      artist: best.artist
    };
  }

  if (best.score >= 165) {
    return {
      ok: true,
      tier: 'soft',
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

  if (t1 === t2) score += 125;
  else if (t2.includes(t1) || t1.includes(t2)) score += 80;

  if (a1 === a2) score += 125;
  else if (a2.includes(a1) || a1.includes(a2)) score += 80;

  if (looksLikeReleaseNoise(foundTitle)) score -= 70;
  if (hasManyVersionTokens(foundTitle)) score -= 35;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
