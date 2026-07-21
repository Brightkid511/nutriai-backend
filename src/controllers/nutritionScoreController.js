const db = require('../config/db');
const AppError = require('../utils/AppError');

const calculateTargets = (user) => {
  const weight = parseFloat(user.weight) || 60;
  const height = parseFloat(user.height) || 165;
  const age = parseInt(user.age, 10) || 30;
  const activity = (user.activity_level || '').toLowerCase();
  const goal = (user.goal || '').toLowerCase();

  // Mifflin-St Jeor, assuming a neutral sex factor since sex isn't in the schema yet
  let bmr = 10 * weight + 6.25 * height - 5 * age;

  const activityMultipliers = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    'very active': 1.9,
  };
  const multiplier = activityMultipliers[activity] || 1.375;

  let calorieTarget = bmr * multiplier;

  if (goal.includes('lose')) calorieTarget -= 400;
  if (goal.includes('gain') || goal.includes('muscle')) calorieTarget += 300;

  const proteinTarget = goal.includes('muscle') ? weight * 1.8 : weight * 1.2;
  const fatTarget = (calorieTarget * 0.27) / 9;
  const carbsTarget = (calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4;
  const fiberTarget = 30;

  return {
    calories: Math.round(calorieTarget),
    protein_g: Math.round(proteinTarget),
    carbs_g: Math.round(carbsTarget),
    fat_g: Math.round(fatTarget),
    fiber_g: fiberTarget,
  };
};

const percentOf = (actual, target) => {
  if (!target) return 0;
  return Math.min(100, Math.round((actual / target) * 100));
};

// GET /api/meal-builder/nutrition-score/:planId
const getNutritionScore = async (req, res) => {
  const userId = req.user?.id;
  const { planId } = req.params;

  if (!userId) throw new AppError('User ID not found in token', 401);

  const [plans] = await db.execute(
    `SELECT * FROM meal_plan_history WHERE id = ? AND user_id = ?`,
    [planId, userId]
  );
  const plan = plans[0];

  if (!plan) throw new AppError('Plan not found', 404);

  const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [userId]);
  const user = users[0];

  const targets = calculateTargets(user);

  // Fiber isn't tracked per-meal yet, so estimate roughly from carbs as a placeholder
  const estimatedFiber = (parseFloat(plan.total_carbs_g) || 0) * 0.12;

  const breakdown = {
    protein: { actual: parseFloat(plan.total_protein_g) || 0, target: targets.protein_g, percent: percentOf(plan.total_protein_g, targets.protein_g) },
    carbohydrates: { actual: parseFloat(plan.total_carbs_g) || 0, target: targets.carbs_g, percent: percentOf(plan.total_carbs_g, targets.carbs_g) },
    healthy_fats: { actual: parseFloat(plan.total_fat_g) || 0, target: targets.fat_g, percent: percentOf(plan.total_fat_g, targets.fat_g) },
    fiber: { actual: Math.round(estimatedFiber), target: targets.fiber_g, percent: percentOf(estimatedFiber, targets.fiber_g) },
  };

  const overallScore = Math.round(
    (breakdown.protein.percent + breakdown.carbohydrates.percent + breakdown.healthy_fats.percent + breakdown.fiber.percent) / 4
  );

  return res.json({
    success: true,
    calorie_target: targets.calories,
    calorie_actual: plan.total_calories,
    breakdown,
    overall_score: overallScore,
  });
};

module.exports = { getNutritionScore };