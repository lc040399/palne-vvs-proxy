#!/usr/bin/env node
import bcrypt from 'bcryptjs';

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  console.error('');
  console.error('Outputs a bcrypt hash you can paste into APP_USERS as');
  console.error('"password_hash" (replacing "password").');
  process.exit(1);
}

const SALT_ROUNDS = 10;
const hash = bcrypt.hashSync(password, SALT_ROUNDS);

console.log(hash);
