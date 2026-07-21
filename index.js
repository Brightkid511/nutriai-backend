// index.js
require('dotenv').config();


const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./src/config/db');
const userRoutes = require('./src/routes/userRoutes');
const mealPlanRoutes = require('./src/routes/mealPlanRoutes');
const foodImageRoutes = require('./src/routes/foodImageRoutes');
const nutritionAnalysisRoutes = require('./src/routes/nutritionAnalysisRoutes');
const aiChefRoutes = require('./src/routes/aiChefRoutes');
const healthProfileRoutes = require('./src/routes/healthProfileRoutes');
const medicationRoutes = require('./src/routes/medicationRoutes');
const cycleTrackingRoutes = require('./src/routes/cycleTrackingRoutes');
const mealBuilderRoutes = require('./src/routes/mealBuilderRoutes');

const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');

// Refuse to start without a real JWT secret - never fall back to a
// hardcoded default that lives in source control.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET is missing or too short in your .env file. Server will not start.');
  process.exit(1);
}
const app = express();
const PORT = process.env.PORT || 5000;

// Render (and most hosts) put your app behind a reverse proxy, so the
// real client IP arrives via the X-Forwarded-For header. Trusting exactly
// 1 hop tells Express "believe the first proxy in front of me" - this is
// what express-rate-limit needs to correctly identify users by IP instead
// of accidentally rate-limiting everyone as one client (or crashing, like
// it's doing now).
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// ---- Rate limiters ----
// Auth endpoints: slow down brute-force login/registration attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again in a few minutes.' },
});

// AI endpoints: these cost you money per call, so cap usage per IP/hour
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'You are sending requests too quickly. Please slow down.' },
});
app.use('/api/users/login', authLimiter);
app.use('/api/users/register', authLimiter);
app.use('/api/ai-chef', aiLimiter);
app.use('/api/meal-builder/suggest', aiLimiter);


// auto-fill-week makes up to 21 AI calls in a single request - needs its
// own, much tighter limit so it can't be spammed or run up your Gemini bill.
const weekFillLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'You have reached the daily limit for auto-filling a week. Please try again tomorrow.' },
});
app.use('/api/meal-builder/auto-fill-week', weekFillLimiter);

// ---- Routes ----
app.use('/api/users', userRoutes);
app.use('/api/meal-plans', mealPlanRoutes);
app.use('/api/food-images', foodImageRoutes);
app.use('/api/nutrition-analysis', nutritionAnalysisRoutes);
app.use('/api/ai-chef', aiChefRoutes);
app.use('/api/health-profile', healthProfileRoutes);
app.use('/api/medications', medicationRoutes);
app.use('/api/cycle-tracking', cycleTrackingRoutes);
app.use('/api/meal-builder', mealBuilderRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to NutriAI Backend! Server is running 🚀',
    status: 'OK',
    dbStatus: 'Connected',
  });
});

// These two MUST be registered last, after every other route/middleware
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`NutriAI Backend running on http://localhost:${PORT}`);
});