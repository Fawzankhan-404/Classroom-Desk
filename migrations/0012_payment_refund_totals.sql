-- Preserve cumulative provider refund totals. This additive column does not
-- change existing payment or entitlement state.
ALTER TABLE classroom_desk_payments ADD COLUMN amount_refunded_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_paise >= 0 AND amount_refunded_paise <= amount_paise);

-- Older releases represented full refunds only with status='refunded'. Preserve
-- that known full amount when introducing the cumulative refund column.
UPDATE classroom_desk_payments
SET amount_refunded_paise = amount_paise
WHERE status = 'refunded' AND amount_refunded_paise = 0;
