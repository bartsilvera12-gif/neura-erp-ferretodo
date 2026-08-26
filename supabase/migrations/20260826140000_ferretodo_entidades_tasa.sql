-- ============================================================================
-- Ferretodo: tasa (arancel) por entidad de cobro.
--
-- Las tarjetas/POS descuentan un porcentaje de cada cobro. Guardando la tasa en
-- la entidad se puede mostrar, en conciliacion, cuanto se cobro (bruto), cuanto
-- se lleva la tarjeta (comision) y cuanto entra realmente (neto).
--
-- 0 = sin arancel (efectivo, transferencias sin costo, etc.). Aditiva.
-- ============================================================================

ALTER TABLE ferretodo.entidades_bancarias
  ADD COLUMN IF NOT EXISTS tasa_porcentaje numeric(5,2) NOT NULL DEFAULT 0
  CHECK (tasa_porcentaje >= 0 AND tasa_porcentaje <= 100);

COMMENT ON COLUMN ferretodo.entidades_bancarias.tasa_porcentaje IS
  'Arancel que descuenta la entidad por cobro, en % (ej. 4.50). 0 = sin costo.';

NOTIFY pgrst, 'reload schema';
