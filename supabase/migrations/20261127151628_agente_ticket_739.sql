-- Cambios de estructura aplicados por el Agente IA (ticket #739, neura-erp-ferretodo). Ya están en la base.

-- Líneas de detalle (una por factura) de un recibo que cobra varias cuentas a crédito
create table if not exists ferretodo.recibos_dinero_items (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  recibo_id uuid not null,
  cobro_cliente_id uuid,
  cuenta_por_cobrar_id uuid,
  numero_venta text,
  monto numeric not null default 0,
  saldo_restante numeric not null default 0,
  created_at timestamptz not null default now()
);
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "ferretodo".recibos_dinero_items to anon;
grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on "ferretodo".recibos_dinero_items to authenticated;
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "ferretodo".recibos_dinero_items to service_role;
alter table "ferretodo".recibos_dinero_items enable row level security;
create policy recibos_dinero_items_delete_1 on "ferretodo".recibos_dinero_items for delete to public using (ferretodo.puede_acceder_empresa(empresa_id));
create policy recibos_dinero_items_insert_2 on "ferretodo".recibos_dinero_items for insert to public with check (ferretodo.puede_acceder_empresa(empresa_id));
create policy recibos_dinero_items_select_3 on "ferretodo".recibos_dinero_items for select to public using (ferretodo.puede_acceder_empresa(empresa_id));
create policy recibos_dinero_items_update_4 on "ferretodo".recibos_dinero_items for update to public using (ferretodo.puede_acceder_empresa(empresa_id)) with check (ferretodo.puede_acceder_empresa(empresa_id));

-- Índice por recibo
create index if not exists recibos_dinero_items_recibo_idx on ferretodo.recibos_dinero_items(recibo_id);

-- Índice por cobro
create index if not exists recibos_dinero_items_cobro_idx on ferretodo.recibos_dinero_items(cobro_cliente_id);
