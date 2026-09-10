# Packaging layer only: upstream runtime/dependencies stay unchanged.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
COPY --chown=root:root runner/ /app/src/
COPY --chown=root:root assets/ /opt/midbrain-harness/
RUN chmod -R a+rX /app/src /opt/midbrain-harness
LABEL dev.midbrain.harness.package="1"
USER node
