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
    siteUrl: "https://scanqr-beta.vercel.app?biz=saloon"
  },
  youngwear_fashions: {
    name: "Youngwear Fashions",
    type: "clothing store",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_YOUNGWEAR_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app?biz=youngwear_fashions"
  },
  demo: {
    name: "Demo Beauty Salon",
    type: "salon",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_DEMO_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app?biz=demo"
  }
};

// Candidate Gemini models ordered by performance & availability
const MODEL_CANDIDATES = [
  'gemini-2.0-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro-latest',
  'gemini-1.5-flash',
  'gemini-pro'
];

async function generateWithFallbackModel(genAI, fullPrompt) {
  let lastErr = null;
  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(fullPrompt);
      const text = result.response.text().trim().replace(/^["']|["']$/g, '');
      if (text) {
        return { text, modelUsed: modelName };
      }
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded') || msg.includes('429')) {
        throw new Error('Gemini API Quota Exceeded (Google Free Tier 15 req/min limit). Please wait 30 seconds.');
      }
      if (msg.includes('PERMISSION_DENIED') || msg.includes('denied access') || msg.includes('API_KEY_INVALID')) {
        throw new Error('Gemini API Key Access Denied by Google Cloud. Please check your key in Settings.');
      }
    }
  }
  throw lastErr || new Error('All Gemini model candidates failed');
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── FIFO Review Queue Storage (Strictly Isolated Per Business Slug) ────────────
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
  "Enthusiastic & Detailed: Happy customer praising the friendly staff, clean aesthetic, and great products/service.",
  "Walk-in Direct: Focus on unexpected quick availability, fair pricing, awesome quality, great result.",
  "Cozy Vibe: Focus on peaceful atmosphere, great smell, attentive staff, leaving super satisfied.",
  "Minimalist 5-Star: 20 to 30 words, punchy, honest, top tier recommendation."
];

const CASUAL_PHRASES = [
  "honestly", "super happy", "really impressed", "hands down", "definitely coming back",
  "so glad I found this place", "left feeling great", "fresh and clean", "spot on", "worth every penny"
];

function sanitizeSlug(s) {
  return s ? s.toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
}

function getBizConfig(slug) {
  const cleanSlug = sanitizeSlug(slug);
  const raw = process.env[`BIZ_${cleanSlug}`];
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  if (DEFAULT_BUSINESSES[cleanSlug]) {
    return DEFAULT_BUSINESSES[cleanSlug];
  }

  // DYNAMIC SLUG FALLBACK: Infer name & type from slug so custom business NEVER fails or defaults to Saloon!
  const formattedName = cleanSlug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let inferredType = 'store';
  if (cleanSlug.includes('fashion') || cleanSlug.includes('clothing') || cleanSlug.includes('wear')) inferredType = 'clothing store';
  else if (cleanSlug.includes('saloon') || cleanSlug.includes('salon') || cleanSlug.includes('hair')) inferredType = 'saloon';
  else if (cleanSlug.includes('barber')) inferredType = 'barbershop';
  else if (cleanSlug.includes('food') || cleanSlug.includes('restaurant')) inferredType = 'restaurant';
  else if (cleanSlug.includes('cafe')) inferredType = 'cafe';

  return {
    name: formattedName,
    type: inferredType,
    googleReviewLink: `https://search.google.com/local/writereview?placeid=${cleanSlug}`,
    siteUrl: `https://scanqr-beta.vercel.app?biz=${cleanSlug}`
  };
}

function seedQueueIfEmpty(slug, config) {
  const cleanSlug = sanitizeSlug(slug);
  if (!reviewQueues[cleanSlug]) reviewQueues[cleanSlug] = [];

  if (reviewQueues[cleanSlug].length === 0) {
    const cfg  = config || getBizConfig(cleanSlug);
    const name = cfg.name || cleanSlug;
    const type = (cfg.type || 'store').toLowerCase();
    
    let initialSeedReviews = [];
    if (type.includes('clothing') || type.includes('fashion') || type.includes('boutique') || cleanSlug.includes('fashion') || cleanSlug.includes('wear')) {
      initialSeedReviews = [
        `honestly so happy with my shopping at ${name}! great clothing collection, fitting was spot on, and staff were super helpful.`,
        `Loved my visit to ${name}. Beautiful clothes, awesome quality, and fair prices. Definitely coming back for more outfits!`,
        `Best fashion store in town! Spotless clean shop, friendly team, and got exactly what I was looking for. Highly recommend!`,
        `Walked into ${name} today and found the perfect outfits. Great style variety, comfortable fabric, and top tier service.`,
        `Super clean boutique atmosphere at ${name}. Staff helped me find my size right away. Really impressed!`
      ];
    } else {
      initialSeedReviews = [
        `honestly so happy with my visit to ${name}! staff were super friendly, clean place, and service was top quality. definitely coming back.`,
        `Great experience at ${name}. Walked in and was greeted warmly right away. Very skilled team and relaxing vibe. Highly recommend!`,
        `Best visit I've had in a while. Spotless clean, fair prices, and the team did an awesome job. Will be back for sure!`,
        `Walked into ${name} today and left super satisfied. Excellent attention to detail, peaceful environment, and great value.`,
        `Top tier service at ${name} from start to finish. Friendly staff, cozy atmosphere, and 100% worth every penny.`
      ];
    }

    initialSeedReviews.forEach(rev => {
      reviewQueues[cleanSlug].push({
        review: rev,
        generated: false,
        source: 'initial-human-seed',
        timestamp: Date.now()
      });
    });
  }
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
  const cleanSlug = sanitizeSlug(slug);
  const config    = getBizConfig(cleanSlug);
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) return;

  const type = config.type || 'business';
  const name = config.name || cleanSlug;

  const selectedPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const selectedPhrase  = CASUAL_PHRASES[Math.floor(Math.random() * CASUAL_PHRASES.length)];
  const randomSeed      = `${Date.now()}_${Math.floor(Math.random() * 999999)}_${meta.ip || 'admin'}`;

  const fullPrompt =
    `You are a real everyday customer writing a quick 5-star Google review for "${name}", a ${type}.\n` +
    `Style persona: ${selectedPersona}\n` +
    `Include a natural casual phrase like "${selectedPhrase}".\n` +
    `CRITICAL: Sound completely human, non-AI, between 25 and 45 words. Focus ONLY on ${name} (${type}). DO NOT use cliché phrases like '10/10' or '5 stars'. Output ONLY the review text. No quotes. Seed: ${randomSeed}`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const { text: reviewText, modelUsed } = await generateWithFallbackModel(genAI, fullPrompt);

    if (!reviewQueues[cleanSlug]) reviewQueues[cleanSlug] = [];
    if (!recentReviews[cleanSlug]) recentReviews[cleanSlug] = new Set();

    if (recentReviews[cleanSlug].has(reviewText)) {
      return;
    }

    recentReviews[cleanSlug].add(reviewText);
    if (recentReviews[cleanSlug].size > 50) {
      const firstItem = recentReviews[cleanSlug].values().next().value;
      recentReviews[cleanSlug].delete(firstItem);
    }

    reviewQueues[cleanSlug].push({
      review: reviewText,
      generated: true,
      source: `gemini-high-entropy (${modelUsed})`,
      meta: { deviceType: meta.deviceType || 'Smartphone', persona: selectedPersona, modelUsed },
      timestamp: Date.now()
    });

    while (reviewQueues[cleanSlug].length > MAX_QUEUE_SIZE) {
      reviewQueues[cleanSlug].shift();
    }
  } catch (err) {
    console.error(`[Queue Error] ${cleanSlug}:`, err.message);
  }
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// ── GET config for a slug ──────────────────────────────────────────────────────
app.get('/api/config/:slug', (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);

  seedQueueIfEmpty(cleanSlug, config);
  res.json(config);
});

// ── FAST FIFO QUEUE REVIEW ENDPOINT (< 50ms) ──────────────────────────────────
async function handleReviewRequest(req, res) {
  const cleanSlug  = sanitizeSlug(req.params.slug) || 'saloon';
  const config     = getBizConfig(cleanSlug);
  const clientMeta = getClientMetadata(req);

  seedQueueIfEmpty(cleanSlug, config);

  const customInput = {
    service:   req.query.service || req.body?.service || '',
    staffName: req.query.staffName || req.body?.staffName || '',
    vibe:      req.query.vibe || req.body?.vibe || ''
  };

  const queue = reviewQueues[cleanSlug] || [];
  let reviewObj = null;

  if (queue.length > 0) {
    reviewObj = queue.shift();
  }

  // CONTINUOUS QUEUE REPLENISHMENT: If queue length drops below 5, generate new AI reviews immediately!
  if (queue.length < 5) {
    setImmediate(() => {
      generateAndEnqueueReview(cleanSlug, clientMeta, customInput);
    });
  }

  if (!reviewObj) {
    const name = config.name || cleanSlug;
    const type = (config.type || 'store').toLowerCase();
    
    let fallbackText = `honestly loved my visit to ${name}! clean place, friendly staff, and great quality. Highly recommend.`;
    if (type.includes('clothing') || type.includes('fashion') || type.includes('boutique') || cleanSlug.includes('fashion') || cleanSlug.includes('wear')) {
      fallbackText = `honestly so happy with my shopping at ${name}! great clothing collection, fitting was spot on, and staff were super helpful.`;
    }

    reviewObj = {
      review: fallbackText,
      generated: false,
      source: 'instant-human-fallback',
      timestamp: Date.now()
    };
  }

  recordScanEvent(cleanSlug, clientMeta, reviewObj.source);

  res.json({
    slug: cleanSlug,
    businessName: config.name,
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
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(503).json({ error: 'Gemini API Key is missing. Enter a valid key in Settings tab.', generated: false });
  }

  const type = config.type || 'business';
  const name = config.name || cleanSlug;

  const selectedPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const selectedPhrase  = CASUAL_PHRASES[Math.floor(Math.random() * CASUAL_PHRASES.length)];
  const randomSeed      = `${Date.now()}_${Math.floor(Math.random() * 999999)}`;

  const fullPrompt =
    `You are a real everyday customer writing a quick 5-star Google review for "${name}", a ${type}.\n` +
    `Style persona: ${selectedPersona}\n` +
    `Include a natural casual phrase like "${selectedPhrase}".\n` +
    `CRITICAL: Sound completely human, non-AI, between 25 and 45 words. Focus ONLY on ${name} (${type}). DO NOT use cliché phrases like '10/10' or '5 stars'. Output ONLY the review text. No quotes. Seed: ${randomSeed}`;

  const t0 = Date.now();
  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const { text: reviewText, modelUsed } = await generateWithFallbackModel(genAI, fullPrompt);

    res.json({
      review: reviewText,
      generated: true,
      persona: selectedPersona,
      modelUsed,
      latencyMs: Date.now() - t0,
      wordCount: reviewText.split(/\s+/).length
    });
  } catch (err) {
    console.error(`[AI Test Error] ${cleanSlug}:`, err.message);
    const msg = err.message || 'Gemini API call failed';
    res.status(500).json({ error: msg, generated: false });
  }
});

// ── ADMIN: Queue Inspector API ────────────────────────────────────────────────
app.get('/admin/api/queue/:slug', adminAuth, (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);
  seedQueueIfEmpty(cleanSlug, config);
  const q = reviewQueues[cleanSlug] || [];
  res.json({
    slug: cleanSlug,
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

// Flush Queue for a business
app.post('/admin/api/queue/:slug/clear', adminAuth, (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  reviewQueues[cleanSlug] = [];
  res.json({ success: true, message: `Queue for business '${cleanSlug}' cleared successfully.` });
});

// Force Generate AI Review into Queue
app.post('/admin/api/queue/:slug/generate', adminAuth, async (req, res) => {
  const cleanSlug  = sanitizeSlug(req.params.slug) || 'saloon';
  const clientMeta = getClientMetadata(req);
  await generateAndEnqueueReview(cleanSlug, clientMeta);
  const q = reviewQueues[cleanSlug] || [];
  res.json({ success: true, message: `Triggered AI generation for '${cleanSlug}'. Current queue length: ${q.length}` });
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

app.delete('/admin/api/analytics/clear', adminAuth, (req, res) => {
  analyticsStore.totalScans = 0;
  analyticsStore.uniqueIps.clear();
  analyticsStore.deviceStats = { Smartphone: 0, Desktop: 0 };
  analyticsStore.timeStats = { Morning: 0, Afternoon: 0, Evening: 0 };
  analyticsStore.sourceStats = { 'Gemini AI Queue': 0, 'Initial Seed Queue': 0, 'Instant Fallback': 0 };
  analyticsStore.logs = [];
  res.json({ success: true, message: 'Analytics history cleared successfully.' });
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
  const cleanSlug = sanitizeSlug(req.params.slug);
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Empty body' });
  }

  if (!req.body.siteUrl) {
    req.body.siteUrl = `https://scanqr-beta.vercel.app?biz=${cleanSlug}`;
  }

  process.env[`BIZ_${cleanSlug}`] = JSON.stringify(req.body);
  
  // Re-seed queue for newly added or updated business immediately
  seedQueueIfEmpty(cleanSlug, req.body);

  res.json({ success: true, config: req.body });
});

app.delete('/admin/api/config/:slug', adminAuth, (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug);
  
  // Delete from env and review queue
  delete process.env[`BIZ_${cleanSlug}`];
  delete reviewQueues[cleanSlug];
  delete recentReviews[cleanSlug];

  res.json({ success: true, message: `Business '${cleanSlug}' deleted successfully.` });
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

// ── INITIALIZE QUEUES ON STARTUP ───────────────────────────────────────────────
Object.keys(DEFAULT_BUSINESSES).forEach(slug => {
  seedQueueIfEmpty(slug, DEFAULT_BUSINESSES[slug]);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  scan-qr backend v10.0 (Enterprise Admin Suite) running on port ${PORT}`);
});
