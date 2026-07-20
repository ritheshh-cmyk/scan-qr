const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// Default admin key fallback so login always works out-of-the-box
const DEFAULT_ADMIN_KEY = process.env.ADMIN_API_KEY || 'scanqr-admin-2024';

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── FIFO Review Queue Storage (max 10 items per slug) ─────────────────────────
const MAX_QUEUE_SIZE = 10;
const reviewQueues   = {}; 
const recentReviews  = {}; 

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

// Seed initial natural reviews into queue if empty
function seedQueueIfEmpty(slug, config) {
  if (!reviewQueues[slug]) reviewQueues[slug] = [];

  if (reviewQueues[slug].length === 0) {
    const name = config.name || 'Our Salon';
    const initialSeedReviews = [
      `honestly so happy with my visit to ${name}! staff were super friendly, clean place, and service was 10/10. definitely coming back.`,
      `Great experience at ${name}. Walked in and was greeted warmly right away. Very skilled team and relaxing vibe. Highly recommend!`,
      `Best salon visit I've had in a while. Spotless clean, fair prices, and my stylist did an awesome job. Will be back for sure!`
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
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
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

// ── Background Worker: Generate new AI review with Maximum Entropy & Human Tone ─
async function generateAndEnqueueReview(slug, meta, customInput = {}) {
  const config = getBizConfig(slug) || {};
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) return;

  const type = config.type || 'salon';
  const name = config.name || 'the salon';

  // Pick random persona & casual phrase seed for maximum entropy
  const selectedPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const selectedPhrase  = CASUAL_PHRASES[Math.floor(Math.random() * CASUAL_PHRASES.length)];
  const randomSeed      = `${Date.now()}_${Math.floor(Math.random() * 999999)}_${meta.ip}`;

  const systemInstruction =
    `You are a real everyday person writing a quick 5-star Google review for "${name}", a ${type}.\n` +
    `CRITICAL INSTRUCTIONS FOR REALISTIC HUMAN TONE:\n` +
    `1. NEVER sound like an AI, marketing brochure, or corporate copywriter.\n` +
    `2. Style direction: ${selectedPersona}\n` +
    `3. Write between 25 and 45 words. Keep it short and natural.\n` +
    `4. Output ONLY the plain text of the review. No quotes, no preamble, no hashtags, no title.`;

  let prompt = `Write a completely unique, natural 5-star review for ${name} (${type}).\n`;
  if (customInput.service)   prompt += `Service: ${customInput.service}.\n`;
  if (customInput.staffName) prompt += `Stylist/Staff: ${customInput.staffName}.\n`;
  if (customInput.vibe)      prompt += `Atmosphere: ${customInput.vibe}.\n`;

  prompt += `Include a natural casual touch using phrasing like "${selectedPhrase}".\n`;
  prompt += `Entropy Seed: ${randomSeed}`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: systemInstruction,
      generationConfig: {
        temperature: 1.0, // Maximum randomness & creative diversity
        topP: 0.95,
        topK: 40
      }
    });

    const result = await model.generateContent(prompt);
    let reviewText = result.response.text().trim();
    reviewText = reviewText.replace(/^["']|["']$/g, '');

    if (!reviewQueues[slug]) reviewQueues[slug] = [];
    if (!recentReviews[slug]) recentReviews[slug] = new Set();

    // Deduplication check
    if (recentReviews[slug].has(reviewText)) {
      console.log(`[Queue] Duplicate review generated for ${slug}, skipping.`);
      return;
    }

    recentReviews[slug].add(reviewText);
    if (recentReviews[slug].size > 50) {
      const firstItem = recentReviews[slug].values().next().value;
      recentReviews[slug].delete(firstItem);
    }

    // Push new review into FIFO queue
    reviewQueues[slug].push({
      review: reviewText,
      generated: true,
      source: 'gemini-high-entropy',
      meta: { deviceType: meta.deviceType, persona: selectedPersona },
      timestamp: Date.now()
    });

    // Bounded FIFO Queue max 10
    while (reviewQueues[slug].length > MAX_QUEUE_SIZE) {
      reviewQueues[slug].shift();
    }

    console.log(`[Queue] Enqueued human-like review for ${slug} (${reviewQueues[slug].length}/${MAX_QUEUE_SIZE})`);
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
  const slug   = sanitizeSlug(req.params.slug);
  const config = getBizConfig(slug) || {};
  const clientMeta = getClientMetadata(req);

  seedQueueIfEmpty(slug, config);

  const customInput = {
    service:   req.query.service || req.body?.service || '',
    staffName: req.query.staffName || req.body?.staffName || '',
    vibe:      req.query.vibe || req.body?.vibe || ''
  };

  const queue = reviewQueues[slug] || [];
  let reviewObj = null;

  // 1. Instantly pop pre-generated review from FIFO Queue
  if (queue.length > 0) {
    reviewObj = queue.shift();
  }

  // 2. Trigger asynchronous background AI generator to replenish queue
  setImmediate(() => {
    generateAndEnqueueReview(slug, clientMeta, customInput);
  });

  if (!reviewObj) {
    const name = config.name || 'Our Salon';
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

// ── ADMIN: Queue & status APIs ────────────────────────────────────────────────
app.get('/admin/api/queue/:slug', adminAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const q = reviewQueues[slug] || [];
  res.json({ slug, queueLength: q.length, items: q });
});

app.get('/admin/api/businesses', adminAuth, (req, res) => {
  const list = Object.keys(process.env)
    .filter(k => k.startsWith('BIZ_'))
    .map(k => {
      const slug = k.replace('BIZ_', '').toLowerCase();
      const cfg  = getBizConfig(slug);
      return { slug, ...(cfg || { error: 'Invalid JSON' }) };
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

app.post('/admin/api/settings', adminAuth, (req, res) => {
  const { geminiApiKey, adminApiKey } = req.body;
  if (geminiApiKey) process.env.GEMINI_API_KEY = geminiApiKey;
  if (adminApiKey)  process.env.ADMIN_API_KEY  = adminApiKey;
  res.json({ success: true });
});

app.get('/admin/api/status', adminAuth, async (req, res) => {
  const bizKeys = Object.keys(process.env).filter(k => k.startsWith('BIZ_'));
  const checks  = [];

  for (const key of bizKeys) {
    const slug   = key.replace('BIZ_', '').toLowerCase();
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
  console.log(`✅  scan-qr backend v4.1 running on port ${PORT}`);
});
