-- F-48: the Text rule (data-model.md "Text") also rejects Unicode bidirectional
-- control characters: U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069.
-- U+200D (ZWJ, emoji sequences) and other format characters stay allowed.
-- Covers every column that checks is_clean_text: users.display_name,
-- budgets.name, categories.name, webauthn_credentials.name,
-- transactions.payee, transactions.memo.
--
-- Postgres does not re-validate existing rows when a function used by a
-- CHECK changes, so the up section first refuses to run if any existing row
-- would violate the new rule (counts only, never values). Rollback: the down
-- section restores the previous definition (it only loosens the rule).

-- migrate:up

DO $$
DECLARE
  bad bigint;
BEGIN
  SELECT (SELECT count(*) FROM users
           WHERE display_name ~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
       + (SELECT count(*) FROM budgets
           WHERE name ~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
       + (SELECT count(*) FROM categories
           WHERE name ~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
       + (SELECT count(*) FROM webauthn_credentials
           WHERE name ~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
       + (SELECT count(*) FROM transactions
           WHERE payee ~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'
              OR memo ~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
    INTO bad;
  IF bad > 0 THEN
    RAISE EXCEPTION 'F-48: % existing rows contain bidi control characters; clean them before this migration', bad;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION is_clean_text(t text, min_len integer, max_len integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN char_length(t) BETWEEN min_len AND max_len
   AND t IS NFC NORMALIZED
   AND t !~ '^[ \t\n\r  -​　﻿]'
   AND t !~ '[ \t\n\r  -​　﻿]$'
   AND t !~ '[\u0001-\u001f\u007f-\u009f]'
   AND t !~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]';

-- migrate:down

CREATE OR REPLACE FUNCTION is_clean_text(t text, min_len integer, max_len integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN char_length(t) BETWEEN min_len AND max_len
   AND t IS NFC NORMALIZED
   AND t !~ '^[ \t\n\r  -​　﻿]'
   AND t !~ '[ \t\n\r  -​　﻿]$'
   AND t !~ '[\u0001-\u001f\u007f-\u009f]';
