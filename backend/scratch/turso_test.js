const { createClient } = require('@libsql/client');

const TURSO_URL   = process.env.TURSO_DATABASE_URL || 'libsql://scan-qr-db-rithesh.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN   || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODQ2MjAwMzQsImlkIjoiMDE5ZjgzYTQtNzkwMS03NjQ1LWFiYjgtN2EwOTcxZDEzZTc3Iiwia2lkIjoiWHRwRkYtcmF3Q09ITnJxSnB0VG5hVk4tNlEtaGtIT3l2TVBJUUpjdWJhayIsInJpZCI6IjQ1NmRjMjY4LTQ0ODUtNDBhOC1hZDNiLWQ4ZTk1NTg2YjgyZCJ9.KD3XGQDPR3etqSCIrkgCb7q6LiZfDekFE-m67PyCKXaHsj4_iqpO3haoLjBjg0ZzR7UKX0whSGhLg-3RZlAaCQ';

const client = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN
});

async function main() {
  console.log('Connecting to Turso Cloud Database at:', TURSO_URL);
  
  await client.execute(`
    CREATE TABLE IF NOT EXISTS businesses (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      googleReviewLink TEXT,
      siteUrl TEXT,
      language TEXT,
      geminiApiKey TEXT,
      data TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Turso Table `businesses` created/verified');

  const defaultBusinesses = [
    {
      slug: 'saloon',
      name: 'Royal Saloon & Spa',
      type: 'saloon',
      googleReviewLink: 'https://search.google.com/local/writereview?placeid=YOUR_SALOON_PLACE_ID',
      siteUrl: 'https://scanqr-beta.vercel.app?biz=saloon',
      language: 'English'
    },
    {
      slug: 'youngwear_fashions',
      name: 'Youngwear Fashions',
      type: 'clothing store',
      googleReviewLink: 'https://search.google.com/local/writereview?placeid=YOUR_YOUNGWEAR_PLACE_ID',
      siteUrl: 'https://scanqr-beta.vercel.app?biz=youngwear_fashions',
      language: 'English'
    },
    {
      slug: 'demo',
      name: 'Demo Beauty Salon',
      type: 'salon',
      googleReviewLink: 'https://search.google.com/local/writereview?placeid=YOUR_DEMO_PLACE_ID',
      siteUrl: 'https://scanqr-beta.vercel.app?biz=demo',
      language: 'English'
    }
  ];

  for (const b of defaultBusinesses) {
    await client.execute({
      sql: `INSERT INTO businesses (slug, name, type, googleReviewLink, siteUrl, language, geminiApiKey, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              name=excluded.name,
              type=excluded.type,
              googleReviewLink=excluded.googleReviewLink,
              siteUrl=excluded.siteUrl,
              language=excluded.language,
              data=excluded.data`,
      args: [b.slug, b.name, b.type, b.googleReviewLink, b.siteUrl, b.language, b.geminiApiKey || null, JSON.stringify(b)]
    });
  }

  const res = await client.execute('SELECT slug, name, type, language FROM businesses');
  console.log('✅ Migrated rows in Turso Cloud Database:');
  console.table(res.rows);
}

main().catch(err => {
  console.error('❌ Turso test error:', err);
  process.exit(1);
});
