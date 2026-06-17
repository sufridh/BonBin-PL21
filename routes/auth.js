const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
// Anyone with the group invite code can register
router.post('/register', async (req, res) => {
  const { username, display_name, password, invite_code } = req.body;

  if (!username || !display_name || !password || !invite_code) {
    return res.status(400).json({ error: 'All fields required' });
  }

  if (invite_code !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Invalid invite code — ask your group admin' });
  }

  if (username.length < 3 || username.length > 30) {
    return res.status(400).json({ error: 'Username must be 3–30 characters' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, username, display_name, is_admin, avatar_base64',
      [username.toLowerCase(), display_name, hash]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, display_name: user.display_name, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, is_admin: user.is_admin, avatar_base64: user.avatar_base64 } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, display_name, password_hash, is_admin, avatar_base64 FROM users WHERE username = $1',
      [username.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, display_name: user.display_name, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, is_admin: user.is_admin, avatar_base64: user.avatar_base64 } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, display_name, is_admin, avatar_base64, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/me
// Update display_name and/or avatar (avatar sent as a data URL, e.g. "data:image/png;base64,...")
const MAX_AVATAR_BYTES = 400 * 1024; // ~400KB decoded, keeps Postgres rows + JWT payloads sane

router.put('/me', authMiddleware, async (req, res) => {
  const { display_name, avatar_base64 } = req.body;

  const updates = [];
  const values = [];
  let paramIndex = 1;

  if (display_name !== undefined) {
    const trimmed = String(display_name).trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      return res.status(400).json({ error: 'Display name must be 1–100 characters' });
    }
    updates.push(`display_name = $${paramIndex++}`);
    values.push(trimmed);
  }

  if (avatar_base64 !== undefined) {
    if (avatar_base64 === null) {
      // Allow clearing the avatar
      updates.push(`avatar_base64 = $${paramIndex++}`);
      values.push(null);
    } else {
      const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(avatar_base64);
      if (!match) {
        return res.status(400).json({ error: 'Avatar must be a base64 image data URL (png, jpeg, webp, or gif)' });
      }
      const decodedSize = Buffer.byteLength(match[2], 'base64');
      if (decodedSize > MAX_AVATAR_BYTES) {
        return res.status(400).json({ error: 'Image too large — please use a photo under ~400KB' });
      }
      updates.push(`avatar_base64 = $${paramIndex++}`);
      values.push(avatar_base64);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  values.push(req.user.id);

  try {
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, username, display_name, is_admin, avatar_base64`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
