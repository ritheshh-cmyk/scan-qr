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

// ── GET / POST AI-generated review for a slug ────────────────────────────────
async function handleReviewRequest(req, res) {
  const slug   = sanitizeSlug(req.params.slug);
  const config = getBizConfig(slug) || {};

  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(503).json({ error: 'Gemini API key not configured', generated: false });
  }

  const type       = config.type || 'salon';
  const name       = config.name || 'the salon';

  // Extract user parameters (from query params or body)
  const service    = req.query.service || req.body?.service || '';
  const staffName  = req.query.staffName || req.body?.staffName || '';
  const vibe       = req.query.vibe || req.body?.vibe || '';
  const customNote = req.query.customNote || req.body?.customNote || '';

  const systemInstruction =
    `You are a helpful customer assistant for "${name}", a premier ${type}. ` +
    `Generate a short, authentic, 5-star Google review written from a customer's personal perspective. ` +
    `RULES:\n` +
    `1. Keep length between 35 and 60 words.\n` +
    `2. Write in a natural, genuine tone. Never use cliché marketing hype.\n` +
    `3. Every output MUST be completely unique in phrasing and structure.\n` +
    `4. Return ONLY the review text. No quotes, no prefix, no markdown tags.`;

  let prompt = `Write a unique 5-star Google review for ${name} (${type}).`;
  if (service)    prompt += ` Service done: ${service}.`;
  if (staffName)  prompt += ` Staff/Stylist name: ${staffName}.`;
  if (vibe)       prompt += ` Vibe/Highlight: ${vibe}.`;
  if (customNote) prompt += ` Customer note: ${customNote}.`;
  prompt += ` (Randomization seed: ${Date.now()}_${Math.random()})`;

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: systemInstruction
    });

    const result = await model.generateContent(prompt);
    const review = result.response.text().trim();
    res.json({ review, generated: true });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'Failed to generate review', details: err.message, generated: false });
  }
}

app.get('/api/review/:slug', handleReviewRequest);
app.post('/api/review/:slug', handleReviewRequest);

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
  console.log(`✅  scan-qr backend v2.1 running on port ${PORT}`);
});
