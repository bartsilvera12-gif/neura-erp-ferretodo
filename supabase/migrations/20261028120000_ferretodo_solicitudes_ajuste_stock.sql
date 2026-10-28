-- ============================================================================
-- Solicitudes de ajuste de stock (Ferretodo). ADITIVA E IDEMPOTENTE.
--
-- Flujo de autorización: cuando un usuario NO admin quiere modificar el stock
-- (entrada / salida / ajuste manual), no se aplica directo: se crea una SOLICITUD
-- pendiente y le llega una notificación al admin, que puede APROBAR (recién ahí
-- se aplica el movimiento y se actualiza el stock) o RECHAZAR. El admin modifica
-- stock directo, sin solicitud.
--
-- Se accede por el pool (postgres), igual que compras/transferencias.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ferretodo.solicitudes_ajuste_stock (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid NOT NULL,
  producto_id           uuid NOT NULL,
  producto_nombre       text,
  producto_sku          text,
  tipo                  text NOT NULL,                      -- ENTRADA | SALIDA | AJUSTE
  cantidad              numeric NOT NULL,                   -- abs para E/S, con signo para AJUSTE
  origen                text NOT NULL DEFAULT 'ajuste_manual',
  costo_unitario        numeric NOT NULL DEFAULT 0,
  motivo                text,
  estado                text NOT NULL DEFAULT 'pendiente',  -- pendiente | aprobada | rechazada
  solicitado_por        uuid,
  solicitado_por_nombre text,
  resuelto_por          uuid,
  resuelto_por_nombre   text,
  resuelto_motivo       text,
  resuelto_at           timestamptz,
  movimiento_id         uuid,                               -- movimiento creado al aprobar
  created_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ferretodo.solicitudes_ajuste_stock'::regclass
       AND conname  = 'solicitudes_ajuste_stock_estado_check'
  ) THEN
    ALTER TABLE ferretodo.solicitudes_ajuste_stock
      ADD CONSTRAINT solicitudes_ajuste_stock_estado_check
      CHECK (estado IN ('pendiente','aprobada','rechazada'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS solicitudes_ajuste_stock_pend_idx
  ON ferretodo.solicitudes_ajuste_stock (empresa_id, estado, created_at DESC);

GRANT ALL ON TABLE ferretodo.solicitudes_ajuste_stock
  TO anon, authenticated, service_role, postgres;
