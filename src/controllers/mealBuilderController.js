const crypto = require('crypto');
const genAI = require('../config/gemini');
const db = require('../config/db');
const { getHealthProfileForUser, buildHealthConstraintsText } = require('./healthProfile');

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

const parseJsonSafely = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  try {
    const cleaned = value
      .replace(/^```json/i, '')
      .replace(/^```/i, '')
      .replace(/```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (_) {
    return fallback;
  }
};

const categoryForMealType = (mealType) => {
  const map = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
  return map[mealType] || 'Lunch';
};

const getFoodOptionsForCategory = async (category) => {
  const [rows] = await db.execute(
    `SELECT food_name, local_name, avg_price_tzs, calories
     FROM foods
     WHERE meal_category = ? AND affordability_tier IN ('Low', 'Medium')
     ORDER BY avg_price_tzs ASC`,
    [category]
  );

  return rows
    .map((f) => `${f.local_name} (${f.food_name}) - ~${f.avg_price_tzs} TZS, ${f.calories} kcal`)
    .join('\n');
};

const todayStr = () => new Date().toISOString().split('T')[0];

// POST /api/meal-builder/suggest
// body: { meal_type, meal_date?, budget_tzs? }
const suggestMeals = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { meal_type, meal_date, budget_tzs } = req.body;

    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });
    if (!VALID_MEAL_TYPES.includes(meal_type)) {
      return res.status(400).json({ success: false, error: `meal_type must be one of: ${VALID_MEAL_TYPES.join(', ')}` });
    }

    const date = meal_date || todayStr();

    const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
    const user = users[0];
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const healthProfile = await getHealthProfileForUser(userId);
    const healthConstraintsText = buildHealthConstraintsText(healthProfile);
    const category = categoryForMealType(meal_type);
    const foodListText = await getFoodOptionsForCategory(category);

    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

    const prompt = `You are an expert Tanzanian nutritionist. Suggest 4 DIFFERENT realistic ${meal_type} options for:
- Age: ${user.age}, Weight: ${user.weight}kg, Height: ${user.height}cm
- Activity Level: ${user.activity_level}
- Goal: ${user.goal}
${healthConstraintsText ? `\n${healthConstraintsText}\n` : ''}${budget_tzs ? `\nBUDGET: keep estimated_cost_tzs at or under ${budget_tzs} TZS per option where realistic.\n` : ''}
Rules:
- Only use dishes built from the APPROVED FOOD LIST below. Do not invent foods outside it.
- If a food conflicts with allergy/medical/avoid rules above, skip it - those rules always win.
- The 4 options must be genuinely different from each other (not minor variations).
- Use local Swahili name for each dish followed by a short English description in parentheses.
- Keep meals realistic for home cooking.
- Return ONLY valid JSON, no markdown fences.

APPROVED FOOD LIST for ${category}:
${foodListText}

Return this exact JSON array structure (4 items):
[
  {
    "meal_name": "Wali na Maharage (rice with beans)",
    "description": "short 1-sentence description",
    "calories": 450,
    "protein_g": 15.5,
    "carbs_g": 70.2,
    "fat_g": 8.1,
    "estimated_cost_tzs": 2500,
    "reasoning": "one short sentence on why this fits the user's goal"
  }
]`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const options = parseJsonSafely(responseText, []);

    if (!Array.isArray(options) || options.length === 0) {
      return res.status(502).json({ success: false, error: 'AI did not return valid meal options, please try again' });
    }

    // Clear any previous suggestions for this exact slot before inserting a fresh batch
    await db.execute(
      `DELETE FROM meal_suggestions WHERE user_id = ? AND meal_type = ? AND meal_date = ?`,
      [userId, meal_type, date]
    );

    const sessionId = crypto.randomUUID();
    const insertedOptions = [];

    for (const option of options.slice(0, 4)) {
      const [result] = await db.execute(
        `INSERT INTO meal_suggestions
         (user_id, session_id, meal_type, meal_date, meal_name, description, calories, protein_g, carbs_g, fat_g, estimated_cost_tzs, reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          sessionId,
          meal_type,
          date,
          option.meal_name || 'Meal option',
          option.description || null,
          option.calories || 0,
          option.protein_g || 0,
          option.carbs_g || 0,
          option.fat_g || 0,
          option.estimated_cost_tzs || null,
          option.reasoning || null,
        ]
      );

      insertedOptions.push({ id: result.insertId, session_id: sessionId, meal_type, meal_date: date, ...option });
    }

    return res.json({ success: true, session_id: sessionId, options: insertedOptions });
  } catch (error) {
    console.error('Suggest meals error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/meal-builder/suggest/:id/replace
const replaceSuggestion = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });

    const [rows] = await db.execute(
      `SELECT * FROM meal_suggestions WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    const original = rows[0];

    if (!original) return res.status(404).json({ success: false, error: 'Suggestion not found' });

    const [sessionRows] = await db.execute(
      `SELECT meal_name FROM meal_suggestions WHERE session_id = ? AND user_id = ?`,
      [original.session_id, userId]
    );
    const excludeNames = sessionRows.map((r) => r.meal_name);

    // Log the replace on the previously-selected food, if any, for the learning layer
    await db.execute(
      `INSERT INTO user_food_preferences (user_id, food_name, times_replaced)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE times_replaced = times_replaced + 1, updated_at = NOW()`,
      [userId, original.meal_name]
    );

    const healthProfile = await getHealthProfileForUser(userId);
    const healthConstraintsText = buildHealthConstraintsText(healthProfile);
    const category = categoryForMealType(original.meal_type);
    const foodListText = await getFoodOptionsForCategory(category);

    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

    const prompt = `You are an expert Tanzanian nutritionist. Suggest ONE alternative ${original.meal_type} option targeting approximately ${original.calories} kcal, ${original.protein_g}g protein, ${original.carbs_g}g carbs, ${original.fat_g}g fat.
${healthConstraintsText ? `\n${healthConstraintsText}\n` : ''}
Do NOT suggest any of these already-shown meals: ${excludeNames.join(', ')}.

Only use dishes from this APPROVED FOOD LIST for ${category}:
${foodListText}

Return ONLY valid JSON, no markdown fences, this exact structure:
{
  "meal_name": "...",
  "description": "...",
  "calories": 450,
  "protein_g": 15.5,
  "carbs_g": 70.2,
  "fat_g": 8.1,
  "estimated_cost_tzs": 2500,
  "reasoning": "..."
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const option = parseJsonSafely(responseText, null);

    if (!option || !option.meal_name) {
      return res.status(502).json({ success: false, error: 'AI did not return a valid replacement, please try again' });
    }

    await db.execute(`DELETE FROM meal_suggestions WHERE id = ?`, [id]);

    const [insertResult] = await db.execute(
      `INSERT INTO meal_suggestions
       (user_id, session_id, meal_type, meal_date, meal_name, description, calories, protein_g, carbs_g, fat_g, estimated_cost_tzs, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        original.session_id,
        original.meal_type,
        original.meal_date,
        option.meal_name,
        option.description || null,
        option.calories || 0,
        option.protein_g || 0,
        option.carbs_g || 0,
        option.fat_g || 0,
        option.estimated_cost_tzs || null,
        option.reasoning || null,
      ]
    );

    return res.json({
      success: true,
      option: { id: insertResult.insertId, session_id: original.session_id, meal_type: original.meal_type, meal_date: original.meal_date, ...option },
    });
  } catch (error) {
    console.error('Replace suggestion error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/meal-builder/select
// body: { suggestion_id }
const selectMeal = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { suggestion_id } = req.body;

    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });
    if (!suggestion_id) return res.status(400).json({ success: false, error: 'suggestion_id is required' });

    const [rows] = await db.execute(
      `SELECT * FROM meal_suggestions WHERE id = ? AND user_id = ?`,
      [suggestion_id, userId]
    );
    const suggestion = rows[0];

    if (!suggestion) return res.status(404).json({ success: false, error: 'Suggestion not found' });

    await db.execute(
      `INSERT INTO user_selected_meals
       (user_id, meal_date, meal_type, suggestion_id, meal_name, calories, protein_g, carbs_g, fat_g, estimated_cost_tzs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         suggestion_id = VALUES(suggestion_id),
         meal_name = VALUES(meal_name),
         calories = VALUES(calories),
         protein_g = VALUES(protein_g),
         carbs_g = VALUES(carbs_g),
         fat_g = VALUES(fat_g),
         estimated_cost_tzs = VALUES(estimated_cost_tzs),
         updated_at = NOW()`,
      [
        userId,
        suggestion.meal_date,
        suggestion.meal_type,
        suggestion.id,
        suggestion.meal_name,
        suggestion.calories,
        suggestion.protein_g,
        suggestion.carbs_g,
        suggestion.fat_g,
        suggestion.estimated_cost_tzs,
      ]
    );

    await db.execute(
      `INSERT INTO user_food_preferences (user_id, food_name, times_selected, last_selected_at)
       VALUES (?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE times_selected = times_selected + 1, last_selected_at = NOW(), updated_at = NOW()`,
      [userId, suggestion.meal_name]
    );

    return res.json({ success: true, message: 'Meal selected', meal_type: suggestion.meal_type, meal_date: suggestion.meal_date });
  } catch (error) {
    console.error('Select meal error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/meal-builder/selected?date=YYYY-MM-DD
const getSelectedMeals = async (req, res) => {
  try {
    const userId = req.user?.id;
    const date = req.query.date || todayStr();

    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });

    const [rows] = await db.execute(
      `SELECT * FROM user_selected_meals WHERE user_id = ? AND meal_date = ?`,
      [userId, date]
    );

    return res.json({ success: true, meal_date: date, selected: rows });
  } catch (error) {
    console.error('Get selected meals error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/meal-builder/save
// body: { meal_date? }
const savePlan = async (req, res) => {
  try {
    const userId = req.user?.id;
    const date = req.body.meal_date || todayStr();

    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });

    const [meals] = await db.execute(
      `SELECT * FROM user_selected_meals WHERE user_id = ? AND meal_date = ?`,
      [userId, date]
    );

    if (meals.length === 0) {
      return res.status(400).json({ success: false, error: 'No meals selected for this date yet' });
    }

    const byType = {};
    meals.forEach((m) => { byType[m.meal_type] = m; });

    const totals = meals.reduce(
      (acc, m) => ({
        calories: acc.calories + (m.calories || 0),
        protein_g: acc.protein_g + parseFloat(m.protein_g || 0),
        carbs_g: acc.carbs_g + parseFloat(m.carbs_g || 0),
        fat_g: acc.fat_g + parseFloat(m.fat_g || 0),
        cost_tzs: acc.cost_tzs + (m.estimated_cost_tzs || 0),
      }),
      { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, cost_tzs: 0 }
    );

    const [result] = await db.execute(
      `INSERT INTO meal_plan_history
       (user_id, plan_date, breakfast_name, lunch_name, dinner_name, snack_name, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_cost_tzs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         breakfast_name = VALUES(breakfast_name),
         lunch_name = VALUES(lunch_name),
         dinner_name = VALUES(dinner_name),
         snack_name = VALUES(snack_name),
         total_calories = VALUES(total_calories),
         total_protein_g = VALUES(total_protein_g),
         total_carbs_g = VALUES(total_carbs_g),
         total_fat_g = VALUES(total_fat_g),
         total_cost_tzs = VALUES(total_cost_tzs),
         updated_at = NOW()`,
      [
        userId,
        date,
        byType.breakfast?.meal_name || null,
        byType.lunch?.meal_name || null,
        byType.dinner?.meal_name || null,
        byType.snack?.meal_name || null,
        totals.calories,
        totals.protein_g,
        totals.carbs_g,
        totals.fat_g,
        totals.cost_tzs,
      ]
    );

    // MySQL doesn't return insertId on the UPDATE branch of an upsert, so fetch it explicitly
    const [savedRows] = await db.execute(
      `SELECT id FROM meal_plan_history WHERE user_id = ? AND plan_date = ?`,
      [userId, date]
    );

    return res.json({
      success: true,
      message: 'Meal plan saved',
      plan_history_id: savedRows[0].id,
      plan_date: date,
      totals,
    });
  } catch (error) {
    console.error('Save plan error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { suggestMeals, replaceSuggestion, selectMeal, getSelectedMeals, savePlan };