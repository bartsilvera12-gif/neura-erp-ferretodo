-- ============================================================================
-- La transferencia pasa a ser tambien una NOTA entre sucursales, contado o
-- credito, y los pagos se aplican contra notas puntuales en vez de solo bajar
-- un saldo neto. Asi cada nota se puede dar por cancelada, que es lo que pidio
-- el cliente ("al registrar el pago, cancelar la deuda/nota").
--
-- La nota es la transferencia misma: mismo numero TRF. Un documento aparte
-- obligaria a mantener dos cosas sincronizadas para representar un solo hecho.
-- ============================================================================

ALTER TABLE neura_transferencias.transferencias
  ADD COLUMN IF NOT EXISTS tipo_pago text NOT NULL DEFAULT 'credito';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_trf_tipo_pago') THEN
    ALTER TABLE neura_transferencias.transferencias
      ADD CONSTRAINT chk_trf_tipo_pago CHECK (tipo_pago IN ('contado','credito'));
  END IF;
END $$;

-- Vencimiento de la nota. En contado es la fecha de recepcion; en credito, la
-- recepcion mas el plazo acordado.
ALTER TABLE neura_transferencias.transferencias
  ADD COLUMN IF NOT EXISTS plazo_dias integer,
  ADD COLUMN IF NOT EXISTS vence_at   date;

-- Que parte de cada pago cancela que nota. El saldo de una nota se deriva de
-- aca (costo total menos lo aplicado): no se guarda como contador para que no
-- pueda quedar desincronizado de los pagos reales.
CREATE TABLE IF NOT EXISTS neura_transferencias.pago_aplicaciones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pago_id          uuid NOT NULL REFERENCES neura_transferencias.pagos_internos(id) ON DELETE CASCADE,
  transferencia_id uuid NOT NULL REFERENCES neura_transferencias.transferencias(id) ON DELETE CASCADE,
  monto            numeric(18,2) NOT NULL CHECK (monto > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pago_aplicacion UNIQUE (pago_id, transferencia_id)
);

CREATE INDEX IF NOT EXISTS ix_pag_apl_trf  ON neura_transferencias.pago_aplicaciones (transferencia_id);
CREATE INDEX IF NOT EXISTS ix_pag_apl_pago ON neura_transferencias.pago_aplicaciones (pago_id);

GRANT ALL ON ALL TABLES IN SCHEMA neura_transferencias TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA neura_transferencias TO postgres, service_role;
