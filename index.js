const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const db = require('./src/config/db');
const userRoutes = require('./src/routes/userRoutes');
const mealPlanRoutes = require('./src/routes/mealPlanRoutes');
const foodImageRoutes = require('./src/routes/foodImageRoutes'); 
const nutritionAnalysisRoutes = require('./src/routes/nutritionAnalysisRoutes');
const aiChefRoutes = require('./src/routes/aiChefRoutes');
const healthProfileRoutes = require('./src/routes/healthProfileRoutes');
const medicationRoutes = require('./src/routes/medicationRoutes');
const cycleTrackingRoutes = require('./src/routes/cycleTrackingRoutes');
// ...


dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/users', userRoutes);
app.use('/api/meal-plans', mealPlanRoutes);
app.use('/api/food-images', foodImageRoutes); 
app.use('/api/nutrition-analysis', nutritionAnalysisRoutes);
app.use('/api/ai-chef', aiChefRoutes);
app.use('/api/health-profile', healthProfileRoutes);
app.use('/api/medications', medicationRoutes);
app.use('/api/cycle-tracking', cycleTrackingRoutes);
  
// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'Welcome to NutriAI Backend! Server is running 🚀',
    status: 'OK',
    dbStatus: 'Connected'
  });
});

app.listen(PORT, () => {
  console.log(`NutriAI Backend running on http://localhost:${PORT}`);
});