const express = require('express');
const router = express.Router();

const {
  getHealthProfile,
  updateHealthProfile,
} = require('../controllers/healthProfileController');

const authenticateToken = require('../middleware/auth');

router.get('/', authenticateToken, getHealthProfile);
router.put('/', authenticateToken, updateHealthProfile);

module.exports = router;