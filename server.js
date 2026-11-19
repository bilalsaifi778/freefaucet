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

// Optional SMTP Mailer (if SMTP_HOST is set in Render Env Vars)
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendNotification(userId, email, title, message, allowEmail = true) {
  await pool.query(
    'INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)',
    [userId, title, message]
  );
  if (mailer && allowEmail && email) {
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: `Free Faucet — ${title}`,
        text: `${message}\n\n1,000 Points = $1.00`
      });
    } catch (e) {
      console.error('Email send error:', e.message);
    }
  }
}

async function awardPointsWithReferral(client, userId, points) {
  if (points <= 0) return;
  const uRes = await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2 RETURNING referred_by', [points, userId]);
  const refId = uRes.rows[0] && uRes.rows[0].referred_by;
  if (refId) {
    const refBonus = Math.max(1, Math.floor(points * 0.10)); // 10% referral commission
    await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2', [refBonus, refId]);
  }
}

function isAdminUser(user) {
  return Boolean(user && (user.is_admin || user.email.toLowerCase() === ADMIN_EMAIL));
}

app.get('/health', (req, res) => res.status(200).send('OK - Free Faucet Engine Active'));

// Main Dashboard
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
      stats: { totalUsers: 0, activePtc: 0, activeTasks: 0, pendingAds: 0, pendingProofs: 0, pendingWithdrawals: 0, centralUsdt: '0.00' },
      ptcAds: [],
      microTasks: [],
      submissions: [],
      withdrawals: [],
      notifications: [],
      referrals: [],
      pendingProofs: [],
      pendingAds: [],
      pendingWithdrawals: [],
      treasuryHistory: []
    });
  }

  const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  const user = userRes.rows[0];
  if (!user) {
    req.session.destroy();
    return res.redirect('/');
  }

  const isAdmin = isAdminUser(user);

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

  const tasksRes = await pool.query(`
    SELECT * FROM micro_tasks
    WHERE status = 'approved'
      AND remaining_slots > 0
      AND id NOT IN (SELECT task_id FROM task_submissions WHERE user_id = $1)
    ORDER BY reward_points DESC
  `, [user.id]);

  const subRes = await pool.query(`
    SELECT ts.*, mt.title, mt.reward_points
    FROM task_submissions ts
    JOIN micro_tasks mt ON ts.task_id = mt.id
    WHERE ts.user_id = $1
    ORDER BY ts.submitted_at DESC LIMIT 30
  `, [user.id]);

  const wdRes = await pool.query(`
    SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30
  `, [user.id]);

  const notifRes = await pool.query(`
    SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30
  `, [user.id]);

  const refRes = await pool.query(`
    SELECT id, email, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC
  `, [user.id]);

  const pendingProofsRes = await pool.query(`
    SELECT ts.*, mt.title, mt.reward_points, mt.proof_required, u.email
    FROM task_submissions ts
    JOIN micro_tasks mt ON ts.task_id = mt.id
    JOIN users u ON ts.user_id = u.id
    WHERE ts.status = 'pending'
    ORDER BY ts.submitted_at ASC
  `);

  const pendingAdsRes = await pool.query(`
    SELECT pa.*, u.email AS advertiser_email
    FROM ptc_ads pa
    LEFT JOIN users u ON pa.advertiser_id = u.id
    WHERE pa.status = 'pending'
    ORDER BY pa.created_at ASC
  `);

  const pendingWdRes = await pool.query(`
    SELECT w.*, u.email
    FROM withdrawals w
    JOIN users u ON w.user_id = u.id
    WHERE w.status = 'pending'
    ORDER BY w.created_at ASC
  `);

  const treasuryRes = await pool.query(`
    SELECT COALESCE(SUM(usdt_delta), 0)::numeric(14,2) AS total_usdt FROM treasury_ledger
  `);

  const treasuryHistRes = await pool.query(`
    SELECT tl.*, u.email FROM treasury_ledger tl LEFT JOIN users u ON tl.user_id = u.id ORDER BY tl.created_at DESC LIMIT 25
  `);

  const usersCountRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM users');

  res.render('dashboard', {
    user,
    isAdmin,
    refCode: '',
    resetToken: '',
    flashMsg: req.query.msg || '',
    stats: {
      totalUsers: usersCountRes.rows[0].cnt,
      activePtc: ptcRes.rows.length,
      activeTasks: tasksRes.rows.length,
      pendingAds: pendingAdsRes.rows.length,
      pendingProofs: pendingProofsRes.rows.length,
      pendingWithdrawals: pendingWdRes.rows.length,
      centralUsdt: treasuryRes.rows[0].total_usdt
    },
    ptcAds: ptcRes.rows,
    microTasks: tasksRes.rows,
    submissions: subRes.rows,
    withdrawals: wdRes.rows,
    notifications: notifRes.rows,
    referrals: refRes.rows,
    pendingProofs: pendingProofsRes.rows,
    pendingAds: pendingAdsRes.rows,
    pendingWithdrawals: pendingWdRes.rows,
    treasuryHistory: treasuryHistRes.rows
  });
});

// Signup
app.post('/auth/signup', async (req, res) => {
  const { email, password, faucetpay_address, ref_code } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const cleanEmail = (email || '').trim().toLowerCase();

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.redirect('/?msg=' + encodeURIComponent('Email already registered. Please login.'));
    }

    let referredById = null;
    if (ref_code && ref_code.trim()) {
      const refUser = await pool.query('SELECT id FROM users WHERE referral_code = $1', [ref_code.trim()]);
      if (refUser.rows.length > 0) referredById = refUser.rows[0].id;
    }

    const hash = await bcrypt.hash(password, 10);
    const shouldBeAdmin = cleanEmail === ADMIN_EMAIL;
    const tempCode = 'FF' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const created = await pool.query(
      `INSERT INTO users (email, password_hash, faucetpay_address, is_admin, referral_code, referred_by, last_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [cleanEmail, hash, (faucetpay_address || '').trim(), shouldBeAdmin, tempCode, referredById, ip]
    );

    const newUserId = created.rows[0].id;
    const finalCode = `FF${1000 + newUserId}`;
    await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [finalCode, newUserId]);

    await sendNotification(newUserId, cleanEmail, 'Welcome to Free Faucet!', 'Your account is active. 1,000 Points = $1.00.', true);
    req.session.userId = newUserId;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Signup error');
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
    if (!match) {
      return res.redirect('/?msg=' + encodeURIComponent('Invalid password.'));
    }
    await pool.query('UPDATE users SET last_ip = $1 WHERE id = $2', [ip, user.id]);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Login error');
  }
});

// Forgot Password — Request Reset Token
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

  await sendNotification(u.id, u.email, 'Password Reset Requested', `Reset token: ${token} (valid 1 hour).`, true);

  // If SMTP is not configured, pass token in query so user can test immediately; if SMTP is active, email is sent
  if (!mailer) {
    return res.redirect('/?reset_token=' + token + '&msg=' + encodeURIComponent('Reset token generated below (SMTP not configured).'));
  }
  res.redirect('/?msg=' + encodeURIComponent('Password reset instructions sent to your email.'));
});

// Reset Password with Token
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

// Update Profile & Email Notifications
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

// Mark Notifications Read
app.post('/api/notifications/read', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.session.userId]);
  res.redirect('/?tab=inbox');
});

// User Adds USDT Balance -> Goes to Single Central Admin Wallet & Credits Ad Credits (1,000 pts = $1.00)
app.post('/api/wallet/deposit-usdt', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const usdtAmt = parseFloat(req.body.usdt_amount);
  const txRef = (req.body.tx_ref || '').trim();

  if (!usdtAmt || usdtAmt < 0.10) {
    return res.redirect('/?tab=advertise&msg=' + encodeURIComponent('Minimum USDT deposit is $0.10 (100 Ad Credits).'));
  }

  const pointsAdded = Math.floor(usdtAmt * 1000); // 1,000 pts = $1.00
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
      [req.session.userId, usdtAmt, pointsAdded, txRef || 'MANUAL-LOG']
    );
    await client.query('COMMIT');

    const u = uRes.rows[0];
    await sendNotification(
      req.session.userId,
      u.email,
      'USDT Balance Added for Ads',
      `Added $${usdtAmt.toFixed(2)} USDT (${pointsAdded} Ad Credits) in central wallet. Ref: ${txRef || 'N/A'}`,
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
      return res.redirect('/?tab=tasks&msg=' + encodeURIComponent('Task no longer available.'));
    }
    await client.query(
      'INSERT INTO task_submissions (task_id, user_id, proof_text, screenshot_url) VALUES ($1, $2, $3, $4)',
      [task_id, req.session.userId, proof_text, (screenshot_url || '').trim()]
    );
    await client.query('UPDATE micro_tasks SET remaining_slots = remaining_slots - 1 WHERE id = $1', [task_id]);
    await client.query('COMMIT');
    res.redirect('/?tab=tasks&msg=' + encodeURIComponent('Proof submitted! Waiting for Admin review.'));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Submission error');
  } finally {
    client.release();
  }
});

// Advertiser Creates Campaign Using Ad Credits (1,000 pts = $1.00) -> Pending Admin Approval
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

// User Submits Withdrawal Request -> ALWAYS 'pending' Until Admin Approves
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

  const usdAmount = Number((points / 1000).toFixed(4)); // 1,000 pts = $1.00
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const uRes = await client.query('SELECT points_balance, email, email_notifications FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
    const u = uRes.rows[0];
    if (!u || u.points_balance < points) {
      await client.query('ROLLBACK');
      return res.redirect('/?tab=withdraw&msg=' + encodeURIComponent('Insufficient points balance.'));
    }

    // Hold points while awaiting Admin approval
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

// ADMIN: Create Micro-Task
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
  res.redirect('/?tab=admin&msg=' + encodeURIComponent('Micro-task published!'));
});

// ADMIN: Create Instant PTC Ad
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
  res.redirect('/?tab=admin&msg=' + encodeURIComponent('PTC ad published!'));
});

// ADMIN: Record Central USDT Treasury Deposit & Credit User/Ad Balance
app.post('/api/admin/treasury/topup', async (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  const uRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!isAdminUser(uRes.rows[0])) return res.status(403).send('Admin only');

  const targetEmail = (req.body.target_email || '').trim().toLowerCase();
  const usdtAmt = parseFloat(req.body.usdt_amount) || 0;
  const txRef = (req.body.tx_ref || '').trim();
  const pts = Math.floor(usdtAmt * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let targetUserId = req.session.userId;
    if (targetEmail) {
      const tRes = await client.query('SELECT id, advertiser_balance FROM users WHERE email = $1 FOR UPDATE', [targetEmail]);
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
    res.redirect('/?tab=admin&msg=' + encodeURIComponent(`Recorded $${usdtAmt.toFixed(2)} USDT in central wallet (${pts} pts).`));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send('Treasury topup error');
  } finally {
    client.release();
  }
});

// ADMIN: Approve or Reject User Task Proof
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

// ADMIN: Approve or Reject User Withdrawal (Mandatory Admin Approval Gate)
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
      // Refund points back to user balance when rejected
      await client.query('UPDATE users SET points_balance = points_balance + $1 WHERE id = $2', [wd.points_amount, wd.user_id]);
    }
    await client.query('COMMIT');

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

// Postback Webhook (1,000 Points = $1.00; 70% share to user => 700 pts per $1.00)
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
    await awardPointsWithReferral(client, userid, userPoints);
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
app.listen(PORT, () => console.log(`Free Faucet running on port ${PORT}`));
