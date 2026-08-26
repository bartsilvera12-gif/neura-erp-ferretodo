-- ============================================================================
-- Ferretodo: comisiones flexibles + control de pago.
--
-- Por defecto la comision es 5% sobre la ganancia. Esta tabla permite,
-- por VENDEDOR y por MES, dos cosas que pidio el cliente:
--   1) cambiar la regla: otro porcentaje o un MONTO FIJO.
--   2) controlar el pago: retenida / liberada / pagada.
--
-- Si no hay fila para un vendedor+mes, se usa el 5% por defecto y estado
-- 'retenida'. Aditiva e idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ferretodo.comision_periodo_vendedor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL,
  -- Se guarda el nombre porque el calculo agrupa por ventas.usuario_nombre.
  vendedor     text NOT NULL,
  -- Mes del periodo en formato YYYY-MM (ej. '2026-08').
  periodo      text NOT NULL CHECK (periodo ~ '^\d{4}-\d{2}$'),
  tipo         text NOT NULL DEFAULT 'porcentaje'
                 CHECK (tipo IN ('porcentaje', 'monto_fijo')),
  -- porcentaje: 5 = 5% de la ganancia. monto_fijo: importe en Gs.
  valor        numeric(14,2) NOT NULL DEFAULT 5 CHECK (valor >= 0),
  estado       text NOT NULL DEFAULT 'retenida'
                 CHECK (estado IN ('retenida', 'liberada', 'pagada')),
  observacion  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_comision_periodo_vendedor UNIQUE (empresa_id, vendedor, periodo)
);

CREATE INDEX IF NOT EXISTS ix_comision_periodo_vendedor_emp
  ON ferretodo.comision_periodo_vendedor (empresa_id, periodo);

COMMENT ON TABLE ferretodo.comision_periodo_vendedor IS
  'Override de comision por vendedor y mes (porcentaje o monto fijo) + estado de pago. Sin fila = 5% y retenida.';

NOTIFY pgrst, 'reload schema';
