const express = require('express');
const router = express.Router();

const {
  suggestMeals,
  replaceSuggestion,
  selectMeal,
  getSelectedMeals,
  savePlan,
  getPlanHistory,
  autoFillWeek,
  confirmWeek,
} = require('../controllers/mealBuilderController');

const { getShoppingList, regenerateShoppingList } = require('../controllers/shoppingListController');
const { getNutritionScore } = require('../controllers/nutritionScoreController');
const { getWeeklyProgress } = require('../controllers/weeklyProgressController');

const authenticateToken = require('../middleware/auth');

// Meal suggestion routes
router.post('/suggest', authenticateToken, suggestMeals);
router.post('/suggest/:id/replace', authenticateToken, replaceSuggestion);
router.post('/select', authenticateToken, selectMeal);
router.get('/selected', authenticateToken, getSelectedMeals);
router.post('/save', authenticateToken, savePlan);
router.get('/history', authenticateToken, getPlanHistory);

// Weekly planning
router.post('/auto-fill-week', authenticateToken, autoFillWeek);
router.post('/confirm-week', authenticateToken, confirmWeek);

// Shopping & analytics
router.get('/shopping-list/:planId', authenticateToken, getShoppingList);
router.post('/shopping-list/:planId/regenerate', authenticateToken, regenerateShoppingList);
router.get('/nutrition-score/:planId', authenticateToken, getNutritionScore);
router.get('/weekly-progress', authenticateToken, getWeeklyProgress);

module.exports = router;