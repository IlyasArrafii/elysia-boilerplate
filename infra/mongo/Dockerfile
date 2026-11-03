# MongoDB 8 with the log-user init script baked in.
#
# The script is copied into the image instead of bind-mounted so that `docker compose up` works on every
# Docker engine, including ones that cannot resolve host paths (a remote context, or a Windows host
# talking to an engine inside WSL). After editing init.js run `docker compose up -d --build`, and
# `docker compose down -v` first if the data volume already exists (the script only runs on an empty volume).
FROM mongo:8

COPY init.js /docker-entrypoint-initdb.d/init.js
