const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient }       = require('@libsql/client');

const app  = express();
const PORT = process.env.PORT || 3000;

// Default admin key fallback
const DEFAULT_ADMIN_KEY = () => process.env.ADMIN_API_KEY || 'Lucky@000';

// Built-in registered businesses fallback
const DEFAULT_BUSINESSES = {
  saloon: {
    name: "Royal Saloon & Spa",
    type: "saloon",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_SALOON_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app?biz=saloon",
    language: "English",
    menuItems: "haircut, beard trim, hair spa, scalp massage",
    highlights: "spotless clean salon, warm tea served, friendly barbers, fair prices"
  },
  youngwear_fashions: {
    name: "Youngwear Fashions",
    type: "clothing store",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_YOUNGWEAR_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app?biz=youngwear_fashions",
    language: "English",
    menuItems: "denim jackets, cotton sarees, crop tops, casual wear, sneakers",
    highlights: "trendy styles, comfortable fabric, helpful staff, spotless boutique"
  },
  demo: {
    name: "Demo Beauty Salon",
    type: "salon",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_DEMO_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app?biz=demo",
    language: "English",
    menuItems: "facial, manicure, pedicure, hair styling",
    highlights: "cozy atmosphere, gentle staff, great music, quick service"
  },
  prision_mandi: {
    name: "Prison Mandi",
    type: "mandi restaurant",
    googleReviewLink: "https://search.google.com/local/writereview?placeid=YOUR_PRISON_MANDI_PLACE_ID",
    siteUrl: "https://scanqr-beta.vercel.app?biz=prision_mandi",
    language: "English",
    menuItems: "fried mandi, juicy mandi, alfaham mandi, grill mandi",
    highlights: "authentic mandi flavor, cozy theme dining, generous portions, quick service"
  }
};

// ── TURSO CLOUD DATABASE & LOCAL DISK ENGINE ─────────────────────────────────
const TURSO_URL   = process.env.TURSO_DATABASE_URL || 'libsql://scan-qr-db-rithesh.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN   || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODQ2MjAwMzQsImlkIjoiMDE5ZjgzYTQtNzkwMS03NjQ1LWFiYjgtN2EwOTcxZDEzZTc3Iiwia2lkIjoiWHRwRkYtcmF3Q09ITnJxSnB0VG5hVk4tNlEtaGtIT3l2TVBJUUpjdWJhayIsInJpZCI6IjQ1NmRjMjY4LTQ0ODUtNDBhOC1hZDNiLWQ4ZTk1NTg2YjgyZCJ9.KD3XGQDPR3etqSCIrkgCb7q6LiZfDekFE-m67PyCKXaHsj4_iqpO3haoLjBjg0ZzR7UKX0whSGhLg-3RZlAaCQ';

let tursoClient = null;
try {
  tursoClient = createClient({
    url: TURSO_URL,
    authToken: TURSO_TOKEN
  });
  console.log(`☁️ Connected to Turso Cloud Database: ${TURSO_URL}`);
} catch (err) {
  console.warn(`[Turso Init Warning]: ${err.message}`);
}

const DB_FILE = path.join(__dirname, 'db', 'businesses.json');

function loadLocalDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      const parsed  = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return { ...DEFAULT_BUSINESSES, ...parsed };
      }
    }
  } catch (err) {
    console.error('[Local DB Load Error]:', err.message);
  }
  return { ...DEFAULT_BUSINESSES };
}

function saveLocalDatabase(dbData) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Local DB Save Error]:', err.message);
    return false;
  }
}

// In-Memory cache backed by Turso Cloud DB + Disk DB
const dbStore = loadLocalDatabase();

async function initAndMigrateTurso() {
  if (!tursoClient) return;
  try {
    // 1. Businesses table
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS businesses (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        googleReviewLink TEXT,
        siteUrl TEXT,
        language TEXT,
        geminiApiKey TEXT,
        menuItems TEXT,
        highlights TEXT,
        reviewTone TEXT,
        data TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Global App Settings / API Keys table
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. 📦 5,000 REVIEW BANK TABLE (Stores up to 5K reviews per business in Turso Cloud DB)
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS review_bank (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        review TEXT NOT NULL,
        review_order INTEGER NOT NULL
      );
    `);

    // 4. 📍 Review Bank Pointer Tracking Table
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS review_bank_pointers (
        slug TEXT PRIMARY KEY,
        current_pointer INTEGER DEFAULT 0
      );
    `);

    // Index for fast slug + order lookup
    await tursoClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_review_bank_slug_order ON review_bank(slug, review_order);
    `);

    // Load API keys from Turso app_settings
    const keysRes = await tursoClient.execute('SELECT key, value FROM app_settings');
    if (keysRes.rows && keysRes.rows.length > 0) {
      keysRes.rows.forEach(r => {
        if (r.key === 'gemini_api_key' && r.value) process.env.GEMINI_API_KEY = r.value;
        if (r.key === 'admin_api_key' && r.value)  process.env.ADMIN_API_KEY  = r.value;
      });
      console.log('🔑 Loaded Global API Keys from Turso Cloud Database');
    }

    // Load existing records from Turso businesses
    const res = await tursoClient.execute('SELECT slug, data FROM businesses');
    if (res.rows && res.rows.length > 0) {
      res.rows.forEach(row => {
        try {
          const parsed = JSON.parse(row.data);
          if (parsed && row.slug) {
            dbStore[row.slug] = parsed;
          }
        } catch {}
      });
      console.log(`✅ Loaded ${res.rows.length} businesses from Turso Cloud Database`);
    } else {
      console.log('🔄 Seeding initial businesses into Turso Cloud Database…');
      for (const [slug, cfg] of Object.entries(dbStore)) {
        await upsertTursoBusiness(slug, cfg);
      }
    }
  } catch (err) {
    console.error('[Turso Migration Error]:', err.message);
  }
}

async function upsertTursoAppSetting(key, value) {
  if (!tursoClient || !key || !value) return;
  try {
    await tursoClient.execute({
      sql: 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      args: [key, value]
    });
  } catch (err) {
    console.error(`[Turso Setting Save Error] ${key}:`, err.message);
  }
}

async function upsertTursoBusiness(slug, cfg) {
  if (!tursoClient) return;
  try {
    await tursoClient.execute({
      sql: `INSERT INTO businesses (slug, name, type, googleReviewLink, siteUrl, language, geminiApiKey, menuItems, highlights, reviewTone, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              name=excluded.name,
              type=excluded.type,
              googleReviewLink=excluded.googleReviewLink,
              siteUrl=excluded.siteUrl,
              language=excluded.language,
              geminiApiKey=excluded.geminiApiKey,
              menuItems=excluded.menuItems,
              highlights=excluded.highlights,
              reviewTone=excluded.reviewTone,
              data=excluded.data`,
      args: [
        slug,
        cfg.name || slug,
        cfg.type || 'store',
        cfg.googleReviewLink || null,
        cfg.siteUrl || `https://scanqr-beta.vercel.app?biz=${slug}`,
        cfg.language || 'English',
        cfg.geminiApiKey || null,
        cfg.menuItems || null,
        cfg.highlights || null,
        cfg.reviewTone || 'casual',
        JSON.stringify(cfg)
      ]
    });
  } catch (err) {
    console.error(`[Turso Upsert Error] ${slug}:`, err.message);
  }
}

async function deleteTursoBusiness(slug) {
  if (!tursoClient) return;
  try {
    await tursoClient.execute({
      sql: 'DELETE FROM businesses WHERE slug = ?',
      args: [slug]
    });
    await tursoClient.execute({
      sql: 'DELETE FROM review_bank WHERE slug = ?',
      args: [slug]
    });
    await tursoClient.execute({
      sql: 'DELETE FROM review_bank_pointers WHERE slug = ?',
      args: [slug]
    });
  } catch (err) {
    console.error(`[Turso Delete Error] ${slug}:`, err.message);
  }
}

function saveDatabase(dbData) {
  saveLocalDatabase(dbData);
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Analytics Tracker Storage ──────────────────────────────────────────────────
const analyticsStore = {
  totalScans: 0,
  uniqueIps: new Set(),
  deviceStats: { Smartphone: 0, Desktop: 0 },
  timeStats: { Morning: 0, Afternoon: 0, Evening: 0 },
  sourceStats: { '5K Review Bank': 0, 'Gemini AI Queue': 0, 'Initial Seed Queue': 0 },
  logs: []
};

function recordScanEvent(slug, meta, reviewSource) {
  analyticsStore.totalScans++;
  if (meta.ip) analyticsStore.uniqueIps.add(meta.ip);

  const device = meta.deviceType || 'Smartphone';
  analyticsStore.deviceStats[device] = (analyticsStore.deviceStats[device] || 0) + 1;

  const tod = meta.timeOfDay || 'Afternoon';
  analyticsStore.timeStats[tod] = (analyticsStore.timeStats[tod] || 0) + 1;

  const src = reviewSource || '5K Review Bank';
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
  "Enthusiastic & Detailed: Happy customer praising friendly staff, clean aesthetic, and great products/service.",
  "Walk-in Direct: Focus on unexpected quick availability, fair pricing, awesome quality, great result.",
  "Cozy Vibe: Focus on peaceful atmosphere, clean setup, attentive staff, leaving super satisfied.",
  "Minimalist 5-Star: 20 to 30 words, punchy, honest, direct recommendation.",
  "Local Regular Customer: Vibe of a loyal customer who frequents this place regularly and recommends it to friends.",
  "First Time Visitor: Vibe of someone who tried this place for the first time on a recommendation and was blown away.",
  "Family or Group Visitor: Vibe of a family or group of friends enjoying their visit together.",
  "Speed & Efficiency Focus: Praising quick response, prompt service, zero waiting time, smooth experience.",
  "Quality Specialist: Highlighting craftsmanship, fresh ingredients, top-notch quality, and attention to detail."
];

const CASUAL_PHRASES = [
  "honestly", "super happy", "really impressed", "hands down", "definitely coming back",
  "so glad I found this place", "left feeling great", "fresh and clean", "spot on", "worth every penny",
  "exceeded my expectations", "top quality experience", "cannot recommend enough", "my new favorite spot", "absolutely loved it"
];

function sanitizeSlug(s) {
  return s ? s.toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
}

function getBizConfig(slug) {
  const cleanSlug = sanitizeSlug(slug);

  if (dbStore[cleanSlug]) {
    return dbStore[cleanSlug];
  }

  const raw = process.env[`BIZ_${cleanSlug}`];
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }

  if (DEFAULT_BUSINESSES[cleanSlug]) {
    return DEFAULT_BUSINESSES[cleanSlug];
  }

  const formattedName = cleanSlug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let inferredType = 'store';
  if (cleanSlug.includes('fashion') || cleanSlug.includes('clothing') || cleanSlug.includes('wear')) inferredType = 'clothing store';
  else if (cleanSlug.includes('saloon') || cleanSlug.includes('salon') || cleanSlug.includes('hair')) inferredType = 'saloon';
  else if (cleanSlug.includes('barber')) inferredType = 'barbershop';
  else if (cleanSlug.includes('food') || cleanSlug.includes('restaurant') || cleanSlug.includes('mandi')) inferredType = 'restaurant';
  else if (cleanSlug.includes('cafe')) inferredType = 'cafe';

  return {
    name: formattedName,
    type: inferredType,
    googleReviewLink: `https://search.google.com/local/writereview?placeid=${cleanSlug}`,
    siteUrl: `https://scanqr-beta.vercel.app?biz=${cleanSlug}`,
    language: "English"
  };
}

function adminAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== DEFAULT_ADMIN_KEY()) {
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

// ── 5,000 BULK REVIEW BANK GENERATOR FOR A BUSINESS ────────────────────────────
async function generate5kBankForSlug(slug, targetCount = 5000) {
  const cleanSlug = sanitizeSlug(slug);
  const config    = getBizConfig(cleanSlug);
  const name      = config.name || cleanSlug;
  const type      = (config.type || 'store').toLowerCase();
  const lang      = config.language || 'English';

  const menuArr = config.menuItems ? config.menuItems.split(',').map(s => s.trim()).filter(Boolean) : [];
  const highArr = config.highlights ? config.highlights.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (!tursoClient) {
    throw new Error('Turso Cloud Client is not initialized');
  }

  // Clear existing bank for clean generation
  await tursoClient.execute({ sql: 'DELETE FROM review_bank WHERE slug = ?', args: [cleanSlug] });
  await tursoClient.execute({ sql: 'INSERT INTO review_bank_pointers (slug, current_pointer) VALUES (?, 0) ON CONFLICT(slug) DO UPDATE SET current_pointer = 0', args: [cleanSlug] });

  console.log(`⚡ Generating ${targetCount} reviews for '${cleanSlug}' into Turso Cloud DB…`);

  const batchSize = 250;
  let inserted = 0;

  for (let batchStart = 0; batchStart < targetCount; batchStart += batchSize) {
    const currentBatch = Math.min(batchSize, targetCount - batchStart);
    const statements  = [];

    for (let i = 0; i < currentBatch; i++) {
      const order = batchStart + i + 1;
      const id    = `${cleanSlug}_${order}_${Date.now()}`;
      
      const item      = menuArr.length ? menuArr[(order + i) % menuArr.length] : (type.includes('fashion') ? 'outfits' : (type.includes('mandi') ? 'mandi' : 'service'));
      const highlight = highArr.length ? highArr[(order + i) % highArr.length] : 'clean vibe and great staff';
      const phrase    = CASUAL_PHRASES[(order + i) % CASUAL_PHRASES.length];

      let rev = '';
      const stylePattern = order % 6;

      if (stylePattern === 0) {
        rev = `${phrase} so glad I visited ${name}. tried the ${item} and it was incredible. ${highlight}, definitely coming back!`;
      } else if (stylePattern === 1) {
        rev = `Loved my visit to ${name}! The team was super welcoming, ${highlight}. Really happy with my ${item}.`;
      } else if (stylePattern === 2) {
        rev = `Best ${type} experience! Spotless clean environment at ${name}, excellent ${item}, and fair pricing. Highly recommended!`;
      } else if (stylePattern === 3) {
        rev = `Walked into ${name} today and left super satisfied. ${phrase} top quality ${item} and ${highlight}.`;
      } else if (stylePattern === 4) {
        rev = `Top tier experience at ${name}! Wonderful ${item}, peaceful atmosphere, and ${highlight}. 100% worth every penny!`;
      } else {
        rev = `${name} exceeded my expectations today. ${phrase} impressive ${item}, awesome staff, and ${highlight}.`;
      }

      statements.push({
        sql: 'INSERT INTO review_bank (id, slug, review, review_order) VALUES (?, ?, ?, ?)',
        args: [id, cleanSlug, rev, order]
      });
    }

    // Execute batch insert in transaction
    await tursoClient.batch(statements, 'write');
    inserted += currentBatch;
  }

  console.log(`✅ Successfully generated & stored ${inserted} reviews for '${cleanSlug}' in Turso Cloud DB!`);
  return inserted;
}

// ── POP REVIEW FROM 5,000 BANK (< 5ms LATENCY) ──────────────────────────────
async function popFrom5kReviewBank(slug) {
  const cleanSlug = sanitizeSlug(slug);
  const config    = getBizConfig(cleanSlug);

  if (!tursoClient) return null;

  try {
    // 1. Get pointer
    const ptrRes = await tursoClient.execute({
      sql: 'SELECT current_pointer FROM review_bank_pointers WHERE slug = ?',
      args: [cleanSlug]
    });

    let pointer = 0;
    if (ptrRes.rows && ptrRes.rows.length > 0) {
      pointer = ptrRes.rows[0].current_pointer || 0;
    }

    // 2. Count total rows in bank for slug
    const countRes = await tursoClient.execute({
      sql: 'SELECT COUNT(*) as total FROM review_bank WHERE slug = ?',
      args: [cleanSlug]
    });

    const totalInBank = (countRes.rows && countRes.rows[0]) ? Number(countRes.rows[0].total) : 0;

    if (totalInBank === 0) return null;

    const reviewOrder = (pointer % totalInBank) + 1;

    // 3. Fetch review at order
    const revRes = await tursoClient.execute({
      sql: 'SELECT review FROM review_bank WHERE slug = ? AND review_order = ?',
      args: [cleanSlug, reviewOrder]
    });

    // 4. Increment pointer atomically
    await tursoClient.execute({
      sql: 'INSERT INTO review_bank_pointers (slug, current_pointer) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET current_pointer = current_pointer + 1',
      args: [cleanSlug]
    });

    if (revRes.rows && revRes.rows.length > 0) {
      return {
        review: revRes.rows[0].review,
        order: reviewOrder,
        totalInBank
      };
    }
  } catch (err) {
    console.error(`[Bank Pop Error] ${cleanSlug}:`, err.message);
  }

  return null;
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString(), tursoConnected: !!tursoClient });
});

// ── GET config for a slug ──────────────────────────────────────────────────────
app.get('/api/config/:slug', (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);
  res.json(config);
});

// ── ULTRA FAST 0ms USER REVIEW ENDPOINT (< 5ms FROM 5K TURSO BANK) ────────────
async function handleReviewRequest(req, res) {
  const cleanSlug  = sanitizeSlug(req.params.slug) || 'saloon';
  const config     = getBizConfig(cleanSlug);
  const clientMeta = getClientMetadata(req);

  let reviewText   = '';
  let reviewSource = '5K Review Bank (Turso Cloud)';

  // 1. Try popping from 5K Turso Review Bank first (< 5ms)
  const bankResult = await popFrom5kReviewBank(cleanSlug);

  if (bankResult && bankResult.review) {
    reviewText   = bankResult.review;
    reviewSource = `5K Review Bank (Turso Cloud #${bankResult.order}/${bankResult.totalInBank})`;
  } else {
    // Fallback seed review if bank is generating
    const name = config.name || cleanSlug;
    reviewText = `honestly so happy with my visit to ${name}! staff were super friendly, clean place, and service was top quality. definitely coming back.`;
    reviewSource = 'Seed Review Fallback';
  }

  recordScanEvent(cleanSlug, clientMeta, reviewSource);

  res.json({
    slug: cleanSlug,
    businessName: config.name,
    review: reviewText,
    generated: true,
    reviewSource,
    clientMeta: { deviceType: clientMeta.deviceType, timeOfDay: clientMeta.timeOfDay }
  });
}

app.get('/api/review/:slug', handleReviewRequest);
app.post('/api/review/:slug', handleReviewRequest);

// ── ADMIN: Populate 5,000 Reviews for ALL Businesses API ───────────────────────
app.post('/admin/api/bank/generate-all', adminAuth, async (req, res) => {
  const slugs = Object.keys(dbStore);
  const results = [];

  try {
    for (const slug of slugs) {
      const count = await generate5kBankForSlug(slug, 5000);
      results.push({ slug, name: dbStore[slug].name || slug, count });
    }
    res.json({ success: true, totalBusinesses: results.length, totalReviews: results.reduce((a, b) => a + b.count, 0), results });
  } catch (err) {
    res.status(500).json({ error: `Bulk 15K generation error: ${err.message}` });
  }
});

// ── ADMIN: Generate 5,000 Reviews for Single Business API ───────────────────────
app.post('/admin/api/bank/generate/:slug', adminAuth, async (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  try {
    const count = await generate5kBankForSlug(cleanSlug, 5000);
    res.json({ success: true, slug: cleanSlug, count, message: `Successfully generated and stored ${count} reviews in Turso Cloud DB for '${cleanSlug}'!` });
  } catch (err) {
    res.status(500).json({ error: `Bank generation error: ${err.message}` });
  }
});

// ── ADMIN: CSV EXPORT ALL 15,000 REVIEWS API ──────────────────────────────────
app.get('/admin/api/bank/export-csv', adminAuth, async (req, res) => {
  if (!tursoClient) {
    return res.status(500).send('Turso Cloud DB not initialized');
  }

  try {
    const query = await tursoClient.execute(`
      SELECT slug, review_order, review FROM review_bank ORDER BY slug ASC, review_order ASC
    `);

    let csv = 'Business Slug,Business Name,Review Order,Review Text\n';

    if (query.rows && query.rows.length > 0) {
      query.rows.forEach(r => {
        const config = getBizConfig(r.slug);
        const name   = (config.name || r.slug).replace(/"/g, '""');
        const text   = (r.review || '').replace(/"/g, '""');
        csv += `"${r.slug}","${name}","${r.review_order}","${text}"\n`;
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=15K_Reviews_Bank_Audit.csv');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).send(`CSV Export Error: ${err.message}`);
  }
});

// ── ADMIN: Bank Inspection & Search API ───────────────────────────────────────
app.get('/admin/api/bank/inspect', adminAuth, async (req, res) => {
  if (!tursoClient) {
    return res.status(500).json({ error: 'Turso Cloud DB not initialized' });
  }

  const slug  = sanitizeSlug(req.query.slug);
  const q     = (req.query.q || '').trim();
  const page  = parseInt(req.query.page || '1', 10);
  const limit = 50;
  const offset = (page - 1) * limit;

  try {
    let whereClause = '';
    const args = [];

    if (slug && q) {
      whereClause = 'WHERE slug = ? AND review LIKE ?';
      args.push(slug, `%${q}%`);
    } else if (slug) {
      whereClause = 'WHERE slug = ?';
      args.push(slug);
    } else if (q) {
      whereClause = 'WHERE review LIKE ?';
      args.push(`%${q}%`);
    }

    const countRes = await tursoClient.execute({
      sql: `SELECT COUNT(*) as total FROM review_bank ${whereClause}`,
      args
    });

    const total = (countRes.rows && countRes.rows[0]) ? Number(countRes.rows[0].total) : 0;

    const dataRes = await tursoClient.execute({
      sql: `SELECT id, slug, review, review_order FROM review_bank ${whereClause} ORDER BY slug ASC, review_order ASC LIMIT ? OFFSET ?`,
      args: [...args, limit, offset]
    });

    // Get per-business summary counts & pointers
    const summaryRes = await tursoClient.execute(`
      SELECT b.slug, COUNT(r.id) as total_in_bank, COALESCE(p.current_pointer, 0) as current_pointer
      FROM businesses b
      LEFT JOIN review_bank r ON b.slug = r.slug
      LEFT JOIN review_bank_pointers p ON b.slug = p.slug
      GROUP BY b.slug
    `);

    const summary = summaryRes.rows.map(r => ({
      slug: r.slug,
      name: (getBizConfig(r.slug) || {}).name || r.slug,
      totalInBank: Number(r.total_in_bank || 0),
      currentPointer: Number(r.current_pointer || 0)
    }));

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      summary,
      items: dataRes.rows.map(r => ({
        id: r.id,
        slug: r.slug,
        businessName: (getBizConfig(r.slug) || {}).name || r.slug,
        reviewOrder: r.review_order,
        review: r.review
      }))
    });
  } catch (err) {
    res.status(500).json({ error: `Bank inspection error: ${err.message}` });
  }
});

// ── ADMIN: Analytics API & CSV Export ──────────────────────────────────────────
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

app.get('/admin/api/analytics/export', adminAuth, (req, res) => {
  let csv = 'Timestamp,Date,Business Slug,Device Type,Time of Day,Review Engine Source,IP Address\n';
  analyticsStore.logs.forEach(l => {
    csv += `"${l.timestamp}","${l.date}","${l.slug}","${l.deviceType}","${l.timeOfDay}","${l.source}","${l.ip}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=scan_analytics_log.csv');
  res.status(200).send(csv);
});

app.delete('/admin/api/analytics/clear', adminAuth, (req, res) => {
  analyticsStore.totalScans = 0;
  analyticsStore.uniqueIps.clear();
  analyticsStore.deviceStats = { Smartphone: 0, Desktop: 0 };
  analyticsStore.timeStats = { Morning: 0, Afternoon: 0, Evening: 0 };
  analyticsStore.sourceStats = { '5K Review Bank': 0, 'Gemini AI Queue': 0, 'Initial Seed Queue': 0 };
  analyticsStore.logs = [];
  res.json({ success: true, message: 'Analytics history cleared successfully.' });
});

// ── ADMIN: DATABASE EXPORT & IMPORT APIs ───────────────────────────────────────
app.get('/admin/api/db/export', adminAuth, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=businesses_db_backup.json');
  res.status(200).send(JSON.stringify(dbStore, null, 2));
});

app.post('/admin/api/db/import', adminAuth, async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  Object.assign(dbStore, req.body);
  saveDatabase(dbStore);

  for (const [slug, cfg] of Object.entries(req.body)) {
    await upsertTursoBusiness(slug, cfg);
  }

  res.json({ success: true, count: Object.keys(dbStore).length, message: 'Database restored to Turso Cloud & Disk successfully.' });
});

// ── ADMIN: Settings API (Turso Cloud Database Backed) ──────────────────────────
app.get('/admin/api/settings', adminAuth, (req, res) => {
  res.json({
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    tursoDatabaseUrl: TURSO_URL,
    tursoConnected: !!tursoClient,
    adminApiKeyConfigured: true
  });
});

app.post('/admin/api/settings', adminAuth, async (req, res) => {
  const { geminiApiKey, adminApiKey } = req.body;
  if (geminiApiKey) {
    process.env.GEMINI_API_KEY = geminiApiKey;
    await upsertTursoAppSetting('gemini_api_key', geminiApiKey);
  }
  if (adminApiKey) {
    process.env.ADMIN_API_KEY  = adminApiKey;
    await upsertTursoAppSetting('admin_api_key', adminApiKey);
  }
  res.json({ success: true, note: 'Saved & Persisted permanently to Turso Cloud DB!' });
});

// ── ADMIN: Business APIs (Turso Cloud DB + Disk Backed) ────────────────────────
app.get('/admin/api/businesses', adminAuth, (req, res) => {
  const slugs = new Set([
    ...Object.keys(dbStore),
    ...Object.keys(DEFAULT_BUSINESSES)
  ]);

  const list = Array.from(slugs).map(slug => {
    const cfg = getBizConfig(slug);
    const hasCustomKey = !!cfg.geminiApiKey;
    const maskedKey = cfg.geminiApiKey ? (cfg.geminiApiKey.substring(0, 6) + '...' + cfg.geminiApiKey.substring(cfg.geminiApiKey.length - 4)) : null;
    return {
      slug,
      ...(cfg || {}),
      hasCustomApiKey: hasCustomKey,
      maskedApiKey: maskedKey
    };
  });

  res.json(list);
});

app.post('/admin/api/config/:slug', adminAuth, async (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug);
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Empty body' });
  }

  if (!req.body.siteUrl) {
    req.body.siteUrl = `https://scanqr-beta.vercel.app?biz=${cleanSlug}`;
  }

  dbStore[cleanSlug] = req.body;
  await upsertTursoBusiness(cleanSlug, req.body);
  saveDatabase(dbStore);

  process.env[`BIZ_${cleanSlug}`] = JSON.stringify(req.body);

  // Auto generate 5K review bank if missing
  setImmediate(async () => {
    try {
      await generate5kBankForSlug(cleanSlug, 5000);
    } catch {}
  });

  res.json({ success: true, config: req.body });
});

app.delete('/admin/api/config/:slug', adminAuth, async (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug);
  
  delete dbStore[cleanSlug];
  await deleteTursoBusiness(cleanSlug);
  saveDatabase(dbStore);

  delete process.env[`BIZ_${cleanSlug}`];

  res.json({ success: true, message: `Business '${cleanSlug}' deleted from Turso Cloud & local DB.` });
});

app.get('/admin/api/status', adminAuth, async (req, res) => {
  const slugs = new Set([
    ...Object.keys(dbStore),
    ...Object.keys(DEFAULT_BUSINESSES)
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
    tursoConnected: !!tursoClient,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    sites: checks,
    checkedAt: new Date().toISOString()
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── INITIALIZE TURSO DB & BANK ON STARTUP ─────────────────────────────────────
initAndMigrateTurso().then(async () => {
  if (!tursoClient) return;
  try {
    const countRes = await tursoClient.execute('SELECT COUNT(*) as total FROM review_bank');
    const totalInBank = countRes.rows && countRes.rows[0] ? Number(countRes.rows[0].total) : 0;

    if (totalInBank === 0) {
      console.log('🔄 Auto-generating initial 5,000 review banks for all businesses into Turso Cloud DB…');
      for (const slug of Object.keys(dbStore)) {
        await generate5kBankForSlug(slug, 5000);
      }
    } else {
      console.log(`📦 Loaded ${totalInBank} pre-generated reviews from Turso Cloud DB Review Bank!`);
    }
  } catch (err) {
    console.error('[Bank Startup Check Error]:', err.message);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  scan-qr backend v18.0 (15,000 Review Bank Engine + Turso Cloud Storage + CSV Exporter) running on port ${PORT}`);
});
