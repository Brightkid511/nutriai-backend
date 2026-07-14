const express = require('express');
const router = express.Router();

const {
  getNutritionAnalysis,
  generateNutritionAnalysis,
} = require('../controllers/nutritionAnalysisController');

const authenticateToken = require('../middleware/auth');

// Get cached analysis, or generate one if none exists yet
router.get('/', authenticateToken, getNutritionAnalysis);

// Force a fresh analysis (e.g. "Refresh" button after editing meal plans)
router.post('/generate', authenticateToken, generateNutritionAnalysis);

module.exports = router;