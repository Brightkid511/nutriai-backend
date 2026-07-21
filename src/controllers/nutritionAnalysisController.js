const genAI = require('../config/gemini');
const db = require('../config/db');
const AppError = require('../utils/AppError');

const parseJsonSafely = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  if (typeof value === 'string') {
    try {
      const cleaned = value
        .replace(/^```json/i, '')
        .replace(/^```/i, '')
        .replace(/```$/i, '')
        .trim();

      return JSON.parse(cleaned);
    } catch (error) {
      return fallback;
    }
  }

  return fallback;
};

const fetchMealBuilderDays = async (userId) => {
  const [rows] = await db.execute(
    `SELECT plan_date, breakfast_name, lunch_name, dinner_name, snack_name
     FROM meal_plan_history
     WHERE user_id = ?
     ORDER BY plan_date DESC
     LIMIT 7`,
    [userId]
  );
  return rows;
};

const fetchPersonalPlans = async (userId) => {
  const [rows] = await db.execute(
    `SELECT name, plan
     FROM personal_meal_plans
     WHERE user_id = ? AND plan_type = 'personal'
     AND (expires_at IS NULL OR expires_at >= NOW())
     ORDER BY created_at DESC
     LIMIT 3`,
    [userId]
  );
  return rows;
};

// Turns saved Meal Builder days + any personal plans into a short,
// readable text block the AI can reason about.
const buildMealSummaryText = (builderDays, personalPlans) => {
  const lines = [];

  builderDays.forEach((row) => {
    const dateStr =
      row.plan_date instanceof Date
        ? row.plan_date.toISOString().split('T')[0]
        : row.plan_date;

    const mealParts = [];
    if (row.breakfast_name) mealParts.push(`breakfast: ${row.breakfast_name}`);
    if (row.lunch_name) mealParts.push(`lunch: ${row.lunch_name}`);
    if (row.dinner_name) mealParts.push(`dinner: ${row.dinner_name}`);
    if (row.snack_name) mealParts.push(`snack: ${row.snack_name}`);

    if (mealParts.length > 0) {
      lines.push(`[Meal Builder] ${dateStr} - ${mealParts.join(', ')}`);
    }
  });

  personalPlans.forEach((planRow) => {
    const plan = parseJsonSafely(planRow.plan, {});
    const label = planRow.name || 'Personal Plan';

    Object.entries(plan).forEach(([day, meals]) => {
      if (!meals || typeof meals !== 'object') return;

      const mealParts = Object.entries(meals)
        .map(([mealType, mealName]) => `${mealType}: ${mealName}`)
        .join(', ');

      if (mealParts) {
        lines.push(`[${label}] ${day} - ${mealParts}`);
      }
    });
  });

  return lines.join('\n');
};

const saveAnalysis = async (userId, analysis) => {
  await db.execute(
    `INSERT INTO nutrition_analysis (user_id, analysis)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE analysis = VALUES(analysis), updated_at = NOW()`,
    [userId, JSON.stringify(analysis)]
  );
};

// Core generation logic, shared by both the cached GET and the forced
// POST /generate endpoints.
const runAnalysis = async (userId) => {
  const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
  const user = users[0];

  if (!user) {
    throw new AppError('User not found', 404);
  }

  const [builderDays, personalPlans] = await Promise.all([
    fetchMealBuilderDays(userId),
    fetchPersonalPlans(userId),
  ]);

  const mealSummary = buildMealSummaryText(builderDays, personalPlans);

  if (!mealSummary) {
    // No plans to analyze yet - return a friendly placeholder instead of
    // calling the AI on empty data.
    const emptyResult = {
      dailyCalories: null,
      macros: {
        energy: { percent: 0, status: 'No data' },
        protein: { percent: 0, status: 'No data' },
        vitamins: { percent: 0, status: 'No data' },
        minerals: { percent: 0, status: 'No data' },
      },
      advice: [
        'Save a few meals with the Meal Builder, or plan your whole week, so I can analyze your nutrition balance.',
      ],
    };

    await saveAnalysis(userId, emptyResult);
    return emptyResult;
  }

  const prompt = `You are an expert nutritionist analyzing a user's meal plans.

User profile:
- Age: ${user.age} years
- Weight: ${user.weight} kg
- Height: ${user.height} cm
- Activity Level: ${user.activity_level}
- Goal: ${user.goal}

Their recently saved meals:
${mealSummary}

Based on this, estimate how well their diet meets daily nutritional needs.
Return ONLY valid JSON, no markdown fences, in this exact structure:
{
  "dailyCalories": 2200,
  "macros": {
    "energy": { "percent": 72, "status": "Good" },
    "protein": { "percent": 68, "status": "Good" },
    "vitamins": { "percent": 54, "status": "Average" },
    "minerals": { "percent": 64, "status": "Good" }
  },
  "advice": [
    "Short, specific, actionable tip 1",
    "Short, specific, actionable tip 2",
    "Short, specific, actionable tip 3"
  ]
}

Rules:
- "percent" is 0-100, how well that category meets this user's daily needs given their goal
- "status" must be one of: "Good", "Average", "Low"
- Give 3-5 advice items, specific to what's actually in their meals (mention actual meals when relevant)
- Do not wrap the JSON in markdown code fences`;

  let responseText;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
    const result = await model.generateContent(prompt);
    responseText = result.response.text();
  } catch (err) {
    console.error('Nutrition analysis Gemini call failed:', err);
    throw new AppError('Nutrition analysis is temporarily unavailable. Please try again shortly.', 502);
  }

  const analysis = parseJsonSafely(responseText, null);

  if (!analysis) {
    throw new AppError('AI returned an unreadable analysis, please try again', 502);
  }

  await saveAnalysis(userId, analysis);
  return analysis;
};

// GET /api/nutrition-analysis
// Returns the cached analysis if one exists, otherwise generates a fresh one.
const getNutritionAnalysis = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const [cached] = await db.execute(
    'SELECT analysis, updated_at FROM nutrition_analysis WHERE user_id = ?',
    [userId]
  );

  if (cached.length > 0) {
    return res.json({
      success: true,
      cached: true,
      updatedAt: cached[0].updated_at,
      analysis: parseJsonSafely(cached[0].analysis, {}),
    });
  }

  const analysis = await runAnalysis(userId);

  return res.json({ success: true, cached: false, analysis });
};

// POST /api/nutrition-analysis/generate
// Always regenerates, ignoring any cached result. Used by a "Refresh" button.
const generateNutritionAnalysis = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const analysis = await runAnalysis(userId);

  return res.json({ success: true, cached: false, analysis });
};

module.exports = {
  getNutritionAnalysis,
  generateNutritionAnalysis,
};