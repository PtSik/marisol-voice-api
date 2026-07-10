-- integration_credentials_encrypted holds a base64 string (AES-GCM ciphertext from crypto.ts),
-- not raw bytes. As BYTEA, PostgREST stored/returned it as \x-hex and decrypt() failed on read.
ALTER TABLE shops
  ALTER COLUMN integration_credentials_encrypted TYPE text
  USING convert_from(integration_credentials_encrypted, 'UTF8');
