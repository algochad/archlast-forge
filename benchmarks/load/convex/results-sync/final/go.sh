cd /home/algochad/Projects/archlast-forge/benchmarks/load/convex
for i in 1 2 3; do echo "fsync-before $(taskset -c 2 bun /tmp/claude-1000/-home-algochad-Projects-archlast-forge/8b085df9-def2-45a2-b0f5-0868554e4909/scratchpad/fs.ts)" >> /home/algochad/.cache/bench/final/fsync.log; done
node matrix.mjs --runs 1 --configs control,forge-sqlite-default --cases A,Aopen,B,Bopen,E,Eu --out /home/algochad/.cache/bench/final/reads.jsonl > /home/algochad/.cache/bench/final/reads.log 2>&1
echo "fsync-mid $(taskset -c 2 bun /tmp/claude-1000/-home-algochad-Projects-archlast-forge/8b085df9-def2-45a2-b0f5-0868554e4909/scratchpad/fs.ts)" >> /home/algochad/.cache/bench/final/fsync.log
node matrix.mjs --runs 3 --configs forge-sqlite-default,forge-sqlite-normal --cases C,D,Copen,Dopen --out /home/algochad/.cache/bench/final/writes.jsonl > /home/algochad/.cache/bench/final/writes.log 2>&1
for i in 1 2 3; do echo "fsync-after $(taskset -c 2 bun /tmp/claude-1000/-home-algochad-Projects-archlast-forge/8b085df9-def2-45a2-b0f5-0868554e4909/scratchpad/fs.ts)" >> /home/algochad/.cache/bench/final/fsync.log; done
echo ALLDONE > /home/algochad/.cache/bench/final/done
