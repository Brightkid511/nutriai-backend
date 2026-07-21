const db = require('../config/db');
const AppError = require('../utils/AppError');

const VALID_LIFE_STAGES = ['none', 'pregnant', 'breastfeeding'];

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
      lifeStage: 'none',
      pregnancyTrimester: null,
      notes: '',
    };
  }

  return {
    allergies: parseJsonArraySafely(row.allergies),
    conditions: parseJsonArraySafely(row.conditions),
    dietaryPreference: row.dietary_preference || 'None',
    lifeStage: row.life_stage || 'none',
    pregnancyTrimester: row.pregnancy_trimester || null,
    notes: row.notes || '',
  };
};

// GET /api/health-profile
const getHealthProfile = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const [rows] = await db.execute('SELECT * FROM health_profiles WHERE user_id = ?', [userId]);

  return res.json({
    success: true,
    profile: toProfileResponse(rows[0]),
  });
};

// PUT /api/health-profile
// body: { allergies: string[], conditions: string[], dietaryPreference: string,
//         lifeStage?: 'none'|'pregnant'|'breastfeeding', pregnancyTrimester?: 1|2|3, notes: string }
const updateHealthProfile = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const {
    allergies = [],
    conditions = [],
    dietaryPreference = 'None',
    lifeStage = 'none',
    pregnancyTrimester = null,
    notes = '',
  } = req.body;

  if (!Array.isArray(allergies) || !Array.isArray(conditions)) {
    throw new AppError('allergies and conditions must be arrays', 400);
  }

  if (!VALID_LIFE_STAGES.includes(lifeStage)) {
    throw new AppError(`lifeStage must be one of: ${VALID_LIFE_STAGES.join(', ')}`, 400);
  }

  const trimesterValue =
    lifeStage === 'pregnant' && [1, 2, 3].includes(Number(pregnancyTrimester))
      ? Number(pregnancyTrimester)
      : null;

  await db.execute(
    `INSERT INTO health_profiles
     (user_id, allergies, conditions, dietary_preference, life_stage, pregnancy_trimester, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       allergies = VALUES(allergies),
       conditions = VALUES(conditions),
       dietary_preference = VALUES(dietary_preference),
       life_stage = VALUES(life_stage),
       pregnancy_trimester = VALUES(pregnancy_trimester),
       notes = VALUES(notes),
       updated_at = NOW()`,
    [
      userId,
      JSON.stringify(allergies),
      JSON.stringify(conditions),
      dietaryPreference,
      lifeStage,
      trimesterValue,
      notes,
    ]
  );

  const [rows] = await db.execute('SELECT * FROM health_profiles WHERE user_id = ?', [userId]);

  return res.json({
    success: true,
    message: 'Health profile saved successfully',
    profile: toProfileResponse(rows[0]),
  });
};

// Builds a short natural-language block describing the user's health
// profile, meant to be dropped straight into an AI prompt. Used by both
// the meal-plan generator and AI Chef so suggestions stay safe.
// Returns '' if the user has no relevant profile data.
const getHealthProfileText = async (userId) => {
  const [rows] = await db.execute('SELECT * FROM health_profiles WHERE user_id = ?', [userId]);

  const profile = toProfileResponse(rows[0]);
  const { allergies, conditions, dietaryPreference, lifeStage, pregnancyTrimester, notes } = profile;

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

  if (lifeStage === 'pregnant') {
    parts.push(
      `LIFE STAGE - the user is PREGNANT${pregnancyTrimester ? ` (trimester ${pregnancyTrimester})` : ''}. ` +
      `This is a hard constraint: avoid raw or undercooked meat/eggs/fish, unpasteurized dairy, ` +
      `raw sprouts, excess vitamin A (e.g. liver in large amounts), unwashed produce, and high-mercury fish. ` +
      `Keep caffeine sources modest. Prioritize iron, folate, calcium, and protein-rich options common in local cuisine.`
    );
  } else if (lifeStage === 'breastfeeding') {
    parts.push(
      `LIFE STAGE - the user is BREASTFEEDING. ` +
      `Prioritize extra hydration, adequate calories, calcium, and protein. ` +
      `Avoid suggesting excessive caffeine or alcohol-containing dishes.`
    );
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