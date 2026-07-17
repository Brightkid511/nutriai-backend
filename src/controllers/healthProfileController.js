const db = require('../config/db');

const parseListSafely = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};

const getHealthProfileForUser = async (userId) => {
  const [rows] = await db.execute(
    'SELECT allergies, conditions, notes, preferred_foods, foods_to_avoid FROM health_profiles WHERE user_id = ?',
    [userId]
  );

  if (rows.length === 0) {
    return { allergies: [], conditions: [], notes: null, preferredFoods: [], foodsToAvoid: [] };
  }

  return {
    allergies: parseListSafely(rows[0].allergies),
    conditions: parseListSafely(rows[0].conditions),
    notes: rows[0].notes || null,
    preferredFoods: parseListSafely(rows[0].preferred_foods),
    foodsToAvoid: parseListSafely(rows[0].foods_to_avoid),
  };
};

const buildHealthConstraintsText = ({ allergies, conditions, notes, preferredFoods, foodsToAvoid }) => {
  const lines = [];

  if (allergies.length > 0) {
    lines.push(
      `STRICT ALLERGY EXCLUSION - the user is allergic to: ${allergies.join(', ')}. Never include these ingredients or anything derived from them, even in small amounts. This overrides every other instruction.`
    );
  }

  if (conditions.length > 0) {
    lines.push(
      `MEDICAL CONDITIONS - the user has: ${conditions.join(', ')}. Adjust meal choices to be appropriate for these conditions (e.g. low-glycemic-index and controlled carbs for diabetes, low sodium for hypertension, low purine for gout). Only adjust food choices - do not give medical dosing or treatment advice.`
    );
  }

  if (foodsToAvoid && foodsToAvoid.length > 0) {
    lines.push(`FOODS THE USER WANTS TO AVOID (preference, not allergy): ${foodsToAvoid.join(', ')}. Do not suggest these.`);
  }

  if (preferredFoods && preferredFoods.length > 0) {
    lines.push(`FOODS THE USER PREFERS: ${preferredFoods.join(', ')}. Favor these when they fit the meal type and nutrition target.`);
  }

  if (notes) {
    lines.push(`ADDITIONAL HEALTH NOTES FROM USER: ${notes}`);
  }

  return lines.join('\n');
};

module.exports = { getHealthProfileForUser, buildHealthConstraintsText };