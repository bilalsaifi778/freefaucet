require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Required on Render behind Cloudflare proxy

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Allow your site to be embedded as an Offerwall iFrame on partner sites
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'timewall-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. HEALTH CHECK (For UptimeRobot 24/7 Keep-Alive)
app.get('/health', (req, res) => res.status(200).send('OK - TimeWall Engine Active'));

// 2. MAIN DASHBOARD & AUTH
app.get('/', async (req, res) => {
  if (!req.session.userId) {
    return res.render('dashboard', { user: null, ptcAds: [], microTasks: [], submissions: [], pendingAdmin: [] });
  }

  const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  const user = userRes.rows[0];

  // Fetch PTC ads not clicked by this user in the last 24 hours
  const ptcRes = await pool.query(`
    SELECT * FROM ptc_ads 
    WHERE remaining_views > 0 
    AND id NOT IN (
      SELECT ad_id FROM ptc_views 
      WHERE user_id = $1 AND viewed_at > NOW() - INTERVAL '24 HOURS'
    )
    ORDER BY reward_points DESC
  `, [user.id]);

  // Fetch available Micro-Tasks
  const tasksRes = await pool.query(`
    SELECT * FROM micro_tasks 
    WHERE remaining_slots > 0 
    AND id NOT IN (SELECT task_id FROM task_submissions WHERE user_id = $1)
    ORDER BY reward_points DESC
  `, [user.id]);

  // Fetch user's submitted task history
  const subRes = await pool.query(`
    SELECT ts.*, mt.title, mt.reward_points 
    FROM task_submissions ts
    JOIN micro_tasks mt ON ts.task_id = mt.id
    WHERE ts.user_id = $1
    ORDER BY ts.submitted_at DESC LIMIT 20
  `, [user.id]);

  // Fetch pending task proofs for Admin/Advertiser review
  const adminRes = await pool.query(`
    SELECT ts.*, mt.title, mt.reward_points, u.email 
    FROM task_submissions ts
    JOIN micro_tasks mt ON ts.task_id = mt.id
    JOIN users u ON ts.user_id = u.id
    WHERE ts.status = 'pending'
    ORDER BY ts.submitted_at ASC
  `);

  res.render('dashboard', {
    user,
    ptcAds: ptcRes.rows,
    microTasks: tasksRes.rows,
    submissions: subRes.rows,
    pendingAdmin: adminRes.rows
  });
});

// Register / Login Combined Endpoint
app.post('/auth', async (req, res) => {
  const { email, password, faucetpay_address } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;

  try {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).send('Invalid password. <a href="/">Go back</a>');
      req.session.userId = user.id;
      return res.redirect('/');
    } else {
      const hash = await bcrypt.hash(password, 10);
      const newUser = await pool.query(
        'INSERT INTO users (email, password_hash, faucetpay_address, last_ip) VALUES ($1, $2, $3, $4) RETURNING id',
        [email.toLowerCase(), hash, faucetpay_address || '', ip]
      );
      req.session.userId = newUser.rows[0].id;
      return res.redirect('/');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication Error');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// 3. PTC TIMER VERIFICATION & CLAIM
app.post('/api/ptc/start', (req, res) => {
  const { adId } = req.body;
  req.session.ptcStart = { adId: parseInt(adId), startTime: Date.now() };
  res.json({ started: true });
});

app.post('/api/ptc/claim', async (req, res) => {
  if (!req.session.userId || !req.session.ptcStart) {
    return res.status(400).json({ error: 'Invalid session or timer not started' });
  }

  const { adId } = req.body;
  const { startTime } = req.session.ptcStart;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const adRes = await client.query('SELECT * FROM ptc_ads WHERE id = $1 FOR UPDATE', [adId]);
    const ad = adRes.rows[0];

    if (!ad || ad.remaining_views <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ad expired' });
    }

    // Server-side timer validation (prevents bypassing JS countdown)
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (elapsedSeconds < ad.timer_seconds - 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Timer not completed yet!' });
    }

    // Check if already claimed in last 24h
    const dup = await client.query(
      "SELECT id FROM ptc_views WHERE user_id = $1 AND ad_id = $2 AND viewed_at > NOW() - INTERVAL '24 HOURS'",
      [req.session.userId, ad.id]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already claimed today' });
    }

    await client.query('INSERT INTO ptc_views (user_id, ad_id) VALUES ($1, $2)', [req.session.userId, ad.id]);
    await client.query('UPDATE ptc_ads SET remaining_views = remaining_views - 1 WHERE id = $1', [ad.id]);
    await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2', [ad.reward_points, req.session.userId]);

    await client.query('COMMIT');
    delete req.session.ptcStart;
    res.json({ success: true, reward: ad.reward_points });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// 4. MICRO-TASK PROOF SUBMISSION & APPROVAL
app.post('/api/tasks/submit', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { task_id, proof_text, screenshot_url } = req.body;

  try {
    await pool.query(
      'INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_url) VALUES ($1, $2, $3, $4)',
      [task_id, req.session.userId, proof_text, screenshot_url || '']
    );
    await pool.query('UPDATE micro_tasks SET remaining_slots = remaining_slots - 1 WHERE id = $1', [task_id]);
    res.redirect('/?msg=Task+Proof+Submitted');
  } catch (err) {
    res.status(500).send('Submission failed');
  }
});

// Advertiser / Admin Approve or Reject Task Proof
app.post('/api/tasks/review', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { submission_id, action } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const subRes = await client.query(`
      SELECT ts.*, mt.reward_points 
      FROM task_submissions ts
      JOIN micro_tasks mt ON ts.task_id = mt.id
      WHERE ts.id = $1 AND ts.status = 'pending' FOR UPDATE
    `, [submission_id]);

    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/');
    }
    const sub = subRes.rows[0];

    if (action === 'approve') {
      await client.query("UPDATE task_submissions SET status = 'approved' WHERE id = $1", [submission_id]);
      await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2', [sub.reward_points, sub.user_id]);
    } else {
      await client.query("UPDATE task_submissions SET status = 'rejected' WHERE id = $1", [submission_id]);
    }

    await client.query('COMMIT');
    res.redirect('/');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Review error');
  } finally {
    client.release();
  }
});

// 5. ADVERTISER SELF-SERVE CAMPAIGN CREATOR
app.post('/api/advertiser/create-ptc', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { title, url, timer_seconds, reward_points, total_views } = req.body;
  const totalCost = parseInt(reward_points) * parseInt(total_views);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT advertiser_balance FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    if (userRes.rows[0].advertiser_balance < totalCost) {
      await client.query('ROLLBACK');
      return res.status(400).send('Insufficient Advertiser Balance. <a href="/">Go back</a>');
    }

    await client.query('UPDATE users SET advertiser_balance = advertiser_balance - $1 WHERE id = $2', [totalCost, req.session.userId]);
    await client.query(
      'INSERT INTO ptc_ads (advertiser_id, title, url, timer_seconds, reward_points, remaining_views) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.session.userId, title, url, timer_seconds, reward_points, total_views]
    );

    await client.query('COMMIT');
    res.redirect('/');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Campaign error');
  } finally {
    client.release();
  }
});

// 6. UNIVERSAL S2S OFFERWALL POSTBACK (BitLabs, Monlix, CPAlead)
// Postback URL format: https://yourdomain.com/api/postback/monlix?userid={userid}&txid={txid}&payout={payout}&status={status}&secret=YOUR_SECRET
app.get('/api/postback/:network', async (req, res) => {
  const { network } = req.params;
  const { userid, txid, payout, status, secret } = req.query;

  if (secret !== process.env.POSTBACK_SECRET) return res.status(403).send('Invalid Secret');

  const userPoints = Math.floor(parseFloat(payout) * 10000 * 0.70); // $1.00 = 7,000 pts to user
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    if (status === '2' || status === 'chargeback' || userPoints < 0) {
      await client.query('UPDATE users SET points_balance = points_balance - $1 WHERE id = $2', [Math.abs(userPoints), userid]);
      await client.query('COMMIT');
      return res.status(200).send('OK_CHARGEBACK');
    }

    const dup = await client.query('SELECT id FROM postback_logs WHERE tx_id = $1', [txid]);
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(200).send('DUP');
    }

    await client.query('INSERT INTO postback_logs (network, tx_id, user_id, points_awarded) VALUES ($1, $2, $3, $4)', [network, txid, userid, userPoints]);
    await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2', [userPoints, userid]);
    await client.query('COMMIT');
    res.status(200).send('OK');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('ERROR');
  } finally {
    client.release();
  }
});

// 7. INSTANT FAUCETPAY WITHDRAWAL
app.post('/api/withdraw', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const { pointsToWithdraw, faucetpayAddress } = req.body;
  const points = parseInt(pointsToWithdraw);

  if (points < 1000) return res.status(400).json({ error: 'Minimum withdrawal is 1,000 Points ($0.10)' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT points_balance FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    const user = userRes.rows[0];

    if (!user || user.points_balance < points) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await client.query('UPDATE users SET points_balance = points_balance - $1, faucetpay_address = $2 WHERE id = $3', [points, faucetpayAddress, req.session.userId]);

    if (process.env.FAUCETPAY_API_KEY) {
      // 10,000 points = $1.00 USDT (100,000,000 satoshi units on FaucetPay)
      const usdtSatoshi = Math.floor((points / 10000) * 100000000);
      const fpRes = await axios.post('https://faucetpay.io/api/v1/send', new URLSearchParams({
        api_key: process.env.FAUCETPAY_API_KEY,
        amount: usdtSatoshi,
        to: faucetpayAddress,
        currency: 'USDT'
      }));
      if (fpRes.data.status !== 200) throw new Error(fpRes.data.message || 'FaucetPay API Error');
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Successfully withdrawn ${points} points to FaucetPay!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TimeWall Platform running on port ${PORT}`));