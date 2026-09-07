-- ============================================================================
-- Transferencias internas de mercaderia entre empresas del grupo
-- (Ferrecolor <-> Ferretodo). Movimiento LOGISTICO a costo: no es una venta,
-- no deja utilidad a quien entrega y no genera ningun documento fiscal.
--
-- Por que un schema propio y no una tabla en cada empresa: la transferencia es
-- UN solo hecho con dos lados. Si se guardara duplicada en los dos schemas, los
-- estados se desincronizan y despues no hay forma de auditar de donde salio la
-- mercaderia. Aca vive el registro canonico, con un unico numero TRF-000125 que
-- referencian los movimientos de inventario de ambas empresas.
--
-- El stock NO vive aca: cada empresa sigue moviendo su propio
-- productos.stock_actual y su propio movimientos_inventario.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS neura_transferencias;

-- Empresas habilitadas a transferirse entre si. Se consulta desde la app para
-- saber a quien puede enviarle cada empresa, asi no hace falta configurar
-- variables de entorno ni hardcodear el par en el codigo.
CREATE TABLE IF NOT EXISTS neura_transferencias.empresas_vinculadas (
  empresa_id   uuid PRIMARY KEY,
  schema_datos text NOT NULL,
  nombre       text NOT NULL,
  activo       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS neura_transferencias.transferencias (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                text NOT NULL UNIQUE,           -- TRF-000125
  empresa_origen_id     uuid NOT NULL,
  schema_origen         text NOT NULL,
  nombre_origen         text NOT NULL,
  empresa_destino_id    uuid NOT NULL,
  schema_destino        text NOT NULL,
  nombre_destino        text NOT NULL,
  estado                text NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente','recibido','cancelado')),
  observacion           text,
  total_costo           numeric(18,2) NOT NULL DEFAULT 0,
  creada_at             timestamptz NOT NULL DEFAULT now(),
  creada_por_id         uuid,
  creada_por_nombre     text,
  recibida_at           timestamptz,
  recibida_por_id       uuid,
  recibida_por_nombre   text,
  cancelada_at          timestamptz,
  cancelada_por_id      uuid,
  cancelada_por_nombre  text,
  cancelada_motivo      text,
  CONSTRAINT chk_trf_empresas_distintas CHECK (empresa_origen_id <> empresa_destino_id)
);

CREATE INDEX IF NOT EXISTS ix_trf_origen  ON neura_transferencias.transferencias (empresa_origen_id, estado, creada_at DESC);
CREATE INDEX IF NOT EXISTS ix_trf_destino ON neura_transferencias.transferencias (empresa_destino_id, estado, creada_at DESC);

CREATE TABLE IF NOT EXISTS neura_transferencias.transferencia_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transferencia_id   uuid NOT NULL REFERENCES neura_transferencias.transferencias(id) ON DELETE CASCADE,
  -- Lado origen: se congela el snapshot al despachar.
  producto_origen_id uuid NOT NULL,
  sku_origen         text,
  nombre_origen      text NOT NULL,
  unidad_medida      text,
  cantidad           numeric(18,4) NOT NULL CHECK (cantidad > 0),
  costo_unitario     numeric(18,4) NOT NULL DEFAULT 0,
  -- Lado destino: lo completa QUIEN RECIBE al confirmar (asigna el producto de
  -- su propio catalogo, o crea uno nuevo). Nulo mientras esta pendiente.
  producto_destino_id     uuid,
  sku_destino             text,
  producto_destino_creado boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ix_trf_items ON neura_transferencias.transferencia_items (transferencia_id);

-- Numeracion TRF-000001 global al grupo: el numero es la clave de auditoria
-- que une los movimientos de las dos empresas, asi que no puede repetirse.
CREATE SEQUENCE IF NOT EXISTS neura_transferencias.transferencia_numero_seq;

CREATE OR REPLACE FUNCTION neura_transferencias.siguiente_numero()
RETURNS text LANGUAGE sql AS $$
  SELECT 'TRF-' || LPAD(nextval('neura_transferencias.transferencia_numero_seq')::text, 6, '0');
$$;

-- El acceso es por pool de Postgres (service role), no por PostgREST: estas
-- tablas no se exponen en la API publica.
GRANT USAGE ON SCHEMA neura_transferencias TO postgres, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA neura_transferencias TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA neura_transferencias TO postgres, service_role;

-- Alta de las dos empresas del grupo.
INSERT INTO neura_transferencias.empresas_vinculadas (empresa_id, schema_datos, nombre)
VALUES
  ('33eb907d-7df3-4e1f-8fe9-20965c6f05ed', 'ferrecolor', 'Ferrecolor'),
  ('7f78c83b-e252-43c5-9e52-a8e0d45beb0f', 'ferretodo',  'Ferretodo')
ON CONFLICT (empresa_id) DO UPDATE
  SET schema_datos = EXCLUDED.schema_datos, nombre = EXCLUDED.nombre, activo = true;

-- ---------------------------------------------------------------------------
-- movimientos_inventario.origen tiene un CHECK con una lista cerrada de valores.
-- Hay que sumar 'transferencia' en AMBOS schemas, si no la entrada/salida de una
-- transferencia es rechazada.
--
-- La lista NO se escribe a mano: se arma con los valores que ya existen en cada
-- schema mas 'transferencia'. Escribirla a mano fallo una vez porque habia
-- movimientos con origen 'devolucion_venta' que no estaban en la lista, y un
-- CHECK que no cubre las filas existentes no se puede crear.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_schema text;
  v_con    text;
  v_vals   text;
BEGIN
  FOREACH v_schema IN ARRAY ARRAY['ferrecolor','ferretodo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = v_schema AND table_name = 'movimientos_inventario') THEN
      RAISE NOTICE 'Schema % sin movimientos_inventario, se omite.', v_schema;
      CONTINUE;
    END IF;

    SELECT c.conname INTO v_con
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = v_schema
       AND t.relname = 'movimientos_inventario'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%origen%'
     LIMIT 1;

    IF v_con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.movimientos_inventario DROP CONSTRAINT %I', v_schema, v_con);
      RAISE NOTICE 'Schema %: constraint % eliminado.', v_schema, v_con;
    END IF;

    -- Valores presentes hoy + los canonicos + transferencia.
    EXECUTE format(
      $q$SELECT string_agg(DISTINCT quote_literal(v), ',')
           FROM (SELECT origen AS v FROM %I.movimientos_inventario WHERE origen IS NOT NULL
                 UNION SELECT unnest(ARRAY['compra','venta','ajuste_manual','inventario_inicial','transferencia'])) s$q$,
      v_schema
    ) INTO v_vals;

    EXECUTE format(
      'ALTER TABLE %I.movimientos_inventario ADD CONSTRAINT chk_mov_origen CHECK (origen IN (%s))',
      v_schema, v_vals
    );
    RAISE NOTICE 'Schema %: origen ahora admite %', v_schema, v_vals;
  END LOOP;
END $$;
