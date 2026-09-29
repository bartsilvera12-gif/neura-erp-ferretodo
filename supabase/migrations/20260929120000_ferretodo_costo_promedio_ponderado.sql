-- ============================================================================
-- Costo Promedio Ponderado (CPP) en compras — Ferretodo. ADITIVA E IDEMPOTENTE.
-- Solo schema ferretodo (mono-sucursal).
--
-- Contexto: al registrar una compra, el costo interno del producto
-- (productos.costo_promedio) debe calcularse como promedio ponderado móvil
-- entre lo que había en stock y la nueva compra, en lugar de reemplazarse por
-- el último costo. El importe REAL de la factura (compras.costo_unitario /
-- costo_unitario_original) NO se toca: el promedio es solo costo interno para
-- inventario, rentabilidad y cálculo de precios.
--
-- Esta migración NO cambia lógica; solo crea las tablas de soporte:
--   1) producto_costo_base    -> "línea base" (stock + costo) del producto ANTES
--      de su primera compra registrada (Opción A). Punto de partida para
--      reconstruir el CPP cuando se anula una compra (Etapa 2).
--   2) producto_costo_historial -> auditoría del CPP en cada compra (y recálculos):
--      costo/cantidad anterior, costo/cantidad de la nueva compra, nuevo
--      promedio, factura (numero_control) + proveedor, fecha y usuario.
--
-- Patrón de las tablas nuevas en ferretodo: solo CREATE TABLE + índices
-- (schema dedicado, acceso por el pooler; sin RLS/grants por tabla).
-- ============================================================================

-- ── 1) Línea base: estado del producto antes de su primera compra ───────────
CREATE TABLE IF NOT EXISTS ferretodo.producto_costo_base (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL,
  producto_id   uuid NOT NULL,
  stock_base    numeric NOT NULL DEFAULT 0,
  costo_base    numeric NOT NULL DEFAULT 0,
  capturado_at  timestamptz NOT NULL DEFAULT now(),
  capturado_por uuid
);

-- Una sola línea base por producto: se captura la primera vez y no se re-escribe.
CREATE UNIQUE INDEX IF NOT EXISTS producto_costo_base_uidx
  ON ferretodo.producto_costo_base (empresa_id, producto_id);

COMMENT ON TABLE ferretodo.producto_costo_base IS
  'Línea base (stock + costo interno) del producto ANTES de su primera compra registrada. Punto de partida para reconstruir el CPP al anular una compra.';

-- ── 2) Historial del costo promedio ponderado ──────────────────────────────
CREATE TABLE IF NOT EXISTS ferretodo.producto_costo_historial (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid NOT NULL,
  producto_id          uuid NOT NULL,
  producto_nombre      text,
  evento               text NOT NULL DEFAULT 'compra',
  costo_anterior       numeric NOT NULL DEFAULT 0,
  cantidad_anterior    numeric NOT NULL DEFAULT 0,
  costo_compra         numeric NOT NULL DEFAULT 0,
  cantidad_ingresada   numeric NOT NULL DEFAULT 0,
  costo_promedio_nuevo numeric NOT NULL DEFAULT 0,
  numero_control       text,
  proveedor_id         uuid,
  proveedor_nombre     text,
  created_by           uuid,
  usuario_nombre       text,
  fecha                timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ferretodo.producto_costo_historial'::regclass
       AND conname  = 'producto_costo_historial_evento_check'
  ) THEN
    ALTER TABLE ferretodo.producto_costo_historial
      ADD CONSTRAINT producto_costo_historial_evento_check
      CHECK (evento IN ('compra','recalculo_anulacion'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS producto_costo_historial_prod_idx
  ON ferretodo.producto_costo_historial (empresa_id, producto_id, fecha DESC);
CREATE INDEX IF NOT EXISTS producto_costo_historial_factura_idx
  ON ferretodo.producto_costo_historial (empresa_id, numero_control);

COMMENT ON TABLE ferretodo.producto_costo_historial IS
  'Auditoría del costo promedio ponderado: costo/cantidad anterior, costo/cantidad de la compra, nuevo promedio, factura y proveedor, fecha y usuario. No modifica los importes de la factura.';
