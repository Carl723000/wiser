/** Worker-private readback: preserve PostGIS 9,0 leaf serialization and direct legacy paths. */
export function projectionGeometryJsonSql(
  geometry: 'source_geometry' | 'ST_Transform(canonical_geometry, 4326)',
): string {
  // PostgreSQL path ordering places each close token after its complete subtree.
  // Multi* remains a leaf; empty roots keep the original direct serializer.
  return `(WITH RECURSIVE root AS MATERIALIZED (
 SELECT ${geometry} AS geom
), route AS MATERIALIZED (
 SELECT geom,CASE WHEN ST_GeometryType(geom)='ST_GeometryCollection' THEN EXISTS (
  SELECT 1 FROM generate_series(1,ST_NumGeometries(geom)) ordinal
  WHERE ST_GeometryType(ST_GeometryN(geom,ordinal))='ST_GeometryCollection'
 ) ELSE false END AS nested FROM root
), tree(path,geom) AS (
 SELECT ARRAY[]::integer[],geom FROM route WHERE nested
 UNION ALL
 SELECT t.path||ordinal,ST_GeometryN(t.geom,ordinal)
 FROM tree t CROSS JOIN LATERAL generate_series(1,
  CASE WHEN ST_GeometryType(t.geom)='ST_GeometryCollection'
  THEN ST_NumGeometries(t.geom) ELSE 0 END) ordinal
), tokens(path,token) AS (
 SELECT path,CASE WHEN path[array_length(path,1)]>1 THEN ',' ELSE '' END ||
  CASE WHEN ST_GeometryType(geom)='ST_GeometryCollection'
   THEN '{"type":"GeometryCollection","geometries":['
   ELSE ST_AsGeoJSON(geom,9,0) END FROM tree
 UNION ALL
 SELECT path||(ST_NumGeometries(geom)+1),']}'
 FROM tree WHERE ST_GeometryType(geom)='ST_GeometryCollection'
)
SELECT CASE WHEN nested THEN (SELECT string_agg(token,'' ORDER BY path) FROM tokens)
 ELSE ST_AsGeoJSON(${geometry},9,0) END FROM route)`;
}
