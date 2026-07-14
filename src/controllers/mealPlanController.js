const genAI = require('../config/gemini');
const db = require('../config/db');

const PLAN_TTL_DAYS = 7;

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

const cleanupExpiredPlans = async (userId) => {
  await db.execute(
    `DELETE FROM personal_meal_plans
     WHERE user_id = ?
     AND expires_at IS NOT NULL
     AND expires_at < NOW()`,
    [userId]
  );
};

const generateMealPlan = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    await cleanupExpiredPlans(userId);

    const [users] = await db.execute(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    );

    const user = users[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
    });

    const prompt = `You are an expert Tanzanian nutritionist and AI Chef. Create a complete, realistic 7-day meal plan for:
- Name: ${user.name}
- Age: ${user.age} years
- Weight: ${user.weight} kg
- Height: ${user.height} cm
- Activity Level: ${user.activity_level}
- Goal: ${user.goal}

Rules:
- Every meal MUST be authentic Tanzanian / East African food, made from ingredients that are cheap and easy to find in a typical Tanzanian market or duka (e.g. ugali, wali, maharage, mchicha, mchuzi wa samaki, ndizi, mtori, pilau, chapati, mandazi, viazi, mahindi, kunde, sukuma wiki, matoke, nyama choma, samaki wa kupaka, uji, kande, mbaazi, mtama, dagaa, etc.)
- Do not suggest imported, expensive, or hard-to-find ingredients (no quinoa, salmon, avocado toast, etc.) unless it's something genuinely common in Tanzania
- Use the local Swahili name for each dish, followed by a short description in parentheses in English (e.g. "Wali na Maharage (rice with beans)")
- 3 main meals + 2 snacks per day
- Balanced nutrition with approximate daily calories appropriate for the user's goal and activity level
- Meals should be realistic for home cooking, not restaurant-only dishes
- Vary the meals across the week - do not repeat the same dish more than twice
- Return ONLY valid JSON
- Do not wrap the JSON in markdown code fences

Return this exact JSON structure:
{
  "dailyCalories": 2500,
  "plan": {
    "Monday": {
      "breakfast": "...",
      "snack1": "...",
      "lunch": "...",
      "snack2": "...",
      "dinner": "..."
    },
    "Tuesday": {
      "breakfast": "...",
      "snack1": "...",
      "lunch": "...",
      "snack2": "...",
      "dinner": "..."
    },
    "Wednesday": {
      "breakfast": "...",
      "snack1": "...",
      "lunch": "...",
      "snack2": "...",
      "dinner": "..."
    },
    "Thursday": {
      "breakfast": "...",
      "snack1": "...",
      "lunch": "...",
      "snack2": "...",
      "dinner": "..."
    },
    "Friday": {
      "breakfast": "...",
      "snack1": "...",
      "lunch": "...",
      "snack2": "...",
      "dinner": "..."
    },
    "Saturday": {
      "breakfast": "...",
      "snack1": "...",
      "lunch": "...",
      "snack2": "...",
      "dinner": "..."
    },
    "Sunday": {
      "breakfast": "...",
      "snack1": "...",
      "lunch": "...",
      "snack2": "...",
      "dinner": "..."
    }
  }
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    const mealPlan = parseJsonSafely(responseText, {
      dailyCalories: null,
      plan: {},
      rawResponse: responseText,
    });

    const planToSave = mealPlan.plan || {};

    // Regenerate behavior:
    // delete the previous AI plan for this user, then save the new one.
    await db.execute(
      `DELETE FROM personal_meal_plans
       WHERE user_id = ?
       AND plan_type = 'ai'`,
      [userId]
    );

    const [insertResult] = await db.execute(
      `INSERT INTO personal_meal_plans
       (user_id, name, plan, plan_type, expires_at)
       VALUES (?, ?, ?, 'ai', DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [
        userId,
        'AI Generated Weekly Plan',
        JSON.stringify(planToSave),
        PLAN_TTL_DAYS,
      ]
    );

    return res.json({
      success: true,
      message: 'Weekly meal plan generated and saved successfully',
      mealPlan: {
        ...mealPlan,
        id: insertResult.insertId,
        name: 'AI Generated Weekly Plan',
        plan_type: 'ai',
        expires_at_days: PLAN_TTL_DAYS,
      },
    });
  } catch (error) {
    console.error('Meal Plan Error:', error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

const getMealPlans = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    await cleanupExpiredPlans(userId);

    const [plans] = await db.execute(
      `SELECT id, user_id, name, plan, plan_type, created_at, updated_at, expires_at
       FROM personal_meal_plans
       WHERE user_id = ?
       AND plan_type = 'ai'
       AND (expires_at IS NULL OR expires_at >= NOW())
       ORDER BY created_at DESC`,
      [userId]
    );

    const parsedPlans = plans.map((item) => ({
      ...item,
      plan: parseJsonSafely(item.plan, {}),
    }));

    return res.json({
      success: true,
      message: 'AI meal plans retrieved successfully',
      plans: parsedPlans,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

const getPersonalPlans = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    await cleanupExpiredPlans(userId);

    const [plans] = await db.execute(
      `SELECT id, user_id, name, plan, plan_type, created_at, updated_at, expires_at
       FROM personal_meal_plans
       WHERE user_id = ?
       AND plan_type = 'personal'
       AND (expires_at IS NULL OR expires_at >= NOW())
       ORDER BY created_at DESC`,
      [userId]
    );

    const parsedPlans = plans.map((item) => ({
      ...item,
      plan: parseJsonSafely(item.plan, {}),
    }));

    return res.json({
      success: true,
      plans: parsedPlans,
    });
  } catch (error) {
    console.error('Error fetching personal plans:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch personal plans',
    });
  }
};

const createPersonalPlan = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { name, plan } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    if (!name || !plan) {
      return res.status(400).json({
        success: false,
        error: 'Name and plan are required',
      });
    }

    await cleanupExpiredPlans(userId);

    const planToSave = typeof plan === 'string'
      ? plan
      : JSON.stringify(plan);

    const [result] = await db.execute(
      `INSERT INTO personal_meal_plans
       (user_id, name, plan, plan_type, expires_at)
       VALUES (?, ?, ?, 'personal', DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [userId, name, planToSave, PLAN_TTL_DAYS]
    );

    return res.status(201).json({
      success: true,
      message: 'Personal meal plan created successfully',
      planId: result.insertId,
      expiresInDays: PLAN_TTL_DAYS,
    });
  } catch (error) {
    console.error('Error creating personal plan:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to create personal plan',
    });
  }
};

const updatePersonalPlan = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { name, plan } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    if (!name || !plan) {
      return res.status(400).json({
        success: false,
        error: 'Name and plan are required',
      });
    }

    await cleanupExpiredPlans(userId);

    const planToSave = typeof plan === 'string'
      ? plan
      : JSON.stringify(plan);

    const [result] = await db.execute(
      `UPDATE personal_meal_plans
       SET name = ?, plan = ?, updated_at = NOW()
       WHERE id = ?
       AND user_id = ?
       AND plan_type = 'personal'`,
      [name, planToSave, id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Personal plan not found',
      });
    }

    return res.json({
      success: true,
      message: 'Personal meal plan updated successfully',
      planId: id,
    });
  } catch (error) {
    console.error('Error updating personal plan:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to update personal plan',
    });
  }
};

const deletePersonalPlan = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const [result] = await db.execute(
      `DELETE FROM personal_meal_plans
       WHERE id = ?
       AND user_id = ?
       AND plan_type = 'personal'`,
      [id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Personal plan not found',
      });
    }

    return res.json({
      success: true,
      message: 'Personal meal plan deleted successfully',
      planId: id,
    });
  } catch (error) {
    console.error('Error deleting personal plan:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to delete personal plan',
    });
  }
};

module.exports = {
  generateMealPlan,
  getMealPlans,
  getPersonalPlans,
  createPersonalPlan,
  updatePersonalPlan,
  deletePersonalPlan,
};