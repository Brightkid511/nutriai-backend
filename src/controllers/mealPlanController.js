const db = require('../config/db');
const AppError = require('../utils/AppError');

const PLAN_TTL_DAYS = 7;

const cleanupExpiredPlans = async (userId) => {
  await db.execute(
    `DELETE FROM personal_meal_plans
     WHERE user_id = ?
     AND expires_at IS NOT NULL
     AND expires_at < NOW()`,
    [userId]
  );
};

const parseJsonSafely = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  return fallback;
};

// GET /api/meal-plans/personal
const getPersonalPlans = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  await cleanupExpiredPlans(userId);

  const [plans] = await db.execute(
    `SELECT id, user_id, name, plan, plan_type, created_at, updated_at, expires_at
     FROM personal_meal_plans
     WHERE user_id = ? AND plan_type = 'personal' AND (expires_at IS NULL OR expires_at >= NOW())
     ORDER BY created_at DESC`,
    [userId]
  );

  const parsedPlans = plans.map((item) => ({ ...item, plan: parseJsonSafely(item.plan, {}) }));

  return res.json({ success: true, plans: parsedPlans });
};

// POST /api/meal-plans/personal
const createPersonalPlan = async (req, res) => {
  const userId = req.user?.id;
  const { name, plan } = req.body;

  if (!userId) throw new AppError('User ID not found in token', 401);
  if (!name || !plan) throw new AppError('Name and plan are required', 400);

  await cleanupExpiredPlans(userId);

  const planToSave = typeof plan === 'string' ? plan : JSON.stringify(plan);

  const [result] = await db.execute(
    `INSERT INTO personal_meal_plans (user_id, name, plan, plan_type, expires_at)
     VALUES (?, ?, ?, 'personal', DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [userId, name, planToSave, PLAN_TTL_DAYS]
  );

  return res.status(201).json({
    success: true,
    message: 'Personal meal plan created successfully',
    planId: result.insertId,
    expiresInDays: PLAN_TTL_DAYS,
  });
};

// PUT /api/meal-plans/personal/:id
const updatePersonalPlan = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;
  const { name, plan } = req.body;

  if (!userId) throw new AppError('User ID not found in token', 401);
  if (!name || !plan) throw new AppError('Name and plan are required', 400);

  await cleanupExpiredPlans(userId);

  const planToSave = typeof plan === 'string' ? plan : JSON.stringify(plan);

  const [result] = await db.execute(
    `UPDATE personal_meal_plans SET name = ?, plan = ?, updated_at = NOW()
     WHERE id = ? AND user_id = ? AND plan_type = 'personal'`,
    [name, planToSave, id, userId]
  );

  if (result.affectedRows === 0) {
    throw new AppError('Personal plan not found', 404);
  }

  return res.json({ success: true, message: 'Personal meal plan updated successfully', planId: id });
};

// DELETE /api/meal-plans/personal/:id
const deletePersonalPlan = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;

  if (!userId) throw new AppError('User ID not found in token', 401);

  const [result] = await db.execute(
    `DELETE FROM personal_meal_plans WHERE id = ? AND user_id = ? AND plan_type = 'personal'`,
    [id, userId]
  );

  if (result.affectedRows === 0) {
    throw new AppError('Personal plan not found', 404);
  }

  return res.json({ success: true, message: 'Personal meal plan deleted successfully', planId: id });
};

module.exports = {
  getPersonalPlans,
  createPersonalPlan,
  updatePersonalPlan,
  deletePersonalPlan,
};