import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A software passkey for tests: a real P-256 key producing real WebAuthn
 * responses (attestation "none", ES256 assertions), so the server runs its
 * genuine verification path — no mocks.
 */
export function createSoftAuthenticator(rpId = 'localhost', origin = 'http://localhost:3000') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const rawId = randomBytes(16);
  const id = isoBase64URL.fromBuffer(new Uint8Array(rawId));
  const rpIdHash = createHash('sha256').update(rpId).digest();
  let counter = 0;

  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const b64 = (buf: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(buf));
  const clientData = (type: string, challenge: string, from = origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: from, crossOrigin: false }));

  // COSE EC2 key: kty=EC2, alg=ES256, crv=P-256, x, y.
  const coseKey = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')],
    [-3, Buffer.from(jwk.y!, 'base64url')],
  ]);

  return {
    id,
    /** Answer to `navigator.credentials.create()` for the given options challenge. */
    register(challenge: string) {
      const credIdLength = Buffer.alloc(2);
      credIdLength.writeUInt16BE(rawId.length);
      // Flags: user present, user verified, attested credential data included.
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), u32(counter), Buffer.alloc(16), credIdLength, rawId, Buffer.from(isoCBOR.encode(coseKey))]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never);
      return {
        id,
        rawId: id,
        type: 'public-key' as const,
        response: { clientDataJSON: b64(clientData('webauthn.create', challenge)), attestationObject: b64(attestationObject), transports: ['internal'] },
        clientExtensionResults: {},
      };
    },
    /** Answer to `navigator.credentials.get()`. `origin` can be overridden to simulate a phishing page. */
    authenticate(challenge: string, from = origin) {
      counter += 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), u32(counter)]);
      const cd = clientData('webauthn.get', challenge, from);
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key' as const,
        response: { clientDataJSON: b64(cd), authenticatorData: b64(authData), signature: b64(signature) },
        clientExtensionResults: {},
      };
    },
  };
}
