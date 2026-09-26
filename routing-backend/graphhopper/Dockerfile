FROM eclipse-temurin:25-jre

ARG GRAPHHOPPER_VERSION=11.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN curl -fsSL \
  "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GRAPHHOPPER_VERSION}/graphhopper-web-${GRAPHHOPPER_VERSION}.jar" \
  -o /app/graphhopper.jar \
 && curl -fsSL \
  "https://raw.githubusercontent.com/graphhopper/graphhopper/11.x/config-example.yml" \
  -o /app/config.yml

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8989
ENTRYPOINT ["/app/start.sh"]
