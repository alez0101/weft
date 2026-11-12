# Sourced by the scripts: plain `docker` if this user may use it, otherwise `sudo docker`.
# Override with WEFT_DOCKER="podman" or similar.
if [ -z "${WEFT_DOCKER:-}" ]; then
  if docker info >/dev/null 2>&1; then WEFT_DOCKER=docker; else WEFT_DOCKER="sudo docker"; fi
fi
read -r -a DOCKER <<< "$WEFT_DOCKER"
