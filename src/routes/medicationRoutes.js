const express = require('express');
const router = express.Router();

const {
  getMedications,
  createMedication,
  updateMedication,
  deleteMedication,
} = require('../controllers/medicationController');

const authenticateToken = require('../middleware/auth');

router.get('/', authenticateToken, getMedications);
router.post('/', authenticateToken, createMedication);
router.put('/:id', authenticateToken, updateMedication);
router.delete('/:id', authenticateToken, deleteMedication);

module.exports = router;