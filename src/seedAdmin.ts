import bcrypt from 'bcryptjs';
import { pool } from './db';

const MIN_PASSWORD_LENGTH = 10;

async function main(): Promise<void> {
  const [username, password] = process.argv.slice(2);

  if (!username || !password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`usage: npm run seed-admin <user> <password (${MIN_PASSWORD_LENGTH}+ chars)>`);
    process.exitCode = 1;
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
    [username, hash],
  );

  console.log(`Admin "${username}" saved.`);
}

main()
  .catch((err) => {
    console.error('Failed to seed admin:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
