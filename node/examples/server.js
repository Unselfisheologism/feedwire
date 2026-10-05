const express = require('express');
const { feedback } = require('../index');
const app = express();
app.use(feedback({ dbPath: process.env.FEEDBACK_DB || 'feedback.db', adminToken: process.env.FEEDBACK_ADMIN_TOKEN }));
app.get('/users', (req, res) => res.json([]));
app.listen(process.env.PORT || 3000, () => console.log('listening'));
