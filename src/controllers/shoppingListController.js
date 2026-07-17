const genAI = require('../config/gemini');
const db = require('../config/db');

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

// GET /api/meal-builder/shopping-list/:planId
const getShoppingList = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });

    // Return cached list if one already exists for this plan
    const [existing] = await db.execute(
      `SELECT items, created_at FROM shopping_lists WHERE plan_history_id = ? AND user_id = ?`,
      [planId, userId]
    );

    if (existing.length > 0) {
      return res.json({
        success: true,
        items: typeof existing[0].items === 'string' ? JSON.parse(existing[0].items) : existing[0].items,
        cached: true,
      });
    }

    const [plans] = await db.execute(
      `SELECT * FROM meal_plan_history WHERE id = ? AND user_id = ?`,
      [planId, userId]
    );
    const plan = plans[0];

    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });

    const mealNames = [plan.breakfast_name, plan.lunch_name, plan.dinner_name, plan.snack_name].filter(Boolean);

    if (mealNames.length === 0) {
      return res.status(400).json({ success: false, error: 'This plan has no meals to build a list from' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

    const prompt = `Break down these Tanzanian meals into a single combined shopping list with realistic quantities for ONE person for ONE day:
${mealNames.map((m) => `- ${m}`).join('\n')}

Rules:
- Combine duplicate ingredients across meals into one line with a total quantity.
- Use grams (g), kilograms (kg), pieces, or bunches as appropriate.
- Keep it to real, commonly available Tanzanian market ingredients.
- Return ONLY valid JSON, no markdown fences.

Return this exact JSON array structure:
[
  { "item": "Rice", "quantity": "500 g" },
  { "item": "Eggs", "quantity": "2" }
]`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const items = parseJsonSafely(responseText, []);

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(502).json({ success: false, error: 'AI did not return a valid shopping list, please try again' });
    }

    await db.execute(
      `INSERT INTO shopping_lists (user_id, plan_history_id, items) VALUES (?, ?, ?)`,
      [userId, planId, JSON.stringify(items)]
    );

    return res.json({ success: true, items, cached: false });
  } catch (error) {
    console.error('Get shopping list error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/meal-builder/shopping-list/:planId/regenerate
const regenerateShoppingList = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    if (!userId) return res.status(401).json({ success: false, error: 'User ID not found in token' });

    await db.execute(
      `DELETE FROM shopping_lists WHERE plan_history_id = ? AND user_id = ?`,
      [planId, userId]
    );

    return getShoppingList(req, res);
  } catch (error) {
    console.error('Regenerate shopping list error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { getShoppingList, regenerateShoppingList };