const express = require('express');
const router = express.Router();
const {
  getPersonalPlans,
  createPersonalPlan,
  updatePersonalPlan,
  deletePersonalPlan,
} = require('../controllers/mealPlanController');

const authenticateToken = require('../middleware/auth');

// Personal (user-authored) meal plans - built via the Planner screen.
// The old AI "generate a whole week at once" endpoint has been removed
// in favor of the Meal Builder's choice-based flow (see mealBuilderRoutes).
router.get('/personal', authenticateToken, getPersonalPlans);
router.post('/personal', authenticateToken, createPersonalPlan);
router.put('/personal/:id', authenticateToken, updatePersonalPlan);
router.delete('/personal/:id', authenticateToken, deletePersonalPlan);

module.exports = router;