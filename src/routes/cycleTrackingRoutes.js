const express = require('express');
const router = express.Router();

const {
  getCycleData,
  createLog,
  updateLog,
  deleteLog,
  updateSettings,
} = require('../controllers/cycleTrackingController');

const authenticateToken = require('../middleware/auth');

router.get('/', authenticateToken, getCycleData);
router.post('/logs', authenticateToken, createLog);
router.put('/logs/:id', authenticateToken, updateLog);
router.delete('/logs/:id', authenticateToken, deleteLog);
router.put('/settings', authenticateToken, updateSettings);

module.exports = router;