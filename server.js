require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'freefaucet-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'bilalsaifi778@gmail.com').toLowerCase();

let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function generateUnique6DigitId(client) {
  for (let i = 0; i < 25; i++) {
    const candidate = String(crypto.randomInt(100000, 1000000));
    const check = await client.query('SELECT id FROM users WHERE public_id = $1', [candidate]);
    if (check.rows.length === 0) return candidate;
  }
  throw new Error('Unable to generate unique 6-digit user ID');
}

async function sendNotification(userId, email, title, message, allowEmail = true) {
  await pool.query(
    'INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)',
    [userId, title, message]
  );
  if (mailer && allowEmail && email) {
    const senderAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
    try {
      await mailer.sendMail({
        from: senderAddr,
        replyTo: process.env.SMTP_USER,
        to: email,
        subject: `Free Faucet: ${title}`,
        text: `Hello,\n\n${message}\n\nRate: 1,000 Points = $1.00.\n\n— Free Faucet Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px; color: #1e293b;">
            <h2 style="color: #1877f2; margin-top: 0;">Free Faucet</h2>
            <h3 style="margin-bottom: 8px;">${title}</h3>
            <p style="line-height: 1.5; font-size: 14px;">${message}</p>
            <p style="font-size: 12px; color: #475569;">Rate: <strong>1,000 Points = $1.00</strong>.</p>
          </div>
        `
      });
    } catch (e) {
      console.error('Email send error:', e.message);
    }
  }
}

async function awardPointsWithReferral(client, userId, points) {
  if (points <= 0) return;
  const uRes = await client.query(
    'UPDATE users SET points_balance = points_balance + $1 WHERE id = $2 RETURNING referred_by',
    [points, userId]
  );
  const refId = uRes.rows[0] && uRes.rows[0].referred_by;
  if (refId) {
    const refBonus = Math.max(1, Math.floor(points * 0.10));
    await client.query(
      'UPDATE users SET points_balance = points_balance + $1 WHERE id = $2',
      [refBonus, refId]
    );
  }
}

function isAdminUser(user) {
  return Boolean(user && (user.is_admin || user.email.toLowerCase() === ADMIN_EMAIL));
}

let cachedStats = { at: 0, totalUsers: 0, centralUsdt: '0.00' };
async function getCachedStats() {
  if (Date.now() - cachedStats.at < 20000) return cachedStats;
  const [uCnt, tSum] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS cnt FROM users'),
    pool.query('SELECT COALESCE(SUM(usdt_delta), 0)::numeric(14,2) AS total_usdt FROM treasury_ledger')
  ]);
  cachedStats = {
    at: Date.now(),
    totalUsers: uCnt.rows[0].cnt,
    centralUsdt: tSum.rows[0].total_usdt
  };
  return cachedStats;
}

app.get('/health', (req, res) => res.status(200).send('OK - Free Faucet v3 Active'));

app.get('/', async (req, res) => {
  const refParam = (req.query.ref || '').trim();
  const resetToken = (req.query.reset_token || '').trim();

  if (!req.session.userId) {
    return res.render('dashboard', {
      user: null,
      isAdmin: false,
      refCode: refParam,
      resetToken,
      flashMsg: req.query.msg || '',
      stats: { totalUsers: 0, activePtc: 0, activeTasks: 0, activeShortlinks: 0, pendingAds: 0, pendingProofs: 0, pendingWithdrawals: 0, openDisputes: 0, centralUsdt: '0.00' },
      ptcAds: [],
      microTasks: [],
      shortlinks: [],
      submissions: [],
      withdrawals: [],
      disputes: [],
      notifications: [],
      referrals: [],
      pendingProofs: [],
      pendingAds: [],
      pendingWithdrawals: [],
      openDisputesList: []
    });
  }

  const client = await pool.connect();
  let user;
  try {
    const userRes = await client.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    user = userRes.rows[0];
    if (!user) {
      req.session.destroy();
      return res.redirect('/');
    }
    if (!user.public_id) {
      await client.query('BEGIN');
      const newSixId = await generateUnique6DigitId(client);
      const upd = await client.query('UPDATE users SET public_id = $1 WHERE id = $2 RETURNING *', [newSixId, user.id]);
      await client.query('COMMIT');
      user = upd.rows[0];
    }
  } finally {
    client.release();
  }

  const isAdmin = isAdminUser(user);

  const [
    ptcRes,
    tasksRes,
    linksRes,
    subRes,
    wdRes,
    dispRes,
    notifRes,
    refRes,
    pendingProofsRes,
    pendingAdsRes,
    pendingWdRes,
    openDispRes,
    baseStats
  ] = await Promise.all([
    pool.query(`
      SELECT * FROM ptc_ads
      WHERE status = 'approved'
        AND remaining_views > 0
        AND id NOT IN (
          SELECT ad_id FROM ptc_views
          WHERE user_id = $1 AND viewed_at > NOW() - INTERVAL '24 HOURS'
        )
      ORDER BY reward_points DESC
    `, [user.id]),
    pool.query(`
      SELECT * FROM micro_tasks
      WHERE status = 'approved'
        AND remaining_slots > 0
        AND id NOT IN (SELECT task_id FROM task_submissions WHERE user_id = $1)
      ORDER BY reward_points DESC
    `, [user.id]),
    pool.query(`
      SELECT s.*,
        (SELECT COUNT(*)::int FROM shortlink_claims sc WHERE sc.shortlink_id = s.id AND sc.user_id = $1 AND sc.claimed_at > NOW() - INTERVAL '24 HOURS') AS claimed_today
      FROM shortlinks s
      ORDER BY s.reward_points DESC
    `, [user.id]),
    pool.query(`
      SELECT ts.*, mt.title, mt.reward_points
      FROM task_submissions ts
      JOIN micro_tasks mt ON ts.task_id = mt.id
      WHERE ts.user_id = $1
      ORDER BY ts.submitted_at DESC LIMIT 40
    `, [user.id]),
    pool.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40', [user.id]),
    pool.query('SELECT * FROM disputes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40', [user.id]),
    pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40', [user.id]),
    pool.query('SELECT id, public_id, email, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC', [user.id]),
    pool.query(`
      SELECT ts.*, mt.title, mt.reward_points, mt.proof_required, u.email, u.public_id
      FROM task_submissions ts
      JOIN micro_tasks mt ON ts.task_id = mt.id
      JOIN users u ON ts.user_id = u.id
      WHERE ts.status = 'pending'
      ORDER BY ts.submitted_at ASC
    `),
    pool.query(`
      SELECT pa.*, u.email AS advertiser_email, u.public_id AS advertiser_public_id
      FROM ptc_ads pa
      LEFT JOIN users u ON pa.advertiser_id = u.id
      WHERE pa.status = 'pending'
      ORDER BY pa.created_at ASC
    `),
    pool.query(`
      SELECT w.*, u.email, u.public_id
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
      WHERE w.status = 'pending'
      ORDER BY w.created_at ASC
    `),
    pool.query(`
      SELECT d.*, u.email, u.public_id
      FROM disputes d
      JOIN users u ON d.user_id = u.id
      WHERE d.status = 'open'
      ORDER BY d.created_at ASC
    `),
    getCachedStats()
  ]);

  res.render('dashboard', {
    user,
    isAdmin,
    refCode: '',
    resetToken: '',
    flashMsg: req.query.msg || '',
    stats: {
      totalUsers: baseStats.totalUsers,
      activePtc: ptcRes.rows.length,
      activeTasks: tasksRes.rows.length,
      activeShortlinks: linksRes.rows.length,
      pendingAds: pendingAdsRes.rows.length,
      pendingProofs: pendingProofsRes.rows.length,
      pendingWithdrawals: pendingWdRes.rows.length,
      openDisputes: openDispRes.rows.length,
      centralUsdt: baseStats.centralUsdt
    },
    ptcAds: ptcRes.rows,
    microTasks: tasksRes.rows,
    shortlinks: linksRes.rows,
    submissions: subRes.rows,
    withdrawals: wdRes.rows,
    disputes: dispRes.rows,
    notifications: notifRes.rows,
    referrals: refRes.rows,
    pendingProofs: pendingProofsRes.rows,
    pendingAds: pendingAdsRes.rows,
    pendingWithdrawals: pendingWdRes.rows,
    openDisputesList: openDispRes.rows
  });
});

// Signup (Generates Unique 6-Character Numeric ID)
app.post('/auth/signup', async (req, res) => {
  const { email, password, faucetpay_address, ref_code } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const cleanEmail = (email || '').trim().toLowerCase();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.redirect('/?msg=' + encodeURIComponent('Email already registered. Please login.'));
    }

    let referredById = null;
    if (ref_code && ref_code.trim()) {
      const refUser = await client.query('SELECT id FROM users WHERE referral_code = $1 OR public_id = $1', [ref_code.trim()]);
      if (refUser.rows.length > 0) referredById = refUser.rows[0].id;
    }

    const sixDigitId = await generateUnique6DigitId(client);
    const hash = await bcrypt.hash(password, 10);
    const shouldBeAdmin = cleanEmail === ADMIN_EMAIL;
    const refCodeVal = `FF${sixDigitId}`;

    const created = await client.query(
      `INSERT INTO users (public_id, email, password_hash, faucetpay_address, is_admin, referral_code, referred_by, last_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [sixDigitId, cleanEmail, hash, (faucetpay_address || '').trim(), shouldBeAdmin, refCodeVal, referredById, ip]
    );
    await client.query('COMMIT');
    cachedStats.at = 0;

    await sendNotification(
      created.rows[0].id,
      cleanEmail,
      'Welcome to Free Faucet',
      `Your account is active. User ID: ${sixDigitId} • Rate: 1,000 Points = $1.00.`,
      true
    );
    req.session.userId = created.rows[0].id;
    res.redirect('/');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Signup error');
  } finally {
    client.release();
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const cleanEmail = (email || '').trim().toLowerCase();

  try {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length === 0) {
      return res.redirect('/?msg=' + encodeURIComponent('Account not found. Please sign up first.'));
    }
    const user = existing.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.redirect('/?msg=' + encodeURIComponent('Invalid password.'));

    await pool.query('UPDATE users SET last_ip = $1 WHERE id = $2', [ip, user.id]);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Login error');
  }
});

// Forgot Password
app.post('/auth/forgot-password', async (req, res) => {
  const cleanEmail = (req.body.email || '').trim().toLowerCase();
  const uRes = await pool.query('SELECT id, email FROM users WHERE email = $1', [cleanEmail]);
  if (uRes.rows.length === 0) {
    return res.redirect('/?msg=' + encodeURIComponent('If that email exists, a reset token has been generated.'));
  }

  const u = uRes.rows[0];
  const token = crypto.randomBytes(20).toString('hex');
  await pool.query(
    "INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 HOUR')",
    [u.id, token]
  );

  await sendNotification(u.id, u.email, 'Password Reset Token', `Use this reset token within 1 hour: ${token}`, true);

  if (!mailer) {
    return res.redirect('/?reset_token=' + token + '&msg=' + encodeURIComponent('Reset token generated below (SMTP not configured).'));
  }
  res.redirect('/?msg=' + encodeURIComponent('Password reset email sent. Check your Inbox (and Spam folder if needed).'));
});

app.post('/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  const rRes = await pool.query(
    "SELECT * FROM password_resets WHERE token = $1 AND used = FALSE AND expires_at > NOW()",
    [(token || '').trim()]
  );
  if (rRes.rows.length === 0) {
    return res.redirect('/?msg=' + encodeURIComponent('Invalid or expired reset token.'));
  }
  const row = rRes.rows[0];
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id]);
  await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [row.id]);
  res.redirect('/?msg=' + encodeURIComponent('Password updated! Please log in with your new password.'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Profile Update
app.post('/api/profile/update', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { faucetpay_address, email_notifications } = req.body;
  const notifyBool = email_notifications === 'on' || email_notifications === 'true';
  await pool.query(
    'UPDATE users SET faucetpay_address = $1, email_notifications = $2 WHERE id = $3',
    [(faucetpay_address || '').trim(), notifyBool, req.session.userId]
  );
  res.redirect('/?tab=profile&msg=' + encodeURIComponent('Profile settings saved.'));
});

app.post('/api/notifications/read', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.session.userId]);
  res.redirect('/?tab=inbox');
});

// User Adds USDT Balance -> Single Central Admin Wallet & Credits Ad Credits (1,000 pts = $1.00)
app.post('/api/wallet/deposit-usdt', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const usdtAmt = Number(parseFloat(req.body.usdt_amount).toFixed(2));
  const txRef = (req.body.tx_ref || '').trim();

  if (!Number.isFinite(usdtAmt) || usdtAmt < 0.10 || usdtAmt > 100000) {
    return res.redirect('/?tab=advertise&msg=' + encodeURIComponent('Enter a valid USDT amount between $0.10 and $100,000.'));
  }

  const pointsAdded = Math.floor(usdtAmt * 1000);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const uRes = await client.query(
      'UPDATE users SET advertiser_balance = advertiser_balance + $1, usdt_balance = usdt_balance + $2 WHERE id = $3 RETURNING email, email_notifications',
      [pointsAdded, usdtAmt, req.session.userId]
    );
    await client.query(
      `INSERT INTO treasury_ledger (user_id, entry_type, usdt_delta, points_delta, tx_ref, notes)
       VALUES ($1, 'user_usdt_deposit', $2, $3, $4, 'User USDT balance added to central admin wallet for advertising')`,
      [req.session.userId, usdtAmt, pointsAdded, txRef || 'CENTRAL-WALLET']
    );
    await client.query('COMMIT');
    cachedStats.at = 0;

    const u = uRes.rows[0];
    await sendNotification(
      req.session.userId,
      u.email,
      'USDT Balance Added to Central Wallet',
      `Added $${usdtAmt.toFixed(2)} USDT (${pointsAdded} Ad Credits) in central wallet. Ref: ${txRef || 'CENTRAL-WALLET'}`,
      u.email_notifications
    );

    res.redirect('/?tab=advertise&msg=' + encodeURIComponent(`Added $${usdtAmt.toFixed(2)} USDT (${pointsAdded} Ad Credits) to central wallet!`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Deposit error');
  } finally {
    client.release();
  }
});

// Claim Shortlink Reward
app.post('/api/shortlinks/claim', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const linkId = parseInt(req.body.shortlink_id, 10);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const lRes = await client.query('SELECT * FROM shortlinks WHERE id = $1 FOR UPDATE', [linkId]);
    if (lRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=shortlinks&msg=' + encodeURIComponent('Shortlink not found.'));
    }
    const link = lRes.rows[0];
    const cntRes = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM shortlink_claims WHERE user_id = $1 AND shortlink_id = $2 AND claimed_at > NOW() - INTERVAL '24 HOURS'",
      [req.session.userId, linkId]
    );
    if (cntRes.rows[0].cnt >= link.daily_limit) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=shortlinks&msg=' + encodeURIComponent('Daily limit reached for this shortlink.'));
    }

    await client.query('INSERT INTO shortlink_claims (user_id, shortlink_id) VALUES ($1, $2)', [req.session.userId, linkId]);
    await awardPointsWithReferral(client, req.session.userId, link.reward_points);
    await client.query('COMMIT');

    res.redirect('/?tab=shortlinks&msg=' + encodeURIComponent(`Claimed +${link.reward_points} pts ($${(link.reward_points / 1000).toFixed(3)}) from shortlink!`));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Shortlink claim error');
  } finally {
    client.release();
  }
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
    const adRes = await client.query("SELECT * FROM ptc_ads WHERE id = $1 AND status = 'approved' FOR UPDATE", [adId]);
    const ad = adRes.rows[0];
    if (!ad || ad.remaining_views <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ad expired' });
    }
    if ((Date.now() - startTime) / 1000 < ad.timer_seconds - 2) {
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
    await awardPointsWithReferral(client, req.session.userId, ad.reward_points);
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

// Submit Micro-Task Proof
app.post('/api/tasks/submit', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { task_id, proof_text, screenshot_url } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskRes = await client.query("SELECT * FROM micro_tasks WHERE id = $1 AND status = 'approved' AND remaining_slots > 0 FOR UPDATE", [task_id]);
    if (taskRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=tasks-view&msg=' + encodeURIComponent('Task no longer available.'));
    }
    await client.query(
      'INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_url) VALUES ($1, $2, $3, $4)',
      [task_id, req.session.userId, proof_text, (screenshot_url || '').trim()]
    );
    await client.query('UPDATE micro_tasks SET remaining_slots = remaining_slots - 1 WHERE id = $1', [task_id]);
    await client.query('COMMIT');
    res.redirect('/?tab=tasks-submissions&msg=' + encodeURIComponent('Proof submitted! Track status under My Submission.'));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Submission error');
  } finally {
    client.release();
  }
});

// Create Dispute
app.post('/api/disputes/create', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const { category, reference_id, subject, details } = req.body;
  await pool.query(
    `INSERT INTO disputes (user_id, category, reference_id, subject, details, status)
     VALUES ($1, $2, $3, $4, $5, 'open')`,
    [req.session.userId, category || 'task_proof', (reference_id || '').trim(), (subject || '').trim(), (details || '').trim()]
  );
  res.redirect('/?tab=tasks-disputes&msg=' + encodeURIComponent('Dispute submitted! Admin will review it in My Disputes.'));
});

// Advertiser Campaign Request
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
    const uRes = await client.query('SELECT advertiser_balance FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    if (!uRes.rows[0] || uRes.rows[0].advertiser_balance < totalCost) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=advertise&msg=' + encodeURIComponent(`Need ${totalCost} Ad Credits ($${(totalCost / 1000).toFixed(2)}). Add USDT balance first.`));
    }
    await client.query('UPDATE users SET advertiser_balance = advertiser_balance - $1 WHERE id = $2', [totalCost, req.session.userId]);
    await client.query(
      `INSERT INTO ptc_ads (advertiser_id, title, description, url, timer_seconds, reward_points, remaining_views, total_cost, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [req.session.userId, title, description || '', url, secs, pts, views, totalCost]
    );
    await client.query('COMMIT');
    res.redirect('/?tab=advertise&msg=' + encodeURIComponent('Campaign submitted! Awaiting Admin approval.'));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Campaign creation error');
  } finally {
    client.release();
  }
});

// User Withdrawal Request -> Pending Until Admin Approves
app.post('/api/withdraw/request', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const points = parseInt(req.body.points_amount, 10);
  const walletAddress = (req.body.wallet_address || '').trim();
  const payoutMethod = (req.body.payout_method || 'USDT (TRC20 / FaucetPay)').trim();

  if (!points || points < 100) {
    return res.redirect('/?tab=withdraw&msg=' + encodeURIComponent('Minimum withdrawal request is 100 Points ($0.10).'));
  }
  if (!walletAddress) {
    return res.redirect('/?tab=withdraw&msg=' + encodeURIComponent('Please enter your USDT or FaucetPay wallet address.'));
  }

  const usdAmount = Number((points / 1000).toFixed(4));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const uRes = await client.query('SELECT points_balance, email, email_notifications FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    const u = uRes.rows[0];
    if (!u || u.points_balance < points) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=withdraw&msg=' + encodeURIComponent('Insufficient points balance.'));
    }

    await client.query('UPDATE users SET points_balance = points_balance - $1, faucetpay_address = $2 WHERE id = $3', [points, walletAddress, req.session.userId]);
    await client.query(
      `INSERT INTO withdrawals (user_id, points_amount, usd_amount, payout_method, wallet_address, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [req.session.userId, points, usdAmount, payoutMethod, walletAddress]
    );
    await client.query('COMMIT');

    await sendNotification(
      req.session.userId,
      u.email,
      'Withdrawal Request Pending Admin Approval',
      `Requested ${points} pts ($${usdAmount.toFixed(2)}). Payout will process only after Admin approval.`,
      u.email_notifications
    );

    res.redirect('/?tab=withdraw&msg=' + encodeURIComponent('Withdrawal request submitted! Status: Pending Admin Approval.'));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Withdrawal request error');
  } finally {
    client.release();
  }
});

// ADMIN: Add Micro-Task
app.post('/api/admin/tasks/create', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const { title, instructions, proof_required, reward_points, total_slots } = req.body;
  await pool.query(
    `INSERT INTO micro_tasks (advertiser_id, title, instructions, proof_required, reward_points, remaining_slots, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'approved')`,
    [req.session.userId, title, instructions, proof_required, Math.max(1, parseInt(reward_points, 10) || 100), Math.max(1, parseInt(total_slots, 10) || 50)]
  );
  res.redirect('/?tab=admin&msg=' + encodeURIComponent('Micro-task added and published!'));
});

// ADMIN: Add PTC Ad
app.post('/api/admin/ptc/create', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const { title, description, url, timer_seconds, reward_points, total_views } = req.body;
  await pool.query(
    `INSERT INTO ptc_ads (advertiser_id, title, description, url, timer_seconds, reward_points, remaining_views, total_cost, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'approved')`,
    [req.session.userId, title, description || '', url, Math.max(5, parseInt(timer_seconds, 10) || 15), Math.max(1, parseInt(reward_points, 10) || 10), Math.max(1, parseInt(total_views, 10) || 100)]
  );
  res.redirect('/?tab=admin&msg=' + encodeURIComponent('PTC ad added and published!'));
});

// ADMIN: Add Shortlink Task
app.post('/api/admin/shortlinks/create', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const { title, target_url, reward_points, daily_limit } = req.body;
  await pool.query(
    'INSERT INTO shortlinks (title, target_url, reward_points, daily_limit) VALUES ($1, $2, $3, $4)',
    [title, target_url, Math.max(1, parseInt(reward_points, 10) || 50), Math.max(1, parseInt(daily_limit, 10) || 5)]
  );
  res.redirect('/?tab=admin&msg=' + encodeURIComponent('Shortlink task added!'));
});

// ADMIN: Central USDT Treasury Deposit
app.post('/api/admin/treasury/topup', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const targetIdOrEmail = (req.body.target_email || '').trim().toLowerCase();
  const usdtAmt = Number(parseFloat(req.body.usdt_amount).toFixed(2)) || 0;
  const txRef = (req.body.tx_ref || '').trim();
  const pts = Math.floor(usdtAmt * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let targetUserId = req.session.userId;
    if (targetIdOrEmail) {
      const tRes = await client.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 OR public_id = $1 FOR UPDATE',
        [targetIdOrEmail]
      );
      if (tRes.rows.length > 0) {
        targetUserId = tRes.rows[0].id;
        await client.query('UPDATE users SET advertiser_balance = advertiser_balance + $1 WHERE id = $2', [pts, targetUserId]);
      }
    }
    await client.query(
      `INSERT INTO treasury_ledger (user_id, entry_type, usdt_delta, points_delta, tx_ref, notes)
       VALUES ($1, 'admin_topup', $2, $3, $4, 'Central wallet USDT recorded by Admin')`,
      [targetUserId, usdtAmt, pts, txRef || 'ADMIN-TREASURY']
    );
    await client.query('COMMIT');
    cachedStats.at = 0;
    res.redirect('/?tab=admin&msg=' + encodeURIComponent(`Recorded $${usdtAmt.toFixed(2)} USDT in central wallet (${pts} pts).`));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Treasury topup error');
  } finally {
    client.release();
  }
});

// ADMIN: Approve or Reject Task Proof
app.post('/api/admin/proofs/review', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const { submission_id, action } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subRes = await client.query(`
      SELECT ts.*, mt.title, mt.reward_points, u.email, u.email_notifications
      FROM task_submissions ts
      JOIN micro_tasks mt ON ts.task_id = mt.id
      JOIN users u ON ts.user_id = u.id
      WHERE ts.id = $1 AND ts.status = 'pending' FOR UPDATE
    `, [submission_id]);
    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=admin');
    }
    const sub = subRes.rows[0];
    if (action === 'approve') {
      await client.query("UPDATE task_submissions SET status = 'approved' WHERE id = $1", [submission_id]);
      await awardPointsWithReferral(client, sub.user_id, sub.reward_points);
    } else {
      await client.query("UPDATE task_submissions SET status = 'rejected' WHERE id = $1", [submission_id]);
      await client.query('UPDATE micro_tasks SET remaining_slots = remaining_slots + 1 WHERE id = $1', [sub.task_id]);
    }
    await client.query('COMMIT');
    await sendNotification(
      sub.user_id,
      sub.email,
      action === 'approve' ? 'Task Proof Approved' : 'Task Proof Rejected',
      action === 'approve'
        ? `Your proof for "${sub.title}" was approved! +${sub.reward_points} pts ($${(sub.reward_points / 1000).toFixed(2)}).`
        : `Your proof for "${sub.title}" was rejected by Admin.`,
      sub.email_notifications
    );
    res.redirect('/?tab=admin');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Review error');
  } finally {
    client.release();
  }
});

// ADMIN: Approve or Reject Advertiser Ad
app.post('/api/admin/ads/review', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const { ad_id, action } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const adRes = await client.query(`
      SELECT pa.*, u.email, u.email_notifications
      FROM ptc_ads pa
      LEFT JOIN users u ON pa.advertiser_id = u.id
      WHERE pa.id = $1 AND pa.status = 'pending' FOR UPDATE
    `, [ad_id]);
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
        await client.query('UPDATE users SET advertiser_balance = advertiser_balance + $1 WHERE id = $2', [refund, ad.advertiser_id]);
      }
    }
    await client.query('COMMIT');
    if (ad.advertiser_id) {
      await sendNotification(
        ad.advertiser_id,
        ad.email,
        action === 'approve' ? 'Ad Campaign Approved' : 'Ad Campaign Rejected',
        action === 'approve'
          ? `Your ad "${ad.title}" is now live!`
          : `Your ad "${ad.title}" was rejected and Ad Credits were refunded.`,
        ad.email_notifications
      );
    }
    res.redirect('/?tab=admin');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Ad review error');
  } finally {
    client.release();
  }
});

// ADMIN: Approve or Reject Withdrawal (Mandatory Admin Gate)
app.post('/api/admin/withdrawals/review', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const { withdrawal_id, action, admin_note } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wdRes = await client.query(`
      SELECT w.*, u.email, u.email_notifications
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
      WHERE w.id = $1 AND w.status = 'pending' FOR UPDATE
    `, [withdrawal_id]);
    if (wdRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=admin');
    }
    const wd = wdRes.rows[0];

    if (action === 'approve') {
      await client.query(
        "UPDATE withdrawals SET status = 'approved', admin_note = $1, reviewed_at = NOW() WHERE id = $2",
        [(admin_note || 'Approved by Admin').trim(), withdrawal_id]
      );
      await client.query(
        `INSERT INTO treasury_ledger (user_id, entry_type, usdt_delta, points_delta, tx_ref, notes)
         VALUES ($1, 'approved_withdrawal', $2, $3, $4, 'Admin-approved withdrawal payout')`,
        [wd.user_id, -Number(wd.usd_amount), -wd.points_amount, `WD-${wd.id}`]
      );
    } else {
      await client.query(
        "UPDATE withdrawals SET status = 'rejected', admin_note = $1, reviewed_at = NOW() WHERE id = $2",
        [(admin_note || 'Rejected by Admin').trim(), withdrawal_id]
      );
      await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2', [wd.points_amount, wd.user_id]);
    }
    await client.query('COMMIT');
    cachedStats.at = 0;

    await sendNotification(
      wd.user_id,
      wd.email,
      action === 'approve' ? 'Withdrawal Approved' : 'Withdrawal Rejected & Refunded',
      action === 'approve'
        ? `Admin approved your withdrawal of ${wd.points_amount} pts ($${Number(wd.usd_amount).toFixed(2)}) to ${wd.wallet_address}.`
        : `Admin rejected your withdrawal of ${wd.points_amount} pts; points have been refunded to your balance.`,
      wd.email_notifications
    );

    res.redirect('/?tab=admin&msg=' + encodeURIComponent(`Withdrawal #${withdrawal_id} marked as ${action}d.`));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Withdrawal review error');
  } finally {
    client.release();
  }
});

// ADMIN: Resolve User Dispute
app.post('/api/admin/disputes/resolve', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const { dispute_id, admin_response, bonus_points } = req.body;
  const bonus = Math.max(0, parseInt(bonus_points, 10) || 0);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const dRes = await client.query(`
      SELECT d.*, u.email, u.email_notifications
      FROM disputes d
      JOIN users u ON d.user_id = u.id
      WHERE d.id = $1 AND d.status = 'open' FOR UPDATE
    `, [dispute_id]);
    if (dRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=admin');
    }
    const d = dRes.rows[0];
    await client.query(
      "UPDATE disputes SET status = 'resolved', admin_response = $1, resolved_at = NOW() WHERE id = $2",
      [(admin_response || 'Resolved by Admin').trim(), dispute_id]
    );
    if (bonus > 0) {
      await awardPointsWithReferral(client, d.user_id, bonus);
    }
    await client.query('COMMIT');

    await sendNotification(
      d.user_id,
      d.email,
      'Dispute Resolved',
      `Dispute "${d.subject}" resolved: ${admin_response || 'Reviewed by Admin'}${bonus > 0 ? ` (+${bonus} pts awarded)` : ''}.`,
      d.email_notifications
    );
    res.redirect('/?tab=admin&msg=' + encodeURIComponent(`Dispute #${dispute_id} resolved.`));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Dispute resolution error');
  } finally {
    client.release();
  }
});

// Postback Webhook (1,000 Points = $1.00; 70% share to user => 700 pts per $1.00)
app.get('/api/postback/:network', async (req, res) => {
  const { network } = req.params;
  const { userid, txid, payout, status, secret } = req.query;
  if (secret !== process.env.POSTBACK_SECRET) return res.status(403).send('Invalid Secret');

  const userPoints = Math.floor(parseFloat(payout) * 1000 * 0.70);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uLookup = await client.query('SELECT id FROM users WHERE id::text = $1 OR public_id = $1', [String(userid)]);
    if (uLookup.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('USER_NOT_FOUND');
    }
    const targetUserId = uLookup.rows[0].id;

    if (status === '2' || status === 'chargeback' || userPoints < 0) {
      await client.query('UPDATE users SET points_balance = points_balance - $1 WHERE id = $2', [Math.abs(userPoints), targetUserId]);
      await client.query('COMMIT');
      return res.status(200).send('OK_CHARGEBACK');
    }
    const dup = await client.query('SELECT id FROM postback_logs WHERE tx_id = $1', [txid]);
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(200).send('DUP');
    }
    await client.query('INSERT INTO postback_logs (network, tx_id, user_id, points_awarded) VALUES ($1, $2, $3, $4)', [network, txid, targetUserId, userPoints]);
    await awardPointsWithReferral(client, targetUserId, userPoints);
    await client.query('COMMIT');
    res.status(200).send('OK');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('ERROR');
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Free Faucet v3 running on port ${PORT}`));
