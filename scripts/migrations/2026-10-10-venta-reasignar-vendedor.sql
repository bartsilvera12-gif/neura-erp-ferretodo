-- =============================================================================
-- Reasignar el vendedor de una venta (corrección de Admin).
--
-- Permite que un Admin cambie el usuario (created_by / usuario_nombre) de una
-- venta ya registrada, por ejemplo cuando una venta se hizo con el código de un
-- usuario pero correspondía a otro. Se agregan columnas de auditoría para dejar
-- rastro de quién hizo el cambio y cuándo.
--
-- Schema del tenant de este repo: ferretodo. Aditiva e idempotente.
-- =============================================================================

ALTER TABLE ferretodo.ventas
  ADD COLUMN IF NOT EXISTS vendedor_reasignado_at  timestamptz,
  ADD COLUMN IF NOT EXISTS vendedor_reasignado_por text;
