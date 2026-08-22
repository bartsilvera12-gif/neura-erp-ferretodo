# Setup Ferretodo — puesta en marcha

Checklist para dejar operativo este ERP. Ejecutar **en este orden**.

---

## 1. Crear el schema `ferretodo` en Postgres

El schema se clona desde la plantilla `zentra_erp`. La función crea el schema y
aplica **todos los grants y default privileges** (postgres, anon, authenticated,
service_role), así que no hace falta otorgarlos a mano.

```sql
SELECT zentra_erp.neura_clone_zentra_erp_to_tenant('ferretodo');
```

Verificación rápida:

```sql
SELECT count(*) AS tablas
FROM information_schema.tables
WHERE table_schema = 'ferretodo';
```

## 2. Aplicar las migraciones propias del tenant

Estas 4 migraciones agregan lo que no trae la plantilla. Son **aditivas e
idempotentes** (se pueden correr más de una vez).

```sql
-- 2.1 Devoluciones de venta
--     (contenido completo en supabase/migrations/20260721120000_ferretodo_devoluciones_ventas.sql)

-- 2.2 Puente Venta -> Factura electrónica (SIFEN)
ALTER TABLE ferretodo.ventas        ADD COLUMN IF NOT EXISTS factura_id uuid;
CREATE INDEX IF NOT EXISTS ventas_factura_id_idx ON ferretodo.ventas (empresa_id, factura_id);
ALTER TABLE ferretodo.facturas      ADD COLUMN IF NOT EXISTS origen_venta_id uuid;
ALTER TABLE ferretodo.facturas      ADD COLUMN IF NOT EXISTS cliente_razon_social text;
ALTER TABLE ferretodo.facturas      ADD COLUMN IF NOT EXISTS cliente_ruc text;
CREATE INDEX IF NOT EXISTS facturas_origen_venta_id_idx ON ferretodo.facturas (empresa_id, origen_venta_id);
ALTER TABLE ferretodo.factura_items ADD COLUMN IF NOT EXISTS tipo_iva text;

-- 2.3 Campos de facturación del cliente
ALTER TABLE ferretodo.clientes ADD COLUMN IF NOT EXISTS nombre_facturacion text;
ALTER TABLE ferretodo.clientes ADD COLUMN IF NOT EXISTS nivel_precio text NOT NULL DEFAULT 'minorista'
  CHECK (nivel_precio IN ('minorista','mayorista','distribuidor'));
ALTER TABLE ferretodo.clientes ADD COLUMN IF NOT EXISTS es_contribuyente boolean NOT NULL DEFAULT false;

-- 2.4 Estado de pago de compras ("Marcar pagada")
ALTER TABLE ferretodo.compras ADD COLUMN IF NOT EXISTS estado_pago text NOT NULL DEFAULT 'pendiente'
  CHECK (estado_pago IN ('pendiente','pagada'));
ALTER TABLE ferretodo.compras ADD COLUMN IF NOT EXISTS pagada_at timestamptz;
ALTER TABLE ferretodo.compras ADD COLUMN IF NOT EXISTS pago_caja_movimiento_id uuid;

-- Refrescar el cache de PostgREST para que reconozca las columnas nuevas
NOTIFY pgrst, 'reload schema';
```

> La 2.1 (devoluciones) es un `CREATE TABLE` largo: correr el archivo
> `supabase/migrations/20260721120000_ferretodo_devoluciones_ventas.sql` completo.

## 3. Exponer el schema en Supabase

Settings → API → **Exposed schemas**: agregar `ferretodo`.

## 4. Crear la empresa y los usuarios

La empresa debe quedar apuntando al schema:

```sql
-- data_schema DEBE ser 'ferretodo'
UPDATE zentra_erp.empresas
SET data_schema = 'ferretodo'
WHERE id = '<EMPRESA_ID_DE_FERRETODO>';
```

Luego crear los usuarios y asociarlos a esa empresa.

## 5. Variables de entorno (Coolify)

| Variable | Valor | Obligatoria |
|---|---|---|
| `NEURA_CLIENT_SCHEMA` | `ferretodo` | **Sí** |
| `NEURA_CLIENT_NAME` | `Ferretodo` | Sí |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase | **Sí** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key | **Sí** |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key | **Sí** |
| `SIFEN_SECRETS_KEY` | secreto propio (`openssl rand -base64 32`) | Solo si se factura |

`SIFEN_SECRETS_KEY` cifra la contraseña del certificado `.p12`. **Generar una
sola vez y no cambiarla nunca**, y setearla **antes** de cargar el certificado.

---

## ⚠️ Facturación electrónica — pendiente antes de emitir

La emisión está **bloqueada a propósito** para que sea imposible emitir con
datos de otra empresa. Antes de facturar hay que completar:

1. **Teléfono y email del emisor** (hoy vacíos → el XML falla de forma segura):
   - `src/app/api/facturas/[id]/sifen/xml/route.ts` → `EMISOR_TELEFONO` / `EMISOR_EMAIL`
   - `src/lib/nota-credito/handle-nc-sifen-xml-post.ts` → ídem
2. **Razón social y RUC** en los comprobantes (hoy `FERRETODO` / `R.U.C.: —`):
   - `src/app/api/ventas/[id]/comprobante-a4/route.ts`
   - `src/app/api/devoluciones/[id]/comprobante/route.ts`
3. **Config SIFEN en la DB** (`/configuracion/facturacion-electronica`):
   certificado `.p12` + contraseña, RUC, timbrado, establecimiento, punto de
   expedición, dirección fiscal, actividad económica, CSC/idCSC y ambiente.
4. **Modo de facturación**: para que aparezca el selector Factura/Ticket en Caja:

```sql
INSERT INTO ferretodo.empresa_facturacion_modo (empresa_id, modo)
VALUES ('<EMPRESA_ID_DE_FERRETODO>', 'sifen')
ON CONFLICT (empresa_id) DO UPDATE SET modo = 'sifen', updated_at = now();
```

## Logo

No se incluyó ninguno (todavía no hay de Ferretodo). Cuando exista:

- `public/brand/ferretodo-logo.png` → header y membrete de documentos
  (poner la ruta en `EMPRESA_DOC.logoUrl` de `src/lib/documentos/membrete.ts`).
- `public/logo-ferretodo.png` → logo por defecto del KUDE.

Mientras no existan, la app degrada sin imagen rota.
