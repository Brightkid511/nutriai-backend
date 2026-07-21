const db = require('../config/db');
const AppError = require('../utils/AppError');

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
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

  const [rows] = await db.execute(
    `SELECT * FROM medications WHERE user_id = ? ORDER BY active DESC, created_at DESC`,
    [userId]
  );

  return res.json({ success: true, medications: rows.map(toMedicationResponse) });
};

// POST /api/medications
// body: { name, dosage, times: string[], daysOfWeek?: number[], startDate?, endDate?, notes? }
const createMedication = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new AppError('User ID not found in token', 401);

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
    throw new AppError('name and a non-empty times array are required', 400);
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

  const [rows] = await db.execute('SELECT * FROM medications WHERE id = ?', [result.insertId]);

  return res.status(201).json({
    success: true,
    message: 'Medication added successfully',
    medication: toMedicationResponse(rows[0]),
  });
};

// PUT /api/medications/:id
const updateMedication = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;

  if (!userId) throw new AppError('User ID not found in token', 401);

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
    throw new AppError('name and a non-empty times array are required', 400);
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
    throw new AppError('Medication not found', 404);
  }

  const [rows] = await db.execute('SELECT * FROM medications WHERE id = ?', [id]);

  return res.json({
    success: true,
    message: 'Medication updated successfully',
    medication: toMedicationResponse(rows[0]),
  });
};

// DELETE /api/medications/:id
const deleteMedication = async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;

  if (!userId) throw new AppError('User ID not found in token', 401);

  const [result] = await db.execute(
    'DELETE FROM medications WHERE id = ? AND user_id = ?',
    [id, userId]
  );

  if (result.affectedRows === 0) {
    throw new AppError('Medication not found', 404);
  }

  return res.json({ success: true, message: 'Medication deleted successfully', medicationId: id });
};

module.exports = {
  getMedications,
  createMedication,
  updateMedication,
  deleteMedication,
};