-- Sign-in codes now go to the email address and, when the account has one,
-- the mobile number. Records which channels the current code reached.
ALTER TABLE "login_otps" ADD COLUMN "channels" VARCHAR(10)[] DEFAULT ARRAY[]::VARCHAR(10)[];

-- Store mobile numbers in E.164 (+919876543210) so they can be texted. Only
-- formatting is removed, and only where the result is a valid international
-- number; anything else (e.g. saved without a country code) is left as it was.
UPDATE "users"
SET "phone" = regexp_replace("phone", '[\s().-]', '', 'g')
WHERE "phone" IS NOT NULL
  AND "phone" <> regexp_replace("phone", '[\s().-]', '', 'g')
  AND regexp_replace("phone", '[\s().-]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$';
