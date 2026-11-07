// Generates the Ed25519 key that signs ZexCore licence files and writes the private key (as JWK) to stdout.
// Pipe it straight into the Worker secret so it never appears on screen or in shell history:
//   node scripts/gen-license-key.mjs | npx wrangler secret put LICENSE_PRIVATE_JWK
// Run it once. The public half is then served at GET /api/public/license-key.
import { generateKeyPairSync } from 'node:crypto';
const { privateKey } = generateKeyPairSync('ed25519');
const j = privateKey.export({ format: 'jwk' });
process.stdout.write(JSON.stringify({ kty: j.kty, crv: j.crv, d: j.d, x: j.x }));
