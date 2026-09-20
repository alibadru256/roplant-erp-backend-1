// Usage: node scripts/hash-password.js "YourChosenPassword"
// Prints a bcrypt hash to paste into db/migrations/002_seed.sql or into an UPDATE statement.
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "YourChosenPassword"');
  process.exit(1);
}

bcrypt.hash(password, 10).then((hash) => {
  console.log(hash);
});
