const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// Default admin key fallback
const DEFAULT_ADMIN_KEY = process.env.ADMIN_API_KEY || 'Lucky@000';

// Built-in registered businesses with Vercel frontend site URL
const DEFAULT_BUSINESSES = {
  saloon: {
    name: "Royal Saloon & Spa",
    type: "saloon",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_SALOON_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app"
  },
  demo: {
    name: "Demo Beauty Salon",
    type: "salon",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_DEMO_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app"
  }
};

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── FIFO Review Queue Storage (max 10 items per slug) ─────────────────────────
const MAX_QUEUE_SIZE = 10;
const reviewQueues   = {}; 
const recentReviews  = {}; 

// ── Analytics Tracker Storage ──────────────────────────────────────────────────
const analyticsStore = {
  totalScans: 0,
  uniqueIps: new Set(),
  deviceStats: { Smartphone: 0, Desktop: 0 },
  timeStats: { Morning: 0, Afternoon: 0, Evening: 0 },
  sourceStats: { 'Gemini AI Queue': 0, 'Initial Seed Queue': 0, 'Instant Fallback': 0 },
  logs: []
};

function recordScanEvent(slug, meta, reviewSource) {
  analyticsStore.totalScans++;
  if (meta.ip) analyticsStore.uniqueIps.add(meta.ip);

  const device = meta.deviceType || 'Smartphone';
  analyticsStore.deviceStats[device] = (analyticsStore.deviceStats[device] || 0) + 1;

  const tod = meta.timeOfDay || 'Afternoon';
  analyticsStore.timeStats[tod] = (analyticsStore.timeStats[tod] || 0) + 1;

  const src = reviewSource || 'FIFO Queue';
  analyticsStore.sourceStats[src] = (analyticsStore.sourceStats[src] || 0) + 1;

  analyticsStore.logs.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    slug: slug || 'saloon',
    ip: meta.ip || '127.0.0.1',
    deviceType: device,
    timeOfDay: tod,
    source: src
  });

  if (analyticsStore.logs.length > 100) {
    analyticsStore.logs.pop();
  }
}

// ── Multi-Angle Human Personas for Extreme Randomness ──────────────────────────
const PERSONAS = [
  "Casual & Short: 2 snappy sentences, very natural, started lowercase, mobile user vibe.",
  "Enthusiastic & Detailed: Happy customer praising the friendly staff, clean aesthetic, and great haircut/service.",
  "Walk-in Direct: Focus on unexpected quick availability, fair pricing, clean towels/tools, great result.",
  "Relaxing Spa Vibe: Focus on peaceful atmosphere, great smell, attentive stylist, leaving refreshed.",
  "Minimalist 5-Star: 20 to 30 words, punchy, honest, 10/10 recommendation."
];

const CASUAL_PHRASES = [
  "honestly", "super happy", "10/10", "hands down", "definitely coming back",
  "so glad I found this place", "left feeling great", "fresh and clean", "spot on", "worth every penny"
];

function seedQueueIfEmpty(slug, config) {
  if (!reviewQueues[slug]) reviewQueues[slug] = [];

  if (reviewQueues[slug].length === 0) {
    const name = config.name || 'Royal Saloon & Spa';
    const initialSeedReviews = [
      `honestly so happy with my visit to ${name}! staff were super friendly, clean place, and service was 10/10. definitely coming back.`,
      `Great experience at ${name}. Walked in and was greeted warmly right away. Very skilled team and relaxing vibe. Highly recommend!`,
      `Best saloon visit I've had in a while. Spotless clean, fair prices, and my stylist did an awesome job. Will be back for sure!`
    ];
    initialSeedReviews.forEach(rev => {
      reviewQueues[slug].push({
        review: rev,
        generated: false,
        source: 'initial-human-seed',
        timestamp: Date.now()
      });
    });
  }
}

function sanitizeSlug(s) {
  return s ? s.toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
}

function getBizConfig(slug) {
  const raw = process.env[`BIZ_${slug}`];
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return DEFAULT_BUSINESSES[slug] || null;
}

function adminAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== DEFAULT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized — provide valid x-api-key header or ?key= query param' });
  }
  next();
}

function getClientMetadata(req) {
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const ip = rawIp.split(',')[0].trim();
  const userAgent = req.headers['user-agent'] || 'Mobile Browser';
  const lang = req.headers['accept-language'] || 'en-US';

  const isMobile = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
  const deviceType = isMobile ? 'Smartphone' : 'Desktop';

  const hour = new Date().getHours();
  let timeOfDay = 'Afternoon';
  if (hour < 12) timeOfDay = 'Morning';
  else if (hour >= 18) timeOfDay = 'Evening';

  return { ip, userAgent, deviceType, lang, timeOfDay, timestamp: Date.now() };
}

// ── Background Worker: Generate new AI review with High Entropy ────────────────
async function generateAndEnqueueReview(slug, meta, customInput = {}) {
  const config = getBizConfig(slug) || {};
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) return;

  const type = config.type || 'saloon';
  const name = config.name || 'Royal Saloon & Spa';

  const selectedPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const selectedPhrase  = CASUAL_PHRASES[Math.floor(Math.random() * CASUAL_PHRASES.length)];
  const randomSeed      = `${Date.now()}_${Math.floor(Math.random() * 999999)}_${meta.ip}`;

  const fullPrompt =
    `You are a real everyday customer writing a quick 5-star Google review for "${name}", a ${type}.\n` +
    `Style persona: ${selectedPersona}\n` +
    `Include a natural casual phrase like "${selectedPhrase}".\n` +
    `CRITICAL: Sound completely human, non-AI, between 25 and 45 words. Output ONLY the review text. No quotes. Seed: ${randomSeed}`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent(fullPrompt);
    let reviewText = result.response.text().trim();
    reviewText = reviewText.replace(/^["']|["']$/g, '');

    if (!reviewQueues[slug]) reviewQueues[slug] = [];
    if (!recentReviews[slug]) recentReviews[slug] = new Set();

    if (recentReviews[slug].has(reviewText)) {
      return;
    }

    recentReviews[slug].add(reviewText);
    if (recentReviews[slug].size > 50) {
      const firstItem = recentReviews[slug].values().next().value;
      recentReviews[slug].delete(firstItem);
    }

    reviewQueues[slug].push({
      review: reviewText,
      generated: true,
      source: 'gemini-high-entropy',
      meta: { deviceType: meta.deviceType, persona: selectedPersona },
      timestamp: Date.now()
    });

    while (reviewQueues[slug].length > MAX_QUEUE_SIZE) {
      reviewQueues[slug].shift();
    }
  } catch (err) {
    console.error(`[Queue Error] ${slug}:`, err.message);
  }
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// ── GET config for a slug ──────────────────────────────────────────────────────
app.get('/api/config/:slug', (req, res) => {
  const slug   = sanitizeSlug(req.params.slug);
  const config = getBizConfig(slug);
  if (!config) return res.status(404).json({ error: `No config found for slug: ${slug}` });

  seedQueueIfEmpty(slug, config);
  res.json(config);
});

// ── FAST FIFO QUEUE REVIEW ENDPOINT (< 50ms) ──────────────────────────────────
async function handleReviewRequest(req, res) {
  const slug   = sanitizeSlug(req.params.slug) || 'saloon';
  const config = getBizConfig(slug) || DEFAULT_BUSINESSES.saloon;
  const clientMeta = getClientMetadata(req);

  seedQueueIfEmpty(slug, config);

  const customInput = {
    service:   req.query.service || req.body?.service || '',
    staffName: req.query.staffName || req.body?.staffName || '',
    vibe:      req.query.vibe || req.body?.vibe || ''
  };

  const queue = reviewQueues[slug] || [];
  let reviewObj = null;

  if (queue.length > 0) {
    reviewObj = queue.shift();
  }

  recordScanEvent(slug, clientMeta, reviewObj ? (reviewObj.generated ? 'Gemini AI Queue' : 'Initial Seed Queue') : 'Instant Fallback');

  setImmediate(() => {
    generateAndEnqueueReview(slug, clientMeta, customInput);
  });

  if (!reviewObj) {
    const name = config.name || 'Royal Saloon & Spa';
    reviewObj = {
      review: `honestly loved my visit to ${name}! clean place, friendly staff, and great service. 10/10 recommend.`,
      generated: false,
      source: 'instant-human-fallback',
      timestamp: Date.now()
    };
  }

  res.json({
    review: reviewObj.review,
    generated: reviewObj.generated,
    queueRemaining: queue.length,
    clientMeta: { deviceType: clientMeta.deviceType, timeOfDay: clientMeta.timeOfDay }
  });
}

app.get('/api/review/:slug', handleReviewRequest);
app.post('/api/review/:slug', handleReviewRequest);

// ── ADMIN: Direct AI Review Tester ─────────────────────────────────────────────
app.post('/admin/api/test-ai/:slug', adminAuth, async (req, res) => {
  const slug   = sanitizeSlug(req.params.slug) || 'saloon';
  const config = getBizConfig(slug) || DEFAULT_BUSINESSES.saloon;
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(503).json({ error: 'Gemini API key not configured on backend', generated: false });
  }

  const type = config.type || 'saloon';
  const name = config.name || 'Royal Saloon & Spa';

  const selectedPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const selectedPhrase  = CASUAL_PHRASES[Math.floor(Math.random() * CASUAL_PHRASES.length)];
  const randomSeed      = `${Date.now()}_${Math.floor(Math.random() * 999999)}`;

  const fullPrompt =
    `You are a real everyday customer writing a quick 5-star Google review for "${name}", a ${type}.\n` +
    `Style persona: ${selectedPersona}\n` +
    `Include a natural casual phrase like "${selectedPhrase}".\n` +
    `CRITICAL: Sound completely human, non-AI, between 25 and 45 words. Output ONLY the review text. No quotes. Seed: ${randomSeed}`;

  const t0 = Date.now();
  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent(fullPrompt);
    let reviewText = result.response.text().trim().replace(/^["']|["']$/g, '');

    res.json({
      review: reviewText,
      generated: true,
      persona: selectedPersona,
      latencyMs: Date.now() - t0,
      wordCount: reviewText.split(/\s+/).length
    });
  } catch (err) {
    console.error(`[AI Test Error] ${slug}:`, err.message);
    res.status(500).json({ error: err.message, generated: false });
  }
});

// ── ADMIN: Queue Inspector API ────────────────────────────────────────────────
app.get('/admin/api/queue/:slug', adminAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug) || 'saloon';
  const config = getBizConfig(slug) || {};
  seedQueueIfEmpty(slug, config);
  const q = reviewQueues[slug] || [];
  res.json({
    slug,
    queueLength: q.length,
    maxSize: MAX_QUEUE_SIZE,
    items: q.map((item, idx) => ({
      position: idx + 1,
      review: item.review,
      generated: item.generated,
      source: item.source || 'queue',
      meta: item.meta || {},
      timestamp: item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : 'now'
    }))
  });
});

// ── ADMIN: Analytics API ───────────────────────────────────────────────────────
app.get('/admin/api/analytics', adminAuth, (req, res) => {
  res.json({
    totalScans: analyticsStore.totalScans,
    uniqueVisitors: analyticsStore.uniqueIps.size,
    deviceStats: analyticsStore.deviceStats,
    timeStats: analyticsStore.timeStats,
    sourceStats: analyticsStore.sourceStats,
    logs: analyticsStore.logs
  });
});

// ── ADMIN: Settings API ────────────────────────────────────────────────────────
app.get('/admin/api/settings', adminAuth, (req, res) => {
  res.json({
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    adminApiKeyConfigured: true
  });
});

app.post('/admin/api/settings', adminAuth, (req, res) => {
  const { geminiApiKey, adminApiKey } = req.body;
  if (geminiApiKey) process.env.GEMINI_API_KEY = geminiApiKey;
  if (adminApiKey)  process.env.ADMIN_API_KEY  = adminApiKey;
  res.json({ success: true, note: 'Updated in-memory. Update env vars on Render to persist.' });
});

// ── ADMIN: Business APIs ───────────────────────────────────────────────────────
app.get('/admin/api/businesses', adminAuth, (req, res) => {
  const slugs = new Set([
    ...Object.keys(DEFAULT_BUSINESSES),
    ...Object.keys(process.env).filter(k => k.startsWith('BIZ_')).map(k => k.replace('BIZ_', '').toLowerCase())
  ]);

  const list = Array.from(slugs).map(slug => {
    const cfg = getBizConfig(slug);
    return { slug, ...(cfg || {}) };
  });

  res.json(list);
});

app.post('/admin/api/config/:slug', adminAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Empty body' });
  }
  process.env[`BIZ_${slug}`] = JSON.stringify(req.body);
  res.json({ success: true, config: req.body });
});

app.get('/admin/api/status', adminAuth, async (req, res) => {
  const slugs = new Set([
    ...Object.keys(DEFAULT_BUSINESSES),
    ...Object.keys(process.env).filter(k => k.startsWith('BIZ_')).map(k => k.replace('BIZ_', '').toLowerCase())
  ]);

  const checks = [];

  for (const slug of slugs) {
    const config = getBizConfig(slug) || {};
    const url    = config.siteUrl;

    if (!url) {
      checks.push({ slug, name: config.name || slug, status: 'no-url', url: null });
      continue;
    }

    try {
      const t0   = Date.now();
      const res2 = await fetch(url, { signal: AbortSignal.timeout(6000) });
      checks.push({
        slug,
        name:       config.name || slug,
        url,
        status:     res2.ok ? 'up' : 'error',
        httpStatus: res2.status,
        latencyMs:  Date.now() - t0
      });
    } catch (err) {
      checks.push({ slug, name: config.name || slug, url, status: 'down', error: err.message });
    }
  }

  res.json({
    backend: { status: 'up', uptimeSeconds: Math.floor(process.uptime()), region: process.env.RENDER_REGION || 'unknown' },
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    queues: Object.keys(reviewQueues).reduce((acc, k) => { acc[k] = reviewQueues[k].length; return acc; }, {}),
    sites: checks,
    checkedAt: new Date().toISOString()
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  scan-qr backend v6.1 running on port ${PORT}`);
});
