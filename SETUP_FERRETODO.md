# Setup Ferretodo — puesta en marcha

Checklist para dejar operativo este ERP. Ejecutar **en este orden**.

---

## 1. Crear el schema `ferretodo` (clon de la estructura de `ferrecolor`)

Ejecutar **completo** el archivo:

```
supabase/setup/00_clonar_schema_ferretodo.sql
```

Clona de `ferrecolor` **solo la estructura** (tablas, columnas, defaults, PK/unique/
check, índices, FKs, secuencias, triggers, funciones, vistas, RLS + policies) y aplica
todos los grants. **No copia ninguna fila.** Es transaccional y aborta si `ferretodo`
ya existe. Al final trae consultas de verificación (deben coincidir las tablas/columnas
y dar 0 filas las de fugas hacia `ferrecolor`).

> No usar `zentra_erp.neura_clone_zentra_erp_to_tenant()`: clona la plantilla
> (no el estado real de Ferrecolor) y además exige que el schema empiece con `erp_`.

## 2. Migraciones del tenant

Ya vienen incluidas en el clon del paso 1 (porque se copian desde `ferrecolor`,
que las tiene aplicadas). Los archivos quedan versionados en
`supabase/migrations/*_ferretodo_*.sql` como referencia para bases nuevas.

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

Cargado desde `Logo Ferretodo .pdf` (CorelDRAW vectorial, renderizado a 600 dpi):

- `public/brand/ferretodo-logo.png` — membrete y documentos (`EMPRESA_DOC.logoUrl`).
- `public/logo-ferretodo.png` — logo por defecto del KUDE.

Es un lockup horizontal (1800×318, ~5.7:1) con **fondo azul marino solido**, no
transparente: sobre hoja blanca se ve el rectangulo azul. Como el logo ya incluye
la palabra FERRETODO, el membrete no repite el nombre al lado.
