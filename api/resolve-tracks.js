// api/resolve-tracks.js

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

    const spotifyToken =
      typeof body.spotifyToken === 'string'
        ? body.spotifyToken.trim()
        : '';

    const tracks = Array.isArray(body.tracks) ? body.tracks : [];

    if (!spotifyToken) {
      return res.status(400).json({ error: 'Missing spotifyToken' });
    }

    if (!tracks.length) {
      return res.status(400).json({ error: 'Missing tracks' });
    }

    const cleanedTracks = tracks
      .map(track => ({
        title: typeof track?.title === 'string' ? track.title.trim() : '',
        artist: typeof track?.artist === 'string' ? track.artist.trim() : '',
        duration: typeof track?.duration === 'string' ? track.duration.trim() : ''
      }))
      .filter(track => track.title && track.artist)
      .slice(0, 30);

    const resolved = [];
    const notFound = [];
    const cache = new Map();
    let cooldownUntil = 0;

    for (const track of cleanedTracks) {
      const cacheKey = `${normalize(track.title)}__${normalize(track.artist)}`;

      if (cache.has(cacheKey)) {
        const cachedUri = cache.get(cacheKey);
        if (cachedUri) {
          resolved.push({
            title: track.title,
            artist: track.artist,
            duration: track.duration,
            uri: cachedUri
          });
        } else {
          notFound.push({
            title: track.title,
            artist: track.artist,
            duration: track.duration,
            reason: 'not_found'
          });
        }
        continue;
      }

      const queries = buildQueries(track.title, track.artist);
      let bestItem = null;
      let bestScore = -Infinity;

      for (const query of queries) {
        const waitMs = cooldownUntil - Date.now();
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        const searchResult = await spotifySearch(spotifyToken, query);

        if (searchResult.type === 'rate_limit') {
          cooldownUntil = Date.now() + ((searchResult.retryAfter + 1) * 1000);
          const cooldownWait = cooldownUntil - Date.now();
          if (cooldownWait > 0) {
            await sleep(cooldownWait);
          }

          const retryResult = await spotifySearch(spotifyToken, query);

          if (retryResult.type === 'rate_limit') {
            cooldownUntil = Date.now() + ((retryResult.retryAfter + 1) * 1000);
            continue;
          }

          if (retryResult.type === 'error') {
            continue;
          }

          for (const item of retryResult.items) {
            const score = scoreTrack(item, track.title, track.artist);
            if (score > bestScore) {
              bestScore = score;
              bestItem = item;
            }
          }
        } else if (searchResult.type === 'error') {
          continue;
        } else {
          for (const item of searchResult.items) {
            const score = scoreTrack(item, track.title, track.artist);
            if (score > bestScore) {
              bestScore = score;
              bestItem = item;
            }
          }
        }

        if (bestScore >= 160) {
          break;
        }

        await sleep(350);
      }

      const uri = bestItem?.uri || null;
      cache.set(cacheKey, uri);

      if (uri) {
        resolved.push({
          title: track.title,
          artist: track.artist,
          duration: track.duration,
          uri
        });
      } else {
        notFound.push({
          title: track.title,
          artist: track.artist,
          duration: track.duration,
          reason: 'not_found'
        });
      }

      await sleep(350);
    }

    return res.status(200).json({
      resolved,
      notFound,
      uris: [...new Set(resolved.map(item => item.uri))]
    });
  } catch (e) {
    console.error('API /resolve-tracks ERROR =', e);
    return res.status(500).json({
      error: e.message || 'Internal Server Error'
    });
  }
}

async function spotifySearch(token, query) {
  const response = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  const raw = await response.text();

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (response.status === 401) {
    throw new Error('Spotify token expired');
  }

  if (response.status === 429) {
    return {
      type: 'rate_limit',
      retryAfter: parseInt(response.headers.get('Retry-After') || '2', 10),
      items: []
    };
  }

  if (!response.ok) {
    return {
      type: 'error',
      items: []
    };
  }

  return {
    type: 'ok',
    items: Array.isArray(data?.tracks?.items) ? data.tracks.items : []
  };
}

function buildQueries(title, artist) {
  const cleanTitle = String(title || '').trim();
  const cleanArtist = String(artist || '').trim();

  const titleNoParens = cleanTitle
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const titleNoDash = cleanTitle
    .split(' - ')[0]
    .trim();

  return [
    `track:${cleanTitle} artist:${cleanArtist}`,
    `${cleanTitle} ${cleanArtist}`,
    `${titleNoParens} ${cleanArtist}`,
    `${titleNoDash} ${cleanArtist}`
  ].filter(Boolean);
}

function scoreTrack(item, requestedTitle, requestedArtist) {
  let score = 0;

  const itemTitle = normalize(item?.name || '');
  const reqTitle = normalize(requestedTitle || '');
  const reqArtist = normalize(requestedArtist || '');
  const itemArtists = Array.isArray(item?.artists)
    ? item.artists.map(a => normalize(a.name))
    : [];

  if (itemTitle === reqTitle) score += 100;
  else if (itemTitle.includes(reqTitle) || reqTitle.includes(itemTitle)) score += 60;

  if (itemArtists.some(a => a === reqArtist)) score += 100;
  else if (itemArtists.some(a => a.includes(reqArtist) || reqArtist.includes(a))) score += 60;

  return score;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
