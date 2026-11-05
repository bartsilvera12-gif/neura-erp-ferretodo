-- ============================================================================
-- Solicitudes de CAMBIO DE COSTO (Ferretodo). ADITIVA E IDEMPOTENTE.
--
-- Regla de negocio: un usuario NO admin no puede modificar el precio de costo
-- (costo_promedio) de un producto que YA existe. El costo solo se carga en el
-- alta del producto y al ingresar mercadería del proveedor (Compras). Si luego
-- hace falta cambiarlo por cualquier motivo, se crea una SOLICITUD pendiente y
-- el admin la APRUEBA (recién ahí se aplica el nuevo costo) o la RECHAZA.
--
-- Se reutiliza la tabla ferretodo.solicitudes_ajuste_stock agregándole una
-- "clase" (stock | costo) y los campos de costo anterior/nuevo. Así el panel de
-- aprobación del admin muestra ambos tipos de solicitud en un solo lugar.
-- ============================================================================

-- clase: distingue solicitudes de ajuste de stock ('stock') de cambios de costo ('costo').
ALTER TABLE ferretodo.solicitudes_ajuste_stock
  ADD COLUMN IF NOT EXISTS clase text NOT NULL DEFAULT 'stock';

ALTER TABLE ferretodo.solicitudes_ajuste_stock
  ADD COLUMN IF NOT EXISTS costo_anterior numeric;

ALTER TABLE ferretodo.solicitudes_ajuste_stock
  ADD COLUMN IF NOT EXISTS costo_nuevo numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ferretodo.solicitudes_ajuste_stock'::regclass
       AND conname  = 'solicitudes_ajuste_stock_clase_check'
  ) THEN
    ALTER TABLE ferretodo.solicitudes_ajuste_stock
      ADD CONSTRAINT solicitudes_ajuste_stock_clase_check
      CHECK (clase IN ('stock','costo'));
  END IF;
END $$;

-- Las solicitudes de costo no mueven stock: tipo/cantidad dejan de ser
-- obligatorias para no forzar valores artificiales. (La columna cantidad era
-- NOT NULL; se relaja porque una solicitud de costo no tiene cantidad.)
ALTER TABLE ferretodo.solicitudes_ajuste_stock
  ALTER COLUMN cantidad DROP NOT NULL;

ALTER TABLE ferretodo.solicitudes_ajuste_stock
  ALTER COLUMN tipo DROP NOT NULL;

GRANT ALL ON TABLE ferretodo.solicitudes_ajuste_stock
  TO anon, authenticated, service_role, postgres;
