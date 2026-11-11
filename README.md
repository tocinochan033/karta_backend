# Karta API

Backend de **Karta**, la app para decidir qué comer según antojo, presupuesto y distancia. Está pensado para el cliente en React Native: mapa de solo comida, ficha del local, menú digital, favoritos y panel B2B para dueños.

Stack: **NestJS**, **Prisma**, **PostgreSQL (Supabase)** y **JWT**.

## Qué cubre este backend

- Registro / login (explorer, owner, admin) y modo invitado en endpoints públicos
- Mapa cercano con radio, cocina, dieta, presupuesto y “abierto ahora”
- Ficha y menú del restaurante
- CRUD B2B: restaurante, ubicación, horarios, categorías y platillos
- Favoritos de lugares y platillos
- Eventos de analítica (`view_menu`, `click_navigation`, `save`, `view_pin`)

## Arranque con Supabase

1. Crea un proyecto en [Supabase](https://supabase.com) y copia el **URI** de Postgres (`Project Settings > Database`).
2. Copia las variables de entorno:

```bash
copy .env.example .env
```

3. Pega `DATABASE_URL` y un `JWT_SECRET` largo.
4. En `karta_backend/.env`, configura `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` con la URL del proyecto y la clave **service_role** de Supabase (Project Settings > API). Mantén esa clave solo en el backend; no la incluyas en la app móvil ni en configuración pública.
5. Instala dependencias y crea las tablas:

```bash
npm install
npx prisma generate
npx prisma db push
npx prisma db seed
npm run start:dev
```

- API: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`
- Swagger: `http://localhost:3000/docs`
- Colección Bruno: Carpeta `bruno/` (o importar `bruno/karta-api.postman_collection.json`)

Usuarios de prueba (seed):

| Rol | Email | Password |
| --- | --- | --- |
| Explorer | ava@karta.app | karta1234 |
| Owner | owner@karta.app | karta1234 |
| Admin | admin@karta.app | karta1234 |

Hay dos restaurantes demo en Roma Norte / Condesa (CDMX) para probar el mapa:

`GET /api/map/nearby?lat=19.4194&lng=-99.1624&radius=1500`

## Auth desde React Native

```http
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
Authorization: Bearer <accessToken>
```

El mapa, catálogos, ficha y menú son públicos (sirven para “continuar como invitado”). Favoritos y panel del dueño requieren JWT.

## Endpoints principales

| Uso en la app | Endpoint |
| --- | --- |
| Filtros | `GET /api/cuisines` `GET /api/dietary-tags` |
| Pines del mapa | `GET /api/map/nearby?lat=&lng=&radius=&cuisineIds=&dietaryTagIds=&maxPrice=&openNow=&q=` |
| Ficha | `GET /api/restaurants/:id` |
| Menú | `GET /api/restaurants/:id/menu` |
| Favoritos | `GET/POST/DELETE /api/me/favorites/places/:restaurantId` |
| Analítica | `POST /api/analytics/events` |
| Dueño | `POST /api/restaurants` + `PUT .../location` + `PUT .../hours` |
| Foto de platillo (owner/admin, multipart `file`) | `POST /api/menu-categories/:id/dishes/image` |
| Limpiar foto no persistida o reemplazada (owner/admin) | `DELETE /api/menu-categories/:id/dishes/image` |
| Publicar | `POST /api/restaurants/:id/submit` (admin activa con `PATCH .../status`) |

El mapa solo muestra restaurantes con `status = active` y ubicación cargada. El dueño crea en `draft`, envía a revisión y un admin lo deja `active`.

Las imágenes de platillos se guardan en el bucket público `karta-dish-images`. El backend lo crea de forma idempotente en la primera subida (o actualiza sus límites si ya existe), con lectura pública, límite de 5 MB y tipos JPG/PNG/WebP. Antes de usarlo, el backend verifica que RLS esté activo y que ninguna política `anon`/`public` pueda escribir en este bucket. Solo reconoce expresiones simples de igualdad o `IN` que fijan otros bucket IDs; las políticas globales o ambiguas fallan cerradas, sin cambiar políticas ni otros buckets. La comprobación también falla cerrada si no puede consultar las políticas. Las escrituras pasan solo por el backend autenticado; no habilites escritura pública en Storage.

Al crear o cambiar la URL de una foto, la API solo admite objetos del bucket de este proyecto bajo el UUID del restaurante. Una URL externa existente se puede conservar sin cambios, pero no asignar a otro platillo. Al borrar un platillo o categoría, la API recoge las URLs antes de borrar los registros, conserva las fotos aún referenciadas y limpia las demás; URLs externas heredadas se omiten. Si falla la limpieza, el borrado se completa y la app muestra una advertencia con el error para permitir seguimiento.

## Notas de producto vs SQL original

El schema de Prisma replica `karta.sql`. Lo que el PDF pide y **aún no está en la base** (promos, descuentos por check-in, redes sociales, presupuesto persistido del usuario) se puede agregar en una siguiente iteración sin romper el cliente.

La distancia se calcula con Haversine sobre `latitude` / `longitude`. PostGIS se puede activar después en Supabase si el volumen lo pide.
