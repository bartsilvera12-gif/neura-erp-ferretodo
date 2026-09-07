-- ============================================================================
-- Cuenta corriente entre las empresas del grupo.
--
-- Cada transferencia RECIBIDA genera deuda de quien recibe con quien entrego,
-- por el costo de la mercaderia. La deuda no se guarda: se DERIVA de las
-- transferencias recibidas menos los pagos, para que no pueda quedar
-- desincronizada del stock que efectivamente se movio.
--
-- Aca solo viven los PAGOS. Un pago mueve caja en las dos empresas pero NO es
-- gasto ni ingreso: la mercaderia ya entro al inventario valorizada al costo,
-- asi que contarlo ademas como gasto duplicaria el costo. Es cancelacion de
-- deuda. Los reportes de resultado leen `gastos`, `compras` y `ventas`, nunca
-- caja_movimientos, asi que esto se cumple solo.
--
-- El pago viaja igual que la mercaderia: sale de la caja de quien paga y entra
-- a la de quien cobra cuando esa empresa lo confirma. Los turnos de caja de las
-- dos empresas no coinciden, asi que no se puede imputar de una sola vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS neura_transferencias.pagos_internos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                text NOT NULL UNIQUE,            -- PAG-000001
  empresa_paga_id       uuid NOT NULL,
  schema_paga           text NOT NULL,
  nombre_paga           text NOT NULL,
  empresa_cobra_id      uuid NOT NULL,
  schema_cobra          text NOT NULL,
  nombre_cobra          text NOT NULL,
  monto                 numeric(18,2) NOT NULL CHECK (monto > 0),
  medio_pago            text NOT NULL DEFAULT 'efectivo'
                          CHECK (medio_pago IN ('efectivo','transferencia','tarjeta','otro')),
  estado                text NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente','confirmado','cancelado')),
  observacion           text,
  creado_at             timestamptz NOT NULL DEFAULT now(),
  creado_por_id         uuid,
  creado_por_nombre     text,
  confirmado_at         timestamptz,
  confirmado_por_id     uuid,
  confirmado_por_nombre text,
  cancelado_at          timestamptz,
  cancelado_por_nombre  text,
  cancelado_motivo      text,
  CONSTRAINT chk_pag_empresas_distintas CHECK (empresa_paga_id <> empresa_cobra_id)
);

CREATE INDEX IF NOT EXISTS ix_pag_paga  ON neura_transferencias.pagos_internos (empresa_paga_id, estado, creado_at DESC);
CREATE INDEX IF NOT EXISTS ix_pag_cobra ON neura_transferencias.pagos_internos (empresa_cobra_id, estado, creado_at DESC);

CREATE SEQUENCE IF NOT EXISTS neura_transferencias.pago_interno_numero_seq;

CREATE OR REPLACE FUNCTION neura_transferencias.siguiente_numero_pago()
RETURNS text LANGUAGE sql AS $$
  SELECT 'PAG-' || LPAD(nextval('neura_transferencias.pago_interno_numero_seq')::text, 6, '0');
$$;

GRANT ALL ON ALL TABLES IN SCHEMA neura_transferencias TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA neura_transferencias TO postgres, service_role;
