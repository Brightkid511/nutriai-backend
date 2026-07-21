const crypto = require('crypto');
const genAI = require('../config/gemini');
const db = require('../config/db');
const { getHealthProfileText } = require('./healthProfileController');
const AppError = require('../utils/AppError');

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
// Auto-fill week only covers the 3 tabs the Meal Builder UI actually shows.
const AUTO_FILL_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];
const AUTO_FILL_DAYS = 7;

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

const addDays = (dateStr, offset) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split('T')[0];
};

const dayLabel = (dateStr) =>
  new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

// Wraps a Gemini call so a provider failure becomes a clean, safe
// 502 instead of leaking SDK/network internals to the client.
const callGeminiForJson = async (prompt) => {
  let result;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
    result = await model.generateContent(prompt);
  } catch (err) {
    console.error('Gemini call failed:', err);
    throw new AppError('Our AI meal generator is temporarily unavailable. Please try again shortly.', 502);
  }
  return result.response.text();
};

// POST /api/meal-builder/suggest
// body: { meal_type, meal_date?, budget_tzs? }
const suggestMeals = async (req, res) => {
  const userId = req.user?.id;
  const { meal_type, meal_date, budget_tzs } = req.body;

  if (!userId) throw new AppError('User ID not found in token', 401);
  if (!VALID_MEAL_TYPES.includes(meal_type)) {
    throw new AppError(`meal_type must be one of: ${VALID_MEAL_TYPES.join(', ')}`, 400);
  }

  const date = meal_date || todayStr();

  const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
  const user = users[0];
  if (!user) throw new AppError('User not found', 404);

  const healthConstraintsText = await getHealthProfileText(userId);
  const category = categoryForMealType(meal_type);
  const foodListText = await getFoodOptionsForCategory(category);

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

  const responseText = await callGeminiForJson(prompt);
  const options = parseJsonSafely(responseText, []);

  if (!Array.isArray(options) || options.length === 0) {
    throw new AppError('AI did not return valid meal options, please try again', 502);
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
};

// POST /api/meal-builder/suggest/:id/replace
const replaceSuggestion = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;

  if (!userId) throw new AppError('User ID not found in token', 401);

  const [rows] = await db.execute(
    `SELECT * FROM meal_suggestions WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  const original = rows[0];

  if (!original) throw new AppError('Suggestion not found', 404);

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

  const healthConstraintsText = await getHealthProfileText(userId);
  const category = categoryForMealType(original.meal_type);
  const foodListText = await getFoodOptionsForCategory(category);

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

  const responseText = await callGeminiForJson(prompt);
  const option = parseJsonSafely(responseText, null);

  if (!option || !option.meal_name) {
    throw new AppError('AI did not return a valid replacement, please try again', 502);
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

  // If this suggestion had already been auto/manually selected for its slot,
  // keep the selection in sync with the replacement so a review screen
  // (e.g. auto-fill week) doesn't show a stale meal after a swap.
  await db.execute(
    `UPDATE user_selected_meals
     SET suggestion_id = ?, meal_name = ?, calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, estimated_cost_tzs = ?, updated_at = NOW()
     WHERE user_id = ? AND meal_date = ? AND meal_type = ? AND suggestion_id = ?`,
    [
      insertResult.insertId,
      option.meal_name,
      option.calories || 0,
      option.protein_g || 0,
      option.carbs_g || 0,
      option.fat_g || 0,
      option.estimated_cost_tzs || null,
      userId,
      original.meal_date,
      original.meal_type,
      id,
    ]
  );

  return res.json({
    success: true,
    option: { id: insertResult.insertId, session_id: original.session_id, meal_type: original.meal_type, meal_date: original.meal_date, ...option },
  });
};

// POST /api/meal-builder/select
// body: { suggestion_id }
const selectMeal = async (req, res) => {
  const userId = req.user?.id;
  const { suggestion_id } = req.body;

  if (!userId) throw new AppError('User ID not found in token', 401);
  if (!suggestion_id) throw new AppError('suggestion_id is required', 400);

  const [rows] = await db.execute(
    `SELECT * FROM meal_suggestions WHERE id = ? AND user_id = ?`,
    [suggestion_id, userId]
  );
  const suggestion = rows[0];

  if (!suggestion) throw new AppError('Suggestion not found', 404);

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
};

// GET /api/meal-builder/selected?date=YYYY-MM-DD
const getSelectedMeals = async (req, res) => {
  const userId = req.user?.id;
  const date = req.query.date || todayStr();

  if (!userId) throw new AppError('User ID not found in token', 401);

  const [rows] = await db.execute(
    `SELECT * FROM user_selected_meals WHERE user_id = ? AND meal_date = ?`,
    [userId, date]
  );

  return res.json({ success: true, meal_date: date, selected: rows });
};

// Core "save whatever is currently selected for this date" logic, shared
// by the single-day Save button and the new week-confirm flow. Returns
// null (instead of throwing) when there's nothing selected for that date,
// so callers looping over a week can just skip empty days.
const upsertPlanForDate = async (userId, date) => {
  const [meals] = await db.execute(
    `SELECT * FROM user_selected_meals WHERE user_id = ? AND meal_date = ?`,
    [userId, date]
  );

  if (meals.length === 0) return null;

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

  await db.execute(
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

  return { plan_history_id: savedRows[0].id, plan_date: date, totals };
};

// POST /api/meal-builder/save
// body: { meal_date? }
const savePlan = async (req, res) => {
  const userId = req.user?.id;
  const date = req.body.meal_date || todayStr();

  if (!userId) throw new AppError('User ID not found in token', 401);

  const result = await upsertPlanForDate(userId, date);

  if (!result) {
    throw new AppError('No meals selected for this date yet', 400);
  }

  return res.json({
    success: true,
    message: 'Meal plan saved',
    ...result,
  });
};

// GET /api/meal-builder/history
const getPlanHistory = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const [rows] = await db.execute(
    `SELECT * FROM meal_plan_history WHERE user_id = ? ORDER BY plan_date DESC`,
    [userId]
  );

  return res.json({ success: true, plans: rows });
};

// Generates and auto-selects ONE meal option for a single day + meal type
// slot, reusing the same prompt style, food list, and health constraints
// as the manual "suggest" flow - just asking for 1 pick instead of 4,
// since auto-fill runs this up to 21 times per request and doesn't need
// the browsing options a human would want.
const generateAndAutoSelectMeal = async ({
  userId,
  mealType,
  date,
  user,
  healthConstraintsText,
  foodListText,
  excludeNames,
}) => {
  const category = categoryForMealType(mealType);

  const prompt = `You are an expert Tanzanian nutritionist. Pick ONE realistic ${mealType} option for:
- Age: ${user.age}, Weight: ${user.weight}kg, Height: ${user.height}cm
- Activity Level: ${user.activity_level}
- Goal: ${user.goal}
${healthConstraintsText ? `\n${healthConstraintsText}\n` : ''}
Rules:
- Only use dishes built from the APPROVED FOOD LIST below.
- If a food conflicts with allergy/medical/avoid rules above, skip it - those rules always win.
- Do NOT repeat any of these meals already used elsewhere this week: ${excludeNames.length ? excludeNames.join(', ') : '(none yet)'}.
- Use local Swahili name followed by a short English description in parentheses.
- Return ONLY valid JSON, no markdown fences.

APPROVED FOOD LIST for ${category}:
${foodListText}

Return this exact JSON structure:
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

  const responseText = await callGeminiForJson(prompt);
  const option = parseJsonSafely(responseText, null);

  if (!option || !option.meal_name) {
    // Don't fail the whole week over one slot - return a clearly-marked
    // placeholder the user can just tap "Replace" on in the review screen.
    return {
      meal_name: 'Could not generate - tap Replace to try again',
      description: '',
      calories: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      estimated_cost_tzs: null,
      reasoning: null,
      _failed: true,
    };
  }

  return option;
};

// POST /api/meal-builder/auto-fill-week
// body: { start_date? } - defaults to today. Generates a full 7-day draft
// (breakfast/lunch/dinner) using the same engine and data model as the
// manual Meal Builder flow (meal_suggestions + user_selected_meals) -
// nothing is written to meal_plan_history yet. The user reviews the
// draft and calls /confirm-week to actually save any of the days.
const autoFillWeek = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const startDate = req.body.start_date || todayStr();

  const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
  const user = users[0];
  if (!user) throw new AppError('User not found', 404);

  const healthConstraintsText = await getHealthProfileText(userId);

  // Fetch each category's food list once up front instead of once per
  // slot (21x fewer DB round trips).
  const foodListByCategory = {};
  for (const mealType of AUTO_FILL_MEAL_TYPES) {
    const category = categoryForMealType(mealType);
    if (!foodListByCategory[category]) {
      foodListByCategory[category] = await getFoodOptionsForCategory(category);
    }
  }

  // Tracks meal names already used this week per meal type, so the AI
  // avoids repeating the same dish across days.
  const usedNamesByType = { breakfast: [], lunch: [], dinner: [] };

  const week = [];

  for (let dayOffset = 0; dayOffset < AUTO_FILL_DAYS; dayOffset++) {
    const date = addDays(startDate, dayOffset);

    // Clear any old suggestions/selections for this date+type combo before
    // regenerating, same cleanup the manual suggest flow already does.
    await db.execute(
      `DELETE FROM meal_suggestions WHERE user_id = ? AND meal_date = ? AND meal_type IN (?, ?, ?)`,
      [userId, date, ...AUTO_FILL_MEAL_TYPES]
    );

    // Run the 3 meal types for this day in parallel to cut wall-clock time
    // roughly 3x, while keeping days sequential so the "avoid repeats"
    // exclude list stays accurate day-to-day.
    const dayResults = await Promise.all(
      AUTO_FILL_MEAL_TYPES.map(async (mealType) => {
        const category = categoryForMealType(mealType);
        const option = await generateAndAutoSelectMeal({
          userId,
          mealType,
          date,
          user,
          healthConstraintsText,
          foodListText: foodListByCategory[category],
          excludeNames: usedNamesByType[mealType],
        });

        const sessionId = crypto.randomUUID();
        const [insertResult] = await db.execute(
          `INSERT INTO meal_suggestions
           (user_id, session_id, meal_type, meal_date, meal_name, description, calories, protein_g, carbs_g, fat_g, estimated_cost_tzs, reasoning)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            sessionId,
            mealType,
            date,
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

        const suggestionId = insertResult.insertId;

        // Auto-select this draft pick so the review screen can show it as
        // "currently chosen for this slot" immediately, using the exact
        // same table the manual flow uses.
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
            date,
            mealType,
            suggestionId,
            option.meal_name,
            option.calories || 0,
            option.protein_g || 0,
            option.carbs_g || 0,
            option.fat_g || 0,
            option.estimated_cost_tzs || null,
          ]
        );

        if (!option._failed) {
          usedNamesByType[mealType].push(option.meal_name);
        }

        return {
          meal_type: mealType,
          suggestion_id: suggestionId,
          meal_date: date,
          meal_name: option.meal_name,
          description: option.description || '',
          calories: option.calories || 0,
          protein_g: option.protein_g || 0,
          carbs_g: option.carbs_g || 0,
          fat_g: option.fat_g || 0,
          estimated_cost_tzs: option.estimated_cost_tzs || null,
          reasoning: option.reasoning || null,
          failed: !!option._failed,
        };
      })
    );

    const meals = {};
    dayResults.forEach((m) => { meals[m.meal_type] = m; });

    week.push({
      date,
      day_name: dayLabel(date),
      meals,
    });
  }

  return res.json({ success: true, start_date: startDate, week });
};

// POST /api/meal-builder/confirm-week
// body: { dates: string[] } - the specific dates (from the auto-fill draft)
// the user wants saved into their real meal history. Any date the user
// unchecked in the review screen just gets omitted from this array.
const confirmWeek = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const { dates } = req.body;

  if (!Array.isArray(dates) || dates.length === 0) {
    throw new AppError('dates must be a non-empty array of YYYY-MM-DD strings', 400);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (dates.some((d) => typeof d !== 'string' || !DATE_RE.test(d))) {
    throw new AppError('Each date must be in YYYY-MM-DD format', 400);
  }

  const saved = [];
  const skipped = [];

  for (const date of dates) {
    const result = await upsertPlanForDate(userId, date);
    if (result) {
      saved.push(result);
    } else {
      skipped.push(date);
    }
  }

  return res.json({
    success: true,
    message: `Saved ${saved.length} of ${dates.length} day(s)`,
    saved,
    skipped,
  });
};

module.exports = {
  suggestMeals,
  replaceSuggestion,
  selectMeal,
  getSelectedMeals,
  savePlan,
  getPlanHistory,
  autoFillWeek,
  confirmWeek,
};