#!/usr/bin/env python3
"""Remove blank-white stretches (pages still loading) from a recorded demo video.

Detection looks only at the page CONTENT area: it ignores the left 300 px (dashboard/console sidebar), the top 70 px
(header, stopwatch, fast-forward badge) and the bottom 90 px (caption bar). A stretch of >= MIN_LEN seconds where
>= 99.5 % of that area is near-white (>= ~240/255) is cut. Pages with real content (even a sparse table) keep enough
dark pixels to stay. The video is re-encoded once (H.264 crf 16), audio-free like the source.

Usage: trim-blank.py in.mp4 [out.mp4]        (default: replaces in.mp4, keeps nothing else)
"""
import re
import subprocess
import sys

MIN_LEN = 0.4
src = sys.argv[1]
dst = sys.argv[2] if len(sys.argv) > 2 else src

probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                       capture_output=True, text=True, check=True)
duration = float(probe.stdout.strip())
det = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", src, "-vf",
                      f"crop=iw-300:ih-160:300:70,negate,blackdetect=d={MIN_LEN}:pix_th=0.06:pic_th=0.995",
                      "-an", "-f", "null", "-"], capture_output=True, text=True)
blank = [(float(a), float(b)) for a, b in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", det.stderr)]
if not blank:
    print(f"{src}: no blank stretches ({duration:.1f} s)")
    sys.exit(0)
cut = sum(b - a for a, b in blank)
expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in blank)
tmp = dst + ".tmp.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf",
                f"select='not({expr})',setpts=N/FRAME_RATE/TB", "-an",
                "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp],
               check=True)
subprocess.run(["mv", tmp, dst], check=True)
print(f"{src}: removed {len(blank)} blank stretch(es), {cut:.1f} s of {duration:.1f} s -> {duration - cut:.1f} s")
for a, b in blank:
    print(f"   cut {a:7.2f}-{b:7.2f}  ({b - a:.1f} s)")
