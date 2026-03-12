-- Add personal_amount column to transactions
-- When set, totals/charts use this value instead of amount.
-- Account balance always uses amount (bank reconciliation stays accurate).
-- personal_amount = 0 means fully ignored from totals.
-- personal_amount = NULL means use the original amount (default behavior).

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS personal_amount numeric(14,2) DEFAULT NULL;
