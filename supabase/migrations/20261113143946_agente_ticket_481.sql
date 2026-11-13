-- Cambios de estructura aplicados por el Agente IA (ticket #481, neura-erp-ferretodo). Ya están en la base.

-- Planes de cuotas con recargo % por producto (producto_id null = plan general)
create table ferretodo.producto_planes_cuotas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  producto_id uuid null,
  cuotas integer not null check (cuotas >= 2 and cuotas <= 60),
  recargo_porcentaje numeric not null default 0 check (recargo_porcentaje >= 0),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "ferretodo".producto_planes_cuotas to anon;
grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on "ferretodo".producto_planes_cuotas to authenticated;
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "ferretodo".producto_planes_cuotas to service_role;
alter table "ferretodo".producto_planes_cuotas enable row level security;
create policy producto_planes_cuotas_delete_1 on "ferretodo".producto_planes_cuotas for delete to public using (ferretodo.puede_acceder_empresa(empresa_id));
create policy producto_planes_cuotas_insert_2 on "ferretodo".producto_planes_cuotas for insert to public with check (ferretodo.puede_acceder_empresa(empresa_id));
create policy producto_planes_cuotas_select_3 on "ferretodo".producto_planes_cuotas for select to public using (ferretodo.puede_acceder_empresa(empresa_id));
create policy producto_planes_cuotas_update_4 on "ferretodo".producto_planes_cuotas for update to public using (ferretodo.puede_acceder_empresa(empresa_id)) with check (ferretodo.puede_acceder_empresa(empresa_id));

-- Guardar el plan de cuotas elegido en cada línea de venta
alter table ferretodo.ventas_items add column cuotas integer not null default 1, add column recargo_porcentaje numeric not null default 0, add column monto_cuota numeric not null default 0;
