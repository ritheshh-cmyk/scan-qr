const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', true); // get real client IP behind Render/Vercel proxies
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── FIFO Review Queue Storage (max 10 items per slug) ─────────────────────────
const MAX_QUEUE_SIZE = 10;
const reviewQueues   = {}; // { slug: [{ review: string, meta: object, timestamp: number }] }

// Seed default reviews for a slug into the queue if empty
function seedQueueIfEmpty(slug, config) {
  if (!reviewQueues[slug]) {
    reviewQueues[slug] = [];
  }
  if (reviewQueues[slug].length === 0) {
    const name = config.name || 'Our Salon';
    const initialReviews = [
      `Honestly loved my visit to ${name}! The staff were so friendly, clean environment, and great service overall. Will definitely be coming back.`,
      `Great experience at ${name}. Super professional stylists, lovely atmosphere, and left feeling very satisfied with my appointment!`
    ];
    initialReviews.forEach(rev => {
      reviewQueues[slug].push({
        review: rev,
        generated: false,
        source: 'initial-seed',
        timestamp: Date.now()
      });
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
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
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — provide x-api-key header or ?key= query param' });
  }
  next();
}

function getClientMetadata(req) {
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const ip = rawIp.split(',')[0].trim();
  const userAgent = req.headers['user-agent'] || 'Unknown Device';
  const lang = req.headers['accept-language'] || 'en-US';

  // Device type estimation
  const isMobile = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
  const deviceType = isMobile ? 'Mobile Phone' : 'Desktop/Tablet';

  // Time of day context
  const hour = new Date().getHours();
  let timeOfDay = 'Daytime';
  if (hour < 12) timeOfDay = 'Morning';
  else if (hour < 17) timeOfDay = 'Afternoon';
  else timeOfDay = 'Evening';

  return { ip, userAgent, deviceType, lang, timeOfDay };
}

// ── Background Worker: Generate new AI review & push to FIFO Queue ──────────────
async function generateAndEnqueueReview(slug, meta, customInput = {}) {
  const config = getBizConfig(slug) || {};
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) return;

  const type = config.type || 'salon';
  const name = config.name || 'the salon';

  const systemInstruction =
    `You are a genuine customer writing a quick, authentic Google review for "${name}", a ${type}.\n` +
    `RULES FOR NATURAL HUMAN TONE:\n` +
    `1. Write in a relaxed, casual, realistic human tone. Avoid sounding like marketing or AI.\n` +
    `2. Keep length concise (30 to 50 words).\n` +
    `3. Every output MUST be completely distinct in phrasing, vocabulary, and structure.\n` +
    `4. Output ONLY the raw review text without any surrounding quotes, tags, or labels.`;

  let prompt = `Write a unique positive 5-star Google review for ${name} (${type}).`;
  if (customInput.service)   prompt += ` Service: ${customInput.service}.`;
  if (customInput.staffName) prompt += ` Stylist/Staff: ${customInput.staffName}.`;
  if (customInput.vibe)      prompt += ` Atmosphere: ${customInput.vibe}.`;

  // Include non-identifying environment hints to diversify AI output
  prompt += ` Context hints: Written on a ${meta.deviceType} during ${meta.timeOfDay}. Seed: ${Date.now()}_${Math.random()}`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: systemInstruction
    });

    const result = await model.generateContent(prompt);
    const reviewText = result.response.text().trim();

    if (!reviewQueues[slug]) reviewQueues[slug] = [];

    // Push new review into FIFO queue
    reviewQueues[slug].push({
      review: reviewText,
      generated: true,
      source: 'gemini-ai',
      meta: { deviceType: meta.deviceType, timeOfDay: meta.timeOfDay },
      timestamp: Date.now()
    });

    // Keep FIFO Queue bounded to MAX_QUEUE_SIZE (10 items) — old items automatically cycle out
    while (reviewQueues[slug].length > MAX_QUEUE_SIZE) {
      reviewQueues[slug].shift(); // remove oldest item from start of queue
    }

    console.log(`[Queue] Added AI review for ${slug}. Current queue length: ${reviewQueues[slug].length}`);
  } catch (err) {
    console.error(`[Queue Error] Failed to generate AI review for ${slug}:`, err.message);
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

  // Ensure queue is seeded
  seedQueueIfEmpty(slug, config);

  res.json(config);
});

// ── FAST FIFO QUEUE REVIEW ENDPOINT (< 50ms Response) ──────────────────────────
async function handleReviewRequest(req, res) {
  const slug   = sanitizeSlug(req.params.slug);
  const config = getBizConfig(slug) || {};
  const clientMeta = getClientMetadata(req);

  // Seed queue if empty
  seedQueueIfEmpty(slug, config);

  const customInput = {
    service:   req.query.service || req.body?.service || '',
    staffName: req.query.staffName || req.body?.staffName || '',
    vibe:      req.query.vibe || req.body?.vibe || '',
    customNote:req.query.customNote || req.body?.customNote || ''
  };

  const queue = reviewQueues[slug] || [];

  let reviewObj = null;

  // 1. Instantly pop a pre-generated review from the FIFO Queue if available
  if (queue.length > 0) {
    reviewObj = queue.shift(); // FIFO pop
  }

  // 2. Trigger background worker to generate the NEXT AI review using client metadata
  // This runs asynchronously so the user gets instant response!
  setImmediate(() => {
    generateAndEnqueueReview(slug, clientMeta, customInput);
  });

  // If queue was empty (rare), fallback immediately
  if (!reviewObj) {
    const name = config.name || 'Our Salon';
    reviewObj = {
      review: `Had a great experience at ${name}! The team was professional, welcoming, and delivered excellent results. Highly recommend!`,
      generated: false,
      source: 'instant-fallback',
      timestamp: Date.now()
    };
  }

  // Return review instantly (< 50ms)
  res.json({
    review: reviewObj.review,
    generated: reviewObj.generated,
    queueRemaining: queue.length,
    clientMeta: { deviceType: clientMeta.deviceType, timeOfDay: clientMeta.timeOfDay }
  });
}

app.get('/api/review/:slug', handleReviewRequest);
app.post('/api/review/:slug', handleReviewRequest);

// ── ADMIN: View current FIFO Queue status ──────────────────────────────────────
app.get('/admin/api/queue/:slug', adminAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  const q = reviewQueues[slug] || [];
  res.json({ slug, queueLength: q.length, items: q });
});

// ── ADMIN: list all businesses ─────────────────────────────────────────────────
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

// ── ADMIN: update a business config ───────────────────────────────────────────
app.post('/admin/api/config/:slug', adminAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Empty body' });
  }
  process.env[`BIZ_${slug}`] = JSON.stringify(req.body);
  res.json({
    success: true,
    note: `In-memory updated. Update BIZ_${slug} in Render env vars to persist permanently.`,
    config: req.body
  });
});

// ── ADMIN: update global settings ─────────────────────────────────────────────
app.post('/admin/api/settings', adminAuth, (req, res) => {
  const { geminiApiKey, adminApiKey } = req.body;
  if (geminiApiKey) process.env.GEMINI_API_KEY = geminiApiKey;
  if (adminApiKey)  process.env.ADMIN_API_KEY  = adminApiKey;
  res.json({ success: true, note: 'Updated in-memory. Update env vars on Render to persist.' });
});

// ── ADMIN: check status ────────────────────────────────────────────────────────
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

// ── ADMIN: serve admin panel HTML ──────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  scan-qr backend v3 (FIFO Queue + Client Meta + Human Tone) running on port ${PORT}`);
});
