// api/generate.js

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
const MUSICBRAINZ_USER_AGENT = 'Snefrou/1.0 (https://snefrou-api.vercel.app)';

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
    const candidateTarget = Math.max(count * 3, 20);

    const candidates = await generateCandidateTracks({
      prompt,
      requestedCount: count,
      candidateTarget
    });

    const accepted = [];
    const softMatches = [];
    const seenKeys = new Set();

    for (const candidate of candidates) {
      if (accepted.length >= count) break;

      const originalKey = buildPairKey(candidate.title, candidate.artist);
      if (!originalKey || seenKeys.has(originalKey)) continue;
      seenKeys.add(originalKey);

      const validation = await validateTrackAgainstMusicBrainz(candidate.title, candidate.artist);

      await sleep(700);

      if (!validation.ok) continue;

      const track = {
        title: validation.title,
        artist: validation.artist,
        duration: candidate.duration || ''
      };

      const validatedKey = buildPairKey(track.title, track.artist);
      if (!validatedKey) continue;

      if (
        accepted.some(t => buildPairKey(t.title, t.artist) === validatedKey) ||
        softMatches.some(t => buildPairKey(t.title, t.artist) === validatedKey)
      ) {
        continue;
      }

      if (!canAcceptArtist(accepted, track.artist, count, false)) {
        if (validation.tier === 'strict') {
          softMatches.push(track);
        }
        continue;
      }

      if (validation.tier === 'strict') {
        accepted.push(track);
      } else {
        softMatches.push(track);
      }
    }

    if (accepted.length < count) {
      for (const track of softMatches) {
        if (accepted.length >= count) break;

        const key = buildPairKey(track.title, track.artist);
        if (accepted.some(t => buildPairKey(t.title, t.artist) === key)) {
          continue;
        }

        if (!canAcceptArtist(accepted, track.artist, count, true)) {
          continue;
        }

        accepted.push(track);
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

async function generateCandidateTracks({ prompt, requestedCount, candidateTarget }) {
  const systemPrompt = [
    'Tu es un expert musical extrêmement précis.',
    `L’utilisateur veut une playlist finale de ${requestedCount} morceaux.`,
    `Tu dois proposer exactement ${candidateTarget} couples titre/artiste candidats.`,
    'Objectif prioritaire : coller au plus près de la demande de l’utilisateur.',
    'Règles impératives :',
    '- ne renvoie que des morceaux réels',
    '- n’invente jamais de titre',
    '- n’invente jamais d’artiste',
    '- ne renvoie jamais d’albums',
    '- évite les live, remaster, deluxe, edit, bonus track, alternate take, versions obscures',
    '- évite les intitulés de release ou de compilation',
    '- privilégie les titres qui reflètent vraiment la couleur, l’époque, le ton et l’énergie du prompt',
    '- évite les propositions génériques si le prompt est précis',
    '- si tu as un doute sérieux sur l’existence exacte d’un morceau, exclue-le',
    '- évite de proposer trop de titres du même artiste',
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
      max_tokens: 2800,
      temperature: 0.35,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            `Demande utilisateur : ${prompt}\n` +
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

  const exactResults = await searchMusicBrainzRecordings(exactQuery, 5);
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

function canAcceptArtist(currentTracks, artistName, targetCount, allowSecondWave = false) {
  const normalizedArtist = normalize(artistName);
  const countForArtist = currentTracks.filter(
    track => normalize(track.artist) === normalizedArtist
  ).length;

  if (countForArtist >= 2) return false;

  if (!allowSecondWave && countForArtist >= 1) {
    const uniqueArtists = new Set(currentTracks.map(track => normalize(track.artist))).size;
    const remainingSlots = targetCount - currentTracks.length;
    if (uniqueArtists < targetCount && remainingSlots > 0) {
      return false;
    }
  }

  return true;
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
