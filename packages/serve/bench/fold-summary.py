import sys, collections
path, filt = sys.argv[1], sys.argv[2]
selfc = collections.Counter(); inc = collections.Counter(); total = 0; per_thread = collections.Counter()
for line in open(path):
    stack, n = line.rsplit(" ", 1); n = int(n)
    parts = stack.split(";"); per_thread[parts[0]] += n
    if filt not in parts[0]: continue
    total += n
    frames = parts[1:]
    if not frames: continue
    selfc[frames[-1]] += n
    for f in set(frames): inc[f] += n
print("samples per thread:", dict(per_thread))
print(f"-- {total} samples in threads matching '{filt}': self time")
for f, n in selfc.most_common(18): print(f"{n*100/total:5.1f}%  {f[:120]}")
print("-- inclusive")
for f, n in inc.most_common(28): print(f"{n*100/total:5.1f}%  {f[:120]}")
