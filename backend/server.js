const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors()); // allow all origins (Vercel sites)
app.use(express.json());

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── GET config for a business slug ───────────────────────────────────────────
// Each business config is stored as an env var: BIZ_<slug>={"name":...}
// Example: BIZ_pizza={"name":"Pizza Palace","googleReviewLink":"https://...","reviews":[...]}
app.get('/api/config/:slug', (req, res) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const envKey = `BIZ_${slug}`;
  const raw = process.env[envKey];

  if (!raw) {
    return res.status(404).json({ error: `No config found for slug: ${slug}` });
  }

  try {
    const config = JSON.parse(raw);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Invalid config JSON for this slug', slug });
  }
});

// ─── POST update config (protected by ADMIN_API_KEY) ──────────────────────────
// This only updates the in-memory value for the current process lifetime.
// To persist, update the env var in the Render dashboard.
app.post('/api/config/:slug', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Provide x-api-key header.' });
  }

  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const body = req.body;

  if (!body || !body.name) {
    return res.status(400).json({ error: 'Request body must include at least { name }' });
  }

  // Persist in-process only (update Render env var to make it permanent)
  process.env[`BIZ_${slug}`] = JSON.stringify(body);

  res.json({
    success: true,
    message: `Config updated for slug: ${slug}. Note: this resets on restart. Update the BIZ_${slug} env var in Render for persistence.`,
    config: body
  });
});

// ─── List all registered slugs (admin only) ────────────────────────────────────
app.get('/api/slugs', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Provide x-api-key header.' });
  }

  const slugs = Object.keys(process.env)
    .filter(k => k.startsWith('BIZ_'))
    .map(k => k.replace('BIZ_', '').toLowerCase());

  res.json({ slugs });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ scan-qr backend running on port ${PORT}`);
});
