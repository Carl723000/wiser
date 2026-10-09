// These bounds follow the candidate geometry schema's 800,000 JSON-value
// traversal limit, not the stricter projection-write position policy.
const MAX_TREE_VALUES = 266_666;
const ROW_BUDGET = 2_621_440;
const ROW_OVERHEAD = 2048;
const KINDS =
  "'ST_Point','ST_MultiPoint','ST_LineString','ST_MultiLineString','ST_Polygon','ST_MultiPolygon','ST_GeometryCollection'";

/** Private, fixed SQL only: callers cannot supply identifiers or geometry policy. */
function readbackSql(render: boolean): string {
  const root = render
    ? 'CASE WHEN candidate.geometry_text IS NULL AND candidate.geometry_guard IS NULL AND NOT candidate.budget_exceeded THEN candidate.geom ELSE NULL END'
    : 'candidate.geom';
  return `(WITH RECURSIVE
root AS MATERIALIZED (
 SELECT (${root})::geometry AS geom
), classified AS MATERIALIZED (
 SELECT geom,ST_GeometryType(geom) AS kind,ST_NPoints(geom) AS positions,
        ST_NumGeometries(geom) AS children FROM root
), route AS MATERIALIZED (
 SELECT r.*,CASE WHEN kind='ST_GeometryCollection' THEN EXISTS(
  SELECT 1 FROM generate_series(1,r.children) ordinal
  WHERE ST_GeometryType(ST_GeometryN(r.geom,ordinal))='ST_GeometryCollection'
 ) ELSE false END AS nested FROM classified r
), admitted AS MATERIALIZED (
 SELECT r.*,CASE WHEN nested THEN CASE
  WHEN ST_IsEmpty(geom) THEN 'EMPTY_GEOMETRY'
  WHEN positions>${MAX_TREE_VALUES} THEN 'ROOT_POSITION_LIMIT'
  WHEN children>positions THEN 'ROOT_MEMBER_BOUND'
  ELSE NULL END ELSE NULL END AS nested_guard FROM route r
), nodes(path,geom,depth) AS (
 SELECT ARRAY[]::integer[],geom,0 FROM admitted WHERE nested AND nested_guard IS NULL
 UNION ALL
 SELECT n.path||ordinal,ST_GeometryN(n.geom,ordinal),n.depth+1
 FROM nodes n CROSS JOIN LATERAL generate_series(1,
  CASE WHEN ST_GeometryType(n.geom)='ST_GeometryCollection'
   AND n.depth<4 AND ST_NumGeometries(n.geom)<=${MAX_TREE_VALUES}
   AND ST_NumGeometries(n.geom)<=ST_NPoints(n.geom)
  THEN ST_NumGeometries(n.geom) ELSE 0 END) ordinal
), bounded AS MATERIALIZED (
 SELECT * FROM nodes LIMIT ${MAX_TREE_VALUES + 1}
), checked AS MATERIALIZED (
 SELECT *,ST_GeometryType(geom) AS kind,ST_NumGeometries(geom) AS children,
 CASE WHEN ST_IsEmpty(geom) THEN 'EMPTY_GEOMETRY'
  WHEN ST_GeometryType(geom) NOT IN (${KINDS}) THEN 'NODE_TYPE_UNSUPPORTED'
  WHEN ST_GeometryType(geom)='ST_GeometryCollection' AND ST_NumGeometries(geom)>${MAX_TREE_VALUES} THEN 'CHILD_COUNT_LIMIT'
  WHEN ST_GeometryType(geom)='ST_GeometryCollection' AND ST_NumGeometries(geom)>ST_NPoints(geom) THEN 'MEMBER_POSITION_BOUND'
  WHEN ST_GeometryType(geom)='ST_GeometryCollection' AND depth>=4 THEN 'DEPTH_LIMIT'
  ELSE NULL END AS guard FROM bounded
), decision AS MATERIALIZED (
 SELECT r.*,COALESCE(r.nested_guard,
  CASE WHEN (SELECT count(*) FROM bounded)>${MAX_TREE_VALUES} THEN 'NODE_COUNT_LIMIT'
   ELSE (SELECT guard FROM checked WHERE guard IS NOT NULL ORDER BY path LIMIT 1) END
 ) AS final_guard FROM admitted r
), tokens AS MATERIALIZED (
 SELECT c.path AS token_path,
  CASE WHEN d.final_guard IS NOT NULL OR NOT d.nested THEN NULL ELSE
   CASE WHEN c.path[array_length(c.path,1)]>1 THEN ',' ELSE '' END ||
   CASE WHEN c.kind='ST_GeometryCollection' THEN '{"type":"GeometryCollection","geometries":['
    ELSE ST_AsGeoJSON(c.geom,15,0) END END AS token
 FROM checked c CROSS JOIN decision d WHERE d.final_guard IS NULL AND d.nested
 UNION ALL
 SELECT c.path||(c.children+1),']}'::text
 FROM checked c CROSS JOIN decision d
 WHERE d.final_guard IS NULL AND d.nested AND c.kind='ST_GeometryCollection'
), token_budget AS MATERIALIZED (
 SELECT COALESCE(sum(octet_length(token)),0) AS bytes,
        count(DISTINCT token_path)=count(*) AS unique_paths FROM tokens
), gated AS MATERIALIZED (
 SELECT d.*,b.bytes,COALESCE(d.final_guard,
  CASE WHEN d.nested AND NOT b.unique_paths THEN 'TOKEN_PATH_COLLISION' ELSE NULL END
 ) AS geometry_guard FROM decision d CROSS JOIN token_budget b
), output AS MATERIALIZED (
 SELECT CASE WHEN geometry_guard IS NOT NULL OR geom IS NULL THEN NULL
  WHEN NOT nested THEN ST_AsGeoJSON(geom,15,0)
  ${render ? `WHEN bytes<=${ROW_BUDGET - ROW_OVERHEAD} THEN (SELECT string_agg(token,'' ORDER BY token_path) FROM tokens)` : ''}
  ELSE NULL END AS geometry_text,
  nested,bytes,geometry_guard FROM gated
)
SELECT geometry_text,geometry_guard,
 CASE WHEN nested THEN bytes ELSE octet_length(geometry_text) END AS geometry_bytes
FROM output)`;
}

/** Capturable through the ordinary read client's query call for native SQL checks. */
export const CANDIDATE_GEOMETRY_ROWS_SQL = `/* data.ingestion.candidate.geometry */
WITH parent_rows AS MATERIALIZED (
 SELECT record.record_id,record.asset_id,record.record_index,record.source_id,
        record.geom,record.source_crs
 FROM ingestion.candidate_record record
 WHERE record.processing_batch_id=$1::uuid AND record.asset_id=$2::uuid
   AND record.record_index>$3::bigint AND record.geom IS NOT NULL
 ORDER BY record.record_index LIMIT $4::integer
), measured AS MATERIALIZED (
 SELECT candidate.*,readback.geometry_text,readback.geometry_guard,
  CASE WHEN readback.geometry_guard IS NOT NULL THEN ${ROW_BUDGET + 1}
   ELSE readback.geometry_bytes+${ROW_OVERHEAD} END AS response_bytes
 FROM parent_rows candidate CROSS JOIN LATERAL ${readbackSql(false)} readback
), prefix AS MATERIALIZED (
 SELECT measured.*,sum(response_bytes) OVER(ORDER BY record_index) AS running_bytes FROM measured
), selected AS MATERIALIZED (
 SELECT prefix.*,running_bytes>${ROW_BUDGET} AS budget_exceeded FROM prefix
 WHERE running_bytes<=2621440 OR
  (record_index=(SELECT min(record_index) FROM measured) AND response_bytes>${ROW_BUDGET})
)
SELECT candidate.record_id,candidate.asset_id,candidate.record_index,candidate.source_id,candidate.source_crs,
 COALESCE(candidate.geometry_text,rendered.geometry_text)::json AS geometry,
 COALESCE(candidate.geometry_guard,rendered.geometry_guard) AS geometry_guard,
 candidate.response_bytes,candidate.running_bytes,candidate.budget_exceeded,
 EXISTS(SELECT 1 FROM ingestion.candidate_record next
  WHERE next.processing_batch_id=$1::uuid AND next.asset_id=$2::uuid
   AND next.record_index>candidate.record_index AND next.geom IS NOT NULL) AS has_more
FROM selected candidate CROSS JOIN LATERAL ${readbackSql(true)} rendered
ORDER BY candidate.record_index`;
