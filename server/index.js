const { openDatabase, DEFAULT_DB_PATH } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const db = openDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);
const app = createApp(db, { secureCookies: process.env.NODE_ENV === 'production' });

app.listen(PORT, '127.0.0.1', () => {
  console.log(`نظام البطاقات يعمل على http://127.0.0.1:${PORT}`);
});
