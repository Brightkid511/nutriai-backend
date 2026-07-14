const express = require('express');
const router = express.Router();

const { chatWithAiChef } = require('../controllers/aiChefController');
const authenticateToken = require('../middleware/auth');

router.post('/chat', authenticateToken, chatWithAiChef);

module.exports = router;