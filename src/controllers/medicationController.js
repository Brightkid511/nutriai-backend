const db = require('../config/db');

const parseJsonArraySafely = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
};

const toMedicationResponse = (row) => ({
  id: row.id,
  name: row.name,
  dosage: row.dosage || '',
  times: parseJsonArraySafely(row.times),
  daysOfWeek: row.days_of_week ? parseJsonArraySafely(row.days_of_week) : null,
  startDate: row.start_date,
  endDate: row.end_date,
  notes: row.notes || '',
  active: !!row.active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// GET /api/medications
// Returns all of the user's medications, active ones first.
const getMedications = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const [rows] = await db.execute(
      `SELECT * FROM medications
       WHERE user_id = ?
       ORDER BY active DESC, created_at DESC`,
      [userId]
    );

    return res.json({
      success: true,
      medications: rows.map(toMedicationResponse),
    });
  } catch (error) {
    console.error('Error fetching medications:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch medications',
    });
  }
};

// POST /api/medications
// body: { name, dosage, times: string[], daysOfWeek?: number[], startDate?, endDate?, notes? }
const createMedication = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const {
      name,
      dosage = '',
      times,
      daysOfWeek = null,
      startDate = null,
      endDate = null,
      notes = '',
    } = req.body;

    if (!name || !Array.isArray(times) || times.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'name and a non-empty times array are required',
      });
    }

    const [result] = await db.execute(
      `INSERT INTO medications
       (user_id, name, dosage, times, days_of_week, start_date, end_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        name,
        dosage,
        JSON.stringify(times),
        daysOfWeek ? JSON.stringify(daysOfWeek) : null,
        startDate,
        endDate,
        notes,
      ]
    );

    const [rows] = await db.execute(
      'SELECT * FROM medications WHERE id = ?',
      [result.insertId]
    );

    return res.status(201).json({
      success: true,
      message: 'Medication added successfully',
      medication: toMedicationResponse(rows[0]),
    });
  } catch (error) {
    console.error('Error creating medication:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to create medication',
    });
  }
};

// PUT /api/medications/:id
const updateMedication = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const {
      name,
      dosage = '',
      times,
      daysOfWeek = null,
      startDate = null,
      endDate = null,
      notes = '',
      active = true,
    } = req.body;

    if (!name || !Array.isArray(times) || times.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'name and a non-empty times array are required',
      });
    }

    const [result] = await db.execute(
      `UPDATE medications
       SET name = ?, dosage = ?, times = ?, days_of_week = ?,
           start_date = ?, end_date = ?, notes = ?, active = ?, updated_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [
        name,
        dosage,
        JSON.stringify(times),
        daysOfWeek ? JSON.stringify(daysOfWeek) : null,
        startDate,
        endDate,
        notes,
        active ? 1 : 0,
        id,
        userId,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Medication not found',
      });
    }

    const [rows] = await db.execute(
      'SELECT * FROM medications WHERE id = ?',
      [id]
    );

    return res.json({
      success: true,
      message: 'Medication updated successfully',
      medication: toMedicationResponse(rows[0]),
    });
  } catch (error) {
    console.error('Error updating medication:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to update medication',
    });
  }
};

// DELETE /api/medications/:id
const deleteMedication = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID not found in token',
      });
    }

    const [result] = await db.execute(
      'DELETE FROM medications WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Medication not found',
      });
    }

    return res.json({
      success: true,
      message: 'Medication deleted successfully',
      medicationId: id,
    });
  } catch (error) {
    console.error('Error deleting medication:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to delete medication',
    });
  }
};

module.exports = {
  getMedications,
  createMedication,
  updateMedication,
  deleteMedication,
};