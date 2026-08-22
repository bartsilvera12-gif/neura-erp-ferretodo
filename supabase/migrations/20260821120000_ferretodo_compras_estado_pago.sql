-- ============================================================================
-- Estado de PAGO en compras (Ferretodo). ADITIVA E IDEMPOTENTE.
-- Solo schema ferretodo (mono-sucursal).
--
-- Que agrega (feature "Marcar como pagada" una compra a credito):
--   * estado_pago            -> 'pendiente' (default) | 'pagada'. Una compra a
--     credito arranca 'pendiente' y el usuario la marca 'pagada' cuando la salda.
--     Las compras 'pagada' dejan de contar como deuda/vencida con proveedores.
--   * pagada_at              -> timestamp del momento en que se marco pagada.
--   * pago_caja_movimiento_id-> id del egreso en caja_movimientos si el pago se
--     descontó de la caja abierta (NULL si no se descontó de caja).
--
-- Aplica a TODAS las filas de una compra (comparten numero_control): el endpoint
-- de pago actualiza todas juntas.
--
-- Todo ADD COLUMN IF NOT EXISTS: aditivo, no borra ni cambia columnas existentes.
-- ============================================================================

ALTER TABLE ferretodo.compras
  ADD COLUMN IF NOT EXISTS estado_pago text NOT NULL DEFAULT 'pendiente'
  CHECK (estado_pago IN ('pendiente','pagada'));

ALTER TABLE ferretodo.compras
  ADD COLUMN IF NOT EXISTS pagada_at timestamptz;

ALTER TABLE ferretodo.compras
  ADD COLUMN IF NOT EXISTS pago_caja_movimiento_id uuid;

COMMENT ON COLUMN ferretodo.compras.estado_pago IS
  'Estado del pago de la compra: pendiente (default) | pagada. Las compras a credito pagadas dejan de figurar como deuda/vencida con proveedores.';
COMMENT ON COLUMN ferretodo.compras.pagada_at IS
  'Momento en que la compra se marco como pagada (NULL mientras esta pendiente).';
COMMENT ON COLUMN ferretodo.compras.pago_caja_movimiento_id IS
  'Id del egreso en caja_movimientos generado al pagar descontando de caja (NULL si el pago no se descontó de caja).';
