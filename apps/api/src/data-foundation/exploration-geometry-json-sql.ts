/** Private readback for catalog.analysis_record.geom (Geometry,4326). */
// Preserve the original default serializer for null/simple/flat/empty geometry.
// Only nested collections need ordered native 9,0 leaves: for SRID 4326 this
// matches the original precision/CRS behavior without adding child CRS fields.
export const EXPLORATION_GEOMETRY_JSON_SQL = `(WITH RECURSIVE root AS MATERIALIZED (
 SELECT record.geom::geometry AS geom
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
 ELSE st_asgeojson(record.geom) END FROM route)`;
