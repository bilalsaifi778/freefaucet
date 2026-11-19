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
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Allow Offerwall iFrame embedding
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

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'bilalsaifi778@gmail.com').toLowerCase();

function isAdminUser(user) {
  return Boolean(user && (user.is_admin || user.email.toLowerCase() === ADMIN_EMAIL));
}

// Health Check (UptimeRobot)
app.get('/health', (req, res) => res.status(200).send('OK - TimeWall Engine Active'));

// Main Dashboard
app.get('/', async (req, res) => {
  if (!req.session.userId) {
    return res.render('dashboard', {
      user: null,
      isAdmin: false,
      stats: { totalUsers: 0, activePtc: 0, activeTasks: 0, pendingAds: 0, pendingProofs: 0 },
      ptcAds: [],
      microTasks: [],
      submissions: [],
      pendingProofs: [],
      pendingAds: [],
      allPtcAds: []
    });
  }

  const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  const user = userRes.rows[0];
  if (!user) {
    req.session.destroy();
    return res.redirect('/');
  }

  const isAdmin = isAdminUser(user);

  // Active & approved PTC ads not viewed by user in last 24h
  const ptcRes = await pool.query(`
    SELECT * FROM ptc_ads
    WHERE status = 'approved'
      AND remaining_views > 0
      AND id NOT IN (
        SELECT ad_id FROM ptc_views
        WHERE user_id = $1 AND viewed_at > NOW() - INTERVAL '24 HOURS'
      )
    ORDER BY reward_points DESC
  `, [user.id]);

  // Active & approved Micro-Tasks not yet submitted by user
  const tasksRes = await pool.query(`
    SELECT * FROM micro_tasks
    WHERE status = 'approved'
      AND remaining_slots > 0
      AND id NOT IN (SELECT task_id FROM task_submissions WHERE user_id = $1)
    ORDER BY reward_points DESC
  `, [user.id]);

  // Current user's task proof submissions
  const subRes = await pool.query(`
    SELECT ts.*, mt.title, mt.reward_points
    FROM task_submissions ts
    JOIN micro_tasks mt ON ts.task_id = mt.id
    WHERE ts.user_id = $1
    ORDER BY ts.submitted_at DESC LIMIT 25
  `, [user.id]);

  // Pending task proofs (for Admin review)
  const pendingProofsRes = await pool.query(`
    SELECT ts.*, mt.title, mt.reward_points, mt.proof_required, u.email
    FROM task_submissions ts
    JOIN micro_tasks mt ON ts.task_id = mt.id
    JOIN users u ON ts.user_id = u.id
    WHERE ts.status = 'pending'
    ORDER BY ts.submitted_at ASC
  `);

  // Pending advertiser PTC campaigns (for Admin approval/rejection)
  const pendingAdsRes = await pool.query(`
    SELECT pa.*, u.email AS advertiser_email
    FROM ptc_ads pa
    LEFT JOIN users u ON pa.advertiser_id = u.id
    WHERE pa.status = 'pending'
    ORDER BY pa.created_at ASC
  `);

  const allPtcRes = await pool.query(`
    SELECT * FROM ptc_ads ORDER BY created_at DESC LIMIT 20
  `);

  const usersCountRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM users');

  res.render('dashboard', {
    user,
    isAdmin,
    stats: {
      totalUsers: usersCountRes.rows[0].cnt,
      activePtc: ptcRes.rows.length,
      activeTasks: tasksRes.rows.length,
      pendingAds: pendingAdsRes.rows.length,
      pendingProofs: pendingProofsRes.rows.length
    },
    ptcAds: ptcRes.rows,
    microTasks: tasksRes.rows,
    submissions: subRes.rows,
    pendingProofs: pendingProofsRes.rows,
    pendingAds: pendingAdsRes.rows,
    allPtcAds: allPtcRes.rows
  });
});

// Login / Register
app.post('/auth', async (req, res) => {
  const { email, password, faucetpay_address } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const cleanEmail = (email || '').trim().toLowerCase();

  try {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).send('Invalid password. <a href="/">Go back</a>');
      await pool.query('UPDATE users SET last_ip = $1 WHERE id = $2', [ip, user.id]);
      req.session.userId = user.id;
      return res.redirect('/');
    } else {
      const hash = await bcrypt.hash(password, 10);
      const shouldBeAdmin = cleanEmail === ADMIN_EMAIL;
      const newUser = await pool.query(
        'INSERT INTO users (email, password_hash, faucetpay_address, is_admin, last_ip) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [cleanEmail, hash, (faucetpay_address || '').trim(), shouldBeAdmin, ip]
      );
      req.session.userId = newUser.rows[0].id;
      return res.redirect('/');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication Error');
  }
});

// Update Profile / FaucetPay Address
app.post('/api/profile/update', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { faucetpay_address } = req.body;
  await pool.query('UPDATE users SET faucetpay_address = $1 WHERE id = $2', [(faucetpay_address || '').trim(), req.session.userId]);
  res.redirect('/?tab=profile');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// PTC Start & Claim
app.post('/api/ptc/start', (req, res) => {
  const { adId } = req.body;
  req.session.ptcStart = { adId: parseInt(adId, 10), startTime: Date.now() };
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
    const adRes = await client.query(
      "SELECT * FROM ptc_ads WHERE id = $1 AND status = 'approved' FOR UPDATE",
      [adId]
    );
    const ad = adRes.rows[0];

    if (!ad || ad.remaining_views <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ad expired or unavailable' });
    }

    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (elapsedSeconds < ad.timer_seconds - 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Timer not completed yet!' });
    }

    const dup = await client.query(
      "SELECT id FROM ptc_views WHERE user_id = $1 AND ad_id = $2 AND viewed_at > NOW() - INTERVAL '24 HOURS'",
      [req.session.userId, ad.id]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already claimed in last 24h' });
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

// Micro-Task Proof Submission
app.post('/api/tasks/submit', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { task_id, proof_text, screenshot_url } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskRes = await client.query(
      "SELECT * FROM micro_tasks WHERE id = $1 AND status = 'approved' AND remaining_slots > 0 FOR UPDATE",
      [task_id]
    );
    if (taskRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).send('Task unavailable. <a href="/">Go back</a>');
    }

    await client.query(
      'INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_url) VALUES ($1, $2, $3, $4)',
      [task_id, req.session.userId, proof_text, (screenshot_url || '').trim()]
    );
    await client.query('UPDATE micro_tasks SET remaining_slots = remaining_slots - 1 WHERE id = $1', [task_id]);
    await client.query('COMMIT');
    res.redirect('/?tab=tasks');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Submission failed');
  } finally {
    client.release();
  }
});

// Advertiser Submits PTC Campaign (Goes to 'pending' for Admin Approval)
app.post('/api/advertiser/create-ptc', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { title, description, url, timer_seconds, reward_points, total_views } = req.body;
  const secs = Math.max(5, parseInt(timer_seconds, 10) || 15);
  const pts = Math.max(1, parseInt(reward_points, 10) || 10);
  const views = Math.max(1, parseInt(total_views, 10) || 10);
  const totalCost = pts * views;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT advertiser_balance FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    if (!userRes.rows[0] || userRes.rows[0].advertiser_balance < totalCost) {
      await client.query('ROLLBACK');
      return res.status(400).send('Insufficient Advertiser Credits. <a href="/">Go back</a>');
    }

    await client.query('UPDATE users SET advertiser_balance = advertiser_balance - $1 WHERE id = $2', [totalCost, req.session.userId]);
    await client.query(
      `INSERT INTO ptc_ads (advertiser_id, title, description, url, timer_seconds, reward_points, remaining_views, total_cost, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [req.session.userId, title, description || '', url, secs, pts, views, totalCost]
    );

    await client.query('COMMIT');
    res.redirect('/?tab=advertise');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Campaign error');
  } finally {
    client.release();
  }
});

// ADMIN: Create New Micro-Task Directly
app.post('/api/admin/tasks/create', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin access required');

  const { title, instructions, proof_required, reward_points, total_slots } = req.body;
  const pts = Math.max(1, parseInt(reward_points, 10) || 100);
  const slots = Math.max(1, parseInt(total_slots, 10) || 50);

  await pool.query(
    `INSERT INTO micro_tasks (advertiser_id, title, instructions, proof_required, reward_points, remaining_slots, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'approved')`,
    [req.session.userId, title, instructions, proof_required, pts, slots]
  );
  res.redirect('/?tab=admin');
});

// ADMIN: Create New PTC Ad Directly (Auto-Approved)
app.post('/api/admin/ptc/create', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin access required');

  const { title, description, url, timer_seconds, reward_points, total_views } = req.body;
  const secs = Math.max(5, parseInt(timer_seconds, 10) || 15);
  const pts = Math.max(1, parseInt(reward_points, 10) || 10);
  const views = Math.max(1, parseInt(total_views, 10) || 100);

  await pool.query(
    `INSERT INTO ptc_ads (advertiser_id, title, description, url, timer_seconds, reward_points, remaining_views, total_cost, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'approved')`,
    [req.session.userId, title, description || '', url, secs, pts, views]
  );
  res.redirect('/?tab=admin');
});

// ADMIN: Approve or Reject User Task Proof
app.post('/api/admin/proofs/review', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin access required');

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
      return res.redirect('/?tab=admin');
    }
    const sub = subRes.rows[0];

    if (action === 'approve') {
      await client.query("UPDATE task_submissions SET status = 'approved' WHERE id = $1", [submission_id]);
      await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2', [sub.reward_points, sub.user_id]);
    } else {
      await client.query("UPDATE task_submissions SET status = 'rejected' WHERE id = $1", [submission_id]);
      // Restore slot on rejected proof
      await client.query('UPDATE micro_tasks SET remaining_slots = remaining_slots + 1 WHERE id = $1', [sub.task_id]);
    }

    await client.query('COMMIT');
    res.redirect('/?tab=admin');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Proof review error');
  } finally {
    client.release();
  }
});

// ADMIN: Approve or Reject Advertiser PTC Campaign (Refunds credits on reject)
app.post('/api/admin/ads/review', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin access required');

  const { ad_id, action } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const adRes = await client.query(
      "SELECT * FROM ptc_ads WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [ad_id]
    );

    if (adRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=admin');
    }
    const ad = adRes.rows[0];

    if (action === 'approve') {
      await client.query("UPDATE ptc_ads SET status = 'approved' WHERE id = $1", [ad_id]);
    } else {
      await client.query("UPDATE ptc_ads SET status = 'rejected' WHERE id = $1", [ad_id]);
      const refund = ad.total_cost || (ad.reward_points * ad.remaining_views);
      if (ad.advertiser_id && refund > 0) {
        await client.query(
          'UPDATE users SET advertiser_balance = advertiser_balance + $1 WHERE id = $2',
          [refund, ad.advertiser_id]
        );
      }
    }

    await client.query('COMMIT');
    res.redirect('/?tab=admin');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Ad review error');
  } finally {
    client.release();
  }
});

// S2S Postback (1,000 Points = $1.00; 70% share to user => 700 pts per $1.00 advertiser payout)
app.get('/api/postback/:network', async (req, res) => {
  const { network } = req.params;
  const { userid, txid, payout, status, secret } = req.query;

  if (secret !== process.env.POSTBACK_SECRET) return res.status(403).send('Invalid Secret');

  const userPoints = Math.floor(parseFloat(payout) * 1000 * 0.70);
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

// Instant FaucetPay Withdrawal (1,000 Points = $1.00 USDT; Minimum 100 Points = $0.10 USDT)
app.post('/api/withdraw', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  const { pointsToWithdraw, faucetpayAddress } = req.body;
  const points = parseInt(pointsToWithdraw, 10);

  if (!points || points < 100) return res.status(400).json({ error: 'Minimum withdrawal is 100 Points ($0.10)' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT points_balance FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    const user = userRes.rows[0];

    if (!user || user.points_balance < points) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await client.query(
      'UPDATE users SET points_balance = points_balance - $1, faucetpay_address = $2 WHERE id = $3',
      [points, (faucetpayAddress || '').trim(), req.session.userId]
    );

    if (process.env.FAUCETPAY_API_KEY) {
      // 1,000 points = $1.00 USDT => 1 point = $0.001 USDT = 100,000 satoshi units on FaucetPay
      const usdtSatoshi = Math.floor((points / 1000) * 100000000);
      const fpRes = await axios.post('https://faucetpay.io/api/v1/send', new URLSearchParams({
        api_key: process.env.FAUCETPAY_API_KEY,
        amount: usdtSatoshi,
        to: (faucetpayAddress || '').trim(),
        currency: 'USDT'
      }));
      if (fpRes.data.status !== 200) throw new Error(fpRes.data.message || 'FaucetPay API Error');
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Sent ${points} pts ($${(points / 1000).toFixed(2)} USDT) to FaucetPay!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TimeWall Platform running on port ${PORT}`));
