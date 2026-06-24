# Java toolchain layer for the containerized instrumentation agent (broadleaf).
# Builds on the shared base (docker/agent-base.Dockerfile → harness-agent-base), which already provides
# the Node runtime, weaver, baked harness code, and Node deps. Build the base first:
#   docker build -f docker/agent-base.Dockerfile -t harness-agent-base .
#   docker build -f docker/agent-java.Dockerfile -t harness-agent-java .
#
# broadleaf is heavy: exploded-JAR boot, load-time weaving, embedded HSQLDB (port 9001) + Solr,
# multi-minute boot, GB-scale RAM. Two host resources are made available at RUN time by src/container.ts
# rather than baked here: the host ~/.m2 cache (so Maven doesn't re-download ~1 GB) and the seeded
# /tmp/broadleaf-hsqldb (so the agent's verification boot finds the right schema). Ensure Docker
# Desktop has enough VM memory (≥6-8 GB) before a broadleaf run.
FROM harness-agent-base

# JDK + Maven. JDK 17 is the broadly-compatible choice for Broadleaf 6.2.14-GA (Spring Boot 2.x era);
# bookworm ships it in-repo. Maven 3.x from the same repo. (No Temurin apt repo needed.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openjdk-17-jdk-headless maven \
  && rm -rf /var/lib/apt/lists/*

# Bake the OpenTelemetry Java agent jar as an OFFLINE FALLBACK. The skill normally instructs the agent
# to download the latest release itself (host parity, and what actually gets wired into start-site.sh),
# and the container has outbound network so that still works. The jar is platform-independent, so a
# baked copy survives a network blip. Tracks `latest` like the host's download-agent step (harness.sh).
RUN set -eux; \
  mkdir -p /opt/otel; \
  curl -fL -o /opt/otel/opentelemetry-javaagent.jar \
    https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
