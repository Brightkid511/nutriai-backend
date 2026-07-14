const genAI = require('../config/gemini');
const db = require('../config/db');

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

// Turns the raw plan JSON blobs from the DB into a short, readable
// text block the AI can reason about (day -> meal type -> meal name).
const buildMealSummaryText = (plans) => {
  const lines = [];

  plans.forEach((planRow) => {
    const plan = parseJsonSafely(planRow.plan, {});
    const label = planRow.plan_type === 'ai' ? 'AI Weekly Plan' : (planRow.name || 'Personal Plan');

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

const fetchUserPlans = async (userId) => {
  const [plans] = await db.execute(
    `SELECT id, name, plan, plan_type
     FROM personal_meal_plans
     WHERE user_id = ?
     AND (expires_at IS NULL OR expires_at >= NOW())
     ORDER BY created_at DESC
     LIMIT 6`,
    [userId]
  );
  return plans;
};

// Core generation logic, shared by both the cached GET and the forced
// POST /generate endpoints.
const runAnalysis = async (userId) => {
  const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
  const user = users[0];

  if (!user) {
    throw new Error('User not found');
  }

  const plans = await fetchUserPlans(userId);
  const mealSummary = buildMealSummaryText(plans);

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
        'Create or generate a meal plan first so I can analyze your nutrition balance.',
      ],
    };

    await saveAnalysis(userId, emptyResult);
    return emptyResult;
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

  const prompt = `You are an expert nutritionist analyzing a user's meal plans.

User profile:
- Age: ${user.age} years
- Weight: ${user.weight} kg
- Height: ${user.height} cm
- Activity Level: ${user.activity_level}
- Goal: ${user.goal}

Their current meal plans:
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
- Give 3-5 advice items, specific to what's actually in their meal plan (mention actual meals when relevant)
- Do not wrap the JSON in markdown code fences`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();

  const analysis = parseJsonSafely(responseText, null);

  if (!analysis) {
    throw new Error('AI returned an unreadable analysis');
  }

  await saveAnalysis(userId, analysis);
  return analysis;
};

const saveAnalysis = async (userId, analysis) => {
  await db.execute(
    `INSERT INTO nutrition_analysis (user_id, analysis)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE analysis = VALUES(analysis), updated_at = NOW()`,
    [userId, JSON.stringify(analysis)]
  );
};

// GET /api/nutrition-analysis
// Returns the cached analysis if one exists, otherwise generates a fresh one.
const getNutritionAnalysis = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'User ID not found in token' });
    }

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

    return res.json({
      success: true,
      cached: false,
      analysis,
    });
  } catch (error) {
    console.error('Nutrition analysis error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/nutrition-analysis/generate
// Always regenerates, ignoring any cached result. Used by a "Refresh" button.
const generateNutritionAnalysis = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'User ID not found in token' });
    }

    const analysis = await runAnalysis(userId);

    return res.json({
      success: true,
      cached: false,
      analysis,
    });
  } catch (error) {
    console.error('Nutrition analysis generation error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getNutritionAnalysis,
  generateNutritionAnalysis,
};