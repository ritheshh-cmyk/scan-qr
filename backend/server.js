const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────────
function sanitizeSlug(s) {
  return s.toLowerCase().replace(/[^a-z0-9_]/g, '');
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

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// ── GET config for a slug ──────────────────────────────────────────────────────
app.get('/api/config/:slug', (req, res) => {
  const slug   = sanitizeSlug(req.params.slug);
  const config = getBizConfig(slug);
  if (!config) return res.status(404).json({ error: `No config found for slug: ${slug}` });
  res.json(config);
});

// ── GET AI-generated review for a slug ────────────────────────────────────────
// Returns { review, generated: true } on success
// Returns 503 with { error } if no API key or Gemini fails
app.get('/api/review/:slug', async (req, res) => {
  const slug   = sanitizeSlug(req.params.slug);
  const config = getBizConfig(slug) || {};

  // Per-business key overrides global key
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(503).json({ error: 'Gemini API key not configured', generated: false });
  }

  const type = config.type || 'salon';
  const name = config.name || 'the salon';

  const prompt =
    `Write a short, genuine-sounding positive Google review for "${name}", a ${type}. ` +
    `Mention specific details: staff skill, cleanliness, atmosphere, value for money, overall experience. ` +
    `Keep it between 40–65 words. Return ONLY the review text — no quotes, no labels, no extra lines.`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const review = result.response.text().trim();
    res.json({ review, generated: true });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'Failed to generate review', details: err.message, generated: false });
  }
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

// ── ADMIN: update a business config (in-process; update Render env to persist) ─
app.post('/admin/api/config/:slug', adminAuth, (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Empty body' });
  }
  process.env[`BIZ_${slug}`] = JSON.stringify(req.body);
  res.json({
    success: true,
    note: `In-memory updated. Go to Render dashboard → Environment and update BIZ_${slug} to persist permanently.`,
    config: req.body
  });
});

// ── ADMIN: update global settings (Gemini key, admin key) in-process ──────────
app.post('/admin/api/settings', adminAuth, (req, res) => {
  const { geminiApiKey, adminApiKey } = req.body;
  if (geminiApiKey) process.env.GEMINI_API_KEY = geminiApiKey;
  if (adminApiKey)  process.env.ADMIN_API_KEY  = adminApiKey;
  res.json({ success: true, note: 'Updated in-memory. Update env vars on Render to persist.' });
});

// ── ADMIN: check status of all registered sites + backend ─────────────────────
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
      const t0  = Date.now();
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
  console.log(`✅  scan-qr backend v2 running on port ${PORT}`);
});
