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

    // ── Run migrations for columns added in newer versions ───────────────────────
    const columnsToMigrate = [
      { name: 'menuItems', type: 'TEXT' },
      { name: 'highlights', type: 'TEXT' },
      { name: 'reviewTone', type: 'TEXT' }
    ];

    for (const col of columnsToMigrate) {
      try {
        await tursoClient.execute(`ALTER TABLE businesses ADD COLUMN ${col.name} ${col.type}`);
        console.log(`📡 Migrated database: Added column '${col.name}' to businesses table.`);
      } catch (err) {
        // Ignore column already exists errors
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          console.warn(`[Turso Migration Column Warning] ${col.name}:`, err.message);
        }
      }
    }

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

// Per-category vocabulary banks
const REVIEW_VOCAB = {
  // ── SALON / HAIR ──────────────────────────────────────────────────────────────
  salon: {
    actions:     ['got my haircut', 'had my hair styled', 'got a blowdry', 'tried their hair spa', 'got highlights done', 'had a keratin treatment', 'went for a hair trim'],
    compliments: ['the stylist was super skilled', 'they listened to exactly what I wanted', 'my hair looks amazing', 'the finish was flawless', 'best haircut I\'ve had in years', 'incredibly clean setup', 'the staff was so gentle and professional'],
    openers:     ['just walked out of', 'finally found my go-to salon —', 'visited', 'popped into', 'treated myself at', 'had an appointment at'],
    closers:     ['already booked my next appointment!', 'my hair has never looked this good.', 'will definitely be back.', '100% recommended.', 'found my new hair salon.', 'super happy with the results.'],
  },
  saloon: {
    actions:     ['got a fresh haircut', 'got my beard trimmed', 'had a hot towel shave', 'tried the hair spa', 'got a scalp massage', 'had a beard styling session'],
    compliments: ['the barber nailed the fade', 'super clean cuts', 'no waiting time at all', 'the ambiance was really chill', 'very skilled team', 'spotless place with great vibe', 'fair prices for top-tier service'],
    openers:     ['just came out of', 'dropped by', 'walked into', 'visited', 'finally went to', 'had a session at'],
    closers:     ['my go-to barber from now on.', 'walked out feeling fresh and confident.', 'best barbershop in the area.', 'will be back every month.', 'highly recommended for all guys.', 'the cut was exactly what I wanted.'],
  },
  barbershop: {
    actions:     ['got a fresh fade', 'had my beard lined up', 'got a hot shave', 'tried their signature cut', 'got a hair design', 'had a complete grooming session'],
    compliments: ['the barber was super precise', 'clean blade work every time', 'really cool vibe', 'they take their time and get it right', 'best fade in town', 'attention to detail is unreal', 'walked out looking sharp'],
    openers:     ['just came from', 'finally found a proper barber —', 'dropped by', 'visited', 'checked out', 'been going to'],
    closers:     ['my new regular spot.', 'the cut was fire.', 'walked out feeling like a new person.', 'already told my friends about this place.', 'top-tier barbershop.', 'will be back for sure.'],
  },
  // ── MANDI / ARABIC FOOD ───────────────────────────────────────────────────────
  'mandi restaurant': {
    actions:     ['had the mandi', 'tried the alfaham', 'ordered the fried mandi', 'had the grill mandi', 'tried the full mandi platter', 'shared the family mandi', 'ordered the juicy mandi'],
    compliments: ['the rice was perfectly cooked', 'the meat was fall-off-the-bone tender', 'super generous portions', 'the flavors were incredibly authentic', 'the mandi sauce was 🔥', 'the smoke flavor was amazing', 'best mandi I\'ve had outside home'],
    openers:     ['just finished a meal at', 'had lunch at', 'visited', 'took my family to', 'tried', 'dropped by'],
    closers:     ['the mandi was everything.', 'coming back with the whole family.', 'the best mandi spot in town.', 'totally worth it — go try it!', 'left stuffed and happy.', 'authentic taste you can\'t find everywhere.'],
  },
  // ── RESTAURANT / GENERAL FOOD ─────────────────────────────────────────────────
  restaurant: {
    actions:     ['had an amazing meal', 'tried the special', 'ordered their signature dish', 'had the chef\'s recommendation', 'tried the new menu', 'had a full dining experience'],
    compliments: ['the food was perfectly cooked', 'super fresh ingredients', 'incredible presentation', 'the flavors were on point', 'really generous portions', 'great ambiance and service', 'attentive and friendly staff'],
    openers:     ['just dined at', 'had a meal at', 'visited', 'took my family to', 'discovered', 'finally tried'],
    closers:     ['will definitely be back.', 'one of the best restaurants in the area.', 'fully recommend to anyone.', 'the food was outstanding.', 'great experience from start to finish.', 'already planning my next visit.'],
  },
  // ── CLOTHING / FASHION ────────────────────────────────────────────────────────
  'clothing store': {
    actions:     ['picked up some amazing outfits', 'found the perfect jeans', 'shopped for casuals', 'got a full outfit', 'found great ethnic wear', 'picked up some trendy pieces', 'got tops and bottoms'],
    compliments: ['the collection is so fresh and trendy', 'great fabric quality', 'super helpful staff who gave honest suggestions', 'good variety at fair prices', 'the fits were perfect', 'the boutique was clean and well-organized', 'love the styling'],
    openers:     ['just shopped at', 'finally checked out', 'visited', 'went to', 'dropped by', 'spent some time at'],
    closers:     ['my wardrobe thanks me.', 'already planning my next shopping trip here.', 'the best fashion store in the area.', 'great value for money.', 'will be back every season.', 'left with a full shopping bag and zero regrets.'],
  },
  // ── CAFE / COFFEE SHOP ────────────────────────────────────────────────────────
  cafe: {
    actions:     ['had an amazing coffee', 'tried their iced latte', 'had brunch', 'tried the signature drink', 'had a croissant and cappuccino', 'worked here for a few hours', 'had a catch-up over coffee'],
    compliments: ['the coffee was perfectly brewed', 'really cozy and chill vibe', 'great playlist in the background', 'fast and friendly service', 'the pastries were fresh', 'perfect place to work or relax', 'good WiFi and great seating'],
    openers:     ['just had the best session at', 'discovered', 'visited', 'spent my afternoon at', 'had a lovely time at', 'stopped by'],
    closers:     ['my new favorite cafe.', 'the perfect spot for a quiet work session.', 'will be back every week.', 'best coffee in the neighborhood.', 'highly recommend for the vibes alone.', 'a must-visit for any coffee lover.'],
  },
  // ── SPA / WELLNESS ───────────────────────────────────────────────────────────
  spa: {
    actions:     ['had a relaxing massage', 'tried the facial', 'had a body scrub treatment', 'tried the aromatherapy session', 'had a full spa package', 'got a deep tissue massage'],
    compliments: ['felt completely rejuvenated', 'the therapist was incredibly skilled', 'super calming atmosphere', 'walked out feeling like a new person', 'attention to detail was impressive', 'beautiful and peaceful setup', 'the products used were premium'],
    openers:     ['just had the most relaxing session at', 'treated myself to a day at', 'visited', 'spent my afternoon at', 'booked a session at', 'finally tried'],
    closers:     ['the best spa experience ever.', 'will make this a monthly ritual.', 'completely worth every penny.', 'walked out glowing.', 'my stress just melted away.', 'highly recommend for self-care days.'],
  },
  // ── GYM / FITNESS ────────────────────────────────────────────────────────────
  gym: {
    actions:     ['had an incredible workout', 'tried their training session', 'used the equipment', 'had a personal training session', 'attended the group class', 'worked out for two hours'],
    compliments: ['the equipment is top-notch', 'super clean and well-maintained', 'motivating environment', 'the trainers are really knowledgeable', 'great energy in the gym', 'not too crowded', 'really well-organized floor plan'],
    openers:     ['just finished a session at', 'been training at', 'joined', 'visited', 'finally tried', 'had my first class at'],
    closers:     ['my new home gym.', 'the gains are real.', 'best decision I made for my fitness.', 'already signed up for the month.', 'the trainers push you to your best.', '100% recommended for anyone serious about fitness.'],
  },
  // ── DEFAULT FALLBACK ──────────────────────────────────────────────────────────
  store: {
    actions:     ['had a great experience', 'found exactly what I needed', 'was served really well', 'got great value', 'had a smooth visit', 'discovered this gem'],
    compliments: ['the service was excellent', 'very friendly and helpful team', 'super clean and well-organized', 'fair prices', 'great quality', 'professional and efficient', 'highly attentive staff'],
    openers:     ['just visited', 'dropped by', 'spent time at', 'checked out', 'tried', 'went to'],
    closers:     ['will definitely be back.', 'highly recommended.', 'a great find in the area.', 'exceeded my expectations.', 'one of the best around.', 'worth every visit.'],
  }
};

function getVocab(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('mandi'))          return REVIEW_VOCAB['mandi restaurant'];
  if (t.includes('restaurant') || t.includes('food') || t.includes('biryani') || t.includes('kebab')) return REVIEW_VOCAB.restaurant;
  if (t.includes('barbershop') || t.includes('barber')) return REVIEW_VOCAB.barbershop;
  if (t.includes('saloon'))         return REVIEW_VOCAB.saloon;
  if (t.includes('salon') || t.includes('hair') || t.includes('beauty')) return REVIEW_VOCAB.salon;
  if (t.includes('spa') || t.includes('wellness') || t.includes('massage')) return REVIEW_VOCAB.spa;
  if (t.includes('clothing') || t.includes('fashion') || t.includes('wear') || t.includes('boutique')) return REVIEW_VOCAB['clothing store'];
  if (t.includes('cafe') || t.includes('coffee') || t.includes('bakery')) return REVIEW_VOCAB.cafe;
  if (t.includes('gym') || t.includes('fitness')) return REVIEW_VOCAB.gym;
  return REVIEW_VOCAB.store;
}

function pick(arr, seed) { return arr[seed % arr.length]; }

async function generate5kBankForSlug(slug, targetCount = 5000) {
  const cleanSlug = sanitizeSlug(slug);
  const config    = getBizConfig(cleanSlug);
  const name      = config.name || cleanSlug;
  const type      = (config.type || 'store').toLowerCase();
  const vocab     = getVocab(type);

  // Supplement with custom menuItems / highlights if configured
  const customItems = config.menuItems ? config.menuItems.split(',').map(s => s.trim()).filter(Boolean) : [];
  const customHighs = config.highlights ? config.highlights.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (!tursoClient) throw new Error('Turso Cloud Client is not initialized');

  await tursoClient.execute({ sql: 'DELETE FROM review_bank WHERE slug = ?', args: [cleanSlug] });
  await tursoClient.execute({ sql: 'INSERT INTO review_bank_pointers (slug, current_pointer) VALUES (?, 0) ON CONFLICT(slug) DO UPDATE SET current_pointer = 0', args: [cleanSlug] });

  console.log(`⚡ Generating ${targetCount} reviews for '${cleanSlug}' (${type}) into Turso Cloud DB…`);

  const batchSize = 250;
  let inserted = 0;

  for (let batchStart = 0; batchStart < targetCount; batchStart += batchSize) {
    const currentBatch = Math.min(batchSize, targetCount - batchStart);
    const statements   = [];

    for (let i = 0; i < currentBatch; i++) {
      const order = batchStart + i + 1;
      const id    = `${cleanSlug}_${order}_${Date.now()}`;
      const seed  = order + i;

      // Pick vocabulary (prefer custom items if available)
      const action     = customItems.length ? pick(customItems, seed)       : pick(vocab.actions,     seed);
      const compliment = customHighs.length ? pick(customHighs, seed + 1)  : pick(vocab.compliments, seed + 1);
      const opener     = pick(vocab.openers,  seed + 2);
      const closer     = pick(vocab.closers,  seed + 3);

      // 20 unique sentence patterns — all contextually accurate
      const pat = order % 20;
      let rev = '';

      if (pat === 0)  rev = `${opener} ${name} and ${action}. ${compliment}. ${closer}`;
      else if (pat === 1)  rev = `just left ${name} and had to leave a review. ${action} and ${compliment}. ${closer}`;
      else if (pat === 2)  rev = `stopped by ${name} today — ${action}. ${compliment}. top tier experience!`;
      else if (pat === 3)  rev = `best ${type} in town, hands down. ${action} at ${name} and ${compliment}. ${closer}`;
      else if (pat === 4)  rev = `walked into ${name} and ${action} right away. ${compliment}. ${closer}`;
      else if (pat === 5)  rev = `so glad a friend recommended ${name}! ${action} and ${compliment}. ${closer}`;
      else if (pat === 6)  rev = `visited ${name} today. ${compliment} and I ${action}. highly recommend!`;
      else if (pat === 7)  rev = `if you're looking for a great ${type}, go to ${name}. ${action} — ${compliment}. ${closer}`;
      else if (pat === 8)  rev = `first time visiting ${name} and I'm blown away. ${action} and ${compliment}. ${closer}`;
      else if (pat === 9)  rev = `can't say enough good things about ${name}! ${action} today and ${compliment}. 100% worth it.`;
      else if (pat === 10) rev = `had an amazing experience at ${name}. the team was warm, I ${action}, and ${compliment}. ${closer}`;
      else if (pat === 11) rev = `really great vibe at ${name}. ${action} and ${compliment}. ${closer}`;
      else if (pat === 12) rev = `loved my time at ${name}! ${action} and ${compliment}. ${closer}`;
      else if (pat === 13) rev = `dropped in at ${name} today. ${action} — ${compliment}. ${closer}`;
      else if (pat === 14) rev = `always a pleasure visiting ${name}. consistently ${action} and ${compliment}. my go-to spot.`;
      else if (pat === 15) rev = `fair prices, awesome staff, and ${action} at ${name}. ${compliment}. ${closer}`;
      else if (pat === 16) rev = `visited ${name} this afternoon. ${action} and left feeling super satisfied. ${compliment}. ${closer}`;
      else if (pat === 17) rev = `outstanding service at ${name}! ${action} — ${compliment}. ${closer}`;
      else if (pat === 18) rev = `recommend ${name} to everyone looking for a great ${type}. ${action} and ${compliment}. ${closer}`;
      else                 rev = `really happy with my visit to ${name} today. ${action} and ${compliment}. ${closer}`;

      // Capitalize first letter
      rev = rev.charAt(0).toUpperCase() + rev.slice(1);

      statements.push({
        sql: 'INSERT INTO review_bank (id, slug, review, review_order) VALUES (?, ?, ?, ?)',
        args: [id, cleanSlug, rev, order]
      });
    }

    await tursoClient.batch(statements, 'write');
    inserted += currentBatch;
  }

  console.log(`✅ Generated & stored ${inserted} contextual reviews for '${cleanSlug}' (${type}) in Turso Cloud DB!`);
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
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSec / 3600);
  const mins  = Math.floor((uptimeSec % 3600) / 60);
  const secs  = uptimeSec % 60;

  // FIFO queue depths per slug
  const queueDepths = {};
  for (const [slug, q] of Object.entries(fifoQueues || {})) {
    queueDepths[slug] = q.length;
  }

  // Business bank sizes from in-memory configs
  const bizSlugs = Object.keys(bizConfigs || {});

  res.json({
    status: 'ok',
    tursoConnected: !!tursoClient,
    uptime: uptimeSec,
    uptimeFormatted: `${hours}h ${mins}m ${secs}s`,
    ts: new Date().toISOString(),
    memory: {
      rssMB:       +(mem.rss / 1024 / 1024).toFixed(1),
      heapUsedMB:  +(mem.heapUsed / 1024 / 1024).toFixed(1),
      heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      externalMB:  +(mem.external / 1024 / 1024).toFixed(1),
    },
    fifoQueueDepths: queueDepths,
    registeredBusinesses: bizSlugs.length,
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'production',
    platform: process.platform,
  });
});

// ── GET config for a slug ──────────────────────────────────────────────────────
app.get('/api/config/:slug', (req, res) => {
  const cleanSlug = sanitizeSlug(req.params.slug) || 'saloon';
  const config    = getBizConfig(cleanSlug);
  res.json(config);
});

// ── IN-MEMORY FIFO QUEUE WITH INSTANT TURSO DB PRE-FETCH ENGINE ──────────────
const fifoQueues = {};

async function ensureFifoQueuePrefilled(slug) {
  const cleanSlug = sanitizeSlug(slug);
  if (!fifoQueues[cleanSlug]) fifoQueues[cleanSlug] = [];

  const targetSize = 10;
  while (fifoQueues[cleanSlug].length < targetSize) {
    const bankResult = await popFrom5kReviewBank(cleanSlug);
    if (!bankResult || !bankResult.review) break;
    fifoQueues[cleanSlug].push(bankResult);
  }
}

async function handleReviewRequest(req, res) {
  const cleanSlug  = sanitizeSlug(req.params.slug) || 'saloon';
  const config     = getBizConfig(cleanSlug);
  const clientMeta = getClientMetadata(req);

  if (!fifoQueues[cleanSlug]) fifoQueues[cleanSlug] = [];

  // If buffer is empty, prefetch synchronously once
  if (fifoQueues[cleanSlug].length === 0) {
    await ensureFifoQueuePrefilled(cleanSlug);
  }

  let reviewText   = '';
  let reviewSource = '5K Review Bank (Turso Cloud RAM FIFO)';

  if (fifoQueues[cleanSlug].length > 0) {
    const popped = fifoQueues[cleanSlug].shift();
    reviewText   = popped.review;
    reviewSource = `5K Review Bank (Turso Cloud #${popped.order}/${popped.totalInBank})`;
  } else {
    const name = config.name || cleanSlug;
    reviewText = `honestly so happy with my visit to ${name}! staff were super friendly, clean place, and service was top quality. definitely coming back.`;
    reviewSource = 'Seed Review Fallback';
  }

  // 🚀 INSTANT RE-FILL: As soon as 1 review is used, instantly pre-fetch next from DB in background!
  setImmediate(() => {
    ensureFifoQueuePrefilled(cleanSlug).catch(() => {});
  });

  recordScanEvent(cleanSlug, clientMeta, reviewSource);

  res.json({
    slug: cleanSlug,
    businessName: config.name,
    review: reviewText,
    generated: true,
    reviewSource,
    bufferRemaining: fifoQueues[cleanSlug].length,
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

  // 🚀 CLEAR RAM FIFO QUEUE IMMEDIATELY ON NAME EDIT SO OLD NAME REVIEWS ARE DISCARDED
  fifoQueues[cleanSlug] = [];

  // Auto generate 5K review bank with NEW name
  setImmediate(async () => {
    try {
      await generate5kBankForSlug(cleanSlug, 5000);
      ensureFifoQueuePrefilled(cleanSlug).catch(() => {});
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

    // 🚀 PRE-FILL RAM FIFO QUEUES FOR ALL BUSINESSES AT STARTUP (< 1ms USER LATENCY)
    for (const slug of Object.keys(dbStore)) {
      ensureFifoQueuePrefilled(slug).catch(() => {});
    }
  } catch (err) {
    console.error('[Bank Startup Check Error]:', err.message);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  scan-qr backend v18.2 (RAM FIFO Queue + Instant Turso DB Prefetch Engine) running on port ${PORT}`);
});
