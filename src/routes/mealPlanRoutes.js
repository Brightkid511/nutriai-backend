const express = require('express');
const router = express.Router();
const {
  generateMealPlan,
  getMealPlans,
  getPersonalPlans,
  createPersonalPlan,
  updatePersonalPlan,
  deletePersonalPlan
} = require('../controllers/mealPlanController');

const authenticateToken = require('../middleware/auth');

// Get all meal plans
router.get('/', authenticateToken, getMealPlans);

// Get user's personal/custom meal plans
router.get('/personal', authenticateToken, getPersonalPlans);

// Create new personal meal plan
router.post('/personal', authenticateToken, createPersonalPlan);

// Update existing personal meal plan
router.put('/personal/:id', authenticateToken, updatePersonalPlan);

// Delete personal meal plan
router.delete('/personal/:id', authenticateToken, deletePersonalPlan);

// Generate new AI meal plan
router.post('/generate', authenticateToken, generateMealPlan);



module.exports = router;