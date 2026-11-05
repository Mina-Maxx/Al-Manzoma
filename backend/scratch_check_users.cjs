const mongoose = require('mongoose');

async function run() {
  await mongoose.connect('mongodb://localhost:27017/quarryvault');
  const users = await mongoose.connection.db.collection('users').find({}).toArray();
  for (const u of users) {
    console.log(`User: ${u.username} | Email: ${u.email} | Status: ${u.status} | mustChange: ${u.must_change_password} | hasHash: ${!!u.password_hash}`);
  }
  process.exit(0);
}
run();
