#!/usr/bin/env bash
# usage: tools/ab.sh <outdir> <name> '<BOTP json>' [seeds...]  -> runs 48 matches per seed set in parallel
out=$1; name=$2; botp=$3; shift 3
seeds=${@:-1 101 201}
for s in $seeds; do (BOTP="$botp" node tools/sim.ts 48 $s 2>&1 | tail -1 > "$out/$name.$s.txt") & done
wait
python -I -c "
import sys,re,glob
vals=[];surv=[];kills=[]
for f in sorted(glob.glob(sys.argv[1]+'/'+sys.argv[2]+'.*.txt')):
  t=open(f).read(); vals.append(float(re.search(r'mean score ([\d.]+)',t).group(1))); surv.append(float(re.search(r'survive ([\d.]+)',t).group(1))); kills.append(float(re.search(r'kills ([\d.]+)',t).group(1)))
print(f'{sys.argv[2]:>10}: score {sum(vals)/len(vals):.2f}  per-set {vals}  survive {sum(surv)/len(surv):.0f}s  kills {sum(kills)/len(kills):.2f}')
" "$out" "$name"
