# MongoDB 8 with the log-user init script baked in.
#
# The script is copied into the image instead of bind-mounted so that `docker compose up` works on every
# Docker engine, including ones that cannot resolve host paths (a remote context, or a Windows host
# talking to an engine inside WSL). After editing init.js run `docker compose up -d --build`, and
# `docker compose down -v` first if the data volume already exists (the script only runs on an empty volume).
#
# Pinned by digest: the TASK-023 waivers in .trivyignore.yaml were written for exactly this image.
# Keep docker-compose.dev.yml on the same pin.
FROM mongo:8.3.13@sha256:e16e606f792ea89d2b4907b54e5e31eb86a7a23e27231dce3a982cc8f2d73cd2

# mongod 8.x refuses to start on Linux 6.19-7.0.x kernels while tcmalloc's per-CPU caches are active
# (SERVER-121912). Its 7.0.14+ exemption reads uname, and Ubuntu, which the GitHub hosted runners use,
# reports every 7.0 kernel as 7.0.0 (SERVER-131779). With rseq=1 glibc takes the rseq registration, so tcmalloc falls back to per-thread
# caches and the check passes, at a small allocator cost. This is the docker-library workaround, not a
# MongoDB fix (TESTING.md §6.3). Remove it once a fixed 8.x tag (8.3.16 / 8.0.37) is pinned here.
ENV GLIBC_TUNABLES=glibc.pthread.rseq=1

COPY init.js /docker-entrypoint-initdb.d/init.js
