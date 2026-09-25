-- integration_credentials_encrypted holds a base64 string (AES-GCM ciphertext from crypto.ts),
-- not raw bytes. As BYTEA, PostgREST stored/returned it as \x-hex and decrypt() failed on read.
--
-- Guarded because `0001_init.sql` was later corrected to declare the column TEXT outright, which
-- is the shape a fresh replay produces. Unguarded, this then failed the rebuild with
-- `convert_from(text, unknown) does not exist` — the cast only exists for the BYTEA the production
-- database actually had. The conversion still runs where the column is still BYTEA.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shops'
      AND column_name = 'integration_credentials_encrypted'
      AND data_type = 'bytea'
  ) THEN
    ALTER TABLE shops
      ALTER COLUMN integration_credentials_encrypted TYPE text
      USING convert_from(integration_credentials_encrypted, 'UTF8');
  END IF;
END $$;
