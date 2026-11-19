const PLACEHOLDER_SECRETS = [
  'your-super-secret-jwt-key',
  'your-api-key-encryption-secret',
  'your-32-character-encryption-key',
  'your-service-to-service-token',
  'change-this-jwt-secret',
  'change-this-api-key-secret',
  'change-this-32-char-encrypt-key!',
  'change-this-service-token',
];

// Preuvid (lot 0) : la liste exacte ci-dessus laissait passer les variantes
// longues des modèles de configuration (par exemple
// « your-super-secret-jwt-key-change-this-in-production », 51 caractères,
// présent dans l'ancien .env.example). On refuse aussi toute valeur qui
// contient un fragment de texte d'exemple, ou qui varie trop peu.
const PLACEHOLDER_FRAGMENTS = [
  'your-', 'your_', 'change-this', 'change_this', 'changeme', 'change-me',
  'replace-me', 'replace_me', 'placeholder', 'example', 'remplacer', 'a-generer',
];

export function isPlaceholderSecret(value: string): boolean {
  if (PLACEHOLDER_SECRETS.includes(value)) return true;
  const lower = value.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((f) => lower.includes(f))) return true;
  // « aaaaaaaa… », « 0000… » : longueur suffisante mais aucune entropie.
  return value.length >= 32 && new Set(value).size < 8;
}

interface Secrets {
  jwtSecret: string;
  apiKeySecret: string;
  encryptionKey: string;
  serviceToken: string;
}

export function validateSecrets(secrets: Secrets): void {
  if (isPlaceholderSecret(secrets.jwtSecret)) {
    throw new Error(
      'JWT_SECRET must be changed from the default value. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
    );
  }

  if (secrets.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long.');
  }

  if (isPlaceholderSecret(secrets.apiKeySecret)) {
    throw new Error(
      'API_KEY_SECRET must be changed from the default value. ' +
      'WARNING: Changing this invalidates all existing API keys.'
    );
  }

  // AES-256 requires a 256-bit (32-byte) key. Hex-encoded = 64 chars, raw = 32 chars.
  const keyBytes = Buffer.byteLength(secrets.encryptionKey, 'utf8');
  if (keyBytes < 32) {
    throw new Error(
      `ENCRYPTION_KEY must be at least 32 bytes (got ${keyBytes}). ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  // Placeholder check: the default value is exactly 32 chars, so the length
  // check above would let it pass. Block it explicitly. Critical when
  // STORAGE_ENCRYPTION=true — files would otherwise be encrypted under a
  // public-string key, re-creating the audit finding the feature was
  // supposed to fix.
  if (isPlaceholderSecret(secrets.encryptionKey)) {
    throw new Error(
      'ENCRYPTION_KEY must be changed from the default value. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (secrets.apiKeySecret.length < 32) {
    throw new Error('API_KEY_SECRET must be at least 32 characters long.');
  }

  if (isPlaceholderSecret(secrets.serviceToken)) {
    throw new Error('SERVICE_TOKEN must be changed from the default value.');
  }

  if (secrets.serviceToken.length < 32) {
    throw new Error('SERVICE_TOKEN must be at least 32 characters long.');
  }
}
