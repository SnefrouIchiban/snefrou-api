export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const { prompt, nb } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: `Tu es un expert musical qui crée des playlists Spotify précises. Génère exactement ${nb || 15} titres. Réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni backticks : {"playlist_title": "...", "tracks": [{"title": "...", "artist": "...", "duration": "3:45"}]}`, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.status(200).json(parsed);
  } catch (e) { res.status(500).json({ error: e.message }); }
}
