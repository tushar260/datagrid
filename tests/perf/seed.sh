set -e
P="psql -h localhost -p ${PERF_PG_PORT:-5432} -U ${PERF_PG_USER:-$(whoami)} -d ${PERF_DB:?set PERF_DB} -q"
# wide: 150 columns x 200k rows
COLS="id int primary key"; SEL="g"
for i in $(seq 1 149); do
  case $((i%4)) in
    0) COLS="$COLS, c$i int";            SEL="$SEL, (g*$i)%100003";;
    1) COLS="$COLS, c$i text";           SEL="$SEL, 'val_'||(g%977)||'_$i'";;
    2) COLS="$COLS, c$i numeric(12,3)";  SEL="$SEL, (g*$i)/7.0";;
    3) COLS="$COLS, c$i timestamp";      SEL="$SEL, now() - (g%5000||' minutes')::interval";;
  esac
done
$P -c "create table perf_wide ($COLS)"
$P -c "insert into perf_wide select $SEL from generate_series(1,200000) g"
# tall: 12 columns x 2M rows
$P -c "create table perf_tall (id int primary key, a text, b text, c int, d int, e numeric(12,2), f timestamp, g text, h int, i text, j boolean, k text)"
$P -c "insert into perf_tall select g, md5(g::text), 'name '||g, g%1000, g%77, g/3.0, now()-(g||' seconds')::interval, repeat('x', 40), g%5, 'cat'||(g%50), g%2=0, left(md5((g*3)::text), 20) from generate_series(1,2000000) g"
$P -c "analyze"
$P -c "select relname, reltuples::bigint, pg_size_pretty(pg_total_relation_size(oid)) from pg_class where relname in ('perf_wide','perf_tall')"
