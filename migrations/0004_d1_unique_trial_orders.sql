CREATE UNIQUE INDEX classroom_desk_payments_provider_order_unique_idx
  ON classroom_desk_payments(provider_order_id)
  WHERE provider_order_id IS NOT NULL;
