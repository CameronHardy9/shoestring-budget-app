-- Budgets (tenants), members, invitations, categories, plan entries,
-- transactions and splits. Source of truth: docs/contracts/data-model.md,
-- ADR-0004 (budgeting), ADR-0005 (money and time), ADR-0006 and ADR-0010.
-- Every budget-owned row carries budget_id; children reference parents with
-- composite FKs that include budget_id, so a row can never point at another
-- budget's data.

-- migrate:up

CREATE TYPE member_role AS ENUM ('owner', 'member');
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'declined', 'revoked');
CREATE TYPE category_kind AS ENUM ('expense', 'income');
CREATE TYPE transaction_direction AS ENUM ('outflow', 'inflow');

-- version increments by exactly 1 on every update (data-model.md "Versioning").
-- The DAL still checks "WHERE version = $expected"; this trigger makes the
-- increment itself impossible to get wrong.
CREATE FUNCTION bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- budgets
CREATE TABLE budgets (
  id         uuid        PRIMARY KEY,
  name       text        NOT NULL,                                -- Sensitive
  timezone   text        NOT NULL,
  currency   char(3)     NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version    integer     NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  CONSTRAINT budgets_name_check CHECK (is_clean_text(name, 1, 60)),
  -- IANA names are validated by the API; this only bounds the shape.
  CONSTRAINT budgets_timezone_check CHECK (timezone ~ '^[A-Za-z0-9_+/-]{1,64}$'),
  CONSTRAINT budgets_currency_check CHECK (currency = 'USD'),
  CONSTRAINT budgets_version_check CHECK (version >= 1)
);
CREATE INDEX budgets_deleted_at_idx ON budgets (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TRIGGER budgets_bump_version BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------- members
CREATE TABLE budget_members (
  budget_id  uuid        NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       member_role NOT NULL,
  joined_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT budget_members_pkey PRIMARY KEY (budget_id, user_id)
);
CREATE INDEX budget_members_user_id_idx ON budget_members (user_id);
-- At most one owner per budget (checked per statement: demote before promote).
CREATE UNIQUE INDEX budget_members_one_owner_key ON budget_members (budget_id) WHERE role = 'owner';

-- At least one owner per non-deleted budget, checked at commit.
CREATE FUNCTION check_budget_has_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b uuid;
BEGIN
  IF TG_TABLE_NAME = 'budgets' THEN
    b := NEW.id;
  ELSE
    b := OLD.budget_id;
  END IF;
  IF EXISTS (SELECT 1 FROM budgets WHERE id = b AND deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM budget_members WHERE budget_id = b AND role = 'owner') THEN
    RAISE EXCEPTION 'budget has no owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'budget_members_owner_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER budgets_owner_required
  AFTER INSERT OR UPDATE OF deleted_at ON budgets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_budget_has_owner();
CREATE CONSTRAINT TRIGGER budget_members_owner_required
  AFTER UPDATE OR DELETE ON budget_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_budget_has_owner();

-- ---------------------------------------------------------------- invitations
CREATE TABLE budget_invitations (
  id                 uuid              PRIMARY KEY,
  budget_id          uuid              NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  email              citext            NOT NULL,                  -- PII
  invited_by_user_id uuid              REFERENCES users (id) ON DELETE SET NULL,
  status             invitation_status NOT NULL DEFAULT 'pending',
  created_at         timestamptz       NOT NULL,
  updated_at         timestamptz       NOT NULL,
  expires_at         timestamptz       NOT NULL,
  responded_at       timestamptz,
  accepted_user_id   uuid              REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT budget_invitations_email_check CHECK (is_valid_email(email)),
  CONSTRAINT budget_invitations_expiry_check CHECK (expires_at = created_at + interval '14 days'),
  CONSTRAINT budget_invitations_responded_check CHECK ((status = 'pending') = (responded_at IS NULL)),
  CONSTRAINT budget_invitations_accepted_user_check CHECK (status = 'accepted' OR accepted_user_id IS NULL)
);
CREATE UNIQUE INDEX budget_invitations_pending_email_key ON budget_invitations (budget_id, email)
  WHERE status = 'pending';
-- "my invitations" and the per-invitee pending limit
CREATE INDEX budget_invitations_pending_by_email_idx ON budget_invitations (email, created_at DESC)
  WHERE status = 'pending';
CREATE INDEX budget_invitations_budget_idx ON budget_invitations (budget_id, created_at DESC);

-- ---------------------------------------------------------------- categories
CREATE TABLE categories (
  id          uuid          PRIMARY KEY,
  budget_id   uuid          NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  name        text          NOT NULL,                             -- Sensitive
  kind        category_kind NOT NULL,
  sort_order  integer       NOT NULL,
  archived_at timestamptz,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  version     integer       NOT NULL DEFAULT 1,
  CONSTRAINT categories_budget_id_id_key UNIQUE (budget_id, id),   -- target of composite FKs
  CONSTRAINT categories_name_check CHECK (is_clean_text(name, 1, 40)),
  CONSTRAINT categories_sort_order_check CHECK (sort_order BETWEEN 0 AND 10000),
  CONSTRAINT categories_version_check CHECK (version >= 1)
);
-- Archived names stay reserved.
CREATE UNIQUE INDEX categories_budget_name_key ON categories (budget_id, lower(name));
CREATE TRIGGER categories_bump_version BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE FUNCTION forbid_category_kind_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'category kind is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'categories_kind_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER categories_kind_immutable BEFORE UPDATE OF kind ON categories
  FOR EACH ROW EXECUTE FUNCTION forbid_category_kind_change();

-- ---------------------------------------------------------------- plan entries
CREATE TABLE plan_entries (
  id                 uuid        PRIMARY KEY,
  budget_id          uuid        NOT NULL,
  category_id        uuid        NOT NULL,
  month              date        NOT NULL,
  amount_cents       bigint      NOT NULL,                        -- Sensitive
  updated_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  version            integer     NOT NULL DEFAULT 1,
  CONSTRAINT plan_entries_category_fkey FOREIGN KEY (budget_id, category_id)
    REFERENCES categories (budget_id, id) ON DELETE CASCADE,
  CONSTRAINT plan_entries_category_month_key UNIQUE (category_id, month),
  CONSTRAINT plan_entries_month_check CHECK (
    extract(day FROM month) = 1 AND month BETWEEN DATE '2000-01-01' AND DATE '2099-12-01'
  ),
  CONSTRAINT plan_entries_amount_check CHECK (amount_cents BETWEEN 0 AND 100000000),
  CONSTRAINT plan_entries_version_check CHECK (version >= 1)
);
CREATE INDEX plan_entries_budget_month_idx ON plan_entries (budget_id, month);
CREATE TRIGGER plan_entries_bump_version BEFORE UPDATE ON plan_entries
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------- transactions
CREATE TABLE transactions (
  id                 uuid                  PRIMARY KEY,           -- UUIDv7
  budget_id          uuid                  NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  date               date                  NOT NULL,
  direction          transaction_direction NOT NULL,
  amount_cents       bigint                NOT NULL,              -- Sensitive
  payee              text,                                        -- Sensitive
  memo               text,                                        -- Sensitive
  created_by_user_id uuid                  REFERENCES users (id) ON DELETE SET NULL,
  updated_by_user_id uuid                  REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz           NOT NULL,
  updated_at         timestamptz           NOT NULL,
  version            integer               NOT NULL DEFAULT 1,
  deleted_at         timestamptz,
  CONSTRAINT transactions_budget_id_id_key UNIQUE (budget_id, id), -- target of composite FKs
  CONSTRAINT transactions_date_check CHECK (date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'),
  CONSTRAINT transactions_amount_check CHECK (amount_cents BETWEEN 1 AND 100000000),
  CONSTRAINT transactions_payee_check CHECK (payee IS NULL OR is_clean_text(payee, 1, 100)),
  CONSTRAINT transactions_memo_check CHECK (memo IS NULL OR is_clean_text(memo, 1, 500)),
  CONSTRAINT transactions_version_check CHECK (version >= 1)
);
-- Transaction list (newest first, keyset) and the month-summary date range.
CREATE INDEX transactions_list_idx ON transactions (budget_id, date DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX transactions_deleted_at_idx ON transactions (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TRIGGER transactions_bump_version BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------- splits
CREATE TABLE transaction_splits (
  id             uuid        PRIMARY KEY,
  budget_id      uuid        NOT NULL,
  transaction_id uuid        NOT NULL,
  category_id    uuid        NOT NULL,
  amount_cents   bigint      NOT NULL,                            -- Sensitive
  created_at     timestamptz NOT NULL,
  CONSTRAINT transaction_splits_transaction_fkey FOREIGN KEY (budget_id, transaction_id)
    REFERENCES transactions (budget_id, id) ON DELETE CASCADE,
  -- Deferred NO ACTION rather than RESTRICT: a budget hard delete cascades to
  -- categories and to transactions -> splits as separate internal statements,
  -- so RESTRICT (or an immediate NO ACTION) would fail on the categories
  -- cascade before the splits are gone. The DAL's deleteCategory sets this
  -- constraint IMMEDIATE, so a direct category delete still fails at once with
  -- SQLSTATE 23503 (-> CATEGORY_IN_USE), exactly like RESTRICT.
  CONSTRAINT transaction_splits_category_fkey FOREIGN KEY (budget_id, category_id)
    REFERENCES categories (budget_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  -- Also serves as the (transaction_id) index.
  CONSTRAINT transaction_splits_transaction_category_key UNIQUE (transaction_id, category_id),
  CONSTRAINT transaction_splits_amount_check CHECK (amount_cents BETWEEN 1 AND 100000000)
);
CREATE INDEX transaction_splits_budget_category_idx ON transaction_splits (budget_id, category_id);

-- Every transaction has 1..20 splits summing exactly to its amount, checked at
-- commit (the API checks first and answers SPLITS_DO_NOT_SUM; this is the
-- backstop). The message never contains amounts.
CREATE FUNCTION check_transaction_splits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t uuid;
  parent_amount bigint;
  n integer;
  total numeric;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    t := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    t := OLD.transaction_id;
  ELSE
    t := NEW.transaction_id;
  END IF;

  SELECT amount_cents INTO parent_amount FROM transactions WHERE id = t;
  IF NOT FOUND THEN
    RETURN NULL; -- the transaction itself was deleted
  END IF;

  SELECT count(*), coalesce(sum(amount_cents), 0) INTO n, total
    FROM transaction_splits WHERE transaction_id = t;
  IF n < 1 OR n > 20 OR total <> parent_amount THEN
    RAISE EXCEPTION 'transaction splits do not sum to the transaction amount or count is outside 1..20'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transaction_splits_sum';
  END IF;

  -- A split moved to another transaction must leave the old one valid too.
  -- (Nested IFs: PL/pgSQL resolves every field of a combined condition, and
  -- OLD.transaction_id does not exist when this fires for `transactions`.)
  IF TG_TABLE_NAME = 'transaction_splits' AND TG_OP = 'UPDATE' THEN
    IF OLD.transaction_id IS DISTINCT FROM NEW.transaction_id THEN
      SELECT amount_cents INTO parent_amount FROM transactions WHERE id = OLD.transaction_id;
      IF FOUND THEN
        SELECT count(*), coalesce(sum(amount_cents), 0) INTO n, total
          FROM transaction_splits WHERE transaction_id = OLD.transaction_id;
        IF n < 1 OR n > 20 OR total <> parent_amount THEN
          RAISE EXCEPTION 'transaction splits do not sum to the transaction amount or count is outside 1..20'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'transaction_splits_sum';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER transaction_splits_sum
  AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_splits();
-- On insert too: a transaction without splits must not commit.
CREATE CONSTRAINT TRIGGER transactions_splits_sum
  AFTER INSERT OR UPDATE OF amount_cents ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_splits();

-- migrate:down
-- Tables before the trigger functions they use.
DROP TABLE transaction_splits;
DROP TABLE transactions;
DROP FUNCTION check_transaction_splits();
DROP TABLE plan_entries;
DROP TABLE categories;
DROP FUNCTION forbid_category_kind_change();
DROP TABLE budget_invitations;
DROP TABLE budget_members;
DROP TABLE budgets;
DROP FUNCTION check_budget_has_owner();
DROP FUNCTION bump_version();
DROP TYPE transaction_direction;
DROP TYPE category_kind;
DROP TYPE invitation_status;
DROP TYPE member_role;
