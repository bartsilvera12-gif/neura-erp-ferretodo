-- ============================================================================
-- Anulación / corrección de cobros de clientes. ADITIVA E IDEMPOTENTE.
--
-- Contexto: un cobro mal registrado (por ejemplo, el saldo total en lugar del
-- abono parcial recibido) dejaba la cuenta por cobrar en 'pagado' sin forma de
-- corregirla. Se agrega anulación SOFT del cobro + auditoría de quién/por qué,
-- el vínculo al movimiento de caja que generó (para revertir el ingreso) y el
-- encadenamiento cobro anulado -> cobro de reemplazo.
--
-- El cobro NUNCA se borra: queda en la tabla marcado con anulado_at y se
-- excluye de saldos, reportes y conciliación. Así se mantiene el historial de
-- pagos parciales y la factura conserva su monto original.
--
-- Se aplica a todos los schemas de datos que tengan la tabla cobros_clientes
-- (ferretodo, reservacaacupe, …): el schema vivo depende del tenant.
-- ============================================================================

DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT table_schema
      FROM information_schema.tables
     WHERE table_name = 'cobros_clientes' AND table_type = 'BASE TABLE'
  LOOP
    -- 1) Auditoría de la anulación + reversa de caja + encadenamiento.
    EXECUTE format('ALTER TABLE %I.cobros_clientes ADD COLUMN IF NOT EXISTS anulado_at timestamptz', sch);
    EXECUTE format('ALTER TABLE %I.cobros_clientes ADD COLUMN IF NOT EXISTS anulado_por_id uuid', sch);
    EXECUTE format('ALTER TABLE %I.cobros_clientes ADD COLUMN IF NOT EXISTS anulado_por_nombre text', sch);
    EXECUTE format('ALTER TABLE %I.cobros_clientes ADD COLUMN IF NOT EXISTS anulado_motivo text', sch);
    -- Movimiento de caja que generó el cobro: permite anular ese ingreso al
    -- anular el cobro (si la caja sigue abierta) en lugar de descuadrarla.
    EXECUTE format('ALTER TABLE %I.cobros_clientes ADD COLUMN IF NOT EXISTS caja_movimiento_id uuid', sch);
    -- Cobro que este cobro reemplaza (corrección de monto/método/fecha).
    EXECUTE format('ALTER TABLE %I.cobros_clientes ADD COLUMN IF NOT EXISTS reemplaza_a_cobro_id uuid', sch);

    -- 2) Índice para recalcular el saldo de una cuenta con sus cobros vigentes.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_cobros_cuenta_vigentes ON %I.cobros_clientes (empresa_id, cuenta_por_cobrar_id) WHERE anulado_at IS NULL',
      sch);

    -- 3) Reparación de saldos: el saldo de una cuenta vigente es su total menos
    --    los cobros vigentes. Corrige las cuentas que quedaron marcadas como
    --    pagadas (o con saldo distinto) por cobros mal aplicados. No toca el
    --    total de la cuenta ni las cuentas anuladas.
    EXECUTE format($q$
      UPDATE %I.cuentas_por_cobrar c
         SET saldo = v.saldo_real,
             estado = CASE WHEN v.saldo_real <= 0.001 THEN 'pagado'
                           WHEN v.saldo_real < c.total  THEN 'parcial'
                           ELSE 'pendiente' END,
             updated_at = now()
        FROM (
          SELECT c2.id,
                 GREATEST(0, c2.total - COALESCE((
                   SELECT SUM(cc.monto) FROM %I.cobros_clientes cc
                    WHERE cc.cuenta_por_cobrar_id = c2.id AND cc.anulado_at IS NULL
                 ), 0)) AS saldo_real
            FROM %I.cuentas_por_cobrar c2
           WHERE c2.estado <> 'anulado'
        ) v
       WHERE v.id = c.id
         AND c.estado <> 'anulado'
         AND abs(c.saldo - v.saldo_real) > 0.001
    $q$, sch, sch, sch);
  END LOOP;
END $$;
