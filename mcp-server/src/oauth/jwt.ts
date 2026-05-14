/**
 * JWT signing and verification for the Audrey TCP OAuth server.
 *
 * Crypto choices:
 *   - RS256 (RSA + SHA-256). PKI-friendly: public key can be published
 *     via JWKS so third parties (and ourselves) verify without sharing
 *     a secret. HS256 would be simpler but couples signing and
 *     verification to the same secret.
 *   - 2048-bit RSA. Standard for OAuth/OIDC at this scale.
 *
 * Key management:
 *   - PRIVATE key lives in env (AUDREY_JWT_PRIVATE_KEY), PEM-encoded.
 *     Set as a Railway secret. Never logged. Never committed.
 *   - PUBLIC key is derived from the private key at boot (jose exports
 *     it via `exportSPKI`). Cached for the process lifetime.
 *   - Key rotation is out-of-scope for Stage A; documented for Stage C.
 *
 * If AUDREY_JWT_PRIVATE_KEY is unset:
 *   - In dev: we generate an ephemeral keypair at boot, log a warning.
 *     Tokens issued during that process are valid only until restart.
 *     Useful for local testing.
 *   - In production (NODE_ENV=production): we PANIC at boot. Refusing
 *     to start beats issuing tokens with a key that disappears.
 */

import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportPKCS8,
  type JWTPayload,
} from 'jose';
import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';

const ALG = 'RS256';

// jose accepts both Web Crypto CryptoKey AND Node's KeyObject. We use
// KeyObject (via node:crypto) because:
//   - It does not have the extractable/non-extractable distinction
//     that Web Crypto enforces (which trips up exportSPKI in some
//     Node 22+ runtimes — observed on node:22-alpine).
//   - createPublicKey() can derive the public key from a private key
//     without any flags needed.
//   - PEM I/O is robust.
type SigningKey = KeyObject;

let signingKeyPromise: Promise<SigningKey> | null = null;
let verificationKeyPromise: Promise<SigningKey> | null = null;
let publicKeyPemCache: string | null = null;

async function loadKeys(): Promise<{ priv: SigningKey; pub: SigningKey; pubPem: string }> {
  const pem = process.env.AUDREY_JWT_PRIVATE_KEY;

  if (pem) {
    // Railway stores secrets without literal newlines; users sometimes
    // paste keys with escaped \n. Normalise both forms.
    const normalised = pem.replace(/\\n/g, '\n');
    // Node's native crypto handles PEM directly with no extractable
    // gotchas. The resulting KeyObject is accepted by jose for both
    // signing (SignJWT.sign) and verification (jwtVerify).
    const priv = createPrivateKey(normalised);
    const pub = createPublicKey(priv);
    const pubPem = pub.export({ type: 'spki', format: 'pem' }) as string;
    return { priv, pub, pubPem };
  }

  // Fallback: ephemeral keypair (dev only)
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUDREY_JWT_PRIVATE_KEY is required in production. Generate one with:\n' +
        "  openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:2048\n" +
        '  cat private.pem  # paste into Railway env var'
    );
  }

  console.error(
    '[audrey-jwt] No AUDREY_JWT_PRIVATE_KEY set — generating EPHEMERAL keypair. ' +
      'Tokens valid only until process restart. DEV ONLY.'
  );
  // For dev fallback we use jose's generateKeyPair, then convert the
  // resulting CryptoKey to a Node KeyObject via PEM round-trip so the
  // rest of the code sees a consistent type.
  const { privateKey } = await generateKeyPair(ALG, { modulusLength: 2048, extractable: true });
  const privPem = await exportPKCS8(privateKey);
  const priv = createPrivateKey(privPem);
  const pub = createPublicKey(priv);
  const pubPem = pub.export({ type: 'spki', format: 'pem' }) as string;
  return { priv, pub, pubPem };
}

async function getSigningKey(): Promise<SigningKey> {
  if (!signingKeyPromise) {
    signingKeyPromise = loadKeys().then(({ priv, pub, pubPem }) => {
      // While we're here, prime the verification side too.
      verificationKeyPromise = Promise.resolve(pub);
      publicKeyPemCache = pubPem;
      return priv;
    });
  }
  return signingKeyPromise;
}

async function getVerificationKey(): Promise<SigningKey> {
  if (!verificationKeyPromise) {
    // Trigger key load (which sets verificationKeyPromise).
    await getSigningKey();
  }
  return verificationKeyPromise!;
}

/**
 * Get the public key in PEM format (SPKI) for JWKS-style publication.
 * Stage B exposes this via /.well-known/jwks.json.
 */
export async function getPublicKeyPem(): Promise<string> {
  if (!publicKeyPemCache) {
    await getSigningKey(); // populates publicKeyPemCache
  }
  return publicKeyPemCache!;
}

// ============================================================
// Access token shape
// ============================================================

export interface AccessTokenClaims extends JWTPayload {
  sub: string;        // user_id (Supabase auth.users.id)
  firm_id: string;
  scope: string;
  client_id: string;
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Mint an access token. `audience` should be this server's MCP URL
 * (e.g. https://audrey-tcp-production.up.railway.app/mcp).
 */
export async function signAccessToken(args: {
  userId: string;
  firmId: string;
  clientId: string;
  scope: string;
  audience: string;
  issuer: string;
}): Promise<{ token: string; expiresIn: number }> {
  const key = await getSigningKey();
  const token = await new SignJWT({
    firm_id: args.firmId,
    scope: args.scope,
    client_id: args.clientId,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(args.userId)
    .setIssuer(args.issuer)
    .setAudience(args.audience)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);

  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verify an access token. Throws on any invalidity. Returns parsed
 * claims on success.
 */
export async function verifyAccessToken(
  token: string,
  expectedAudience: string,
  expectedIssuer: string
): Promise<AccessTokenClaims> {
  const key = await getVerificationKey();
  const { payload } = await jwtVerify(token, key, {
    audience: expectedAudience,
    issuer: expectedIssuer,
    algorithms: [ALG],
  });

  if (typeof payload.sub !== 'string' || typeof payload.firm_id !== 'string') {
    throw new Error('Token missing required claims (sub, firm_id)');
  }

  return payload as AccessTokenClaims;
}

// ============================================================
// Dev-only helper: generate a fresh keypair and print it
// ============================================================

if (process.argv[1]?.endsWith('jwt.ts') || process.argv[1]?.endsWith('jwt.js')) {
  (async () => {
    const { privateKey } = await generateKeyPair(ALG, { modulusLength: 2048 });
    const pem = await exportPKCS8(privateKey);
    console.log(pem);
  })();
}
