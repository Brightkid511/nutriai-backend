const express = require('express');
const router = express.Router();

const { getFoodImage } = require('../controllers/foodImageController');

// Get a real food photo URL for a given dish name
// No auth needed — this just returns a public stock photo URL, not user data.
router.get('/', getFoodImage);

module.exports = router;