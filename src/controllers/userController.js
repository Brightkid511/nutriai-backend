// src/controllers/userController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const AppError = require('../utils/AppError');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/users/register
const register = async (req, res) => {
  const { name, email, password, age, weight, height, activity_level, goal } = req.body;

  if (!name || !name.trim()) {
    throw new AppError('Name is required', 400);
  }
  if (!email || !EMAIL_REGEX.test(email.trim())) {
    throw new AppError('A valid email is required', 400);
  }
  if (!password || password.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existing.length > 0) {
    throw new AppError('An account with this email already exists', 409);
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const [result] = await db.execute(
    'INSERT INTO users (name, email, password, age, weight, height, activity_level, goal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name.trim(), normalizedEmail, hashedPassword, age || null, weight || null, height || null, activity_level || null, goal || null]
  );

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    userId: result.insertId,
  });
};

// POST /api/users/login
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new AppError('Email and password are required', 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  const user = users[0];

  // Deliberately the SAME error whether the email doesn't exist or the
  // password is wrong - telling attackers which one it was makes it easy
  // to enumerate valid accounts.
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new AppError('Invalid email or password', 401);
  }

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      age: user.age,
      weight: user.weight,
      height: user.height,
      activity_level: user.activity_level,
      goal: user.goal,
    },
  });
};

module.exports = { register, login };