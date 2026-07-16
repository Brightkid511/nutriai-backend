const db = require('../config/db');

const parseJsonArraySafely = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
};

const toProfileResponse = (row) => {
  if (!row) {
    return {
      allergies: [],
      conditions: [],
      dietaryPreference: 'None',
      notes: '',
    };
  }

  return {
    allergies: parseJsonArraySafely(row.allergies),
    conditions: parseJsonArraySafely(row.conditions),
    dietaryPreference: row.dietary_preference || 'None',
    notes: row.notes || '',
  };
};

// GET /api/health-profile
const getHealthProfile = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const [rows] = await db.execute(
      'SELECT * FROM health_profiles WHERE user_id = ?',
      [userId]
    );

    return res.json({
      success: true,
      profile: toProfileResponse(rows[0]),
    });
  } catch (error) {
    console.error('Error fetching health profile:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch health profile',
    });
  }
};

// PUT /api/health-profile
// body: { allergies: string[], conditions: string[], dietaryPreference: string, notes: string }
const updateHealthProfile = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const {
      allergies = [],
      conditions = [],
      dietaryPreference = 'None',
      notes = '',
    } = req.body;

    if (!Array.isArray(allergies) || !Array.isArray(conditions)) {
      return res.status(400).json({
        success: false,
        error: 'allergies and conditions must be arrays',
      });
    }

    await db.execute(
      `INSERT INTO health_profiles
       (user_id, allergies, conditions, dietary_preference, notes)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         allergies = VALUES(allergies),
         conditions = VALUES(conditions),
         dietary_preference = VALUES(dietary_preference),
         notes = VALUES(notes),
         updated_at = NOW()`,
      [
        userId,
        JSON.stringify(allergies),
        JSON.stringify(conditions),
        dietaryPreference,
        notes,
      ]
    );

    const [rows] = await db.execute(
      'SELECT * FROM health_profiles WHERE user_id = ?',
      [userId]
    );

    return res.json({
      success: true,
      message: 'Health profile saved successfully',
      profile: toProfileResponse(rows[0]),
    });
  } catch (error) {
    console.error('Error saving health profile:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to save health profile',
    });
  }
};

// Builds a short natural-language block describing the user's health
// profile, meant to be dropped straight into an AI prompt. Used by both
// the meal-plan generator and AI Chef so suggestions stay safe.
// Returns '' if the user has no relevant profile data.
const getHealthProfileText = async (userId) => {
  const [rows] = await db.execute(
    'SELECT * FROM health_profiles WHERE user_id = ?',
    [userId]
  );

  const profile = toProfileResponse(rows[0]);
  const { allergies, conditions, dietaryPreference, notes } = profile;

  const parts = [];

  if (allergies.length > 0) {
    parts.push(
      `ALLERGIES - the user is allergic to: ${allergies.join(', ')}. ` +
      `Do NOT include these ingredients or anything derived from them, under any circumstances.`
    );
  }

  if (conditions.length > 0) {
    parts.push(
      `HEALTH CONDITIONS - the user has: ${conditions.join(', ')}. ` +
      `Favor meals appropriate for managing these conditions ` +
      `(e.g. low-glycemic and controlled-carb options for diabetes, low-sodium for hypertension).`
    );
  }

  if (dietaryPreference && dietaryPreference !== 'None') {
    parts.push(`DIETARY PREFERENCE - ${dietaryPreference}.`);
  }

  if (notes && notes.trim()) {
    parts.push(`ADDITIONAL NOTES FROM USER - ${notes.trim()}`);
  }

  return parts.join('\n');
};

module.exports = {
  getHealthProfile,
  updateHealthProfile,
  getHealthProfileText,
};