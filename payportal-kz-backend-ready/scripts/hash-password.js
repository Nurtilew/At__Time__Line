const readline = require('node:readline');
const bcrypt = require('bcryptjs');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Enter a strong admin password (not your bank password): ', async (password) => {
  rl.close();
  if (!password || password.length < 12 || password.length > 72 || Buffer.byteLength(password, 'utf8') > 72) {
    console.error('Use 12–72 characters, and no more than 72 UTF-8 bytes.');
    process.exitCode = 1;
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  console.log('\nPut this in .env as ADMIN_PASSWORD_HASH=');
  console.log(hash);
});
