import 'dotenv/config';

/** Reads a required environment variable or fails fast with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
