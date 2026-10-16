// Synthetic data for ?demo: lets anyone see the UI without a Google account or an OAuth client.
const DAY = 86400000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHANNELS = [
  ['Atelier Lumière', 'Photo et lumière naturelle'], ['Code & Café', 'Dev web'], ['Les Carnets du Vélo', 'Voyage à vélo'],
  ['Cuisine du Dimanche', 'Recettes'], ['Quantum Bretagne', 'Physique'], ['Mécanique Claire', 'Réparation auto'],
  ['Histoire de Poche', 'Histoire'], ['Synthé Club', 'Musique électronique'], ['Petit Jardin', 'Jardinage'],
  ['Retro Octets', 'Jeux rétro'], ['Maths en Marche', 'Mathématiques'], ['Trail & Brume', 'Course en montagne'],
  ['Bricolo Malin', 'Bricolage'], ['Cinéma de Quartier', 'Critique de films'], ['Ciel Profond', 'Astronomie'],
  ['Le Labo du Fer', 'Forge'], ['Lingua Facile', 'Langues'], ['Pixel Aquarelle', 'Illustration'],
];

const TITLES = [
  'Ce que personne ne vous dit sur', 'Je teste pendant 30 jours', 'La méthode simple pour', 'Pourquoi tout le monde se trompe sur',
  'Guide complet pour débuter', "J'ai tout reconstruit en un week-end", 'Les 7 erreurs à éviter', 'Réponse à vos questions sur',
  'Le test ultime', 'Ce qui a changé cette année',
];

function art(seed, label) {
  const hue = (seed * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 65% 30%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="160" y="105" font-family="sans-serif" font-size="64" font-weight="700" fill="rgba(255,255,255,.85)" text-anchor="middle">${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

export async function fillDemoCache(cache, now = Date.now()) {
  const rand = rng(42);
  const channels = [];
  const videos = [];
  CHANNELS.forEach(([title, topic], ci) => {
    const subs = Math.round(10 ** (3.3 + rand() * 3.2));
    const hidden = ci === 5;
    const base = subs * (0.02 + rand() * 0.14);
    const sparse = ci === 3 || ci === 14; // few videos -> "peu de données"
    const count = sparse ? 4 : 40;
    const id = `demo-${ci}`;
    channels.push({
      id, title, thumb: '', subscriberCount: hidden ? 0 : subs, hiddenSubscriberCount: hidden,
      uploads: null, loadedAt: now,
    });
    let age = 0.3 + rand() * 2;
    for (let i = 0; i < count; i++) {
      const roll = rand();
      const isShort = roll < 0.12;
      const isLive = roll > 0.96;
      const hype = rand() < 0.08 ? 3 + rand() * 6 : 0.4 + rand() * 1.4;
      const f = 1 - Math.exp(-age / 3);
      const views = Math.round(base * hype * Math.min(1, f + 0.05));
      const t = TITLES[Math.floor(rand() * TITLES.length)];
      videos.push({
        id: `${id}:${i}`, channelId: id, title: `${t} ${topic.toLowerCase()}`,
        publishedAt: new Date(now - age * DAY).toISOString(),
        thumb: art(ci * 7 + i, title[0]),
        duration: isShort ? 40 : 300 + Math.floor(rand() * 1800),
        views, fetchedAt: now,
        excluded: isLive ? 'live' : isShort ? 'short' : null,
      });
      age += sparse ? 9 + rand() * 6 : 1 + rand() * 5;
    }
  });
  await cache.putMany('channels', channels);
  await cache.putMany('videos', videos);
  await cache.setMeta('lastFull', now - 2 * 3600000);
  await cache.setMeta('lastLight', now - 2 * 3600000);
  await cache.setMeta('lastSubs', now - 2 * 3600000);
}
