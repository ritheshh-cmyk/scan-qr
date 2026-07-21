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
  }
};

// ── TURSO CLOUD DATABASE & LOCAL DISK FALLBACK ENGINE ─────────────────────────
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
    // 1. Businesses table (with backupReviews JSON column)
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
      sql: `INSERT INTO businesses (slug, name, type, googleReviewLink, siteUrl, language, geminiApiKey, menuItems, highlights, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              name=excluded.name,
              type=excluded.type,
              googleReviewLink=excluded.googleReviewLink,
              siteUrl=excluded.siteUrl,
              language=excluded.language,
              geminiApiKey=excluded.geminiApiKey,
              menuItems=excluded.menuItems,
              highlights=excluded.highlights,
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
  } catch (err) {
    console.error(`[Turso Delete Error] ${slug}:`, err.message);
  }
}

function saveDatabase(dbData) {
  saveLocalDatabase(dbData);
}

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

// ── FIFO Review Queue & Detailed Telemetry Engine (Per-Business Isolated) ───────
const MAX_QUEUE_SIZE = 10;
const reviewQueues   = {}; 
const recentReviews  = {}; 

// Queue Telemetry Tracker Per Business
const queueStats = {}; 
let globalOfflineFallbackCount = 0; // Total times 50 backup reviews were served

function getQueueStats(slug) {
  const cleanSlug = sanitizeSlug(slug);
  if (!queueStats[cleanSlug]) {
    queueStats[cleanSlug] = {
      totalPopped: 0,
      offlineFallbackPopped: 0,
      backupIndex: 0,
      lastPoppedAt: null,
      lastGeneratedAt: null
    };
  }
  return queueStats[cleanSlug];
}

// ── Analytics Tracker Storage ──────────────────────────────────────────────────
const analyticsStore = {
  totalScans: 0,
  uniqueIps: new Set(),
  deviceStats: { Smartphone: 0, Desktop: 0 },
  timeStats: { Morning: 0, Afternoon: 0, Evening: 0 },
  sourceStats: { 'Gemini AI Queue': 0, 'Initial Seed Queue': 0, 'Offline Backup 50': 0 },
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

  // 1. Check persistent database cache first!
  if (dbStore[cleanSlug]) {
    return dbStore[cleanSlug];
  }

  // 2. Check process.env
  const raw = process.env[`BIZ_${cleanSlug}`];
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }

  // 3. Check hardcoded defaults
  if (DEFAULT_BUSINESSES[cleanSlug]) {
    return DEFAULT_BUSINESSES[cleanSlug];
  }

  // 4. DYNAMIC SLUG FALLBACK: Infer name & type from slug so custom business NEVER fails!
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
    siteUrl: `https://scanqr-beta.vercel.app?biz=${cleanSlug}`,
    language: "English"
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

// ── Background Worker: Generate new AI review with Context Realism ─────────────
async function generateAndEnqueueReview(slug, meta, customInput = {}) {
  const cleanSlug = sanitizeSlug(slug);
  const config    = getBizConfig(cleanSlug);

  const primaryKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  const backupKey  = process.env.GEMINI_API_KEY;

  if (!primaryKey && !backupKey) return;

  const type       = config.type || 'business';
  const name       = config.name || cleanSlug;
  const lang       = config.language || 'English';
  const menuItems  = config.menuItems ? `Popular Menu/Services: ${config.menuItems}.` : '';
  const highlights = config.highlights ? `Special Highlights: ${config.highlights}.` : '';

  const selectedPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const selectedPhrase  = CASUAL_PHRASES[Math.floor(Math.random() * CASUAL_PHRASES.length)];
  const randomSeed      = `${Date.now()}_${Math.floor(Math.random() * 999999)}_${meta.ip || 'admin'}`;

  const fullPrompt =
    `You are a real everyday customer writing a quick 5-star Google review for "${name}", a ${type}.\n` +
    `${menuItems} ${highlights}\n` +
    `Language: Write the review naturally in ${lang}.\n` +
    `Style persona: ${selectedPersona}\n` +
    `Include a natural casual phrase like "${selectedPhrase}". Naturally reference one of the services, items, or highlights if applicable.\n` +
    `CRITICAL: Sound completely human, non-AI, between 25 and 45 words. Focus ONLY on ${name} (${type}). DO NOT use cliché phrases like '10/10' or '5 stars'. Output ONLY the review text. No quotes. Seed: ${randomSeed}`;

  let reviewText = null;
  let modelUsed  = null;

  try {
    const genAI = new GoogleGenerativeAI(primaryKey);
    const res = await generateWithFallbackModel(genAI, fullPrompt);
    reviewText = res.text;
    modelUsed  = res.modelUsed;
  } catch (primaryErr) {
    if (backupKey && backupKey !== primaryKey) {
      try {
        const genAI = new GoogleGenerativeAI(backupKey);
        const res = await generateWithFallbackModel(genAI, fullPrompt);
        reviewText = res.text;
        modelUsed  = res.modelUsed + ' (failover)';
      } catch (backupErr) {
        return;
      }
    } else {
      return;
    }
  }

  if (!reviewText) return;

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
    meta: { deviceType: meta.deviceType || 'Smartphone', persona: selectedPersona, modelUsed, language: lang },
    timestamp: Date.now()
  });

  while (reviewQueues[cleanSlug].length > MAX_QUEUE_SIZE) {
    reviewQueues[cleanSlug].shift();
  }

  const stats = getQueueStats(cleanSlug);
  stats.lastGeneratedAt = new Date().toISOString();
}

// ── 50 TAILORED OFFLINE BACKUP REVIEWS GENERATOR ─────────────────────────────────
async function generate50BackupReviews(slug) {
  const cleanSlug = sanitizeSlug(slug);
  const config    = getBizConfig(cleanSlug);
  const name      = config.name || cleanSlug;
  const type      = (config.type || 'store').toLowerCase();
  const lang      = config.language || 'English';

  const menuArr = config.menuItems ? config.menuItems.split(',').map(s => s.trim()) : [];
  const highArr = config.highlights ? config.highlights.split(',').map(s => s.trim()) : [];

  const backups = [];

  for (let i = 1; i <= 50; i++) {
    const item  = menuArr.length ? menuArr[i % menuArr.length] : (type.includes('fashion') ? 'outfits' : 'service');
    const highlight = highArr.length ? highArr[i % highArr.length] : 'clean vibe and great staff';
    const phrase = CASUAL_PHRASES[i % CASUAL_PHRASES.length];

    let rev = '';
    if (i % 5 === 0) {
      rev = `${phrase} so glad I visited ${name}. got the ${item} and it was fantastic. ${highlight}, definitely coming back!`;
    } else if (i % 5 === 1) {
      rev = `Loved my visit to ${name}! The team was warm and welcoming, ${highlight}. Really happy with my ${item}.`;
    } else if (i % 5 === 2) {
      rev = `Best ${type} in town! Spotless clean environment at ${name}, excellent ${item}, and fair pricing. Highly recommended!`;
    } else if (i % 5 === 3) {
      rev = `Walked into ${name} today and left super satisfied. ${phrase} top quality ${item} and ${highlight}.`;
    } else {
      rev = `Top tier experience at ${name}! Wonderful ${item}, peaceful atmosphere, and ${highlight}. 100% worth it!`;
    }

    backups.push(rev);
  }

  config.backupReviews = backups;
  dbStore[cleanSlug]   = config;

  await upsertTursoBusiness(cleanSlug, config);
  saveDatabase(dbStore);

  return backups;
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString(), tursoConnected: !!tursoClient });
});

// ── GET config for a slug ──────────────────────────────────────────────────────
app.get('/api/config/:slug', (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);

  seedQueueIfEmpty(cleanSlug, config);
  res.json(config);
});

// ── FAST FIFO QUEUE REVIEW ENDPOINT (< 50ms) WITH 50 BACKUP FAILOVER ───────────
async function handleReviewRequest(req, res) {
  const cleanSlug  = sanitizeSlug(req.params.slug) || 'saloon';
  const config     = getBizConfig(cleanSlug);
  const clientMeta = getClientMetadata(req);

  seedQueueIfEmpty(cleanSlug, config);

  const stats = getQueueStats(cleanSlug);
  const queue = reviewQueues[cleanSlug] || [];
  let reviewObj = null;

  if (queue.length > 0) {
    reviewObj = queue.shift();
  }

  // CONTINUOUS QUEUE REPLENISHMENT: If queue length drops below 5, generate new AI reviews!
  if (queue.length < 5) {
    setImmediate(() => {
      generateAndEnqueueReview(cleanSlug, clientMeta);
    });
  }

  // 🛡️ OFFLINE / QUOTA EXHAUSTED FAILOVER: Pop from 50 Backup Reviews Array!
  if (!reviewObj) {
    const backups = config.backupReviews && config.backupReviews.length ? config.backupReviews : null;
    let fallbackText = '';

    if (backups && backups.length > 0) {
      const idx = stats.backupIndex % backups.length;
      fallbackText = backups[idx];
      stats.backupIndex++;
    } else {
      const name = config.name || cleanSlug;
      fallbackText = `honestly loved my visit to ${name}! clean place, friendly staff, and top tier quality. Highly recommend.`;
    }

    reviewObj = {
      review: fallbackText,
      generated: false,
      source: 'offline-backup-50',
      timestamp: Date.now()
    };

    stats.offlineFallbackPopped++;
    globalOfflineFallbackCount++;
  }

  stats.totalPopped++;
  stats.lastPoppedAt = new Date().toISOString();

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

// ── ADMIN: Generate 50 Offline Backup Reviews API ──────────────────────────────
app.post('/admin/api/config/:slug/generate-backups', adminAuth, async (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  try {
    const backups = await generate50BackupReviews(cleanSlug);
    res.json({
      success: true,
      slug: cleanSlug,
      count: backups.length,
      sample: backups.slice(0, 3),
      message: `Successfully generated and persisted 50 offline backup reviews for '${cleanSlug}' to Turso Cloud DB!`
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to generate 50 backup reviews: ${err.message}` });
  }
});

// ── ADMIN: Direct AI Review Tester ─────────────────────────────────────────────
app.post('/admin/api/test-ai/:slug', adminAuth, async (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);
  const geminiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(503).json({ error: 'Gemini API Key is missing. Enter a valid key in Settings or Business form.', generated: false });
  }

  const type       = config.type || 'business';
  const name       = config.name || cleanSlug;
  const lang       = config.language || 'English';
  const menuItems  = config.menuItems ? `Popular Menu/Services: ${config.menuItems}.` : '';
  const highlights = config.highlights ? `Special Highlights: ${config.highlights}.` : '';

  const selectedPersona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  const selectedPhrase  = CASUAL_PHRASES[Math.floor(Math.random() * CASUAL_PHRASES.length)];
  const randomSeed      = `${Date.now()}_${Math.floor(Math.random() * 999999)}`;

  const fullPrompt =
    `You are a real everyday customer writing a quick 5-star Google review for "${name}", a ${type}.\n` +
    `${menuItems} ${highlights}\n` +
    `Language: Write the review naturally in ${lang}.\n` +
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
      language: lang,
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

// ── ADMIN: Comprehensive Per-Business Queue Summary API ───────────────────────
app.get('/admin/api/queues/summary', adminAuth, (req, res) => {
  const slugs = new Set([
    ...Object.keys(dbStore),
    ...Object.keys(DEFAULT_BUSINESSES),
    ...Object.keys(reviewQueues)
  ]);

  const summary = Array.from(slugs).map(slug => {
    const config = getBizConfig(slug);
    const q      = reviewQueues[slug] || [];
    const stats  = getQueueStats(slug);

    const aiCount   = q.filter(i => i.generated).length;
    const seedCount = q.filter(i => !i.generated).length;
    const backupCount = config.backupReviews ? config.backupReviews.length : 0;

    return {
      slug,
      name:                  config.name || slug,
      type:                  config.type || 'business',
      language:              config.language || 'English',
      menuItems:             config.menuItems || null,
      highlights:            config.highlights || null,
      queueLength:           q.length,
      maxQueueSize:          MAX_QUEUE_SIZE,
      aiGeneratedCount:      aiCount,
      seedCount:             seedCount,
      offlineBackupCount:    backupCount,
      totalPopped:           stats.totalPopped || 0,
      offlineFallbackPopped: stats.offlineFallbackPopped || 0,
      lastPoppedAt:          stats.lastPoppedAt ? new Date(stats.lastPoppedAt).toLocaleTimeString() : 'Never',
      lastGeneratedAt:       stats.lastGeneratedAt ? new Date(stats.lastGeneratedAt).toLocaleTimeString() : 'Startup',
      hasCustomApiKey:       !!config.geminiApiKey,
      googleReviewLink:      config.googleReviewLink || null
    };
  });

  res.json({
    totalBusinesses: summary.length,
    globalOfflineFallbackCount,
    summary
  });
});

// ── ADMIN: Queue Inspector API ────────────────────────────────────────────────
app.get('/admin/api/queue/:slug', adminAuth, (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);
  seedQueueIfEmpty(cleanSlug, config);

  const q     = reviewQueues[cleanSlug] || [];
  const stats = getQueueStats(cleanSlug);

  res.json({
    slug: cleanSlug,
    businessName: config.name || cleanSlug,
    queueLength: q.length,
    maxSize: MAX_QUEUE_SIZE,
    totalPopped: stats.totalPopped || 0,
    offlineFallbackPopped: stats.offlineFallbackPopped || 0,
    backupCount: config.backupReviews ? config.backupReviews.length : 0,
    lastPoppedAt: stats.lastPoppedAt ? new Date(stats.lastPoppedAt).toLocaleTimeString() : 'Never',
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

app.post('/admin/api/queue/:slug/clear', adminAuth, (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  reviewQueues[cleanSlug] = [];
  res.json({ success: true, message: `Queue for business '${cleanSlug}' cleared successfully.` });
});

app.post('/admin/api/queue/:slug/seed', adminAuth, (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  reviewQueues[cleanSlug] = [];
  const config = getBizConfig(cleanSlug);
  seedQueueIfEmpty(cleanSlug, config);
  const q = reviewQueues[cleanSlug] || [];
  res.json({ success: true, message: `Re-seeded human queue for '${cleanSlug}'. Queue size: ${q.length}` });
});

app.post('/admin/api/queue/:slug/generate', adminAuth, async (req, res) => {
  const cleanSlug  = sanitizeSlug(req.params.slug) || 'saloon';
  const clientMeta = getClientMetadata(req);
  await generateAndEnqueueReview(cleanSlug, clientMeta);
  const q = reviewQueues[cleanSlug] || [];
  res.json({ success: true, message: `Triggered AI generation for '${cleanSlug}'. Current queue length: ${q.length}` });
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
  analyticsStore.sourceStats = { 'Gemini AI Queue': 0, 'Initial Seed Queue': 0, 'Offline Backup 50': 0 };
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
    seedQueueIfEmpty(slug, cfg);
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
    ...Object.keys(DEFAULT_BUSINESSES),
    ...Object.keys(process.env).filter(k => k.startsWith('BIZ_')).map(k => k.replace('BIZ_', '').toLowerCase())
  ]);

  const list = Array.from(slugs).map(slug => {
    const cfg = getBizConfig(slug);
    const hasCustomKey = !!cfg.geminiApiKey;
    const maskedKey = cfg.geminiApiKey ? (cfg.geminiApiKey.substring(0, 6) + '...' + cfg.geminiApiKey.substring(cfg.geminiApiKey.length - 4)) : null;
    return {
      slug,
      ...(cfg || {}),
      hasCustomApiKey: hasCustomKey,
      maskedApiKey: maskedKey,
      hasBackup50: cfg.backupReviews && cfg.backupReviews.length === 50
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

  // Preserve existing backupReviews if not passed
  const existing = getBizConfig(cleanSlug);
  if (existing.backupReviews && !req.body.backupReviews) {
    req.body.backupReviews = existing.backupReviews;
  }

  // 1. Update in-memory persistent dbStore
  dbStore[cleanSlug] = req.body;

  // 2. Persist to Turso Cloud SQLite Database (including custom geminiApiKey & backupReviews)!
  await upsertTursoBusiness(cleanSlug, req.body);

  // 3. Persist to local disk database (db/businesses.json) synchronously
  saveDatabase(dbStore);

  // 4. Keep env var synced
  process.env[`BIZ_${cleanSlug}`] = JSON.stringify(req.body);
  
  // 5. Seed queue immediately
  seedQueueIfEmpty(cleanSlug, req.body);

  res.json({ success: true, config: req.body });
});

app.delete('/admin/api/config/:slug', adminAuth, async (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug);
  
  delete dbStore[cleanSlug];
  await deleteTursoBusiness(cleanSlug);
  saveDatabase(dbStore);

  delete process.env[`BIZ_${cleanSlug}`];
  delete reviewQueues[cleanSlug];
  delete recentReviews[cleanSlug];
  delete queueStats[cleanSlug];

  res.json({ success: true, message: `Business '${cleanSlug}' deleted from Turso Cloud & local DB.` });
});

app.get('/admin/api/status', adminAuth, async (req, res) => {
  const slugs = new Set([
    ...Object.keys(dbStore),
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
    tursoConnected: !!tursoClient,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    globalOfflineFallbackCount,
    queues: Object.keys(reviewQueues).reduce((acc, k) => { acc[k] = reviewQueues[k].length; return acc; }, {}),
    sites: checks,
    checkedAt: new Date().toISOString()
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── INITIALIZE TURSO DB & QUEUES ON STARTUP ─────────────────────────────────────
initAndMigrateTurso().then(() => {
  Object.keys(dbStore).forEach(slug => {
    seedQueueIfEmpty(slug, dbStore[slug]);
    // Auto-generate 50 backup reviews if missing
    if (!dbStore[slug].backupReviews || dbStore[slug].backupReviews.length === 0) {
      generate50BackupReviews(slug).catch(() => {});
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  scan-qr backend v16.0 (50 Offline Backup Reviews Engine + Context Realism) running on port ${PORT}`);
});
